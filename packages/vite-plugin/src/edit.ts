import MagicString from 'magic-string'
import { createHash } from 'node:crypto'
import type { Loc, TwGroup, TwOp } from '@writeback/protocol'
import { parseJsx, walk } from './tag.ts'
import { applyTokenEdit, parseToken, removeTokenGroup, tokenGroups } from './classlist.ts'
import { componentInfoIn, infoOf, type CompInfo } from './attribute.ts'

export function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

type Segment = { raw: string; start: number; end: number }

/**
 * Feature 2: resolving a cva() defined in another file needs to read + follow
 * imports, but edit.ts stays free of fs/path concerns. The caller (the bridge)
 * injects a host that turns a RELATIVE import specifier into the target file's
 * project-relative path + source, applying extension/index resolution and root
 * confinement. Returns null to refuse (bare specifier, missing, outside root).
 */
export type EditHost = {
  resolve: (spec: string, fromFile: string) => { file: string; source: string } | null
}

type Located =
  | {
      ok: true
      segments: Segment[]
      locked: string[]
      loc: Loc
      /** the source string `segments`/`locked` offsets index into (== call-site source
       *  for a same-file edit; the cva definition file for a cross-file cva) */
      editSource: string
      /** project-relative path of `editSource` — where the write/diff/journal land */
      editFile: string
      /** the matched JSXOpeningElement + its program, for gates that need the element itself */
      node: any
      ast: any
    }
  | { ok: false; reason: 'computed-classname' | 'no-classname'; loc: Loc }
  | null // element not found at loc

const CLSX_NAMES = new Set(['clsx', 'cn', 'cx', 'classNames'])

/**
 * Feature 1: a clsx arg that is a conditional whose every branch is a string literal
 * — `cond ? 'a' : 'b'`, `cond && 'a'`, and nestings thereof. The branch classes can't
 * be edited (we don't know which branch wins at runtime) but they ARE read-only:
 * returns their raw class tokens so the caller can lock the groups they occupy.
 * Returns null when any branch is not a static string literal (→ refuse the element).
 */
function conditionalLiterals(node: any): string[] | null {
  if (node.type === 'StringLiteral') return [node.value]
  if (node.type === 'ConditionalExpression') {
    const c = conditionalLiterals(node.consequent)
    const a = conditionalLiterals(node.alternate)
    return c && a ? [...c, ...a] : null
  }
  // `cond && 'a'` — only the right operand contributes a class string
  if (node.type === 'LogicalExpression' && node.operator === '&&') {
    return conditionalLiterals(node.right)
  }
  return null
}

const isCvaCall = (n: any) =>
  n?.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'cva'

/**
 * The `cva(...)` call bound to a local `name = cva(...)` declarator that is actually IN
 * SCOPE at offset `at` (the element being edited). Scope matters: a same-named cva inside
 * some other function is a different binding entirely, and blindly taking the last match
 * would resolve one component's className to another component's private cva — and then
 * write there. `at` omitted = only a module-level declarator counts (the exported-binding
 * lookup, where a function-scoped cva can never be the export).
 */
function findLocalCva(ast: any, name: string, at?: number): any | null {
  const hits: { init: any; start: number; end: number }[] = []
  const scopeOf = (n: any, outer: { start: number; end: number }) =>
    /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod)$/.test(n.type)
      ? { start: n.start, end: n.end }
      : outer
  const program = { start: ast.program.start, end: ast.program.end }
  const visit = (n: any, scope: { start: number; end: number }) => {
    if (!n || typeof n.type !== 'string') return
    const inner = scopeOf(n, scope)
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.id.name === name && isCvaCall(n.init)) {
      hits.push({ init: n.init, ...scope })
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc') continue
      const c = n[k]
      if (Array.isArray(c)) c.forEach((x) => visit(x, inner))
      else visit(c, inner)
    }
  }
  visit(ast.program, program)
  if (!hits.length) return null
  const visible =
    at === undefined
      ? hits.filter((h) => h.start === program.start && h.end === program.end) // module scope only
      : hits.filter((h) => at >= h.start && at <= h.end)
  if (!visible.length) return null
  // innermost enclosing scope shadows the outer ones
  return visible.sort((a, b) => a.end - a.start - (b.end - b.start))[0].init
}

