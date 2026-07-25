import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge } from '../src/bridge'

/**
 * The bridge glue — hashing, staging, journalling — over its real HTTP transport and a
 * real project on disk. The pure resolve/splice half is covered in edit.test.ts; what is
 * only testable here is which FILE a hash locks and which files a bulk actually writes.
 */
const PORT = 7391
let root: string
let close: () => void

const FILES: Record<string, string> = {
  'src/App.tsx': `import { button } from './ui/button'
import { Badge } from './ui/badge'
export function App({ on }: any) {
  return (
    <div className={clsx('p-2 flex', on ? 'bg-white' : 'bg-black')}>
      <button className={button()}>a</button>
      <Badge className="p-1">x</Badge>
      <Badge>y</Badge>
    </div>
  )
}
`,
  'src/Other.tsx': `import { button } from './ui/button'
export const O = () => (
  <button className={button()}>o</button>
)
`,
  'src/ui/button.ts': `export const button = cva('rounded-md p-4', {
  variants: { size: { sm: 'px-3', md: 'px-4' } },
  defaultVariants: { size: 'md' },
})
`,
  'src/ui/badge.tsx': `export function Badge({ className, children }: any) {
  return <span className={clsx('rounded-full', className)}>{children}</span>
}
`,
}

const write = (rel: string, body: string) => {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
}
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

/** loc of the single JSX element on the line containing `needle` (col 0 = line-tolerant match) */
const locOf = (rel: string, needle: string) => ({
  file: rel,
  line: read(rel).split('\n').findIndex((l) => l.includes(needle)) + 1,
  col: 0,
})

const api = async (msg: any) =>
  (await fetch(`http://127.0.0.1:${PORT}/api`, { method: 'POST', body: JSON.stringify(msg) })).json() as any

