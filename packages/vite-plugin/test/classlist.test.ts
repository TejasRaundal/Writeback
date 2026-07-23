import { describe, it, expect } from 'vitest'
import { applyTokenEdit, parseToken } from '../src/classlist'

describe('parseToken', () => {
  it('spacing groups', () => {
    expect(parseToken('p-4')).toEqual({ group: 'p', variants: [], value: '4' })
    expect(parseToken('px-2')).toEqual({ group: 'px', variants: [], value: '2' })
    expect(parseToken('gap-x-4')).toEqual({ group: 'gap-x', variants: [], value: '4' })
    expect(parseToken('gap-2')).toEqual({ group: 'gap', variants: [], value: '2' })
  })
  it('negative margins', () => {
    expect(parseToken('-mx-2')).toEqual({ group: 'mx', variants: [], value: '-2' })
    expect(parseToken('md:-mt-8')).toEqual({ group: 'mt', variants: ['md'], value: '-8' })
  })
  it('variant chains', () => {
    expect(parseToken('md:px-4')).toEqual({ group: 'px', variants: ['md'], value: '4' })
    expect(parseToken('md:hover:bg-red-500')).toEqual({ group: 'bg', variants: ['md', 'hover'], value: 'red-500' })
  })
  it('text ambiguity: sizes and colors are separate groups', () => {
    expect(parseToken('text-lg')).toEqual({ group: 'text-size', variants: [], value: 'lg' })
    expect(parseToken('text-sm')).toEqual({ group: 'text-size', variants: [], value: 'sm' })
    expect(parseToken('text-red-500')).toEqual({ group: 'text', variants: [], value: 'red-500' })
    expect(parseToken('text-white')).toEqual({ group: 'text', variants: [], value: 'white' })
  })
  it('typography groups', () => {
    expect(parseToken('font-bold')).toEqual({ group: 'font-weight', variants: [], value: 'bold' })
    expect(parseToken('font-mono')).toEqual({ group: 'font-family', variants: [], value: 'mono' })
    expect(parseToken('font-display')).toBeNull() // custom family token — leave alone
    expect(parseToken('tracking-wide')).toEqual({ group: 'tracking', variants: [], value: 'wide' })
    expect(parseToken('leading-tight')).toEqual({ group: 'leading', variants: [], value: 'tight' })
  })
  it('appearance groups', () => {
    expect(parseToken('rounded')).toEqual({ group: 'rounded', variants: [], value: 'DEFAULT' })
    expect(parseToken('rounded-lg')).toEqual({ group: 'rounded', variants: [], value: 'lg' })
    expect(parseToken('rounded-t-xl')).toEqual({ group: 'rounded-t', variants: [], value: 'xl' })
    expect(parseToken('shadow')).toEqual({ group: 'shadow', variants: [], value: 'DEFAULT' })
    expect(parseToken('shadow-md')).toEqual({ group: 'shadow', variants: [], value: 'md' })
    expect(parseToken('shadow-red-500')).toBeNull() // shadow color — leave alone
    expect(parseToken('opacity-50')).toEqual({ group: 'opacity', variants: [], value: '50' })
  })
  it('bg non-color utilities are not the bg group', () => {
    expect(parseToken('bg-cover')).toBeNull()
    expect(parseToken('bg-gradient-to-r')).toBeNull()
    expect(parseToken('bg-blend-multiply')).toBeNull()
    expect(parseToken('bg-opacity-50')).toBeNull()
    expect(parseToken('bg-clip-text')).toBeNull()
    expect(parseToken('bg-none')).toBeNull()
    expect(parseToken('bg-slate-900')).toEqual({ group: 'bg', variants: [], value: 'slate-900' })
  })
  it('text non-color utilities are not the text-color group', () => {
    for (const t of ['text-center', 'text-left', 'text-right', 'text-justify', 'text-wrap', 'text-nowrap', 'text-balance', 'text-pretty', 'text-ellipsis', 'text-clip', 'text-opacity-50']) {
      expect(parseToken(t)).toBeNull()
    }
    expect(parseToken('text-red-500')).toEqual({ group: 'text', variants: [], value: 'red-500' })
  })
  it('arbitrary values', () => {
    expect(parseToken('p-[17px]')).toEqual({ group: 'p', variants: [], value: '[17px]' })
  })
  it('unrelated tokens', () => {
    expect(parseToken('flex')).toBeNull()
    expect(parseToken('items-center')).toBeNull()
  })
})