/** The import that brings `localName` into scope, as {specifier, imported-name-in-target}. */
function findImport(ast: any, localName: string): { spec: string; imported: string } | null {
  for (const n of ast.program.body) {
    if (n.type !== 'ImportDeclaration' || typeof n.source?.value !== 'string') continue
    for (const s of n.specifiers) {
      if (s.type === 'ImportSpecifier' && s.local.name === localName) {
        return { spec: n.source.value, imported: s.imported.name ?? s.imported.value }
      }
      if (s.type === 'ImportDefaultSpecifier' && s.local.name === localName) {
        return { spec: n.source.value, imported: 'default' }
      }
    }
  }
  return null
}

/**
 * Feature 2: find the `cva(...)` call that a given EXPORT of `source` ultimately
 * resolves to — following named/default exports and re-export chains across files
 * via `host`. `hops` bounds re-export indirection (refuse beyond). Returns the call
 * node plus the file/source it lives in, so edits land at the definition.
 */
function findExportedCva(
  file: string,
  source: string,
  exportName: string,
  host: EditHost,
  hops: number,
): { call: any; source: string; file: string } | null {
  let ast: any
  try {
    ast = parseJsx(source)
  } catch {
    return null
  }
  const body = ast.program.body

  // `export *` is checked LAST, after this module's own exports: a module's own binding
  // shadows anything a star re-export would bring in, so resolving it first would edit a
  // cva the app never renders (and leave the one it does render untouched).
  const starExports = () => {
    for (const n of body) {
      if (n.type !== 'ExportAllDeclaration' || !n.source || hops <= 0) continue
      const tgt = host.resolve(n.source.value, file)
      const hit = tgt && findExportedCva(tgt.file, tgt.source, exportName, host, hops - 1)
      if (hit) return hit
    }
    return null
  }

  // (a) re-export from another module: `export { x as name } from './other'`
  for (const n of body) {
    if (n.type === 'ExportNamedDeclaration' && n.source && Array.isArray(n.specifiers)) {
      for (const s of n.specifiers) {
        if (s.type === 'ExportSpecifier' && (s.exported.name ?? s.exported.value) === exportName) {
          if (hops <= 0) return null
          const tgt = host.resolve(n.source.value, file)
          if (!tgt) return null
          return findExportedCva(tgt.file, tgt.source, s.local.name, host, hops - 1)
        }
      }
    }
  }

  // (b) default export: `export default cva(...)` or `export default <ident>`
  if (exportName === 'default') {
    for (const n of body) {
      if (n.type !== 'ExportDefaultDeclaration') continue
      const d = n.declaration
      if (isCvaCall(d)) return { call: d, source, file }
      if (d?.type === 'Identifier') {
        const local = findLocalCva(ast, d.name)
        if (local) return { call: local, source, file }
        const imp = findImport(ast, d.name)
        if (imp && hops > 0) {
          const tgt = host.resolve(imp.spec, file)
          if (tgt) return findExportedCva(tgt.file, tgt.source, imp.imported, host, hops - 1)
        }
      }
    }
    return starExports()
  }

  // `export { base as name }` (no source) renames on the way out — the binding to look
  // for in THIS file is the local name, not the exported one.
  let localName = exportName
  for (const n of body) {
    if (n.type !== 'ExportNamedDeclaration' || n.source || !Array.isArray(n.specifiers)) continue
    for (const s of n.specifiers) {
      if (s.type === 'ExportSpecifier' && (s.exported.name ?? s.exported.value) === exportName) {
        localName = s.local.name
      }
    }
  }

  // (c) named declaration in this file: `export const name = cva(...)` (or a bare
  //     `const name = cva(...)` paired with `export { name }` — walk sees both)
  const local = findLocalCva(ast, localName)
  if (local) return { call: local, source, file }

  // (d) this file re-binds `name` from an import and re-exports it: follow the import
  const imp = findImport(ast, localName)
  if (imp && hops > 0) {
    const tgt = host.resolve(imp.spec, file)
    if (tgt) return findExportedCva(tgt.file, tgt.source, imp.imported, host, hops - 1)
  }
  return starExports()
}

