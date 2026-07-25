import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { themeDecls, findThemeToken, spliceThemeToken, validTokenValue, themeTokenIndex, applyThemeTokenEdit } from '../src/token'

/**
 * Feature C: the CSS half. There is no CSS AST here, so these tests are the contract for the
 * hand-written scanner: what it finds, what it refuses, and — the load-bearing part — that a
 * splice only ever moves the ONE declaration value it was aimed at.
 */
describe('themeDecls', () => {
  it('reads custom properties out of a top-level @theme block', () => {
    const css = `@theme {\n  --color-brand: #ff6600;\n  --spacing-lg: 2rem;\n}\n`
    expect(themeDecls(css)!.map((d) => [d.name, d.value])).toEqual([
      ['--color-brand', '#ff6600'],
      ['--spacing-lg', '2rem'],
    ])
  })

  it('ignores custom properties declared OUTSIDE @theme', () => {
    const css = `:root { --color-brand: red; }\n@theme { --color-ok: blue; }\n`
    expect(themeDecls(css)!.map((d) => d.name)).toEqual(['--color-ok'])
  })

  it('accepts @theme inline / @theme static, but not @themed', () => {
    expect(themeDecls('@theme inline { --color-a: red; }')!.map((d) => d.name)).toEqual(['--color-a'])
    expect(themeDecls('@theme static { --color-b: red; }')!.map((d) => d.name)).toEqual(['--color-b'])
    expect(themeDecls('@themed { --color-c: red; }')).toEqual([])
  })

  it('survives comments, semicolons inside url()/var(), and a missing final semicolon', () => {
    const css = `@theme {
  /* the brand */
  --color-brand: #ff6600; /* trailing note */
  --bg-hero: url(a.png?x=1;y=2);
  --color-fallback: var(--color-brand, #000)
}`
    expect(themeDecls(css)!.map((d) => [d.name, d.value])).toEqual([
      ['--color-brand', '#ff6600'],
      ['--bg-hero', 'url(a.png?x=1;y=2)'],
      ['--color-fallback', 'var(--color-brand, #000)'],
    ])
  })

  it('reads several @theme blocks, and marks nested declarations', () => {
    const css = `@theme { --color-a: red; }\n@media print { @theme { --color-x: black; } }\n@theme { @media print { --color-b: blue; } }`
    const d = themeDecls(css)!
    // the @theme inside @media is not top-level, so it is not scanned at all
    expect(d.map((x) => x.name)).toEqual(['--color-a', '--color-b'])
    expect(d.find((x) => x.name === '--color-b')!.nested).toBe(true)
  })

  it('reports unbalanced CSS as unreadable rather than guessing', () => {
    expect(themeDecls('@theme { --color-a: red;')).toBeNull()
  })
})

describe('findThemeToken', () => {
  const css = `@theme {\n  --color-a: red;\n  --color-dup: blue;\n  --color-dup: green;\n  --color-cmt: /* why */ teal;\n}`
  it('finds the single declaration', () => {
    const r = findThemeToken(css, '--color-a')
    expect(r.ok && r.decl.value).toBe('red')
  })
  it('refuses an unknown name with unknown-edit (no creation path)', () => {
    expect(findThemeToken(css, '--color-nope')).toEqual({ ok: false, reason: 'unknown-edit' })
  })
  it('refuses a duplicated declaration rather than picking a winner', () => {
    expect(findThemeToken(css, '--color-dup')).toEqual({ ok: false, reason: 'parse-error' })
  })
  it('refuses a value containing a comment — the splice would destroy it', () => {
    expect(findThemeToken(css, '--color-cmt')).toEqual({ ok: false, reason: 'parse-error' })
  })
  it('refuses a nested declaration', () => {
    expect(findThemeToken('@theme { @media print { --color-n: red; } }', '--color-n')).toEqual({ ok: false, reason: 'parse-error' })
  })
})

describe('validTokenValue', () => {
  it('accepts real CSS values', () => {
    for (const v of ['#ff6600', 'oklch(0.7 0.2 30)', '"Georgia", serif', '2rem', 'var(--color-a)']) {
      expect(validTokenValue(v)).toBe(true)
    }
  })
  it('rejects anything that could escape the declaration', () => {
    for (const v of ['', '   ', 'red; --color-b: blue', 'red } .x {', 'red /* x */', 'a\nb', 'x'.repeat(501)]) {
      expect(validTokenValue(v)).toBe(false)
    }
  })
})

