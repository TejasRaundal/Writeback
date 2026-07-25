import { describe, it, expect } from 'vitest'
import { resolveLoc, applyEdit, applyCallSiteEdit, applyTextEdit, ownClassesAt, type EditHost } from '../src/edit'

/**
 * In-memory stand-in for the bridge's real host (src/imports.ts): relative specifiers
 * only, with the same .ts/.tsx/.js/.jsx + /index.* resolution. Keeps the cross-file tests
 * pure, exactly like the rest of edit.test.ts; the fs/confinement half is covered in
 * imports.test.ts.
 */
const memHost = (files: Record<string, string>): EditHost => ({
  resolve: (spec, fromFile) => {
    if (!spec.startsWith('.')) return null // bare / node_modules — the bridge refuses these
    const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
    const out: string[] = []
    for (const p of (dir ? dir + '/' + spec : spec).split('/')) {
      if (p === '' || p === '.') continue
      if (p === '..') out.pop()
      else out.push(p)
    }
    const base = out.join('/')
    const exts = ['.ts', '.tsx', '.js', '.jsx']
    for (const c of [base, ...exts.map((e) => base + e), ...exts.map((e) => base + '/index' + e)]) {
      if (c in files) return { file: c, source: files[c] }
    }
    return null
  },
})

const SRC = `import clsx from 'clsx'
export function A({ on }: { on: boolean }) {
  return (
    <div className="p-4 bg-slate-900">
      <span className="text-sm">a</span><span className="text-sm text-red-500">b</span>
      <button className={clsx('p-2', on && 'bg-blue-500')}>c</button>
      <p className={\`p-2 text-xs\`}>d</p>
      <i>no classes</i>
    </div>
  )
}
`

// locs are the JSXOpeningElement start positions (1-based line, 0-based col)
const DIV = { file: 'A.tsx', line: 4, col: 4 }
const SPAN2 = { file: 'A.tsx', line: 5, col: 40 }
const BUTTON = { file: 'A.tsx', line: 6, col: 6 }
const TPL = { file: 'A.tsx', line: 7, col: 6 }
const NOCLASS = { file: 'A.tsx', line: 8, col: 6 }

describe('resolveLoc', () => {
  it('resolves a static className', () => {
    expect(resolveLoc(SRC, DIV)).toMatchObject({ classes: ['p-4', 'bg-slate-900'] })
  })
  it('exact col matters: second element on the line', () => {
    expect(resolveLoc(SRC, SPAN2)).toMatchObject({ classes: ['text-sm', 'text-red-500'] })
  })
  it('resolves the static clsx arg alongside a conditional branch (Feature 1)', () => {
    // clsx('p-2', on && 'bg-blue-500') — 'p-2' is editable; the &&-branch is read-only
    expect(resolveLoc(SRC, BUTTON)).toMatchObject({ classes: ['p-2'] })
  })
  it('template literal without expressions is editable', () => {
    expect(resolveLoc(SRC, TPL)).toMatchObject({ classes: ['p-2', 'text-xs'] })
  })
  it('no className', () => {
    expect(resolveLoc(SRC, NOCLASS)).toMatchObject({ classes: null, reason: 'no-classname' })
  })

  it('column-tolerant: a bare line number resolves when one element is on that line', () => {
    // div is line 4; pass col 0 (as if from a grep) — should still resolve and echo the real col
    const r = resolveLoc(SRC, { file: 'A.tsx', line: 4, col: 0 })
    expect(r.classes).toEqual(['p-4', 'bg-slate-900'])
    expect(r.loc).toEqual({ file: 'A.tsx', line: 4, col: 4 }) // echoes the element's true column
  })

  it('column-tolerant: an ambiguous line (two elements) still needs an exact col', () => {
    // line 5 has two spans — a bare col 0 can't disambiguate
    expect(resolveLoc(SRC, { file: 'A.tsx', line: 5, col: 0 }).classes).toBeNull()
    // but the exact col resolves the right one
    expect(resolveLoc(SRC, SPAN2).classes).toEqual(['text-sm', 'text-red-500'])
  })
})

describe('applyEdit', () => {
  const op = (group: any, value: string) => ({ kind: 'tw' as const, group, variants: [], value })

  it('round-trips a padding edit with a diff', () => {
    const r = applyEdit(SRC, DIV, op('p', '6'), 'A.tsx')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.code).toContain(`<div className="p-6 bg-slate-900">`)
    expect(r.diff).toContain('-    <div className="p-4 bg-slate-900">')
    expect(r.diff).toContain('+    <div className="p-6 bg-slate-900">')
    // rest of file untouched
    expect(r.code.replace('p-6 bg-slate-900', 'p-4 bg-slate-900')).toBe(SRC)
  })

  it('edits the exact element when two share a line', () => {
    const r = applyEdit(SRC, SPAN2, op('text', 'blue-500'), 'A.tsx')
    expect(r.ok && r.code).toContain(`<span className="text-sm text-blue-500">b</span>`)
    expect(r.ok && r.code).toContain(`<span className="text-sm">a</span>`)
  })

  it('edits the static clsx arg when the group is not in a conditional branch (Feature 1)', () => {
    // clsx('p-2', on && 'bg-blue-500') — p is static/editable, bg lives in the branch
    const r = applyEdit(SRC, BUTTON, op('p', '4'), 'A.tsx')
    expect(r.ok && r.code).toContain(`clsx('p-4', on && 'bg-blue-500')`)
  })

  it('refuses an edit to a group that appears in a conditional branch (Feature 1)', () => {
    // editing bg would fight the runtime-dynamic `on && 'bg-blue-500'` branch
    expect(applyEdit(SRC, BUTTON, op('bg', 'red-500'), 'A.tsx')).toEqual({ ok: false, reason: 'locked-group' })
  })

  it('does not destroy a text-align class when editing text color', () => {
    const src = `const T = () => <p className="flex text-center text-slate-400">x</p>\n`
    const r = applyEdit(src, { file: 'T.tsx', line: 1, col: 16 }, op('text', 'red-500'), 'T.tsx')
    expect(r.ok && r.code).toContain('flex text-center text-red-500')
  })

  it('strips a conflicting duplicate from a sibling clsx arg (no two same-group tokens)', () => {
    const src = `const C = () => <div className={clsx('p-2 flex', 'p-4 gap-2')}>x</div>\n`
    const loc = { file: 'C.tsx', line: 1, col: 16 }
    const r = applyEdit(src, loc, op('p', '8'), 'C.tsx')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // exactly one padding token remains across both args
    expect((r.code.match(/\bp-\d/g) || [])).toEqual(['p-8'])
    expect(r.code).toContain('gap-2') // unrelated tokens untouched
  })

  it('preserves HTML entities in the literal (splices raw source, not cooked value)', () => {
    const src = `const E = () => <a className="p-2" title="a&amp;b">x</a>\n`
    const r = applyEdit(src, { file: 'E.tsx', line: 1, col: 16 }, op('p', '4'), 'E.tsx')
    expect(r.ok && r.code).toContain('title="a&amp;b"')
    expect(r.ok && r.code).toContain('className="p-4"')
  })

  it('emits a diff whose hunk header line counts match the body', () => {
    const src = `const D = () => (\n  <div className="p-4" />\n)\n`
    const r = applyEdit(src, { file: 'D.tsx', line: 2, col: 2 }, op('p', '8'), 'D.tsx')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const header = r.diff.split('\n').find((l) => l.startsWith('@@'))!
    const bodyLines = r.diff.split('\n').filter((l) => /^[ +-]/.test(l) && !l.startsWith('+++') && !l.startsWith('---'))
    const oldCount = bodyLines.filter((l) => l[0] === ' ' || l[0] === '-').length
    const newCount = bodyLines.filter((l) => l[0] === ' ' || l[0] === '+').length
    const m = header.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/)!
    expect(Number(m[2])).toBe(oldCount)
    expect(Number(m[4])).toBe(newCount)
    expect(Number(m[1])).toBe(1) // hunk starts at the leading context line (line 1)
  })

  it('edits inside static clsx string args (M4)', () => {
    const src = `const X = () => <div className={clsx('p-2 flex', 'text-sm')}>x</div>\n`
    const loc = { file: 'X.tsx', line: 1, col: 16 }
    expect(resolveLoc(src, loc)).toMatchObject({ classes: ['p-2', 'flex', 'text-sm'] })
    const r = applyEdit(src, loc, op('p', '6'), 'X.tsx')
    expect(r.ok && r.code).toContain(`clsx('p-6 flex', 'text-sm')`)
    // new group lands in the first (base) arg
    const r2 = applyEdit(src, loc, op('bg', 'red-500'), 'X.tsx')
    expect(r2.ok && r2.code).toContain(`clsx('p-2 flex bg-red-500', 'text-sm')`)
  })

  const CVA_SRC = `import { cva } from 'cva'
const button = cva('rounded-md font-medium', {
  variants: {
    intent: { primary: 'bg-blue-600 text-white', ghost: 'bg-transparent text-slate-300' },
    size: { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2 text-base' },
  },
  defaultVariants: { intent: 'primary', size: 'md' },
})
export const A = () => <button className={button()}>a</button>
export const B = () => <button className={button({ intent: 'ghost', size: 'sm' })}>b</button>
export const C = ({ i }: any) => <button className={button({ intent: i })}>c</button>
`
  const A = { file: 'B.tsx', line: 9, col: 23 }
  const B = { file: 'B.tsx', line: 10, col: 23 }
  const C = { file: 'B.tsx', line: 11, col: 33 }

  it('cva: resolves base + default variant slots (M5)', () => {
    expect(resolveLoc(CVA_SRC, A)).toMatchObject({
      classes: ['rounded-md', 'font-medium', 'bg-blue-600', 'text-white', 'px-4', 'py-2', 'text-base'],
    })
  })
  it('cva: literal call args select the right slots', () => {
    expect(resolveLoc(CVA_SRC, B).classes).toContain('bg-transparent')
    expect(resolveLoc(CVA_SRC, B).classes).toContain('px-3')
  })
  it('cva: edits the active variant slot, not the base', () => {
    const r = applyEdit(CVA_SRC, B, op('px', '6'), 'B.tsx')
    expect(r.ok && r.code).toContain(`sm: 'px-6 py-1.5 text-sm'`)
    expect(r.ok && r.code).toContain(`md: 'px-4 py-2 text-base'`) // other slot untouched
  })
  it('cva: new groups land in the base string', () => {
    const r = applyEdit(CVA_SRC, A, op('gap', '2'), 'B.tsx')
    expect(r.ok && r.code).toContain(`cva('rounded-md font-medium gap-2'`)
  })
  it('cva: dynamic variant args are refused', () => {
    expect(resolveLoc(CVA_SRC, C)).toMatchObject({ classes: null, reason: 'computed-classname' })
  })

  it('edits a no-expression template literal', () => {
    const r = applyEdit(SRC, TPL, op('p', '8'), 'A.tsx')
    expect(r.ok && r.code).toContain('`p-8 text-xs`')
  })
})