const op = (group: string, value: string) => ({ kind: 'tw', group, variants: [], value })

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'wb-bridge-'))
  close = startBridge(root, PORT)
  // wait for listen()
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/health`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
})

beforeEach(() => {
  for (const [rel, body] of Object.entries(FILES)) write(rel, body)
})

afterAll(() => {
  close?.()
  rmSync(root, { recursive: true, force: true })
})

describe('cross-file cva over the bridge (Feature 2)', () => {
  it('resolve names the definition file, and the edit lands there', async () => {
    const loc = locOf('src/App.tsx', '{button()}')
    const r = await api({ t: 'resolve', loc })
    expect(r.classes).toEqual(['rounded-md', 'p-4', 'px-4'])
    expect(r.editFile).toBe('src/ui/button.ts') // the client can SEE which file it will write

    const e = await api({ t: 'edit', id: 'x1', loc: r.loc, hash: r.hash, op: op('p', '8') })
    expect(e.t).toBe('edited')
    expect(read('src/ui/button.ts')).toContain(`cva('rounded-md p-8'`)
    expect(read('src/App.tsx')).toBe(FILES['src/App.tsx']) // call site untouched
  })

  it('the echoed loc + hash chain into a second edit with no re-resolve', async () => {
    const loc = locOf('src/App.tsx', '{button()}')
    const r = await api({ t: 'resolve', loc })
    const e1 = await api({ t: 'edit', id: 'c1', loc: r.loc, hash: r.hash, op: op('p', '8') })
    expect(e1.t).toBe('edited')
    // the echoed loc is an ELEMENT loc (in the call-site file), so it resolves again...
    expect(e1.loc.file).toBe('src/App.tsx')
    // ...and the echoed hash is the token the next edit needs
    const e2 = await api({ t: 'edit', id: 'c2', loc: e1.loc, hash: e1.hash, op: op('gap', '2') })
    expect(e2.t).toBe('edited')
    expect(read('src/ui/button.ts')).toContain(`cva('rounded-md p-8 gap-2'`)
  })

  it('refuses when the DEFINITION file changed under a valid hash', async () => {
    const loc = locOf('src/App.tsx', '{button()}')
    const r = await api({ t: 'resolve', loc })
    write('src/ui/button.ts', FILES['src/ui/button.ts'].replace('rounded-md', 'rounded-lg'))
    const e = await api({ t: 'edit', id: 'd1', loc: r.loc, hash: r.hash, op: op('p', '8') })
    expect(e).toMatchObject({ t: 'refused', reason: 'hash-mismatch' })
  })

  it('refuses when the CALL SITE changed under a valid hash', async () => {
    // the call site chooses which variant slot gets written — leaving it unlocked would
    // let an edit the client previewed against the base silently retarget to `sm`
    const loc = locOf('src/App.tsx', '{button()}')
    const r = await api({ t: 'resolve', loc })
    write('src/App.tsx', FILES['src/App.tsx'].replace('button()', "button({ size: 'sm' })"))
    const before = read('src/ui/button.ts')
    const e = await api({ t: 'edit', id: 'd2', loc: r.loc, hash: r.hash, op: op('px', '6') })
    expect(e).toMatchObject({ t: 'refused', reason: 'hash-mismatch' })
    expect(read('src/ui/button.ts')).toBe(before) // the definition file was NOT rewritten
  })

  it('undo restores the definition file, not the call site', async () => {
    const loc = locOf('src/App.tsx', '{button()}')
    const r = await api({ t: 'resolve', loc })
    await api({ t: 'edit', id: 'u1', loc: r.loc, hash: r.hash, op: op('p', '8') })
    expect(read('src/ui/button.ts')).not.toBe(FILES['src/ui/button.ts'])
    const u = await api({ t: 'undo', id: 'u1' })
    expect(u.t).toBe('edited')
    expect(read('src/ui/button.ts')).toBe(FILES['src/ui/button.ts'])
  })
})

describe('locked groups over the bridge (Feature 1)', () => {
  it('resolve advertises the locked groups and the write refuses them by name', async () => {
    const loc = locOf('src/App.tsx', 'p-2 flex')
    const r = await api({ t: 'resolve', loc })
    expect(r.classes).toEqual(['p-2', 'flex'])
    expect(r.locked).toEqual(['bg'])
    const e = await api({ t: 'edit', id: 'l1', loc: r.loc, hash: r.hash, op: op('bg', 'white') })
    // NOT computed-classname: the element is editable, this one group is not
    expect(e).toMatchObject({ t: 'refused', reason: 'locked-group' })
    const ok = await api({ t: 'edit', id: 'l2', loc: r.loc, hash: r.hash, op: op('p', '8') })
    expect(ok.t).toBe('edited')
  })
})

describe('bulk', () => {
  it('composes two cross-file edits from DIFFERENT call sites into one definition file', async () => {
    const a = await api({ t: 'resolve', loc: locOf('src/App.tsx', '{button()}') })
    const b = await api({ t: 'resolve', loc: locOf('src/Other.tsx', '{button()}') })
    const r = await api({
      t: 'bulk', id: 'b1', edits: [
        { loc: a.loc, hash: a.hash, op: op('p', '8') },
        { loc: b.loc, hash: b.hash, op: op('gap', '2') },
      ],
    })
    expect(r.t).toBe('edited')
    expect(read('src/ui/button.ts')).toContain(`cva('rounded-md p-8 gap-2'`) // composed, not clobbered
  })

  it('does NOT skip the hash check for an edit whose target is already staged', async () => {
    // one valid edit must not launder a stale hash for the edits behind it
    const a = await api({ t: 'resolve', loc: locOf('src/App.tsx', '{button()}') })
    const b = await api({ t: 'resolve', loc: locOf('src/Other.tsx', '{button()}') })
    const r = await api({
      t: 'bulk', id: 'b2', edits: [
        { loc: a.loc, hash: a.hash, op: op('p', '8') },
        { loc: b.loc, hash: 'bogus', op: op('gap', '2') },
      ],
    })
    expect(r).toMatchObject({ t: 'refused', reason: 'hash-mismatch' })
    expect(read('src/ui/button.ts')).toBe(FILES['src/ui/button.ts']) // all-or-nothing held
  })

  it('carries target:callsite edits, and reverts them as a unit', async () => {
    const withClass = await api({ t: 'resolve', loc: locOf('src/App.tsx', '<Badge className="p-1">') })
    const bare = await api({ t: 'resolve', loc: locOf('src/App.tsx', '<Badge>y</Badge>') })
    expect(bare.reason).toBe('no-classname')
    const r = await api({
      t: 'bulk', id: 'b3', edits: [
        { loc: withClass.loc, hash: withClass.hash, op: op('p', '8'), target: 'callsite' },
        { loc: bare.loc, hash: bare.hash, op: op('p', '4'), target: 'callsite' },
      ],
    })
    expect(r.t).toBe('edited')
    const after = read('src/App.tsx')
    expect(after).toContain('<Badge className="p-8">x</Badge>')
    expect(after).toContain('<Badge className="p-4">y</Badge>') // both staged into one file
    await api({ t: 'undo', id: 'b3' })
    expect(read('src/App.tsx')).toBe(FILES['src/App.tsx'])
  })
})