describe('spliceThemeToken', () => {
  const css = `@theme {\n  --color-brand: #ff6600;\n  --color-other: #000;\n}\n`

  it('replaces only the value, keeping every byte around it', () => {
    const r = spliceThemeToken(css, '--color-brand', '#00ff00')
    expect(r.ok && r.code).toBe(`@theme {\n  --color-brand: #00ff00;\n  --color-other: #000;\n}\n`)
    expect(r.ok && r.line).toBe(2)
  })

  it('reports the DECLARATION line even when the value wrapped onto the next one', () => {
    // the line is what jump-to-source uses: it must land on the property the user clicked
    const wrapped = `@theme {\n  --color-brand:\n    #ff6600;\n}\n`
    const r = spliceThemeToken(wrapped, '--color-brand', '#00ff00')
    expect(r.ok && r.line).toBe(2)
    expect(r.ok && r.code).toBe(`@theme {\n  --color-brand:\n    #00ff00;\n}\n`)
  })

  it('leaves an identically-named property outside @theme alone', () => {
    const mixed = `:root { --color-brand: red; }\n@theme { --color-brand: blue; }\n`
    const r = spliceThemeToken(mixed, '--color-brand', 'green')
    expect(r.ok && r.code).toBe(`:root { --color-brand: red; }\n@theme { --color-brand: green; }\n`)
  })

  it('refuses a value that would terminate the declaration', () => {
    expect(spliceThemeToken(css, '--color-brand', 'red; --color-other: pink')).toEqual({ ok: false, reason: 'parse-error' })
    expect(spliceThemeToken(css, '--color-brand', 'red }')).toEqual({ ok: false, reason: 'parse-error' })
  })

  it('refuses an unbalanced paren — the re-scan no longer reads the token back', () => {
    // this one is not caught by the character check: only re-scanning the result catches it
    expect(spliceThemeToken(css, '--color-brand', 'rgb(0 0 0')).toEqual({ ok: false, reason: 'parse-error' })
    expect(spliceThemeToken(css, '--color-brand', '"unterminated')).toEqual({ ok: false, reason: 'parse-error' })
  })

  it('refuses a name that is not a custom property', () => {
    expect(spliceThemeToken(css, 'color', 'red')).toEqual({ ok: false, reason: 'unknown-edit' })
  })

  it('trims the incoming value and normalises nothing else', () => {
    const r = spliceThemeToken(`@theme {\n  --font-display:   "Georgia" ,  serif ;\n}`, '--font-display', '  "Verdana", sans-serif  ')
    expect(r.ok && r.code).toBe(`@theme {\n  --font-display:   "Verdana", sans-serif ;\n}`)
  })
})

describe('project scan', () => {
  const boot = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'wb-token-'))
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), body)
    }
    return root
  }

  it('indexes editable tokens with the declaring file + its lock hash', () => {
    const root = boot({ 'src/index.css': '@theme { --color-brand: #ff6600; }', 'src/other.txt': 'ignored' })
    try {
      const idx = themeTokenIndex(root)
      expect(Object.keys(idx)).toEqual(['--color-brand'])
      expect(idx['--color-brand'].file).toBe('src/index.css')
      expect(idx['--color-brand'].hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits a token declared in two files, and refuses the write for it', () => {
    const root = boot({ 'src/a.css': '@theme { --color-dup: red; --color-a: red; }', 'src/b.css': '@theme { --color-dup: blue; }' })
    try {
      expect(Object.keys(themeTokenIndex(root))).toEqual(['--color-a'])
      expect(applyThemeTokenEdit(root, '--color-dup', 'green')).toEqual({ ok: false, reason: 'parse-error' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('produces a diff of the one line, and never touches a sibling CSS file', () => {
    const root = boot({ 'src/a.css': '@theme { --color-a: red; }', 'src/nested/b.css': '@theme { --color-b: blue; }' })
    try {
      const r = applyThemeTokenEdit(root, '--color-b', 'green')
      expect(r.ok && r.file).toBe('src/nested/b.css')
      expect(r.ok && r.code).toBe('@theme { --color-b: green; }')
      expect(r.ok && r.diff).toContain('+@theme { --color-b: green; }')
      expect(r.ok && r.diff).toContain('--- a/src/nested/b.css')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an unknown token is unknown-edit, not a silent no-op', () => {
    const root = boot({ 'src/a.css': '@theme { --color-a: red; }' })
    try {
      expect(applyThemeTokenEdit(root, '--color-zzz', 'green')).toEqual({ ok: false, reason: 'unknown-edit' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