describe('applyTokenEdit', () => {
  const ed = (group: any, value: string, variants: string[] = []) => ({ group, variants, value })

  it('replaces in place, minimal diff', () => {
    expect(applyTokenEdit('flex p-4 text-sm', ed('p', '6'))).toBe('flex p-6 text-sm')
  })
  it('appends when no group member exists', () => {
    expect(applyTokenEdit('flex text-sm', ed('p', '4'))).toBe('flex text-sm p-4')
  })
  it('appends to empty class string', () => {
    expect(applyTokenEdit('', ed('p', '4'))).toBe('p-4')
  })
  it('removes duplicate group members (never blind-append)', () => {
    expect(applyTokenEdit('p-2 flex p-4', ed('p', '6'))).toBe('p-6 flex')
  })
  it('variant chains are independent groups', () => {
    expect(applyTokenEdit('px-4 md:px-8', ed('px', '2'))).toBe('px-2 md:px-8')
    expect(applyTokenEdit('px-4 md:px-8', ed('px', '2', ['md']))).toBe('px-4 md:px-2')
  })
  it('appends variant token when only base exists', () => {
    expect(applyTokenEdit('px-4', ed('px', '2', ['md']))).toBe('px-4 md:px-2')
  })
  it('negative margin in, negative margin out', () => {
    expect(applyTokenEdit('-mx-2 flex', ed('mx', '-4'))).toBe('-mx-4 flex')
    expect(applyTokenEdit('flex', ed('mx', '-4'))).toBe('flex -mx-4')
  })
  it('replaces pre-existing arbitrary value', () => {
    expect(applyTokenEdit('p-[17px] flex', ed('p', '4'))).toBe('p-4 flex')
  })
  it('writes arbitrary value (escape hatch)', () => {
    expect(applyTokenEdit('p-4 flex', ed('p', '[17px]'))).toBe('p-[17px] flex')
  })
  it('text color replaces color, not size', () => {
    expect(applyTokenEdit('text-sm text-slate-300', ed('text', 'red-500'))).toBe('text-sm text-red-500')
  })
  it('bg color', () => {
    expect(applyTokenEdit('bg-slate-900 p-6', ed('bg', 'slate-800'))).toBe('bg-slate-800 p-6')
  })
  it('px edit does not touch p', () => {
    expect(applyTokenEdit('p-4', ed('px', '2'))).toBe('p-4 px-2')
  })
  it('font-size edit replaces size, not color', () => {
    expect(applyTokenEdit('text-sm text-slate-400', ed('text-size', 'lg'))).toBe('text-lg text-slate-400')
  })
  it('font weight and family are independent despite sharing the font- prefix', () => {
    expect(applyTokenEdit('font-bold font-mono', ed('font-weight', 'medium'))).toBe('font-medium font-mono')
    expect(applyTokenEdit('font-bold font-mono', ed('font-family', 'sans'))).toBe('font-bold font-sans')
  })
  it('rounded DEFAULT builds the bare token', () => {
    expect(applyTokenEdit('rounded-lg p-4', ed('rounded', 'DEFAULT'))).toBe('rounded p-4')
    expect(applyTokenEdit('rounded p-4', ed('rounded', 'xl'))).toBe('rounded-xl p-4')
  })
  it('shadow edit leaves shadow colors alone', () => {
    expect(applyTokenEdit('shadow-md shadow-red-500', ed('shadow', 'xl'))).toBe('shadow-xl shadow-red-500')
  })
})