/**
 * M5 + Feature 2: editable segments for `className={button()}` where `button = cva(base, cfg)`.
 * Editable segments = the base string + the active variant slots (defaults merged with
 * literal call args). The cva may be defined in THIS file (M5) or imported from another
 * file (Feature 2, via `host`). Anything non-literal → null (refuse).
 */
function resolveCva(
  ast: any,
  source: string,
  file: string,
  name: string,
  callArgs: any[],
  host: EditHost | undefined,
  at: number,
): { segments: Segment[]; source: string; file: string } | null {
  // same-file first — an in-file declarator IN SCOPE at the element wins over an
  // equally-named import (one out of scope is a different binding and is ignored)
  const local = findLocalCva(ast, name, at)
  if (local) {
    const segments = buildCvaSegments(local, callArgs)
    return segments ? { segments, source, file } : null
  }
  // cross-file: follow the import that brought `name` in (at most 2 module hops)
  if (!host) return null
  const imp = findImport(ast, name)
  if (!imp) return null
  const tgt = host.resolve(imp.spec, file)
  if (!tgt) return null
  const hit = findExportedCva(tgt.file, tgt.source, imp.imported, host, 1)
  if (!hit) return null
  const segments = buildCvaSegments(hit.call, callArgs)
  if (!segments) return null
  return { segments, source: hit.source, file: hit.file }
}

/** Base + active-variant-slot segments from a resolved `cva(base, cfg)` call node. */
function buildCvaSegments(def: any, callArgs: any[]): Segment[] | null {
  const base = def.arguments[0]
  if (base?.type !== 'StringLiteral') return null
  const segments: Segment[] = [{ raw: base.value, start: base.start + 1, end: base.end - 1 }]

  const cfg = def.arguments[1]
  if (cfg && cfg.type !== 'ObjectExpression') return null
  const prop = (obj: any, key: string) =>
    obj?.properties?.find((p: any) => (p.key?.name ?? p.key?.value) === key)?.value
  const variants = prop(cfg, 'variants')
  if (!variants) return segments

  // active variant per dimension: defaultVariants overridden by literal call args
  const active: Record<string, string> = {}
  const defaults = prop(cfg, 'defaultVariants')
  for (const p of defaults?.properties ?? []) {
    if (p.value?.type === 'StringLiteral') active[p.key?.name ?? p.key?.value] = p.value.value
  }
  const callArg = callArgs[0]
  if (callArg) {
    if (callArg.type !== 'ObjectExpression') return null
    for (const p of callArg.properties) {
      if (p.type !== 'ObjectProperty' || p.value?.type !== 'StringLiteral') return null // dynamic variant → refuse
      active[p.key?.name ?? p.key?.value] = p.value.value
    }
  }
  for (const [dim, key] of Object.entries(active)) {
    const slot = prop(prop(variants, dim), key)
    if (slot?.type === 'StringLiteral') {
      segments.push({ raw: slot.value, start: slot.start + 1, end: slot.end - 1 })
    }
  }
  return segments
}