describe('conditional-clsx static-part editing (Feature 1)', () => {
  const op = (group: any, value: string) => ({ kind: 'tw' as const, group, variants: [], value })
  const loc = { file: 'F.tsx', line: 1, col: 16 }

  it('resolves only the static literal args (ternary branches stay read-only)', () => {
    const src = `const F = () => <div className={clsx('p-2 flex', a ? 'bg-red-500' : 'bg-blue-500')}>x</div>\n`
    // branch colors are NOT surfaced as editable classes
    expect(resolveLoc(src, loc)).toMatchObject({ classes: ['p-2', 'flex'] })
  })

  it('edits a static group and leaves the conditional untouched', () => {
    const src = `const F = () => <div className={clsx('p-2 flex', a ? 'bg-red-500' : 'bg-blue-500')}>x</div>\n`
    const r = applyEdit(src, loc, op('p', '8'), 'F.tsx')
    expect(r.ok && r.code).toContain(`clsx('p-8 flex', a ? 'bg-red-500' : 'bg-blue-500')`)
  })

  it('refuses a group present in EITHER ternary branch', () => {
    const src = `const F = () => <div className={clsx('p-2 flex', a ? 'bg-red-500' : 'bg-blue-500')}>x</div>\n`
    expect(applyEdit(src, loc, op('bg', 'green-500'), 'F.tsx')).toEqual({ ok: false, reason: 'locked-group' })
  })

  it('locks a group that appears in only one branch (&& logical)', () => {
    const src = `const F = () => <div className={clsx('p-2', a && 'text-red-500')}>x</div>\n`
    // text (color) is locked by the && branch; editing text color must refuse
    expect(applyEdit(src, loc, op('text', 'blue-500'), 'F.tsx')).toEqual({ ok: false, reason: 'locked-group' })
    // but an unrelated static group edits fine
    const r = applyEdit(src, loc, op('p', '4'), 'F.tsx')
    expect(r.ok && r.code).toContain(`clsx('p-4', a && 'text-red-500')`)
  })

  it('handles nested conditionals whose leaves are all literals', () => {
    const src = `const F = () => <div className={clsx('p-2', a ? 'bg-red-500' : b ? 'bg-green-500' : 'bg-blue-500')}>x</div>\n`
    expect(resolveLoc(src, loc)).toMatchObject({ classes: ['p-2'] })
    // every nested-branch bg is locked
    expect(applyEdit(src, loc, op('bg', 'amber-500'), 'F.tsx')).toEqual({ ok: false, reason: 'locked-group' })
    // padding still editable
    expect((applyEdit(src, loc, op('p', '6'), 'F.tsx') as any).code).toContain(`clsx('p-6'`)
  })

  it('a new group edit lands in the first static segment when unlocked', () => {
    const src = `const F = () => <div className={clsx('p-2', a && 'text-red-500')}>x</div>\n`
    const r = applyEdit(src, loc, op('gap', '4'), 'F.tsx')
    expect(r.ok && r.code).toContain(`clsx('p-2 gap-4', a && 'text-red-500')`)
  })

  it('still refuses the whole element when any arg is not a literal or all-literal conditional', () => {
    const src = "const F = () => <div className={clsx('p-2', `bg-${a}`)}>x</div>\n"
    expect(resolveLoc(src, loc)).toMatchObject({ classes: null, reason: 'computed-classname' })
    expect(applyEdit(src, loc, op('p', '4'), 'F.tsx')).toEqual({ ok: false, reason: 'computed-classname' })
  })

  it('refuses when there is no static literal arg at all (fully conditional)', () => {
    const src = `const F = () => <div className={clsx(a ? 'p-2' : 'p-4')}>x</div>\n`
    expect(resolveLoc(src, loc)).toMatchObject({ classes: null, reason: 'computed-classname' })
  })

  it('surfaces locked groups at RESOLVE time, so a client never offers a doomed edit', () => {
    const src = `const F = () => <div className={clsx('p-2 flex', a ? 'bg-red-500 text-white' : 'bg-blue-500 text-black')}>x</div>\n`
    const r = resolveLoc(src, loc) as any
    expect(r.classes).toEqual(['p-2', 'flex'])
    expect(r.locked.sort()).toEqual(['bg', 'text'])
    // and the write-time refusal names the same condition, distinctly from "not editable"
    expect(applyEdit(src, loc, op('bg', 'green-500'), 'F.tsx')).toEqual({ ok: false, reason: 'locked-group' })
  })

  it('no `locked` key at all when nothing is conditional', () => {
    const src = `const F = () => <div className={clsx('p-2 flex')}>x</div>\n`
    expect(resolveLoc(src, loc)).not.toHaveProperty('locked')
  })

  it('locks a group an AMBIGUOUS branch token could occupy (arbitrary value)', () => {
    // text-[20px] is a font-SIZE or a colour — parseToken declines to say, so both groups
    // are locked. Editing text-size here would be silently overridden whenever big is true.
    const src = `const F = () => <div className={clsx('text-sm p-2', big && 'text-[20px]')}>x</div>\n`
    expect((resolveLoc(src, loc) as any).locked.sort()).toEqual(['text', 'text-size'])
    expect(applyEdit(src, loc, op('text-size', 'lg'), 'F.tsx')).toEqual({ ok: false, reason: 'locked-group' })
    expect(applyEdit(src, loc, op('text', 'red-500'), 'F.tsx')).toEqual({ ok: false, reason: 'locked-group' })
    // an unrelated group is still editable
    expect((applyEdit(src, loc, op('p', '4'), 'F.tsx') as any).code).toContain(`'text-sm p-4'`)
  })

  it('a definitively non-conflicting branch token locks nothing', () => {
    // text-center is alignment, not size/colour — it must not lock the text groups
    const src = `const F = () => <div className={clsx('text-sm p-2', a && 'text-center')}>x</div>\n`
    expect(resolveLoc(src, loc)).not.toHaveProperty('locked')
    expect((applyEdit(src, loc, op('text-size', 'lg'), 'F.tsx') as any).code).toContain(`'text-lg p-2'`)
  })

  it('refuses the common object/logical clsx arg forms rather than guessing', () => {
    for (const arg of ["{ 'p-2': cond }", "cond || 'p-2'", "cond ?? 'p-2'", 'other']) {
      const src = `const F = () => <div className={clsx('m-2', ${arg})}>x</div>\n`
      expect(resolveLoc(src, loc)).toMatchObject({ classes: null, reason: 'computed-classname' })
      expect(applyEdit(src, loc, op('m', '4'), 'F.tsx')).toEqual({ ok: false, reason: 'computed-classname' })
    }
  })

  it('conflict-strips across static segments only, never the conditional branch', () => {
    const src = `const F = () => <div className={clsx('p-2', 'p-4', a && 'text-red-500')}>x</div>\n`
    const r = applyEdit(src, loc, op('p', '8'), 'F.tsx')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.code.match(/\bp-\d/g) || [])).toEqual(['p-8']) // one padding across static args
    expect(r.code).toContain(`a && 'text-red-500'`) // branch untouched
  })
})

