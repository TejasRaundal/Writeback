import { describe, it, expect } from 'vitest'
import { tagSource } from '../src/tag'

describe('tagSource', () => {
  it('stamps host elements with file:line:col', () => {
    const out = tagSource(`export const A = () => <div className="p-4">hi</div>\n`, 'src/A.tsx')
    expect(out).toContain(`<div data-wb="src/A.tsx:1:23" className="p-4">`)
  })

  it('does not stamp component elements', () => {
    const out = tagSource(`const B = () => <Card title="x" />\n`, 'src/B.tsx')
    expect(out).toBeNull()
  })

  it('stamps multiple elements on one line with distinct cols', () => {
    const out = tagSource(`const C = () => <div><span>a</span><span>b</span></div>\n`, 'src/C.tsx')!
    expect(out.match(/data-wb="src\/C\.tsx:1:\d+"/g)).toHaveLength(3)
    const cols = [...out.matchAll(/data-wb="src\/C\.tsx:1:(\d+)"/g)].map((m) => m[1])
    expect(new Set(cols).size).toBe(3)
  })

  it('posix-normalizes windows paths', () => {
    const out = tagSource(`const D = () => <div />\n`, 'src\\ui\\D.tsx')
    expect(out).toContain('data-wb="src/ui/D.tsx:')
  })

  it('returns null on unparseable code', () => {
    expect(tagSource('const = <<>', 'x.tsx')).toBeNull()
  })
})
