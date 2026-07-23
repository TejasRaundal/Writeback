import MagicString from 'magic-string'
import { createHash } from 'node:crypto'
import type { Loc, TwOp } from '@writeback/protocol'
import { parseJsx, walk } from './tag.ts'
import { applyTokenEdit, parseToken, removeTokenGroup } from './classlist.ts'

export function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

type Segment = { raw: string; start: number; end: number }

type Located =
  | { ok: true; segments: Segment[]; loc: Loc }
  | { ok: false; reason: 'computed-classname' | 'no-classname'; loc: Loc }
  | null // element not found at loc

const CLSX_NAMES = new Set(['clsx', 'cn', 'cx', 'classNames'])

/**
 * M5: className={button()} / button({ intent: 'ghost' }) where `button = cva(base, cfg)`
 * in the same file. Editable segments = the base string + the active variant slots
 * (defaults merged with literal call args). Anything non-literal → null (refuse).
 */
function cvaSegments(ast: any, name: string, callArgs: any[]): Segment[] | null {
  let def: any = null
  walk(ast.program, (n) => {
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.id.name === name &&
        n.init?.type === 'CallExpression' && n.init.callee?.name === 'cva') def = n.init
  })
  if (!def) return null
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
function analyze(ast: any, node: any): { ok: true; segments: Segment[] } | { ok: false; reason: 'computed-classname' | 'no-classname' } {
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
    // clsx('a b', 'c') with ALL string-literal args (M4)
    if (
      e.type === 'CallExpression' &&
      e.callee.type === 'Identifier' &&
      CLSX_NAMES.has(e.callee.name) &&
      e.arguments.length > 0 &&
      e.arguments.every((a: any) => a.type === 'StringLiteral')
    ) {
      return { ok: true, segments: e.arguments.map((a: any) => ({ raw: a.value, start: a.start + 1, end: a.end - 1 })) }
    }
    // cva-produced className: button() / button({ size: 'sm' }) (M5)
    if (e.type === 'CallExpression' && e.callee.type === 'Identifier' && !CLSX_NAMES.has(e.callee.name)) {
      const segs = cvaSegments(ast, e.callee.name, e.arguments)
      if (segs) return { ok: true, segments: segs }
    }
  }
  return { ok: false, reason: 'computed-classname' }
}

/**
 * Find the JSXOpeningElement at loc. Prefers an exact line:col match (browser stamps).
 * Falls back to line-only when a single element sits on that line — so agents can pass
 * just a line number (col 0) from a grep and still resolve. Returns the matched element's
 * real loc so the caller can echo it for a precise follow-up edit.
 */
function locate(source: string, loc: Loc): Located {
  let ast
  try {
    ast = parseJsx(source)
  } catch {
    return null
  }
  const onLine: any[] = []
  let exact: any = null
  walk(ast.program, (node) => {
    if (node.type !== 'JSXOpeningElement' || node.loc.start.line !== loc.line) return
    onLine.push(node)
    if (node.loc.start.column === loc.col) exact = node
  })
  const node = exact ?? (onLine.length === 1 ? onLine[0] : null)
  if (!node) return null // no element on this line, or ambiguous (>1) without an exact col
  const matched: Loc = { file: loc.file, line: node.loc.start.line, col: node.loc.start.column }
  const a = analyze(ast, node)
  if (!a.ok) return { ok: false, reason: a.reason, loc: matched }
  // Splice against the RAW source, never babel's cooked .value — otherwise HTML
  // entities / escapes in the literal (e.g. &amp;) get silently rewritten on edit.
  for (const seg of a.segments) seg.raw = source.slice(seg.start, seg.end)
  return { ok: true, segments: a.segments, loc: matched }
}

export function resolveLoc(source: string, loc: Loc) {
  const r = locate(source, loc)
  if (r === null) return { classes: null, reason: 'computed-classname' as const } // stale loc / not found
  if (!r.ok) return { classes: null, reason: r.reason, loc: r.loc }
  return { classes: r.segments.flatMap((s) => s.raw.split(/\s+/).filter(Boolean)), loc: r.loc }
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
  | { ok: true; code: string; diff: string }
  | { ok: false; reason: 'computed-classname' | 'parse-error' }

export function applyEdit(source: string, loc: Loc, op: TwOp, relPath: string): EditResult {
  const r = locate(source, loc)
  if (r === null || !r.ok) return { ok: false, reason: 'computed-classname' }

  // pick the segment holding a member of the target group — the LAST one, since for
  // cva the variant slot (later segment) is the intended owner over the base; fall
  // back to the first (base) segment for new groups
  const chain = op.variants.join(':')
  const seg =
    [...r.segments].reverse().find((s) =>
      s.raw.split(/\s+/).some((tok) => {
        const p = parseToken(tok)
        return p && p.group === op.group && p.variants.join(':') === chain
      }),
    ) ?? r.segments[0]

  const newClasses = applyTokenEdit(seg.raw, op)
  const s = new MagicString(source)
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
  return { ok: true, code, diff: unifiedDiff(relPath, source, code) }
}