describe('cross-file cva resolution (Feature 2)', () => {
  const op = (group: any, value: string) => ({ kind: 'tw' as const, group, variants: [], value })

  const DEF = `import { cva } from 'cva'
export const button = cva('rounded-md font-medium', {
  variants: {
    size: { sm: 'px-3 py-1.5', md: 'px-4 py-2' },
  },
  defaultVariants: { size: 'md' },
})
`
  const CALL = `import { button } from './ui/button'
export const A = () => (
  <button className={button()}>a</button>
)
`
  const CALL_SM = CALL.replace('button()', "button({ size: 'sm' })")
  const APP = { file: 'src/App.tsx', line: 3, col: 2 }
  const host = () => memHost({ 'src/ui/button.ts': DEF })

  it('resolves a cva imported from another file', () => {
    expect(resolveLoc(CALL, APP, host())).toMatchObject({
      classes: ['rounded-md', 'font-medium', 'px-4', 'py-2'],
      editFile: 'src/ui/button.ts',
    })
  })

  it('surfaces the definition file + its source so the caller hashes the right file', () => {
    const r = resolveLoc(CALL, APP, host()) as any
    expect(r.editFile).toBe('src/ui/button.ts')
    expect(r.editSource).toBe(DEF) // hash must be of the DEFINITION file, not the call site
    expect(r.loc).toEqual(APP) // the echoed element loc stays the call site (for the follow-up edit)
  })

  it('the edit lands in the DEFINING file, not the call site', () => {
    const r = applyEdit(CALL, APP, op('p', '8'), 'src/App.tsx', host())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.file).toBe('src/ui/button.ts')
    expect(r.preSource).toBe(DEF)
    expect(r.code).toContain(`cva('rounded-md font-medium p-8'`)
    expect(r.code).not.toContain('<button') // the returned code IS the def file
    expect(r.diff).toContain('--- a/src/ui/button.ts')
    expect(r.diff).toContain('+++ b/src/ui/button.ts')
    // reverting the one changed literal reproduces the def file byte-for-byte
    expect(r.code.replace('rounded-md font-medium p-8', 'rounded-md font-medium')).toBe(DEF)
  })

  it('echoes the ELEMENT loc, not the cva definition site, so the reply is chainable', () => {
    // a cva( call is not a JSXOpeningElement — echoing its position would hand back a loc
    // that every follow-up resolve/edit refuses with a misleading computed-classname
    const r = applyEdit(CALL, APP, op('p', '8'), 'src/App.tsx', host())
    expect(r.ok && r.loc).toEqual(APP)
    expect(r.ok && r.file).toBe('src/ui/button.ts') // the write target is still the def file
    // and the echoed loc really does resolve again, against the (unchanged) call site
    expect(resolveLoc(CALL, (r as any).loc, host()).classes).toBeTruthy()
  })

  it('edits the active variant slot across files (call-arg selected)', () => {
    const r = applyEdit(CALL_SM, APP, op('px', '6'), 'src/App.tsx', host())
    expect(r.ok && r.code).toContain(`sm: 'px-6 py-1.5'`)
    expect(r.ok && r.code).toContain(`md: 'px-4 py-2'`) // other slot untouched
  })

  it('conflict-strips across base and slot in the definition file', () => {
    // px lives only in the slots; editing it must not leave a duplicate anywhere
    const r = applyEdit(CALL_SM, APP, op('px', '6'), 'src/App.tsx', host())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.code.match(/\bpx-[\d.]+/g) || [])).toEqual(['px-6', 'px-4'])
  })

  it('follows a default export', () => {
    const def = `import { cva } from 'cva'\nexport default cva('rounded-md', {})\n`
    const call = `import button from './ui/button'\nexport const A = () => (\n  <button className={button()}>a</button>\n)\n`
    const h = memHost({ 'src/ui/button.ts': def })
    expect(resolveLoc(call, APP, h)).toMatchObject({ classes: ['rounded-md'], editFile: 'src/ui/button.ts' })
  })

  it('follows a default export that names a local declarator', () => {
    const def = `import { cva } from 'cva'\nconst button = cva('rounded-md', {})\nexport default button\n`
    const call = `import btn from './ui/button'\nexport const A = () => (\n  <button className={btn()}>a</button>\n)\n`
    expect(resolveLoc(call, APP, memHost({ 'src/ui/button.ts': def }))).toMatchObject({ classes: ['rounded-md'] })
  })

  it('follows `export { x }` where x is declared bare in the same file', () => {
    const def = `import { cva } from 'cva'\nconst button = cva('rounded-md', {})\nexport { button }\n`
    expect(resolveLoc(CALL, APP, memHost({ 'src/ui/button.ts': def }))).toMatchObject({ classes: ['rounded-md'] })
  })

  it('follows a locally-aliased named export (`export { base as button }`)', () => {
    const def = `import { cva } from 'cva'\nconst base = cva('rounded-md', {})\nexport { base as button }\n`
    expect(resolveLoc(CALL, APP, memHost({ 'src/ui/button.ts': def }))).toMatchObject({ classes: ['rounded-md'] })
  })

  it('follows an import alias at the call site', () => {
    const call = `import { button as btn } from './ui/button'\nexport const A = () => (\n  <button className={btn()}>a</button>\n)\n`
    expect(resolveLoc(call, APP, host())).toMatchObject({ classes: ['rounded-md', 'font-medium', 'px-4', 'py-2'] })
  })

  it('resolves through a directory index barrel', () => {
    const call = `import { button } from './ui'\nexport const A = () => (\n  <button className={button()}>a</button>\n)\n`
    const h = memHost({ 'src/ui/index.ts': `export { button } from './button'\n`, 'src/ui/button.ts': DEF })
    const r = applyEdit(call, APP, op('p', '8'), 'src/App.tsx', h)
    // one re-export hop is allowed, and the write still lands at the definition
    expect(r.ok && r.file).toBe('src/ui/button.ts')
    expect(r.ok && r.code).toContain(`font-medium p-8`)
  })

  it('follows `export * from` re-exports', () => {
    const call = `import { button } from './ui'\nexport const A = () => (\n  <button className={button()}>a</button>\n)\n`
    const h = memHost({ 'src/ui/index.ts': `export * from './button'\n`, 'src/ui/button.ts': DEF })
    expect(resolveLoc(call, APP, h)).toMatchObject({ editFile: 'src/ui/button.ts' })
  })

  it('refuses a re-export chain longer than 2 hops', () => {
    const call = `import { button } from './ui'\nexport const A = () => (\n  <button className={button()}>a</button>\n)\n`
    const h = memHost({
      'src/ui/index.ts': `export { button } from './internal'\n`,
      'src/ui/internal.ts': `export { button } from './button'\n`,
      'src/ui/button.ts': DEF,
    })
    expect(resolveLoc(call, APP, h)).toMatchObject({ classes: null, reason: 'computed-classname' })
    expect(applyEdit(call, APP, op('p', '8'), 'src/App.tsx', h)).toEqual({ ok: false, reason: 'computed-classname' })
  })

  it('refuses a bare / node_modules specifier', () => {
    const call = `import { button } from '@acme/ui'\nexport const A = () => (\n  <button className={button()}>a</button>\n)\n`
    // host returns null for anything non-relative — nothing outside the project is ever read
    expect(resolveLoc(call, APP, memHost({ 'src/ui/button.ts': DEF }))).toMatchObject({
      classes: null,
      reason: 'computed-classname',
    })
  })

  it('refuses when the imported module cannot be resolved', () => {
    expect(resolveLoc(CALL, APP, memHost({}))).toMatchObject({ classes: null, reason: 'computed-classname' })
  })

  it('refuses when no host is supplied at all (same-file behaviour unchanged)', () => {
    expect(resolveLoc(CALL, APP)).toMatchObject({ classes: null, reason: 'computed-classname' })
  })

  it('refuses when the imported binding is not a cva', () => {
    const def = `export const button = (x) => 'p-2'\n`
    expect(resolveLoc(CALL, APP, memHost({ 'src/ui/button.ts': def }))).toMatchObject({ classes: null })
  })

  it('refuses a non-literal base in the definition file', () => {
    const def = "import { cva } from 'cva'\nexport const button = cva(`rounded-${x}`, {})\n"
    expect(resolveLoc(CALL, APP, memHost({ 'src/ui/button.ts': def }))).toMatchObject({ classes: null })
  })

  it('refuses a dynamic variant arg at the call site even when the def resolves', () => {
    const call = `import { button } from './ui/button'\nexport const A = ({ s }: any) => (\n  <button className={button({ size: s })}>a</button>\n)\n`
    expect(resolveLoc(call, APP, host())).toMatchObject({ classes: null, reason: 'computed-classname' })
  })

  it('refuses when the definition file does not parse', () => {
    expect(resolveLoc(CALL, APP, memHost({ 'src/ui/button.ts': 'export const button = cva(((\n' }))).toMatchObject({
      classes: null,
    })
  })

  it('a same-file cva wins over an equally-named import', () => {
    const call = `import { button } from './ui/button'
const button2 = 0
const localButton = cva('local-base', {})
export const A = () => (
  <button className={localButton()}>a</button>
)
`
    const r = applyEdit(call, { file: 'src/App.tsx', line: 5, col: 2 }, op('p', '2'), 'src/App.tsx', host())
    expect(r.ok && r.file).toBe('src/App.tsx') // stays in the call-site file
    expect(r.ok && r.code).toContain(`cva('local-base p-2'`)
  })

  it("the barrel's OWN export shadows its `export *` re-export", () => {
    // ESM: `export const button` in index.ts wins over `export * from './other'`. Resolving
    // the star first would edit a cva the app never renders and leave the real one alone.
    const call = `import { button } from './ui'\nexport const A = () => (\n  <button className={button()}>a</button>\n)\n`
    const h = memHost({
      'src/ui/index.ts': `export * from './other'\nexport const button = cva('px-1 rendered', {})\n`,
      'src/ui/other.ts': `export const button = cva('px-9 shadowed', {})\n`,
    })
    expect(resolveLoc(call, APP, h)).toMatchObject({ classes: ['px-1', 'rendered'], editFile: 'src/ui/index.ts' })
    const r = applyEdit(call, APP, op('px', '4'), 'src/App.tsx', h)
    expect(r.ok && r.file).toBe('src/ui/index.ts')
    expect(r.ok && r.code).toContain(`cva('px-4 rendered'`)
    expect(r.ok && r.code).toContain(`export * from './other'`) // the other file is never touched
  })

  it('a cva in ANOTHER function is out of scope and never hijacks resolution', () => {
    // B's private `chip` must not answer for A's <span>, which uses the import
    const call = `import { chip } from './ui/chip'
export function A() { return <span className={chip()}>a</span> }
export function B() { const chip = cva('px-8 py-8'); return <b className={chip()}>b</b> }
`
    const h = memHost({ 'src/ui/chip.ts': `export const chip = cva('px-1 imported', {})\n` })
    const inA = { file: 'src/App.tsx', line: 2, col: 0 }
    const inB = { file: 'src/App.tsx', line: 3, col: 0 }
    expect(resolveLoc(call, inA, h)).toMatchObject({ classes: ['px-1', 'imported'], editFile: 'src/ui/chip.ts' })
    const r = applyEdit(call, inA, op('px', '4'), 'src/App.tsx', h)
    expect(r.ok && r.file).toBe('src/ui/chip.ts')
    expect(r.ok && r.code).toContain(`cva('px-4 imported'`)
    // B still resolves to its OWN local cva, in the call-site file
    expect(resolveLoc(call, inB, h)).toMatchObject({ classes: ['px-8', 'py-8'] })
    const rb = applyEdit(call, inB, op('px', '4'), 'src/App.tsx', h)
    expect(rb.ok && rb.file).toBe('src/App.tsx')
    expect(rb.ok && rb.code).toContain(`cva('px-4 py-8')`)
  })

  it('two same-named function-scoped cvas do not cross-write', () => {
    const src = `export function A() { const chip = cva('px-1'); return <span className={chip()}>a</span> }
export function B() { const chip = cva('px-9'); return <b className={chip()}>b</b> }
`
    const r = applyEdit(src, { file: 'S.tsx', line: 1, col: 0 }, op('px', '4'), 'S.tsx')
    expect(r.ok && r.code).toContain(`cva('px-4')`)
    expect(r.ok && r.code).toContain(`cva('px-9')`) // B untouched
  })

  it('same-file cva still needs no host (M5 regression guard)', () => {
    const src = `const b = cva('rounded-md', {})\nexport const A = () => (\n  <button className={b()}>a</button>\n)\n`
    expect(resolveLoc(src, APP)).toMatchObject({ classes: ['rounded-md'] })
  })
})

