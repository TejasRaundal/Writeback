import MagicString from 'magic-string'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cssFiles } from './theme.ts'
import { hashOf, unifiedDiff } from './edit.ts'

/**
 * Feature C — `@theme` design-token editing (Tailwind v4).
 *
 * The class-edit path parses JSX with babel; there is no CSS AST dependency in this repo and
 * adding one is off the table, so this module hand-scans the stylesheet instead. The scan is
 * comment-, string- and paren-aware (never a regex over the source), it locates the ONE
 * declaration of the token inside a top-level `@theme` block, splices only that declaration's
 * VALUE with magic-string, and then RE-SCANS the result: the file must still declare exactly
 * the same tokens in the same order, and ours must now hold byte-for-byte the value asked for.
 * Anything ambiguous refuses instead of guessing — the name declared twice, declared inside a
 * nested block, a comment inside the value, or a value that could break out of the declaration.
 *
 * Only EXISTING tokens are editable. Creating one is a design decision (which file? which
 * block? what scale does it join?) that a click in a panel cannot make.
 */

const IDENT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
const WS = ' \t\r\n\f'
const isIdent = (ch: string | undefined) => !!ch && IDENT.includes(ch)

const skipComment = (css: string, i: number): number => {
  const e = css.indexOf('*/', i + 2)
  return e < 0 ? css.length : e + 2
}
function skipString(css: string, i: number): number {
  const q = css[i]
  for (let j = i + 1; j < css.length; j++) {
    if (css[j] === '\\') j++
    else if (css[j] === q) return j + 1
  }
  return css.length
}
// `url(a;b)` / `var(--x, y)` must not be mistaken for a declaration boundary
function skipParens(css: string, i: number): number {
  let depth = 0
  for (let j = i; j < css.length;) {
    const c = css[j]
    if (c === '/' && css[j + 1] === '*') { j = skipComment(css, j); continue }
    if (c === '"' || c === "'") { j = skipString(css, j); continue }
    if (c === '(') { depth++; j++; continue }
    if (c === ')') { depth--; j++; if (depth === 0) return j; continue }
    j++
  }
  return css.length
}
/** index OF the `}` matching the `{` at `open`, or -1 when the file is unbalanced */
function matchBrace(css: string, open: number): number {
  let depth = 0
  for (let i = open; i < css.length;) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') { i = skipComment(css, i); continue }
    if (c === '"' || c === "'") { i = skipString(css, i); continue }
    if (c === '{') { depth++; i++; continue }
    if (c === '}') { depth--; i++; if (depth === 0) return i - 1; continue }
    i++
  }
  return -1
}
function stripComments(s: string): string {
  let out = ''
  for (let i = 0; i < s.length;) {
    if (s[i] === '/' && s[i + 1] === '*') { i = skipComment(s, i); continue }
    out += s[i++]
  }
  return out.trim()
}
function trimSpan(css: string, start: number, end: number): { start: number; end: number } {
  while (start < end && WS.includes(css[start])) start++
  while (end > start && WS.includes(css[end - 1])) end--
  return { start, end }
}

/** inner ranges (between the braces) of every top-level `@theme` block; null = unbalanced CSS */
function themeBlocks(css: string): { start: number; end: number }[] | null {
  const out: { start: number; end: number }[] = []
  let i = 0
  let depth = 0
  while (i < css.length) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') { i = skipComment(css, i); continue }
    if (c === '"' || c === "'") { i = skipString(css, i); continue }
    if (c === '(') { i = skipParens(css, i); continue }
    if (c === '{') { depth++; i++; continue }
    if (c === '}') { depth--; i++; continue }
    // `@theme`, `@theme inline`, `@theme static` — but not `@themed`
    if (c === '@' && depth === 0 && css.startsWith('@theme', i) && !isIdent(css[i + 6])) {
      let j = i + 6
      while (j < css.length && css[j] !== '{' && css[j] !== ';') {
        if (css[j] === '/' && css[j + 1] === '*') { j = skipComment(css, j); continue }
        j++
      }
      if (css[j] !== '{') { i = j + 1; continue } // `@theme;` — no block to read
      const close = matchBrace(css, j)
      if (close < 0) return null
      out.push({ start: j + 1, end: close })
      i = close + 1
      continue
    }
    i++
  }
  return out
}