/** Editable className segments of one JSXOpeningElement (no loc — caller attaches it). */
function analyze(
  ast: any,
  node: any,
  ctx: { source: string; file: string; host?: EditHost },
):
  | { ok: true; segments: Segment[]; locked?: string[]; editSource?: string; editFile?: string }
  | { ok: false; reason: 'computed-classname' | 'no-classname' } {
  const attr = node.attributes.find(
    (a: any) => a.type === 'JSXAttribute' && a.name.name === 'className',
  )
  if (!attr) return { ok: false, reason: 'no-classname' }
  const v = attr.value
  if (v?.type === 'StringLiteral') {
    return { ok: true, segments: [{ raw: v.value, start: v.start + 1, end: v.end - 1 }] }
  }
  if (v?.type === 'JSXExpressionContainer') {
    const e = v.expression
    // `...` with zero expressions is as static as a string literal
    if (e.type === 'TemplateLiteral' && e.expressions.length === 0) {
      const q = e.quasis[0]
      return { ok: true, segments: [{ raw: q.value.raw, start: q.start, end: q.end }] }
    }
    // clsx('a b', cond ? 'c' : 'd', ...) — string-literal args are editable segments;
    // all-literal conditional args are read-only (their groups get locked). Any other
    // kind of arg still refuses the whole element (Feature 1 / M4).
    if (
      e.type === 'CallExpression' &&
      e.callee.type === 'Identifier' &&
      CLSX_NAMES.has(e.callee.name) &&
      e.arguments.length > 0
    ) {
      const segments: Segment[] = []
      const locked: string[] = []
      for (const arg of e.arguments) {
        if (arg.type === 'StringLiteral') {
          segments.push({ raw: arg.value, start: arg.start + 1, end: arg.end - 1 })
        } else {
          const lits = conditionalLiterals(arg)
          if (!lits) return { ok: false, reason: 'computed-classname' }
          for (const lit of lits) locked.push(...lit.split(/\s+/).filter(Boolean))
        }
      }
      // nothing statically editable (all args were conditionals) → refuse
      if (segments.length === 0) return { ok: false, reason: 'computed-classname' }
      return { ok: true, segments, locked }
    }
    // cva-produced className: button() / button({ size: 'sm' }) — same-file (M5) or
    // imported from another file (Feature 2). Cross-file edits land in the def file.
    if (e.type === 'CallExpression' && e.callee.type === 'Identifier' && !CLSX_NAMES.has(e.callee.name)) {
      const r = resolveCva(ast, ctx.source, ctx.file, e.callee.name, e.arguments, ctx.host, node.start)
      if (r) return { ok: true, segments: r.segments, editSource: r.source, editFile: r.file }
    }
  }
  return { ok: false, reason: 'computed-classname' }
}

/**
 * The JSXOpeningElement at loc. Prefers an exact line:col match (browser stamps). Falls
 * back to line-only when a single element sits on that line — so agents can pass just a
 * line number (col 0) from a grep and still resolve. Null when the line holds no element,
 * or holds several and no exact column was given.
 */
function findElement(ast: any, loc: Loc): any | null {
  const onLine: any[] = []
  let exact: any = null
  walk(ast.program, (node) => {
    if (node.type !== 'JSXOpeningElement' || node.loc.start.line !== loc.line) return
    onLine.push(node)
    if (node.loc.start.column === loc.col) exact = node
  })
  return exact ?? (onLine.length === 1 ? onLine[0] : null)
}

/** The matched element's real loc, so the caller can echo it for a precise follow-up edit. */
function locate(source: string, loc: Loc, host?: EditHost): Located {
  let ast
  try {
    ast = parseJsx(source)
  } catch {
    return null
  }
  const node = findElement(ast, loc)
  if (!node) return null // no element on this line, or ambiguous (>1) without an exact col
  const matched: Loc = { file: loc.file, line: node.loc.start.line, col: node.loc.start.column }
  const a = analyze(ast, node, { source, file: loc.file, host })
  if (!a.ok) return { ok: false, reason: a.reason, loc: matched }
  // segments/locked offsets index into editSource (== source for a same-file edit,
  // or the cva definition file for a cross-file cva).
  const editSource = a.editSource ?? source
  const editFile = a.editFile ?? loc.file
  // Splice against the RAW source, never babel's cooked .value — otherwise HTML
  // entities / escapes in the literal (e.g. &amp;) get silently rewritten on edit.
  for (const seg of a.segments) seg.raw = editSource.slice(seg.start, seg.end)
  return { ok: true, segments: a.segments, locked: a.locked ?? [], loc: matched, editSource, editFile, node, ast }
}

/** The conflict groups a read-only conditional branch occupies — edits to them refuse. */
function lockedGroups(locked: string[]): TwGroup[] {
  return [...new Set(locked.flatMap(tokenGroups))]
}

export function resolveLoc(source: string, loc: Loc, host?: EditHost) {
  const r = locate(source, loc, host)
  if (r === null) return { classes: null, reason: 'computed-classname' as const } // stale loc / not found
  if (!r.ok) return { classes: null, reason: r.reason, loc: r.loc }
  const classes = r.segments.flatMap((s) => s.raw.split(/\s+/).filter(Boolean))
  // Feature 1: groups a conditional branch owns are readable but NOT editable. Surfaced
  // here so the refusal is loud at RESOLVE time — a client that hides these controls
  // never offers an edit the write path is going to reject.
  const locked = lockedGroups(r.locked)
  const extra = locked.length ? { locked } : {}
  // when the editable source lives in another file (cross-file cva), surface it so the
  // caller hashes / addresses the DEFINITION file, not the call site.
  if (r.editFile !== loc.file) return { classes, loc: r.loc, editFile: r.editFile, editSource: r.editSource, ...extra }
  return { classes, loc: r.loc, ...extra }
}