describe('call-site instance editing (Feature 3)', () => {
  const op = (group: any, value: string) => ({ kind: 'tw' as const, group, variants: [], value })

  // a component that forwards className, and one that ignores it
  const CARD = `export function Card({ className, ...rest }: any) {
  return <div className={className} {...rest} />
}
`
  const PLAIN = `export function Plain() {
  return <div className="p-1" />
}
`
  const PAGE = `import { Card } from './ui/card'
import { Plain } from './ui/plain'

export function Page() {
  return (
    <div className="p-4">
      <Card className="p-2 flex">a</Card>
      <Card>b</Card>
      <Card title="x" />
      <Card className={cn('p-2', x)}>d</Card>
      <Plain className="p-2">e</Plain>
    </div>
  )
}
`
  const STATIC = { file: 'src/Page.tsx', line: 7, col: 6 }
  const BARE = { file: 'src/Page.tsx', line: 8, col: 6 }
  const ATTRS = { file: 'src/Page.tsx', line: 9, col: 6 }
  const DYNAMIC = { file: 'src/Page.tsx', line: 10, col: 6 }
  const NOFWD = { file: 'src/Page.tsx', line: 11, col: 6 }
  const HOST = { file: 'src/Page.tsx', line: 6, col: 4 }
  const host = () => memHost({ 'src/ui/card.tsx': CARD, 'src/ui/plain.tsx': PLAIN })

  it('edits the usage own static className, in the CALL-SITE file', () => {
    const r = applyCallSiteEdit(PAGE, STATIC, op('p', '8'), 'src/Page.tsx', host())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.code).toContain(`<Card className="p-8 flex">a</Card>`)
    expect(r.file).toBe('src/Page.tsx') // never the component definition
    expect(r.preSource).toBe(PAGE)
    expect(r.diff).toContain('--- a/src/Page.tsx')
    expect(r.loc).toEqual(STATIC)
    // nothing else in the file moved
    expect(r.code.replace('p-8 flex', 'p-2 flex')).toBe(PAGE)
  })

  it('replaces within the conflict group at the call site (no duplicate padding)', () => {
    const r = applyCallSiteEdit(PAGE, STATIC, op('p', '8'), 'src/Page.tsx', host())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const line = r.code.split('\n')[STATIC.line - 1]
    expect(line).toContain('className="p-8 flex"')
    expect(line.match(/\bp-\d\b/g)).toEqual(['p-8']) // replaced p-2, not appended alongside it
  })

  it('appends a NEW className attribute when the usage has none', () => {
    const r = applyCallSiteEdit(PAGE, BARE, op('p', '8'), 'src/Page.tsx', host())
    expect(r.ok && r.code).toContain(`<Card className="p-8">b</Card>`)
  })

  it('appends after the last existing attribute (self-closing usage)', () => {
    const r = applyCallSiteEdit(PAGE, ATTRS, op('bg', 'red-500'), 'src/Page.tsx', host())
    expect(r.ok && r.code).toContain(`<Card title="x" className="bg-red-500" />`)
  })

  it('refuses a computed className at the call site', () => {
    expect(applyCallSiteEdit(PAGE, DYNAMIC, op('p', '8'), 'src/Page.tsx', host())).toEqual({
      ok: false,
      reason: 'computed-classname',
    })
  })

  it('refuses when the component does not forward className', () => {
    // <Plain className="p-2"> would be silently swallowed by Plain — refuse, don't pretend
    expect(applyCallSiteEdit(PAGE, NOFWD, op('p', '8'), 'src/Page.tsx', host())).toEqual({
      ok: false,
      reason: 'not-forwarded',
    })
  })

  it('refuses when forwarding cannot be proven (no host to read the definition)', () => {
    expect(applyCallSiteEdit(PAGE, STATIC, op('p', '8'), 'src/Page.tsx')).toEqual({
      ok: false,
      reason: 'not-forwarded',
    })
  })

  it('refuses a host element — call-site edits are for components only', () => {
    expect(applyCallSiteEdit(PAGE, HOST, op('p', '8'), 'src/Page.tsx', host())).toEqual({
      ok: false,
      reason: 'unknown-edit',
    })
  })

  it('refuses a stale/ambiguous loc', () => {
    expect(applyCallSiteEdit(PAGE, { file: 'src/Page.tsx', line: 99, col: 0 }, op('p', '8'), 'src/Page.tsx', host())).toEqual({
      ok: false,
      reason: 'computed-classname',
    })
  })

  it('accepts a component defined in the call-site file itself (no host needed)', () => {
    const src = `export function Card({ className }: any) {
  return <div className={className} />
}
export function Page() {
  return <Card className="p-2" />
}
`
    const r = applyCallSiteEdit(src, { file: 'src/Page.tsx', line: 5, col: 9 }, op('p', '6'), 'src/Page.tsx')
    expect(r.ok && r.code).toContain(`<Card className="p-6" />`)
    expect(r.ok && r.code).toContain(`export function Card({ className }: any) {`) // definition untouched
  })

  it('resolves the component through a directory index barrel', () => {
    const h = memHost({ 'src/ui/index.ts': `export { Card } from './card'\n`, 'src/ui/card.tsx': CARD })
    const page = `import { Card } from './ui'\nexport const P = () => (\n  <Card className="p-2" />\n)\n`
    const r = applyCallSiteEdit(page, { file: 'src/Page.tsx', line: 3, col: 2 }, op('p', '8'), 'src/Page.tsx', h)
    expect(r.ok && r.code).toContain(`<Card className="p-8" />`)
  })

  it('resolves the component through `export * from` and a local alias', () => {
    const h = memHost({
      'src/ui/index.ts': `export * from './card'\n`,
      'src/ui/card.tsx': `${CARD}export { Card as Panel }\n`,
    })
    const page = `import { Panel } from './ui'\nexport const P = () => (\n  <Panel className="p-2" />\n)\n`
    const r = applyCallSiteEdit(page, { file: 'src/Page.tsx', line: 3, col: 2 }, op('p', '8'), 'src/Page.tsx', h)
    expect(r.ok && r.code).toContain(`<Panel className="p-8" />`)
  })

  it('resolves a default-exported component', () => {
    const h = memHost({ 'src/ui/card.tsx': `export default function Card({ className }: any) {\n  return <div className={className} />\n}\n` })
    const page = `import Card from './ui/card'\nexport const P = () => (\n  <Card />\n)\n`
    const r = applyCallSiteEdit(page, { file: 'src/Page.tsx', line: 3, col: 2 }, op('gap', '4'), 'src/Page.tsx', h)
    expect(r.ok && r.code).toContain(`<Card className="gap-4" />`)
  })

  it('refuses when the imported component cannot be found', () => {
    const page = `import { Card } from './ui/card'\nexport const P = () => (\n  <Card className="p-2" />\n)\n`
    expect(applyCallSiteEdit(page, { file: 'src/Page.tsx', line: 3, col: 2 }, op('p', '8'), 'src/Page.tsx', memHost({}))).toEqual({
      ok: false,
      reason: 'not-forwarded',
    })
  })

  it('edits an expression-free template-literal className', () => {
    const page = "import { Card } from './ui/card'\nexport const P = () => (\n  <Card className={`p-2 flex`} />\n)\n"
    const r = applyCallSiteEdit(page, { file: 'src/Page.tsx', line: 3, col: 2 }, op('p', '8'), 'src/Page.tsx', host())
    expect(r.ok && r.code).toContain('`p-8 flex`')
  })

  // the gate authorises a source write, so it must be an AST link from a className prop
  // binding to rendered markup — not the presence of the word "className" in the file
  describe('the forwarding gate', () => {
    const usage = (imp: string) => `import { W } from './ui/w'\nexport const P = () => (\n  <W>hi</W>\n)\n${imp}`
    const at = { file: 'src/Page.tsx', line: 3, col: 2 }
    const gate = (def: string) => applyCallSiteEdit(usage(''), at, op('px', '4'), 'src/Page.tsx', memHost({ 'src/ui/w.tsx': def }))

    it('refuses a component that merely MENTIONS className in an unrelated object', () => {
      expect(gate(`export function W() {\n  const o = { className: 'x' }\n  return <span className="px-2">{o.className}</span>\n}\n`)).toEqual({
        ok: false,
        reason: 'not-forwarded',
      })
    })

    it('refuses a props spread onto a NESTED child (the class would land on the wrong node)', () => {
      expect(gate(`export function W(props: any) {\n  return <span className="px-2"><input {...props} /></span>\n}\n`)).toEqual({
        ok: false,
        reason: 'not-forwarded',
      })
    })

    it('refuses a component that takes a className prop but never renders it', () => {
      expect(gate(`export function W({ className }: any) {\n  return <span className="px-2" title={className} />\n}\n`)).toEqual({
        ok: false,
        reason: 'not-forwarded',
      })
    })

    it('accepts a props spread onto the ROOT element', () => {
      const r = gate(`export function W(props: any) {\n  return <div {...props} />\n}\n`)
      expect(r.ok && r.code).toContain('<W className="px-4">hi</W>')
    })

    it('accepts `props.className` composed into the root className', () => {
      const r = gate(`export function W(props: any) {\n  return <div className={cn('a', props.className)} />\n}\n`)
      expect(r.ok && r.code).toContain('<W className="px-4">hi</W>')
    })

    it('accepts a defaulted destructured className', () => {
      const r = gate(`export function W({ className = '' }: any) {\n  return <div className={className} />\n}\n`)
      expect(r.ok && r.code).toContain('<W className="px-4">hi</W>')
    })

    it('refuses a NON-forwarding component declared in the call-site file itself', () => {
      const src = `function W() {\n  return <span className="px-2" />\n}\nexport const P = () => (\n  <W>hi</W>\n)\n`
      expect(applyCallSiteEdit(src, { file: 'src/Page.tsx', line: 5, col: 2 }, op('px', '4'), 'src/Page.tsx')).toEqual({
        ok: false,
        reason: 'not-forwarded',
      })
    })
  })

  it('warns when the class it writes collides with one the component sets itself', () => {
    // Badge composes with plain clsx: BOTH px classes reach the DOM and stylesheet order —
    // not the order we wrote them in — decides the winner. The write proceeds, loudly.
    const badge = `export function Badge({ className }: any) {\n  return <span className={clsx('rounded-full px-2', className)} />\n}\n`
    const page = `import { Badge } from './ui/badge'\nexport const P = () => (\n  <Badge className="px-3" />\n)\n`
    const at = { file: 'src/Page.tsx', line: 3, col: 2 }
    const r = applyCallSiteEdit(page, at, op('px', '1'), 'src/Page.tsx', memHost({ 'src/ui/badge.tsx': badge }))
    expect(r.ok && r.code).toContain('<Badge className="px-1" />')
    expect(r.ok && r.warn).toContain('px-2')
    // an unrelated group has no conflict, so no warning
    const r2 = applyCallSiteEdit(page, at, op('gap', '2'), 'src/Page.tsx', memHost({ 'src/ui/badge.tsx': badge }))
    expect(r2.ok && r2.warn).toBeUndefined()
  })

  it('does not warn when the component merges classes (twMerge settles the conflict)', () => {
    const badge = `import { twMerge } from 'tailwind-merge'\nexport function Badge({ className }: any) {\n  return <span className={twMerge('px-2', className)} />\n}\n`
    const page = `import { Badge } from './ui/badge'\nexport const P = () => (\n  <Badge className="px-3" />\n)\n`
    const r = applyCallSiteEdit(page, { file: 'src/Page.tsx', line: 3, col: 2 }, op('px', '1'), 'src/Page.tsx', memHost({ 'src/ui/badge.tsx': badge }))
    expect(r.ok).toBe(true)
    expect(r.ok && r.warn).toBeUndefined()
  })

  it('appends the new attribute after a spread, not into it', () => {
    const page = `import { Card } from './ui/card'\nexport const P = () => (\n  <Card {...rest} />\n)\n`
    const r = applyCallSiteEdit(page, { file: 'src/Page.tsx', line: 3, col: 2 }, op('p', '8'), 'src/Page.tsx', host())
    expect(r.ok && r.code).toContain('<Card {...rest} className="p-8" />')
  })

  it('the DEFAULT target refuses a component usage that does not forward, too', () => {
    // omitting target:'callsite' must not be a way around the gate — applyEdit reaches the
    // same attribute, and a class Plain never reads is still a silent no-op in the browser
    expect(applyEdit(PAGE, NOFWD, op('p', '8'), 'src/Page.tsx', host())).toEqual({
      ok: false,
      reason: 'not-forwarded',
    })
  })

  it('the ordinary path is unchanged: the same loc still edits what the element renders', () => {
    // sanity — target:'callsite' is opt-in; applyEdit on a component usage keeps its old behaviour
    const r = applyEdit(PAGE, STATIC, op('p', '8'), 'src/Page.tsx', host())
    expect(r.ok && r.code).toContain(`<Card className="p-8 flex">a</Card>`)
    expect(r.ok && r.file).toBe('src/Page.tsx')
  })
})

