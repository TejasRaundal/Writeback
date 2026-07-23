import { describe, it, expect } from 'vitest'
import { resolveLoc, applyEdit } from '../src/edit'

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
  it('refuses clsx', () => {
    expect(resolveLoc(SRC, BUTTON)).toMatchObject({ classes: null, reason: 'computed-classname' })
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

  it('refuses computed className', () => {
    expect(applyEdit(SRC, BUTTON, op('p', '4'), 'A.tsx')).toEqual({ ok: false, reason: 'computed-classname' })
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
