import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// fonts: token name -> the resolved CSS font stack (read from the project, never hardcoded)
export type Scale = { spacing: string[]; colors: Record<string, string>; fonts: Record<string, string> }

// v4 default spacing is `--spacing` × a numeric progression — enumerate the standard steps
const NUMERIC_STEPS = ['0', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '7', '8', '9', '10', '11', '12', '14', '16', '20', '24', '28', '32', '36', '40', '48', '56', '64']

const FALLBACK: Scale = {
  spacing: NUMERIC_STEPS,
  colors: { white: '#ffffff', black: '#000000' },
  fonts: { sans: 'ui-sans-serif, system-ui, sans-serif', serif: 'ui-serif, Georgia, serif', mono: 'ui-monospace, monospace' },
}

/** Extract --color-* / --spacing-* / --font-* custom properties from CSS text. */
export function cssVars(css: string): { colors: Record<string, string>; spacing: Record<string, string>; fonts: Record<string, string> } {
  const colors: Record<string, string> = {}
  const spacing: Record<string, string> = {}
  const fonts: Record<string, string> = {}
  for (const m of css.matchAll(/--(color|spacing|font)-([\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
    const [, kind, name, value] = m
    const bucket = kind === 'color' ? colors : kind === 'spacing' ? spacing : fonts
    bucket[name] = value.trim()
  }
  // don't treat --font-weight-* / --font-feature-* etc. as families
  for (const k of Object.keys(fonts)) if (/^(weight|feature|variation|size)-/.test(k)) delete fonts[k]
  return { colors, spacing, fonts }
}

function* cssFiles(dir: string, depth = 3): Generator<string> {
  if (depth === 0 || !existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* cssFiles(p, depth - 1)
    else if (e.name.endsWith('.css')) yield p
  }
}

function flattenColors(obj: any, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}-${k}` : k
    if (typeof v === 'string') out[k === 'DEFAULT' ? prefix : key] = v
    else if (typeof v === 'object') Object.assign(out, flattenColors(v, key))
  }
  return out
}

function v4Scale(root: string, req: NodeRequire): Scale {
  const colors: Record<string, string> = {}
  const fonts: Record<string, string> = {}
  const spacing = new Set(NUMERIC_STEPS)
  // the real resolved default theme ships as CSS in the tailwindcss package
  try {
    const themeCss = readFileSync(req.resolve('tailwindcss/theme.css'), 'utf8')
    const v = cssVars(themeCss)
    Object.assign(colors, v.colors)
    Object.assign(fonts, v.fonts)
  } catch { /* defaults unavailable — user overrides below still apply */ }
  // user @theme overrides / additions live in the project's CSS
  for (const f of cssFiles(join(root, 'src'))) {
    const vars = cssVars(readFileSync(f, 'utf8'))
    Object.assign(colors, vars.colors)
    Object.assign(fonts, vars.fonts)
    for (const name of Object.keys(vars.spacing)) spacing.add(name)
  }
  return { spacing: sortSpacing([...spacing]), colors, fonts: Object.keys(fonts).length ? fonts : FALLBACK.fonts }
}

// numeric tokens in scale order, named tokens after
function sortSpacing(keys: string[]): string[] {
  return keys.sort((a, b) => {
    const na = parseFloat(a)
    const nb = parseFloat(b)
    if (isNaN(na) && isNaN(nb)) return a.localeCompare(b)
    if (isNaN(na)) return 1
    if (isNaN(nb)) return -1
    return na - nb
  })
}

function v3Scale(root: string, req: NodeRequire): Scale {
  const resolveConfig = req('tailwindcss/resolveConfig')
  let userConfig = {}
  for (const name of ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs']) {
    const p = join(root, name)
    if (existsSync(p)) {
      userConfig = req(p)
      break
    }
  }
  const theme = (resolveConfig.default ?? resolveConfig)((userConfig as any).default ?? userConfig).theme
  const fonts: Record<string, string> = {}
  for (const [name, val] of Object.entries(theme.fontFamily ?? {})) {
    fonts[name] = Array.isArray(val) ? (val as string[]).join(', ') : String(val)
  }
  return {
    spacing: sortSpacing(Object.keys(theme.spacing ?? {}).filter((k) => k !== 'px')),
    colors: flattenColors(theme.colors),
    fonts: Object.keys(fonts).length ? fonts : FALLBACK.fonts,
  }
}

export function getScale(root: string): Scale {
  try {
    const req = createRequire(join(root, 'package.json'))
    const version: string = req('tailwindcss/package.json').version
    return version.startsWith('3') ? v3Scale(root, req) : v4Scale(root, req)
  } catch {
    return FALLBACK // no tailwind resolvable — stock scale, panel still works
  }
}