describe('text editing', () => {
  const T = [
    `export const A = ({ on }: any) => (`,
    `  <div className="p-2">`,
    `    <h1 className="text-xl">Hello</h1>`,
    `    <p className="m-1">Fish &amp; Chips</p>`,
    `    <span className={clsx('x', dyn())}>Label</span>`,
    `    <em className="e">{on ? 'a' : 'b'}</em>`,
    `    <div className="mix"><b>x</b> tail</div>`,
    `    <p className="empty"></p>`,
    `    <img className="i" />`,
    `    <h2 className="two">`,
    `      Two line`,
    `    </h2>`,
    `  </div>`,
    `)`,
  ].join('\n') + '\n'
  const loc = (line: number) => ({ file: 'src/T.tsx', line, col: 0 })
  const tOp = (value: string) => ({ kind: 'text' as const, value })

  it('resolve surfaces the text of a single static JSXText child', () => {
    const r: any = resolveLoc(T, loc(3))
    expect(r.classes).toEqual(['text-xl'])
    expect(r.text).toBe('Hello')
  })

  it('text is the RAW slice — HTML entities survive display', () => {
    expect((resolveLoc(T, loc(4)) as any).text).toBe('Fish &amp; Chips')
  })

  it('a refused (computed-className) element still offers its text', () => {
    const r: any = resolveLoc(T, loc(5))
    expect(r.classes).toBeNull()
    expect(r.reason).toBe('computed-classname')
    expect(r.text).toBe('Label')
  })

  it('expression children, mixed children, containers, and self-closing offer no text', () => {
    expect((resolveLoc(T, loc(6)) as any).text).toBeUndefined() // {on ? 'a' : 'b'}
    expect((resolveLoc(T, loc(7)) as any).text).toBeUndefined() // <b>x</b> tail
    expect((resolveLoc(T, loc(2)) as any).text).toBeUndefined() // element children
    expect((resolveLoc(T, loc(9)) as any).text).toBeUndefined() // <img />
  })

  it('an empty non-self-closing element offers empty text (insertable)', () => {
    expect((resolveLoc(T, loc(8)) as any).text).toBe('')
  })

  it('multi-line text is trimmed to its core', () => {
    expect((resolveLoc(T, loc(10)) as any).text).toBe('Two line')
  })

  it('replaces text and touches nothing else', () => {
    const r = applyTextEdit(T, loc(3), tOp('Goodbye'), 'src/T.tsx')
    if (!r.ok) throw new Error('refused')
    expect(r.code).toBe(T.replace('>Hello<', '>Goodbye<'))
    expect(r.file).toBe('src/T.tsx')
    expect(r.preSource).toBe(T)
    expect(r.diff).toContain('--- a/src/T.tsx')
  })

  it('JSX-special characters are written as a {"…"} expression and still parse', () => {
    const r = applyTextEdit(T, loc(3), tOp('a {b} <c>'), 'src/T.tsx')
    if (!r.ok) throw new Error('refused')
    expect(r.code).toContain('<h1 className="text-xl">{"a {b} <c>"}</h1>')
  })

  it('meaningful leading/trailing whitespace forces the expression form', () => {
    const r = applyTextEdit(T, loc(3), tOp('  padded  '), 'src/T.tsx')
    if (!r.ok) throw new Error('refused')
    expect(r.code).toContain('{"  padded  "}')
  })

  it('inserts into an empty element', () => {
    const r = applyTextEdit(T, loc(8), tOp('hi'), 'src/T.tsx')
    if (!r.ok) throw new Error('refused')
    expect(r.code).toContain('<p className="empty">hi</p>')
  })

  it('multi-line text replacement keeps the surrounding indentation', () => {
    const r = applyTextEdit(T, loc(10), tOp('One line'), 'src/T.tsx')
    if (!r.ok) throw new Error('refused')
    expect(r.code).toContain('      One line\n    </h2>')
  })

  it('refuses elements with no safely editable text', () => {
    for (const line of [6, 7, 9]) {
      const r = applyTextEdit(T, loc(line), tOp('x'), 'src/T.tsx')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('unknown-edit')
    }
  })
})

