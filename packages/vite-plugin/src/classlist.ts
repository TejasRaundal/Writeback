import type { TwGroup } from '@writeback/protocol'

// ponytail: hand-rolled group tables for the v1-supported groups only; swap for
// tailwind-merge's class-group config when M4/M5 widen coverage.

const SPACING_GROUPS = [
  'gap-x', 'gap-y', 'gap',
  'px', 'py', 'pt', 'pr', 'pb', 'pl', 'p',
  'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'm',
] as const

// text-<suffix> in this set = font-size, not color
const FONT_SIZES = new Set([
  'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
])

// bg-<suffix> starting with these = not a color
const BG_NON_COLOR = /^(gradient-|linear-|radial-|conic-|cover$|contain$|auto$|center|top|bottom|left|right|repeat|no-repeat|fixed$|local$|scroll$|clip-|origin-|blend-|opacity-|none$)/

// text-<suffix> starting with these = not a color (align / wrap / overflow / transform / decoration / opacity)
const TEXT_NON_COLOR = /^(left$|center$|right$|justify$|start$|end$|wrap$|nowrap$|balance$|pretty$|ellipsis$|clip$|opacity-)/

const FONT_WEIGHTS = new Set(['thin', 'extralight', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black'])
const FONT_FAMILIES = new Set(['sans', 'serif', 'mono'])
const SHADOW_SIZES = new Set(['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', 'inner', 'none'])
// order matters: longest prefix first
const ROUNDED_GROUPS = ['rounded-tl', 'rounded-tr', 'rounded-bl', 'rounded-br', 'rounded-t', 'rounded-r', 'rounded-b', 'rounded-l', 'rounded']
const SIMPLE_PREFIX = ['tracking', 'leading', 'opacity'] as const

export type ParsedToken = { group: TwGroup; variants: string[]; value: string }

// Split a class token on ':' but not inside [brackets]
function splitVariants(token: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of token) {
    if (ch === '[') depth++
    else if (ch === ']') depth--
    if (ch === ':' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  return parts
}

export function parseToken(token: string): ParsedToken | null {
  const parts = splitVariants(token)
  const variants = parts.slice(0, -1)
  let base = parts[parts.length - 1]
  let neg = ''
  if (base.startsWith('-')) {
    neg = '-'
    base = base.slice(1)
  }
  for (const g of SPACING_GROUPS) {
    if (base.startsWith(g + '-')) {
      return { group: g, variants, value: neg + base.slice(g.length + 1) }
    }
  }
  if (neg) return null
  if (base.startsWith('text-')) {
    const suffix = base.slice(5)
    if (suffix.startsWith('[')) return null // arbitrary — size/color ambiguous, leave alone
    if (FONT_SIZES.has(suffix)) return { group: 'text-size', variants, value: suffix }
    if (TEXT_NON_COLOR.test(suffix)) return null // align/wrap/overflow/opacity — not a color
    return { group: 'text', variants, value: suffix }
  }
  if (base.startsWith('bg-')) {
    const suffix = base.slice(3)
    if (BG_NON_COLOR.test(suffix)) return null
    return { group: 'bg', variants, value: suffix }
  }
  if (base.startsWith('font-')) {
    const suffix = base.slice(5)
    if (FONT_WEIGHTS.has(suffix)) return { group: 'font-weight', variants, value: suffix }
    if (FONT_FAMILIES.has(suffix)) return { group: 'font-family', variants, value: suffix }
    return null // custom font token — leave alone
  }
  for (const g of SIMPLE_PREFIX) {
    if (base.startsWith(g + '-')) return { group: g, variants, value: base.slice(g.length + 1) }
  }
  for (const g of ROUNDED_GROUPS) {
    if (base === g) return { group: g as TwGroup, variants, value: 'DEFAULT' }
    if (base.startsWith(g + '-')) return { group: g as TwGroup, variants, value: base.slice(g.length + 1) }
  }
  if (base === 'shadow') return { group: 'shadow', variants, value: 'DEFAULT' }
  if (base.startsWith('shadow-')) {
    const suffix = base.slice(7)
    if (SHADOW_SIZES.has(suffix)) return { group: 'shadow', variants, value: suffix }
    return null // shadow color — a different group, leave alone
  }
  return null
}

/**
 * Every group a token might belong to — conservatively. `parseToken` returns null for
 * tokens whose group is AMBIGUOUS (`text-[20px]` is a size or a colour, `font-display`
 * a family or a weight); those still occupy a conflict group at runtime, so a caller
 * that needs to LOCK groups (Feature 1's read-only conditional branches) must treat
 * them as occupying all the groups they could be. Tokens that are definitively outside
 * every supported group (`text-center`, `bg-gradient-to-r`) return [].
 */
export function tokenGroups(token: string): TwGroup[] {
  const parsed = parseToken(token)
  if (parsed) return [parsed.group]
  const parts = splitVariants(token)
  let base = parts[parts.length - 1]
  if (base.startsWith('-')) base = base.slice(1)
  // arbitrary values are the ambiguous cases parseToken deliberately declines
  if (base.startsWith('text-')) return base.slice(5).startsWith('[') ? ['text', 'text-size'] : []
  if (base.startsWith('shadow-')) return base.slice(7).startsWith('[') ? ['shadow'] : []
  if (base.startsWith('font-')) return ['font-family', 'font-weight'] // unknown suffix: could be either
  return []
}

function buildToken(group: TwGroup, variants: string[], value: string): string {
  const chain = variants.length ? variants.join(':') + ':' : ''
  const prefix = group === 'text-size' ? 'text' : group === 'font-weight' || group === 'font-family' ? 'font' : group
  if (value === 'DEFAULT') return `${chain}${prefix}`
  if (value.startsWith('-')) return `${chain}-${prefix}-${value.slice(1)}`
  return `${chain}${prefix}-${value}`
}

/**
 * The conflict-group identity of a variant chain. `hover:md:p-2` and `md:hover:p-2` compile to
 * the SAME rule (same media query, same pseudo-class), so they are one conflict group — comparing
 * the chains as ordered strings would treat them as two and blind-append a competing token, which
 * is exactly what the never-blind-append rule exists to prevent. Order-insensitive by sorting;
 * duplicated segments collapse too (`hover:hover:` is the `hover:` group).
 */
export const chainKey = (variants: string[]): string => [...new Set(variants)].sort().join(':')
/** same identity, from an already-joined chain string ('' = base) */
export const chainKeyOf = (chain: string): string => chainKey(chain ? chain.split(':') : [])
const sameChain = (p: ParsedToken, key: string) => chainKey(p.variants) === key

/**
 * Characters a class token may contain. Everything a JSX string/template literal could be
 * broken out of — quotes, backticks, braces, `$`, backslash, whitespace — is absent by
 * construction, so a spliced token can never grow an attribute, an event handler, or a live
 * `${…}` expression. Reparse-verify only proves the FILE parses; this is what proves the edit
 * stayed inside the literal. Applied to the whole built token, variant prefixes included.
 */
const TOKEN_CHARS = /^[A-Za-z0-9_@:/.[\]#%(),!*+&<>=?|~^-]+$/
export const validToken = (token: string): boolean => token.length <= 200 && TOKEN_CHARS.test(token)
/** the token an edit would emit is the thing to validate — variants and value both ride in it */
export const validTokenEdit = (edit: { group: TwGroup; variants: string[]; value: string }): boolean =>
  edit.variants.every((v) => !!v && validToken(v) && !v.includes(':')) && validToken(buildToken(edit.group, edit.variants, edit.value))

type Piece = { tok: string; gap: string }
/**
 * Tokens plus the EXACT whitespace around them. A `className` written across several lines is
 * a formatting choice the user made; rebuilding the list with single spaces would reflow lines
 * the edit never touched (and fight their formatter), so every surviving token keeps its own
 * separator.
 */
function pieces(classes: string): { lead: string; items: Piece[] } {
  const items: Piece[] = []
  let lead = ''
  let last = 0
  for (const m of classes.matchAll(/\S+/g)) {
    if (!items.length) lead = classes.slice(0, m.index!)
    else items[items.length - 1].gap = classes.slice(last, m.index!)
    items.push({ tok: m[0], gap: '' })
    last = m.index! + m[0].length
  }
  if (items.length) items[items.length - 1].gap = classes.slice(last)
  else lead = classes
  return { lead, items }
}
const joinPieces = (lead: string, items: Piece[]) => lead + items.map((i) => i.tok + i.gap).join('')

/** drop items[i], handing its trailing whitespace to the token before it (so the list keeps its shape) */
function dropAt(items: Piece[], i: number) {
  if (i === items.length - 1 && i > 0) items[i - 1].gap = items[i].gap
  items.splice(i, 1)
}

/** Remove every token belonging to (group, variant-chain) — used to clear conflicting duplicates. */
export function removeTokenGroup(classes: string, group: TwGroup, chain: string): string {
  const { lead, items } = pieces(classes)
  const key = chainKeyOf(chain)
  for (let i = items.length - 1; i >= 0; i--) {
    const p = parseToken(items[i].tok)
    if (p && p.group === group && sameChain(p, key)) dropAt(items, i)
  }
  return joinPieces(items.length ? lead : '', items)
}

export function applyTokenEdit(
  classes: string,
  edit: { group: TwGroup; variants: string[]; value: string },
): string {
  const newToken = buildToken(edit.group, edit.variants, edit.value)
  const key = chainKey(edit.variants)
  const { lead, items } = pieces(classes)
  const hits: number[] = []
  items.forEach((it, i) => {
    const p = parseToken(it.tok)
    if (p && p.group === edit.group && sameChain(p, key)) hits.push(i)
  })
  if (hits.length) {
    items[hits[0]].tok = newToken // replaced in place, keeping its position and separators
    for (const i of hits.slice(1).reverse()) dropAt(items, i) // duplicates in the same group are dropped
  } else {
    // append: reuse the separator BETWEEN the last two tokens, so a multi-line list stays multi-line
    const sep = items.length > 1 ? items[items.length - 2].gap : ' '
    if (items.length) {
      const trail = items[items.length - 1].gap
      items[items.length - 1].gap = sep
      items.push({ tok: newToken, gap: trail })
    } else return newToken
  }
  return joinPieces(lead, items)
}