// ponytail: single-hunk unified diff — every edit touches exactly one attribute value
function unifiedDiff(file: string, before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA > start && endB > start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  const ctx = (arr: string[], i: number) => (i >= 0 && i < arr.length ? [arr[i]] : [])
  // context lines are part of the hunk, so the @@ ranges must count them
  const lead = start > 0 ? 1 : 0
  const trail = endA + 1 < a.length ? 1 : 0
  const hunkStart = start + 1 - lead
  const lines = [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${hunkStart},${lead + (endA - start + 1) + trail} +${hunkStart},${lead + (endB - start + 1) + trail} @@`,
    ...ctx(a, start - 1).map((l) => ' ' + l),
    ...a.slice(start, endA + 1).map((l) => '-' + l),
    ...b.slice(start, endB + 1).map((l) => '+' + l),
    ...ctx(a, endA + 1).map((l) => ' ' + l),
  ]
  return lines.join('\n')
}

export type EditResult =
  | {
      ok: true
      code: string
      diff: string
      /** project-relative path of the file `code` replaces — the call-site file for a
       *  same-file edit, or the cva definition file for a cross-file cva (Feature 2) */
      file: string
      /** the pre-edit content of `file` (for the caller's hash-mismatch check + journal) */
      preSource: string
      /** the ELEMENT's loc — always in the call-site file, so a client can chain an edit
       *  (or re-resolve) with it. Cross-file edits report the def file through `file`. */
      loc: Loc
      /** the write is going through but something about it is uncertain (see callSiteGate) */
      warn?: string
    }
  // 'not-forwarded'/'unknown-edit' only ever come out of the component-usage paths
  | { ok: false; reason: 'computed-classname' | 'parse-error' | 'not-forwarded' | 'unknown-edit' | 'locked-group' }

export function applyEdit(source: string, loc: Loc, op: TwOp, relPath: string, host?: EditHost): EditResult {
  const r = locate(source, loc, host)
  if (r === null || !r.ok) return { ok: false, reason: 'computed-classname' }
  const editSource = r.editSource
  const editFile = r.editFile

  // pick the segment holding a member of the target group — the LAST one, since for
  // cva the variant slot (later segment) is the intended owner over the base; fall
  // back to the first (base) segment for new groups
  const chain = op.variants.join(':')

  // Feature 1: refuse if the target group appears in a read-only conditional branch —
  // whichever way the branch resolves at runtime would fight our static edit. Groups an
  // AMBIGUOUS branch token could occupy (`text-[20px]`) count too, or the branch would
  // silently win over the edit we just wrote.
  if (lockedGroups(r.locked).includes(op.group)) {
    return { ok: false, reason: 'locked-group' }
  }
  // a className written onto a component USAGE only renders if that component forwards
  // it — same gate as target:'callsite', because this path reaches the same attribute
  const usage = r.node.name
  let warn: string | undefined
  if (usage?.type === 'JSXIdentifier' && /^[A-Z]/.test(usage.name)) {
    const gate = callSiteGate(r.ast, source, loc.file, usage.name, op, host)
    if (!gate.ok) return { ok: false, reason: 'not-forwarded' }
    warn = gate.warn
  }
  const seg =
    [...r.segments].reverse().find((s) =>
      s.raw.split(/\s+/).some((tok) => {
        const p = parseToken(tok)
        return p && p.group === op.group && p.variants.join(':') === chain
      }),
    ) ?? r.segments[0]

  const newClasses = applyTokenEdit(seg.raw, op)
  // splice against editSource — for a cross-file cva this is the DEFINITION file, and
  // the segment offsets index into it (relPath/loc.file is only the call site).
  const s = new MagicString(editSource)
  if (seg.start !== seg.end) s.overwrite(seg.start, seg.end, newClasses)
  else s.appendLeft(seg.start, newClasses)
  // strip the same group from every OTHER segment (clsx('p-2','p-4') must not keep both)
  for (const other of r.segments) {
    if (other === seg || other.start === other.end) continue
    const cleaned = removeTokenGroup(other.raw, op.group, chain)
    if (cleaned !== other.raw) s.overwrite(other.start, other.end, cleaned)
  }
  const code = s.toString()
  try {
    parseJsx(code) // reparse-verify: never write a broken file
  } catch {
    return { ok: false, reason: 'parse-error' }
  }
  // diff/journal/write target the file we actually changed (editFile). The echoed loc is
  // always the ELEMENT's: a cva definition site is not a JSX element, so echoing it would
  // hand back a loc that every follow-up resolve/edit refuses.
  return { ok: true, code, diff: unifiedDiff(editFile, editSource, code), file: editFile, preSource: editSource, loc: r.loc, ...(warn ? { warn } : {}) }
}

/* ─────────────────────────── Feature 3: call-site (per-instance) edits ─────────────────────── */

/**
 * What the component exported as `exportName` from `file` does with className — does it
 * forward it, and what classes does it put on its own root? Mirrors findExportedCva's
 * chain walking (named/default/aliased exports, `export … from`, `export *`), bounded by
 * `hops`. `null` = not found here (keep looking / refuse); a record is a determinate answer.
 */
function exportedComponentInfo(
  file: string,
  source: string,
  exportName: string,
  host: EditHost,
  hops: number,
): CompInfo | null {
  let ast: any
  try {
    ast = parseJsx(source)
  } catch {
    return null
  }
  const body = ast.program.body

  if (exportName === 'default') {
    for (const n of body) {
      if (n.type !== 'ExportDefaultDeclaration') continue
      const d = n.declaration
      if (d?.type === 'Identifier') return localComponentInfo(ast, source, file, d.name, host, hops)
      // `export default function Card(){}` / `export default (p) => …`
      if (/^(FunctionDeclaration|ArrowFunctionExpression|FunctionExpression)$/.test(d?.type ?? '')) {
        return infoOf(source, d)
      }
    }
    return null
  }

  // `export { local as exportName }` renames on the way out — with a source it's a
  // re-export to follow, without one the binding to inspect here is the LOCAL name.
  let localName = exportName
  for (const n of body) {
    if (n.type !== 'ExportNamedDeclaration' || !Array.isArray(n.specifiers)) continue
    for (const s of n.specifiers) {
      if (s.type !== 'ExportSpecifier' || (s.exported.name ?? s.exported.value) !== exportName) continue
      if (n.source) {
        if (hops <= 0) return null
        const tgt = host.resolve(n.source.value, file)
        return tgt ? exportedComponentInfo(tgt.file, tgt.source, s.local.name, host, hops - 1) : null
      }
      localName = s.local.name
    }
  }

  const own = localComponentInfo(ast, source, file, localName, host, hops)
  if (own !== null) return own

  // `export * from './x'` barrels — the name may live in any of them (checked last: this
  // module's own export shadows a star re-export)
  for (const n of body) {
    if (n.type !== 'ExportAllDeclaration' || !n.source || hops <= 0) continue
    const tgt = host.resolve(n.source.value, file)
    const hit = tgt ? exportedComponentInfo(tgt.file, tgt.source, exportName, host, hops - 1) : null
    if (hit !== null) return hit
  }
  return null
}

/** Component declared in THIS file, else the module it is imported from. */
function localComponentInfo(
  ast: any,
  source: string,
  file: string,
  name: string,
  host: EditHost | undefined,
  hops: number,
): CompInfo | null {
  const own = componentInfoIn(ast, source, name)
  if (own !== null) return own
  if (!host || hops <= 0) return null
  const imp = findImport(ast, name)
  if (!imp) return null
  const tgt = host.resolve(imp.spec, file)
  return tgt ? exportedComponentInfo(tgt.file, tgt.source, imp.imported, host, hops - 1) : null
}

/**
 * The gate for writing a className onto a component USAGE. A component that never reads
 * className would swallow the edit silently, so an indeterminate answer refuses.
 * When it does forward, the caller also learns whether the class it is about to write
 * collides with a class the component sets itself.
 */
function callSiteGate(
  ast: any,
  source: string,
  file: string,
  name: string,
  op: TwOp,
  host: EditHost | undefined,
): { ok: false } | { ok: true; warn?: string } {
  const info = localComponentInfo(ast, source, file, name, host, 2)
  if (info?.forwards !== true) return { ok: false }
  if (info.merges) return { ok: true } // tailwind-merge settles the conflict at runtime
  const chain = op.variants.join(':')
  // never blind-append: a class of the same group already on the component's root is a
  // real conflict, and with no merge helper STYLESHEET order picks the winner, not us.
  const clash = info.tokens.find((tok) => {
    const p = parseToken(tok)
    return p && p.group === op.group && p.variants.join(':') === chain
  })
  return clash
    ? { ok: true, warn: `<${name}> already sets \`${clash}\` and does not merge classes — stylesheet order decides which wins` }
    : { ok: true }
}