/**
 * Feature A: the panel's variant-chain selector emits ops with `variants: ['hover'|'md'|…]`.
 * The engine already keyed conflict groups by (group, chain); these lock in that the WRITE
 * path — segment choice, sibling-segment stripping, cva slots, call sites — is chain-scoped
 * too, and that base-chain behaviour is unchanged when variant tokens sit next to it.
 */
describe('variant-aware editing (Feature A)', () => {
  const vop = (group: any, value: string, variants: string[] = []) => ({ kind: 'tw' as const, group, variants, value })

  const V = `export const V = () => (
  <div>
    <a className="text-slate-400 hover:text-white text-sm">n</a>
    <span className="p-2">s</span>
  </div>
)
`
  const LINK = { file: 'V.tsx', line: 3, col: 4 }
  const SPAN = { file: 'V.tsx', line: 4, col: 4 }

  it('resolve hands back variant tokens as-is (they are ordinary classes)', () => {
    expect(resolveLoc(V, LINK)).toMatchObject({ classes: ['text-slate-400', 'hover:text-white', 'text-sm'] })
  })

  it('replaces the hover token and leaves the base color alone', () => {
    const r = applyEdit(V, LINK, vop('text', 'emerald-300', ['hover']), 'V.tsx')
    expect(r.ok && r.code).toContain('className="text-slate-400 hover:text-emerald-300 text-sm"')
  })

  it('edits the base color without touching the hover token', () => {
    const r = applyEdit(V, LINK, vop('text', 'slate-200'), 'V.tsx')
    expect(r.ok && r.code).toContain('className="text-slate-200 hover:text-white text-sm"')
  })

  it('appends a variant token when the element only has the base one', () => {
    const r = applyEdit(V, SPAN, vop('p', '6', ['md']), 'V.tsx')
    expect(r.ok && r.code).toContain('className="p-2 md:p-6"')
  })

  it('text-size and hover text-color stay in separate groups under a chain', () => {
    const r = applyEdit(V, LINK, vop('text-size', 'lg', ['hover']), 'V.tsx')
    expect(r.ok && r.code).toContain('className="text-slate-400 hover:text-white text-sm hover:text-lg"')
  })

  it('sibling clsx segments are stripped per chain, not per group', () => {
    const src = `const C = () => <div className={clsx('p-2 hover:p-3', 'p-4 hover:p-5')}>x</div>\n`
    const loc = { file: 'C.tsx', line: 1, col: 16 }
    const r = applyEdit(src, loc, vop('p', '8', ['hover']), 'C.tsx')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // exactly one hover padding survives, and BOTH base paddings are untouched
    expect(r.code.match(/hover:p-\d/g)).toEqual(['hover:p-8'])
    expect(r.code.match(/(?<!hover:)\bp-\d/g)).toEqual(['p-2', 'p-4'])
  })

  it('a cva variant slot owning the hover token receives the edit (not the base string)', () => {
    const src = `const button = cva('rounded-md hover:bg-blue-700', {
  variants: { intent: { primary: 'bg-blue-600 hover:bg-blue-500' } },
  defaultVariants: { intent: 'primary' },
})
export const B = () => <button className={button()}>b</button>
`
    const r = applyEdit(src, { file: 'B.tsx', line: 5, col: 23 }, vop('bg', 'sky-400', ['hover']), 'B.tsx')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.code).toContain(`primary: 'bg-blue-600 hover:bg-sky-400'`)
    // the base segment's competing hover token is stripped, so only one can win
    expect(r.code).toContain(`cva('rounded-md', {`)
  })

  it('call-site edits carry the chain too', () => {
    const CARD = `export const Card = ({ className }: any) => <div className={className} />\n`
    const PAGE = `import { Card } from './card'
export const P = () => <Card className="p-2">a</Card>
`
    const host = memHost({ 'card.tsx': CARD })
    const r = applyCallSiteEdit(PAGE, { file: 'P.tsx', line: 2, col: 23 }, vop('p', '6', ['md']), 'P.tsx', host)
    expect(r.ok && r.code).toContain('<Card className="p-2 md:p-6">')
  })

  it('a conditional branch locks its group across EVERY chain (conservative on purpose)', () => {
    // `on && 'hover:bg-blue-500'` can flip at runtime; a static base-bg edit would silently
    // fight it in the same declaration, so the whole bg group refuses — chain or no chain.
    const src = `const C = ({ on }: any) => <div className={clsx('p-2', on && 'hover:bg-blue-500')}>x</div>\n`
    const loc = { file: 'C.tsx', line: 1, col: 26 }
    expect(applyEdit(src, loc, vop('bg', 'red-500', ['hover']), 'C.tsx')).toEqual({ ok: false, reason: 'locked-group' })
    expect(applyEdit(src, loc, vop('bg', 'red-500'), 'C.tsx')).toEqual({ ok: false, reason: 'locked-group' })
  })
})

