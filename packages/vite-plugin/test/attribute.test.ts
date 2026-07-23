import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { callSiteHints, cvaBlast } from '../src/attribute'

const PLAYGROUND = join(__dirname, '..', '..', '..', 'apps', 'playground')

describe('cvaBlast', () => {
  it('lists variant combos from a cva call', () => {
    const src = `
const b = cva('base', { variants: { intent: { primary: 'x', ghost: 'y' }, size: { sm: 'a', md: 'b' } } })
`
    expect(cvaBlast(src)).toEqual(['intent: primary | ghost', 'size: sm | md'])
  })
  it('empty when no cva', () => {
    expect(cvaBlast('const a = 1')).toEqual([])
  })
})

describe('callSiteHints', () => {
  it('finds call sites of the enclosing component', () => {
    // element inside Card (App.tsx) — Card is called 3× with no className prop, so no hints
    // but a component called WITH className should be found; use a synthetic source
    const src = `
export function Chip({ className }: any) {
  return <span className={cn('chip', className)}>x</span>
}
`
    // playground has no <Chip className=...> call sites — expect []
    expect(callSiteHints(PLAYGROUND, src, { file: 'x.tsx', line: 3, col: 9 })).toEqual([])
  })
  it('finds real call sites passing className', () => {
    const FIXTURE = join(__dirname, 'fixture')
    const src = `
export function Chip({ className }: any) {
  return <span className={cn('chip', className)}>x</span>
}
`
    const hints = callSiteHints(FIXTURE, src, { file: 'x.tsx', line: 3, col: 9 })
    expect(hints).toHaveLength(1)
    expect(hints[0].component).toBe('Chip')
    expect(hints[0].loc.file).toBe('src/Page.tsx')
    expect(hints[0].loc.line).toBe(6)
  })
})