/** The static className value range of a JSX attribute, or null when it is dynamic. */
function staticAttrRange(attr: any): { start: number; end: number } | null {
  const v = attr.value
  if (v?.type === 'StringLiteral') return { start: v.start + 1, end: v.end - 1 }
  if (v?.type === 'JSXExpressionContainer') {
    const e = v.expression
    if (e.type === 'TemplateLiteral' && e.expressions.length === 0) {
      const q = e.quasis[0]
      return { start: q.start, end: q.end }
    }
  }
  return null // clsx/cva/props/etc — an instance edit must not reach into a computed value
}

/**
 * M4 per-instance editing: apply `op` to the className of the COMPONENT USAGE at `loc`
 * (`<Card …>`), instead of the component's definition. Guarded server-side — a component
 * that doesn't forward className would silently swallow the edit, so that refuses.
 *
 * The three outcomes for the usage's className:
 *   static string / expression-free template → normal group-aware token edit
 *   absent                                   → append a NEW className attribute (the one
 *                                              sanctioned append: a fresh attribute, never
 *                                              a blind token append into an existing list)
 *   anything computed                        → refuse `computed-classname`
 *
 * The append adds no competitor to an existing class list, but the component's OWN root
 * classes are a list we can't edit from here — a collision with one of those is reported
 * as a `warn` (see callSiteGate), because stylesheet order, not source order, settles it.
 */