/**
 * Feature B: the panel's per-instance mode needs the classes a call-site edit can actually
 * WRITE — the usage's own className attribute. `resolveLoc` answers "what does this element
 * render", which for `<Card className={card()} />` is a cva definition in another file; a
 * client that drove its controls from that would show classes its edits never touch.
 * Never a regex over source: same parse → findElement → static-attribute-range path the
 * write takes, so the two can't drift.
 */
describe('own call-site classes (Feature B)', () => {
  const CARD = `export function Card({ className, ...rest }: any) {
  return <div className={className} {...rest} />
}
`
  const PAGE = `import { Card } from './ui/card'
const card = cva('rounded-md p-4')

export function Page() {
  return (
    <div className="p-4">
      <Card className="p-2 flex">a</Card>
      <Card>b</Card>
      <Card title="x" />
      <Card className={cn('p-2', x)}>d</Card>
      <Card className={card()}>e</Card>
      <Card className={\`p-3 gap-2\`}>f</Card>
      <Card className="">g</Card>
    </div>
  )
}
`
  const at = (line: number, col = 6) => ({ file: 'src/Page.tsx', line, col })

  it('reads the tokens on the usage own static className', () => {
    expect(ownClassesAt(PAGE, at(7))).toEqual({ classes: ['p-2', 'flex'] })
  })

  it('an expression-free template literal is as static as a string', () => {
    expect(ownClassesAt(PAGE, at(12))).toEqual({ classes: ['p-3', 'gap-2'] })
  })

  it('no className attribute is EDITABLE-EMPTY, not a refusal — the write appends one', () => {
    // distinct from `null`: the panel offers the full control set and the first edit
    // creates the attribute (the one sanctioned append)
    expect(ownClassesAt(PAGE, at(8))).toEqual({ classes: [] })
    expect(ownClassesAt(PAGE, at(9))).toEqual({ classes: [] }) // other attrs, still no className
    expect(ownClassesAt(PAGE, at(13))).toEqual({ classes: [] }) // className="" — empty, not absent
  })

  it('refuses a computed usage className, exactly where applyCallSiteEdit would', () => {
    expect(ownClassesAt(PAGE, at(10))).toEqual({ classes: null })
    const r = applyCallSiteEdit(PAGE, at(10), { kind: 'tw', group: 'p', variants: [], value: '8' }, 'src/Page.tsx', memHost({ 'src/ui/card.tsx': CARD }))
    expect(r).toEqual({ ok: false, reason: 'computed-classname' })
  })

  it('is NOT the definition classes resolveLoc reports for a cva usage — the point of `own`', () => {
    const loc = at(11)
    // what the element renders: the cva base, which lives at the definition
    expect(resolveLoc(PAGE, loc).classes).toEqual(['rounded-md', 'p-4'])
    // what a per-instance edit could write: nothing — the usage's own value is computed
    expect(ownClassesAt(PAGE, loc)).toEqual({ classes: null })
  })

  it('is null for anything that is not a component usage', () => {
    expect(ownClassesAt(PAGE, { file: 'src/Page.tsx', line: 6, col: 4 })).toBeNull() // host <div>
    expect(ownClassesAt(PAGE, at(99))).toBeNull() // no element on that line
    expect(ownClassesAt('const x = (', at(1))).toBeNull() // unparseable
  })
})