type RawDecl = { name: string; depth: number; nameStart: number; valueStart: number; valueEnd: number }

/** `prop: value` units in [from,to), with the brace depth they sit at (0 = the block itself) */
function declsIn(css: string, from: number, to: number): RawDecl[] {
  const out: RawDecl[] = []
  let i = from
  let depth = 0
  let segStart = from
  let colon = -1
  const flush = (end: number) => {
    if (colon >= 0) out.push({ name: stripComments(css.slice(segStart, colon)), depth, nameStart: trimSpan(css, segStart, colon).start, valueStart: colon + 1, valueEnd: end })
    colon = -1
  }
  while (i < to) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') { i = Math.min(skipComment(css, i), to); continue }
    if (c === '"' || c === "'") { i = Math.min(skipString(css, i), to); continue }
    if (c === '(') { i = Math.min(skipParens(css, i), to); continue }
    if (c === ';') { flush(i); i++; segStart = i; continue }
    // a nested block opens/closes — flush BEFORE the depth moves so the decl keeps its own depth
    if (c === '{') { flush(i); depth++; i++; segStart = i; continue }
    if (c === '}') { flush(i); depth--; i++; segStart = i; continue }
    if (c === ':' && colon < 0) { colon = i; i++; continue }
    i++
  }
  flush(to)
  return out
}

export type ThemeDecl = {
  name: string
  /** offsets of the VALUE (comments/whitespace trimmed) — the only span an edit may touch */
  start: number
  end: number
  value: string
  /** offset of the PROPERTY NAME — what `loc.line` reports, so jump-to-source lands on the
   *  declaration the user clicked even when its value wrapped onto the next line */
  declStart: number
  /** declared inside a nested block within `@theme` — never editable */
  nested: boolean
}

/** every custom property declared in a top-level `@theme` block, in source order. null = unbalanced CSS */
export function themeDecls(css: string): ThemeDecl[] | null {
  const blocks = themeBlocks(css)
  if (!blocks) return null
  const out: ThemeDecl[] = []
  for (const b of blocks) {
    for (const d of declsIn(css, b.start, b.end)) {
      if (!d.name.startsWith('--')) continue
      const { start, end } = trimSpan(css, d.valueStart, d.valueEnd)
      out.push({ name: d.name, start, end, value: css.slice(start, end), declStart: d.nameStart, nested: d.depth > 0 })
    }
  }
  return out
}

export type TokenRefusal = 'unknown-edit' | 'parse-error'

/** the one editable declaration of `name`, or why it isn't one */
export function findThemeToken(css: string, name: string): { ok: true; decl: ThemeDecl } | { ok: false; reason: TokenRefusal } {
  const decls = themeDecls(css)
  if (!decls) return { ok: false, reason: 'parse-error' }
  const hits = decls.filter((d) => d.name === name)
  if (!hits.length) return { ok: false, reason: 'unknown-edit' }
  // declared twice, or inside a nested block: we will not guess which one wins
  if (hits.length > 1 || hits[0].nested) return { ok: false, reason: 'parse-error' }
  // a comment inside the value would be destroyed by the splice
  if (!hits[0].value || hits[0].value.includes('/*')) return { ok: false, reason: 'parse-error' }
  return { ok: true, decl: hits[0] }
}