export function applyCallSiteEdit(
  source: string,
  loc: Loc,
  op: TwOp,
  _relPath: string,
  host?: EditHost,
): EditResult {
  let ast
  try {
    ast = parseJsx(source)
  } catch {
    return { ok: false, reason: 'parse-error' }
  }
  const node = findElement(ast, loc)
  if (!node) return { ok: false, reason: 'computed-classname' } // stale loc / ambiguous line
  const name = node.name
  // only a plain PascalCase component usage is a "call site" — host elements (and
  // `<ui.Card>` member expressions) are edited through the ordinary path
  if (name.type !== 'JSXIdentifier' || !/^[A-Z]/.test(name.name)) return { ok: false, reason: 'unknown-edit' }
  // the gate the client's `resolved.instance.forwards` promised, re-checked here: a
  // className this component never reads would be a silent no-op in the browser
  const gate = callSiteGate(ast, source, loc.file, name.name, op, host)
  if (!gate.ok) return { ok: false, reason: 'not-forwarded' }

  const matched: Loc = { file: loc.file, line: node.loc.start.line, col: node.loc.start.column }
  const attr = node.attributes.find((a: any) => a.type === 'JSXAttribute' && a.name.name === 'className')
  const s = new MagicString(source)
  if (!attr) {
    // new attribute, placed after the last existing one (or the tag name when there are none)
    const last = node.attributes[node.attributes.length - 1]
    s.appendLeft(last ? last.end : name.end, ` className="${applyTokenEdit('', op)}"`)
  } else {
    const range = staticAttrRange(attr)
    if (!range) return { ok: false, reason: 'computed-classname' }
    const raw = source.slice(range.start, range.end)
    const next = applyTokenEdit(raw, op)
    if (range.start !== range.end) s.overwrite(range.start, range.end, next)
    else s.appendLeft(range.start, next)
  }
  const code = s.toString()
  try {
    parseJsx(code) // reparse-verify: never write a broken file
  } catch {
    return { ok: false, reason: 'parse-error' }
  }
  return { ok: true, code, diff: unifiedDiff(loc.file, source, code), file: loc.file, preSource: source, loc: matched, ...(gate.warn ? { warn: gate.warn } : {}) }
}
