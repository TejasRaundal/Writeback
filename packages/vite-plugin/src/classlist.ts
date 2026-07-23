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

function buildToken(group: TwGroup, variants: string[], value: string): string {
  const chain = variants.length ? variants.join(':') + ':' : ''
  const prefix = group === 'text-size' ? 'text' : group === 'font-weight' || group === 'font-family' ? 'font' : group
  if (value === 'DEFAULT') return `${chain}${prefix}`
  if (value.startsWith('-')) return `${chain}-${prefix}-${value.slice(1)}`
  return `${chain}${prefix}-${value}`
}

/** Remove every token belonging to (group, variant-chain) — used to clear conflicting duplicates. */
export function removeTokenGroup(classes: string, group: TwGroup, chain: string): string {
  return classes
    .split(/\s+/)
    .filter(Boolean)
    .filter((tok) => {
      const p = parseToken(tok)
      return !(p && p.group === group && p.variants.join(':') === chain)
    })
    .join(' ')
}

export function applyTokenEdit(
  classes: string,
  edit: { group: TwGroup; variants: string[]; value: string },
): string {
  const newToken = buildToken(edit.group, edit.variants, edit.value)
  const chain = edit.variants.join(':')
  const tokens = classes.split(/\s+/).filter(Boolean)
  let replaced = false
  const out: string[] = []
  for (const tok of tokens) {
    const parsed = parseToken(tok)
    if (parsed && parsed.group === edit.group && parsed.variants.join(':') === chain) {
      if (!replaced) {
        out.push(newToken)
        replaced = true
      }
      // duplicates in the same group are dropped
    } else out.push(tok)
  }
  if (!replaced) out.push(newToken)
  return out.join(' ')
}