// a value that could terminate the declaration, open a block, or start a comment would let
// one edit rewrite the rest of the stylesheet — rejected before the splice, not after
const BAD_IN_VALUE = [';', '{', '}', '/*', '*/', '\\', '\n', '\r']
export const validTokenValue = (v: string): boolean => {
  const t = v.trim()
  return !!t && t.length <= 500 && !BAD_IN_VALUE.some((b) => t.includes(b))
}

/**
 * Replace the value of `name` in `css`. Splice → re-scan → verify, exactly like the JSX path
 * reparses before returning: the token set must be unchanged and the token must now read back
 * as the requested value, or nothing is written.
 */
export function spliceThemeToken(css: string, name: string, value: string): { ok: true; code: string; line: number } | { ok: false; reason: TokenRefusal } {
  if (!name.startsWith('--')) return { ok: false, reason: 'unknown-edit' }
  const v = value.trim()
  if (!validTokenValue(v)) return { ok: false, reason: 'parse-error' }
  const found = findThemeToken(css, name)
  if (!found.ok) return found
  const before = themeDecls(css)!
  const s = new MagicString(css)
  s.overwrite(found.decl.start, found.decl.end, v)
  const code = s.toString()
  const after = themeDecls(code)
  if (!after || after.length !== before.length) return { ok: false, reason: 'parse-error' }
  if (after.map((d) => d.name).join(',') !== before.map((d) => d.name).join(',')) return { ok: false, reason: 'parse-error' }
  const re = findThemeToken(code, name)
  if (!re.ok || re.decl.value !== v) return { ok: false, reason: 'parse-error' }
  // the DECLARATION's line, not the value's: they differ when the value wrapped
  return { ok: true, code, line: css.slice(0, found.decl.declStart).split('\n').length }
}

type Site = { file: string; ok: boolean }

/**
 * Every `@theme` token in the project's CSS (same scan as getScale: under `src/`, depth 3),
 * with each place it is declared. More than one site = ambiguous = not editable.
 */
function scanProject(root: string): Map<string, Site[]> {
  const sites = new Map<string, Site[]>()
  for (const abs of cssFiles(join(root, 'src'))) {
    let css: string
    try {
      css = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const decls = themeDecls(css)
    if (!decls) continue
    const file = abs.slice(resolve(root).length + 1).replace(/\\/g, '/')
    for (const d of decls) {
      const ok = !d.nested && !!d.value && !d.value.includes('/*')
      sites.set(d.name, [...(sites.get(d.name) ?? []), { file, ok }])
    }
  }
  return sites
}

/** the `config.tokens` payload: editable tokens only, each with its file's lock hash */
export function themeTokenIndex(root: string): Record<string, { file: string; hash: string }> {
  const out: Record<string, { file: string; hash: string }> = {}
  const hashes = new Map<string, string>()
  for (const [name, sites] of scanProject(root)) {
    if (sites.length !== 1 || !sites[0].ok) continue
    const file = sites[0].file
    if (!hashes.has(file)) {
      try {
        hashes.set(file, hashOf(readFileSync(join(root, file), 'utf8')))
      } catch {
        continue
      }
    }
    out[name] = { file, hash: hashes.get(file)! }
  }
  return out
}

export type TokenEdit =
  | { ok: true; code: string; diff: string; file: string; preSource: string; line: number }
  | { ok: false; reason: TokenRefusal }

/** locate the CSS file declaring `name` and produce its rewritten content + diff (no I/O writes) */
export function applyThemeTokenEdit(root: string, name: string, value: string): TokenEdit {
  const sites = scanProject(root).get(name)
  if (!sites || !sites.length) return { ok: false, reason: 'unknown-edit' }
  if (sites.length > 1) return { ok: false, reason: 'parse-error' } // declared in two files — refuse
  const file = sites[0].file
  const css = readFileSync(join(root, file), 'utf8')
  const r = spliceThemeToken(css, name, value)
  if (!r.ok) return r
  return { ok: true, code: r.code, diff: unifiedDiff(file, css, r.code), file, preSource: css, line: r.line }
}