/**
 * Review finding (HIGH): `op.value` / `op.variants` were spliced in unvalidated, and
 * reparse-verify could not see it — the injected result is VALID JavaScript. Both write paths
 * now reject the token on its characters, before any splice.
 */
describe('injected class tokens never reach the splice', () => {
  const bad = (value: string, variants: string[] = []) => ({ kind: 'tw' as const, group: 'p' as const, variants, value })
  const ATTR = `const A = () => <div className="p-4">hi</div>\n`
  const TPL = `const A = () => <div className={\`p-4\`}>hi</div>\n`
  const LOC = { file: 'A.tsx', line: 1, col: 16 }

  it('refuses a value that would close the attribute and add JSX of its own', () => {
    const r = applyEdit(ATTR, LOC, bad('x" onClick={alert(1)} z="'), 'A.tsx')
    expect(r).toEqual({ ok: false, reason: 'off-scale' })
  })

  it('refuses a variant that would turn a static template literal into an expression', () => {
    // the value here is perfectly on-scale: the design-system gate alone would pass this
    const r = applyEdit(TPL, LOC, bad('4', ['${x}']), 'A.tsx')
    expect(r).toEqual({ ok: false, reason: 'off-scale' })
  })

  it('refuses on the call-site path too, where the whole attribute is being written', () => {
    const CARD = `export function Card({ className }: any) { return <div className={className} /> }\n`
    const PAGE = `import { Card } from './ui/card'\nexport const P = () => <Card>x</Card>\n`
    const r = applyCallSiteEdit(PAGE, { file: 'src/Page.tsx', line: 2, col: 23 }, bad('4" onClick={x} y="'), 'src/Page.tsx', memHost({ 'src/ui/card.tsx': CARD }))
    expect(r).toEqual({ ok: false, reason: 'off-scale' })
  })

  it('still accepts the legitimate arbitrary-value escape hatch', () => {
    const r = applyEdit(ATTR, LOC, bad('[17px]'), 'A.tsx')
    expect(r.ok && r.code).toContain('className="p-[17px]"')
  })
})

/** Review finding: a one-token bump reflowed the whole className, rewriting untouched lines. */
describe('a multi-line className keeps its formatting through a splice', () => {
  const SRC = `const A = () => (
  <div
    className={\`
      p-4
      m-2
      text-white
    \`}
  >x</div>
)
`
  const LOC = { file: 'A.tsx', line: 2, col: 2 }

  it('changes only the token that moved', () => {
    const r = applyEdit(SRC, LOC, { kind: 'tw', group: 'p', variants: [], value: '8' }, 'A.tsx')
    expect(r.ok && r.code).toBe(SRC.replace('p-4', 'p-8'))
    expect(r.ok && r.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))).toEqual(['-      p-4'])
  })

  it('appends onto a new line of its own rather than collapsing the list', () => {
    const r = applyEdit(SRC, LOC, { kind: 'tw', group: 'gap', variants: [], value: '2' }, 'A.tsx')
    expect(r.ok && r.code).toBe(SRC.replace('text-white', 'text-white\n      gap-2'))
  })
})

/** Review coverage gap: a variant chain through the cva definition, and through a call site. */
describe('variant chains beyond the base path', () => {
  const vop = (group: any, value: string, variants: string[]) => ({ kind: 'tw' as const, group, variants, value })

  it('replaces an existing hover token inside the active cva slot, in place', () => {
    const UI = `export const btn = cva('rounded-md hover:bg-blue-700', {
  variants: { size: { md: 'px-4 hover:px-5' } },
  defaultVariants: { size: 'md' },
})
`
    const APP = `import { btn } from './ui/btn'\nexport const A = () => <button className={btn()}>x</button>\n`
    const host = memHost({ 'src/ui/btn.ts': UI })
    const loc = { file: 'src/App.tsx', line: 2, col: 23 }
    // the slot owns `hover:px-*`, so the edit lands there and NOT beside the base
    const r = applyEdit(APP, loc, vop('px', '8', ['hover']), 'src/App.tsx', host)
    expect(r.ok && r.file).toBe('src/ui/btn.ts')
    expect(r.ok && r.code).toContain(`md: 'px-4 hover:px-8'`)
    expect(r.ok && r.code).toContain(`cva('rounded-md hover:bg-blue-700'`) // base untouched
    // a chain with no member anywhere appends to the BASE segment
    const r2 = applyEdit(APP, loc, vop('bg', 'black', ['dark']), 'src/App.tsx', host)
    expect(r2.ok && r2.code).toContain(`cva('rounded-md hover:bg-blue-700 dark:bg-black'`)
  })

  it('a reordered chain edits the token that is already there, never a second one', () => {
    const SRC = `const A = () => <div className="hover:md:p-2 flex">x</div>\n`
    const r = applyEdit(SRC, { file: 'A.tsx', line: 1, col: 16 }, vop('p', '8', ['md', 'hover']), 'A.tsx')
    expect(r.ok && r.code).toContain('className="md:hover:p-8 flex"')
    expect((r.ok && r.code.match(/p-\d/g)) || []).toEqual(['p-8'])
  })

  it('carries a chain onto a call site, and warns on a same-chain clash only', () => {
    const CARD = `export function Card({ className }: any) {
  return <div className={clsx('rounded hover:p-1', className)} />
}
`
    const PAGE = `import { Card } from './ui/card'
export const P = () => <Card className="p-2">x</Card>
`
    const host = memHost({ 'src/ui/card.tsx': CARD })
    const loc = { file: 'src/Page.tsx', line: 2, col: 23 }
    const r = applyEdit(PAGE, loc, vop('p', '4', ['hover']), 'src/Page.tsx', host)
    expect(r.ok && r.code).toContain('<Card className="p-2 hover:p-4">')
    expect(r.ok && r.warn).toContain('hover:p-1') // the component's own hover padding clashes
    const other = applyCallSiteEdit(PAGE, loc, vop('gap', '2', ['md']), 'src/Page.tsx', host)
    expect(other.ok && other.code).toContain('<Card className="p-2 md:gap-2">')
    expect(other.ok && other.warn).toBeUndefined() // different chain, different group: no clash
  })
})
