import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { cssVars, getScale } from '../src/theme'

describe('cssVars', () => {
  it('extracts @theme custom properties', () => {
    const css = `@theme { --color-brand: #ff6600; --color-brand-dark: oklch(0.2 0 0); --spacing-huge: 10rem; }`
    expect(cssVars(css)).toEqual({
      colors: { brand: '#ff6600', 'brand-dark': 'oklch(0.2 0 0)' },
      spacing: { huge: '10rem' },
      fonts: {},
    })
  })
  it('extracts font families but not font-weight/size vars', () => {
    const css = `@theme { --font-display: "Georgia", serif; --font-weight-bold: 700; --font-mono: ui-monospace; }`
    expect(cssVars(css).fonts).toEqual({ display: '"Georgia", serif', mono: 'ui-monospace' })
  })
})

describe('getScale (v4, against playground)', () => {
  const scale = getScale(join(__dirname, '..', '..', '..', 'apps', 'playground'))
  it('reads the real v4 default palette from tailwindcss/theme.css', () => {
    expect(Object.keys(scale.colors).length).toBeGreaterThan(50)
    expect(scale.colors['red-500']).toBeTruthy()
    expect(scale.colors['slate-900']).toBeTruthy()
  })
  it('spacing is the numeric progression in order', () => {
    expect(scale.spacing.indexOf('2')).toBeLessThan(scale.spacing.indexOf('10'))
    expect(scale.spacing).toContain('0.5')
  })
  it('reads font families from the theme, including the playground @theme additions', () => {
    expect(scale.fonts.sans).toBeTruthy() // default
    expect(scale.fonts.display).toContain('Georgia') // added in apps/playground/src/index.css
    expect(scale.fonts.condensed).toBeTruthy()
  })
})
