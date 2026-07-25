import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
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
      <Badge className={button()}>z</Badge>
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
  'src/Nav.tsx': `export const Nav = () => (
  <a className="text-slate-400 hover:text-white p-2">n</a>
)
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

/**
 * Review finding (HIGH): every verb that needs no hash — `token`, `checkpoint`, `undo`, `open` —
 * was reachable from ANY page on ANY localhost port (and from any installed extension), with no
 * preflight to stop it. The allowlist is now the bridge's OWN origin (where the panel it serves
 * runs) plus non-browser callers, which never send an Origin at all.
 */
describe('origin allowlist', () => {
  const post = (msg: any, origin?: string) =>
    fetch(`http://127.0.0.1:${PORT}/api`, {
      method: 'POST',
      body: JSON.stringify(msg),
      headers: origin ? { origin, 'content-type': 'text/plain' } : { 'content-type': 'text/plain' },
    })

  it('rejects another localhost dev server, whatever port it is on', async () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:6006', 'https://localhost', 'http://evil.example']) {
      expect((await post({ t: 'journal' }, origin)).status).toBe(403)
    }
  })

  it('rejects every chrome-extension origin — the extension never opens the socket', async () => {
    expect((await post({ t: 'journal' }, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')).status).toBe(403)
  })

  it('accepts the panel (the bridge serves it, so it runs on the bridge origin) and local tools', async () => {
    expect((await post({ t: 'journal' }, `http://127.0.0.1:${PORT}`)).status).toBe(200)
    expect((await post({ t: 'journal' }, `http://localhost:${PORT}`)).status).toBe(200)
    expect((await post({ t: 'journal' })).status).toBe(200) // no Origin = curl/agent/CI
  })

  it('a cross-origin write never reaches the file, not even with a valid hash', async () => {
    const r = await api({ t: 'resolve', loc: locOf('src/Nav.tsx', '<a className=') })
    const res = await post({ t: 'edit', id: 'csrf1', loc: r.loc, hash: r.hash, op: op('p', '8') }, 'http://localhost:5173')
    expect(res.status).toBe(403)
    expect(read('src/Nav.tsx')).toBe(FILES['src/Nav.tsx'])
  })
})

/**
 * Review finding (HIGH): `op.value`/`op.variants` were spliced in unvalidated. The unit tests own
 * the charset rule; what only this harness proves is that the WIRE refuses it — on the single
 * edit path, on the bulk path, and on the call-site path — with nothing written.
 */
describe('injected class tokens over the wire', () => {
  const inj = (value: string, variants: string[] = []) => ({ kind: 'tw', group: 'p', variants, value })

  it('refuses a value carrying a JSX attribute of its own', async () => {
    const r = await api({ t: 'resolve', loc: locOf('src/Nav.tsx', '<a className=') })
    const e = await api({ t: 'edit', id: 'inj1', loc: r.loc, hash: r.hash, op: inj('4" onClick={eval(1)} z="') })
    expect(e).toMatchObject({ t: 'refused', reason: 'off-scale' })
    expect(read('src/Nav.tsx')).toBe(FILES['src/Nav.tsx'])
  })

  it('refuses an ON-SCALE value whose VARIANT is a live expression', async () => {
    const r = await api({ t: 'resolve', loc: locOf('src/Nav.tsx', '<a className=') })
    const e = await api({ t: 'edit', id: 'inj2', loc: r.loc, hash: r.hash, op: inj('8', ['${process.exit(1)}']) })
    expect(e).toMatchObject({ t: 'refused', reason: 'off-scale' })
    expect(read('src/Nav.tsx')).toBe(FILES['src/Nav.tsx'])
  })

  it('refuses it inside a bulk, and inside a callsite edit, writing nothing', async () => {
    const r = await api({ t: 'resolve', loc: locOf('src/Nav.tsx', '<a className=') })
    const b = await api({ t: 'resolve', loc: locOf('src/App.tsx', '<Badge className="p-1">') })
    const bulk = await api({ t: 'bulk', id: 'inj3', edits: [
      { loc: r.loc, hash: r.hash, op: op('p', '8') },
      { loc: b.loc, hash: b.hash, op: inj('4 flex') },
    ] })
    expect(bulk).toMatchObject({ t: 'refused', reason: 'off-scale' })
    expect(read('src/Nav.tsx')).toBe(FILES['src/Nav.tsx'])
    const cs = await api({ t: 'edit', id: 'inj4', loc: b.loc, hash: b.hash, target: 'callsite', op: inj('4"><script>') })
    expect(cs).toMatchObject({ t: 'refused', reason: 'off-scale' })
    expect(read('src/App.tsx')).toBe(FILES['src/App.tsx'])
  })
})

/**
 * Review finding: `resolve()` normalises `..`, but a SYMLINK planted inside the project still
 * points wherever it likes and writeFileSync follows it. Confinement is checked on the REAL
 * path now, and the CSS scanner does not follow links at all — so a linked stylesheet is never
 * even offered as an editable token.
 */
describe('symlinks never escape the project root', () => {
  it('does not offer, or write, a token declared in a linked-in stylesheet', async (ctx) => {
    const outside = mkdtempSync(join(tmpdir(), 'wb-outside-'))
    const evil = join(outside, 'evil.css')
    writeFileSync(evil, `@theme {
  --color-evil: #ff0000;
}
`)
    const link = join(root, 'src/linked.css')
    try {
      symlinkSync(evil, link, 'file')
    } catch {
      ctx.skip() // unprivileged Windows: symlink creation is not permitted
      rmSync(outside, { recursive: true, force: true })
      return
    }
    try {
      const c = await api({ t: 'config' })
      expect(Object.keys(c.tokens ?? {})).not.toContain('--color-evil')
      const e = await api({ t: 'token', id: 'sym1', name: '--color-evil', value: '#00ff00', hash: 'x' })
      expect(e).toMatchObject({ t: 'refused', reason: 'unknown-edit' })
      expect(readFileSync(evil, 'utf8')).toContain('#ff0000') // the file outside is untouched
    } finally {
      rmSync(link, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses to resolve or edit a source file linked in from outside', async (ctx) => {
    const outside = mkdtempSync(join(tmpdir(), 'wb-outside-'))
    const target = join(outside, 'Evil.tsx')
    const body = `export const E = () => <p className="p-2">e</p>
`
    writeFileSync(target, body)
    const link = join(root, 'src/Linked.tsx')
    try {
      symlinkSync(target, link, 'file')
    } catch {
      ctx.skip()
      rmSync(outside, { recursive: true, force: true })
      return
    }
    try {
      const r = await api({ t: 'resolve', loc: { file: 'src/Linked.tsx', line: 1, col: 25 } })
      expect(r.reason).toBe('file-not-found')
      const e = await api({ t: 'edit', id: 'sym2', loc: { file: 'src/Linked.tsx', line: 1, col: 25 }, hash: r.hash, op: op('p', '8') })
      expect(e).toMatchObject({ t: 'refused', reason: 'file-not-found' })
      expect(readFileSync(target, 'utf8')).toBe(body)
    } finally {
      rmSync(link, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
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

describe('text edits over the bridge', () => {
  it('writes, journals, and undoes a text edit; off-scale never applies to text', async () => {
    const loc = locOf('src/App.tsx', '<Badge className="p-1">x</Badge>')
    const r = await api({ t: 'resolve', loc })
    expect(r.text).toBe('x')
    // '13' would refuse off-scale as a spacing value — text values are never scale-checked
    const e = await api({ t: 'edit', id: 'tx1', loc: r.loc, hash: r.hash, op: { kind: 'text', value: '13' } })
    expect(e.t).toBe('edited')
    expect(read('src/App.tsx')).toContain('>13</Badge>')

    const u = await api({ t: 'undo', id: 'tx1' })
    expect(u.t).toBe('edited')
    expect(read('src/App.tsx')).toBe(FILES['src/App.tsx'])
  })

  it('accepts the composite resolve hash for a text edit on a cross-file-cva element', async () => {
    const loc = locOf('src/App.tsx', '{button()}')
    const r = await api({ t: 'resolve', loc })
    expect(r.editFile).toBe('src/ui/button.ts') // resolve hands out the composite lock...
    expect(r.text).toBe('a')
    // ...but the text edit writes the CALL SITE — the composite token must still unlock it
    const e = await api({ t: 'edit', id: 'tx2', loc: r.loc, hash: r.hash, op: { kind: 'text', value: 'Send' } })
    expect(e.t).toBe('edited')
    expect(read('src/App.tsx')).toContain('>Send</button>')
    expect(read('src/ui/button.ts')).toBe(FILES['src/ui/button.ts']) // definition untouched
  })

  it('dry-run text edits preview without writing', async () => {
    const loc = locOf('src/App.tsx', '<Badge className="p-1">x</Badge>')
    const r = await api({ t: 'resolve', loc })
    const e = await api({ t: 'edit', id: 'tx3', loc: r.loc, hash: r.hash, op: { kind: 'text', value: 'Preview' }, dry: true })
    expect(e.t).toBe('edited')
    expect(e.dry).toBe(true)
    expect(e.diff).toContain('Preview')
    expect(read('src/App.tsx')).toBe(FILES['src/App.tsx'])
  })

  it('bulk mixes class and text ops on one element as a unit', async () => {
    const loc = locOf('src/App.tsx', '<Badge className="p-1">x</Badge>')
    const r = await api({ t: 'resolve', loc })
    const e = await api({ t: 'bulk', id: 'tb1', edits: [
      { loc: r.loc, hash: r.hash, op: { kind: 'tw', group: 'p', variants: [], value: '2' } },
      { loc: r.loc, hash: r.hash, op: { kind: 'text', value: 'both' } },
    ] })
    expect(e.t).toBe('edited')
    expect(read('src/App.tsx')).toContain('<Badge className="p-2">both</Badge>')
    const u = await api({ t: 'undo', id: 'tb1' })
    expect(u.t).toBe('edited')
    expect(read('src/App.tsx')).toBe(FILES['src/App.tsx'])
  })
})

/**
 * Feature A: the panel's variant-chain selector puts `variants` on the wire for the first
 * time. What only this harness proves is that the SERVER-side gates — the design-scale
 * check, hashing, bulk staging, undo — treat a `hover:` op exactly like a base one.
 */
describe('variant ops over the bridge (Feature A)', () => {
  const vop = (group: string, value: string, variants: string[]) => ({ kind: 'tw', group, variants, value })

  it('writes the variant token and leaves the base token alone', async () => {
    const loc = locOf('src/Nav.tsx', '<a className=')
    const r = await api({ t: 'resolve', loc })
    expect(r.classes).toEqual(['text-slate-400', 'hover:text-white', 'p-2'])
    const e = await api({ t: 'edit', id: 'v1', loc: r.loc, hash: r.hash, op: vop('text', 'black', ['hover']) })
    expect(e.t).toBe('edited')
    expect(read('src/Nav.tsx')).toContain('className="text-slate-400 hover:text-black p-2"')

    const u = await api({ t: 'undo', id: 'v1' })
    expect(u.t).toBe('edited')
    expect(read('src/Nav.tsx')).toBe(FILES['src/Nav.tsx'])
  })

  it('enforces the design scale on variant ops, same as base ones', async () => {
    const loc = locOf('src/Nav.tsx', '<a className=')
    const r = await api({ t: 'resolve', loc })
    const off = await api({ t: 'edit', id: 'v2', loc: r.loc, hash: r.hash, op: vop('p', '13', ['md']) })
    expect(off).toMatchObject({ t: 'refused', reason: 'off-scale' })
    expect(read('src/Nav.tsx')).toBe(FILES['src/Nav.tsx'])
    const ok = await api({ t: 'edit', id: 'v3', loc: r.loc, hash: r.hash, op: vop('p', '8', ['md']) })
    expect(ok.t).toBe('edited')
    expect(read('src/Nav.tsx')).toContain('p-2 md:p-8')
  })

  it('bulk composes a base and a variant edit of the SAME property on one element', async () => {
    const loc = locOf('src/Nav.tsx', '<a className=')
    const r = await api({ t: 'resolve', loc })
    const e = await api({ t: 'bulk', id: 'v4', edits: [
      { loc: r.loc, hash: r.hash, op: vop('text', 'black', []) },
      { loc: r.loc, hash: r.hash, op: vop('text', 'white', ['hover']) },
    ] })
    expect(e.t).toBe('edited')
    // both survive: they are different conflict groups, so neither replaced the other
    expect(read('src/Nav.tsx')).toContain('className="text-black hover:text-white p-2"')
    await api({ t: 'undo', id: 'v4' })
    expect(read('src/Nav.tsx')).toBe(FILES['src/Nav.tsx'])
  })

  it('dry-run shows the prefixed token without writing', async () => {
    const loc = locOf('src/Nav.tsx', '<a className=')
    const r = await api({ t: 'resolve', loc })
    const d = await api({ t: 'edit', id: 'v5', loc: r.loc, hash: r.hash, op: vop('bg', 'black', ['dark']), dry: true })
    expect(d.dry).toBe(true)
    expect(d.diff).toContain('dark:bg-black')
    expect(read('src/Nav.tsx')).toBe(FILES['src/Nav.tsx'])
  })
})

/**
 * Feature B: the panel's per-instance mode, end to end over the wire. The flow it drives is
 * (1) resolve the definition, which refuses but names the forwarding component + its call
 * sites, (2) resolve one call site to learn the usage's OWN className, (3) edit it with
 * target:'callsite'. Step 2 is the new part: `classes` is what the element RENDERS, which
 * for `<Badge className={button()}>` is a cva definition in a third file — driving controls
 * from it would offer edits the write path refuses.
 */
describe('per-instance editing flow (Feature B)', () => {
  const cop = (group: string, value: string) => ({ kind: 'tw', group, variants: [], value })

  it('the definition refuses but advertises the forwarding component and its call sites', async () => {
    const r = await api({ t: 'resolve', loc: locOf('src/ui/badge.tsx', '<span className=') })
    expect(r.classes).toBeNull()
    expect(r.reason).toBe('computed-classname')
    expect(r.instance).toEqual({ component: 'Badge', forwards: true })
    // only usages that pass a className are hinted — the panel offers "edit only this instance" here
    expect(r.hints.map((h: any) => h.loc.file)).toContain('src/App.tsx')
    expect(r.own).toBeUndefined() // the definition's root is a host <span>, not a call site
  })

  it('a call site reports its OWN classes, and the callsite edit writes exactly those', async () => {
    const r = await api({ t: 'resolve', loc: locOf('src/App.tsx', '<Badge className="p-1">') })
    expect(r.own).toEqual({ classes: ['p-1'] })
    const e = await api({ t: 'edit', id: 'fb1', loc: r.loc, hash: r.hash, target: 'callsite', op: cop('p', '8') })
    expect(e.t).toBe('edited')
    expect(read('src/App.tsx')).toContain('<Badge className="p-8">x</Badge>')
    expect(read('src/ui/badge.tsx')).toBe(FILES['src/ui/badge.tsx']) // the component is untouched
    await api({ t: 'undo', id: 'fb1' })
    expect(read('src/App.tsx')).toBe(FILES['src/App.tsx'])
  })

  it('a usage with no className is editable-empty (own: []), and the edit appends the attribute', async () => {
    const r = await api({ t: 'resolve', loc: locOf('src/App.tsx', '<Badge>y</Badge>') })
    expect(r.reason).toBe('no-classname') // what the ELEMENT renders: nothing editable...
    expect(r.own).toEqual({ classes: [] }) // ...but the USAGE is editable, the write adds the attribute
    const e = await api({ t: 'edit', id: 'fb2', loc: r.loc, hash: r.hash, target: 'callsite', op: cop('p', '4') })
    expect(e.t).toBe('edited')
    expect(read('src/App.tsx')).toContain('<Badge className="p-4">y</Badge>')
    await api({ t: 'undo', id: 'fb2' })
    expect(read('src/App.tsx')).toBe(FILES['src/App.tsx'])
  })

  it('own is null — not the definition classes — when the usage className is computed', async () => {
    const r = await api({ t: 'resolve', loc: locOf('src/App.tsx', '<Badge className={button()}>') })
    // `classes` follows the cva into a THIRD file: real, but nothing a per-instance edit can write
    expect(r.classes).toEqual(['rounded-md', 'p-4', 'px-4'])
    expect(r.editFile).toBe('src/ui/button.ts')
    expect(r.own).toEqual({ classes: null })
    // and the write path agrees, so a client honouring `own` never offers a doomed edit
    const e = await api({ t: 'edit', id: 'fb3', loc: r.loc, hash: r.hash, target: 'callsite', op: cop('p', '8') })
    expect(e).toMatchObject({ t: 'refused', reason: 'computed-classname' })
    expect(read('src/ui/button.ts')).toBe(FILES['src/ui/button.ts'])
  })

  it('dry-run previews a callsite edit without writing', async () => {
    const r = await api({ t: 'resolve', loc: locOf('src/App.tsx', '<Badge className="p-1">') })
    const d = await api({ t: 'edit', id: 'fb4', loc: r.loc, hash: r.hash, target: 'callsite', op: cop('gap', '2'), dry: true })
    expect(d.dry).toBe(true)
    expect(d.diff).toContain('<Badge className="p-1 gap-2">x</Badge>')
    expect(read('src/App.tsx')).toBe(FILES['src/App.tsx'])
  })

  it('a component that does NOT forward className refuses the instance edit', async () => {
    // src/Other.tsx has no such usage; the App's own <button> is a host element, so the
    // shape a client must never enter instance mode for is the non-forwarding component
    const r = await api({ t: 'resolve', loc: locOf('src/App.tsx', '<Badge className="p-1">') })
    write('src/ui/badge.tsx', `export function Badge({ children }: any) {
  return <span className="rounded-full">{children}</span>
}
`)
    const e = await api({ t: 'edit', id: 'fb5', loc: r.loc, hash: r.hash, target: 'callsite', op: cop('p', '8') })
    expect(e).toMatchObject({ t: 'refused', reason: 'not-forwarded' })
  })

  it('host elements carry no `own` — instance mode is unreachable for them', async () => {
    const r = await api({ t: 'resolve', loc: locOf('src/App.tsx', 'p-2 flex') })
    expect(r.classes).toEqual(['p-2', 'flex'])
    expect(r.own).toBeUndefined()
  })
})

/**
 * Feature C: `@theme` design-token editing over the bridge. This gets its own project root
 * (and its own bridge per test, since the resolved scale is bridge state) because it needs a
 * RESOLVABLE tailwind v4 — merging the project's `@theme` over the shipped default theme is
 * the only path on which `getScale` reads project CSS at all, and "the scale follows the
 * token" is the half of this feature that nothing else can prove.
 */
describe('@theme token editing over the bridge (Feature C)', () => {
  const CSS = `@import "tailwindcss";

@theme {
  --color-brand: #ff6600;
  --font-display: "Georgia", serif;
}
`
  let troot: string
  let tclose: () => void
  let tport = 7401
  const tapi = async (msg: any) =>
    (await fetch(`http://127.0.0.1:${tport}/api`, { method: 'POST', body: JSON.stringify(msg) })).json() as any
  const tread = () => readFileSync(join(troot, 'src/index.css'), 'utf8')

  beforeEach(async () => {
    tport++ // a fresh port per test: http.close() does not wait for the socket to drain
    troot = mkdtempSync(join(tmpdir(), 'wb-token-bridge-'))
    const put = (rel: string, body: string) => {
      mkdirSync(join(troot, rel, '..'), { recursive: true })
      writeFileSync(join(troot, rel), body)
    }
    put('package.json', '{"name":"wb-token-fixture","version":"0.0.0"}')
    put('src/index.css', CSS)
    // a minimal resolvable tailwind v4 — no "exports" field, so the subpath resolves
    put('node_modules/tailwindcss/package.json', '{"name":"tailwindcss","version":"4.1.0"}')
    put('node_modules/tailwindcss/theme.css', '@theme { --color-white: #fff; --color-black: #000; --font-sans: ui-sans-serif; }')
    tclose = startBridge(troot, tport)
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${tport}/health`)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 20))
      }
    }
  })
  afterEach(() => {
    tclose?.()
    rmSync(troot, { recursive: true, force: true })
  })

  it('config advertises the editable tokens, and the edit rewrites the declaration', async () => {
    const c = await tapi({ t: 'config' })
    expect(c.colors.brand).toBe('#ff6600') // the project @theme merged over the defaults
    expect(c.tokens['--color-brand']).toMatchObject({ file: 'src/index.css' })
    expect(c.tokens['--font-display'].hash).toBe(c.tokens['--color-brand'].hash) // same file, same lock

    const e = await tapi({ t: 'token', id: 'tk1', name: '--color-brand', value: '#00ff00', hash: c.tokens['--color-brand'].hash })
    expect(e.t).toBe('edited')
    expect(e.loc).toEqual({ file: 'src/index.css', line: 4, col: 0 })
    expect(e.diff).toContain('+  --color-brand: #00ff00;')
    expect(tread()).toBe(CSS.replace('#ff6600', '#00ff00'))
  })

  it('the next config fetch reports the new value (getScale followed the token)', async () => {
    const c = await tapi({ t: 'config' })
    await tapi({ t: 'token', id: 'tk2', name: '--font-display', value: '"Verdana", sans-serif', hash: c.tokens['--font-display'].hash })
    const after = await tapi({ t: 'config' })
    expect(after.fonts.display).toBe('"Verdana", sans-serif')
    expect(after.tokens['--font-display'].hash).not.toBe(c.tokens['--font-display'].hash) // the lock moved with the file
  })

  it('a stale hash refuses and writes nothing', async () => {
    const c = await tapi({ t: 'config' })
    writeFileSync(join(troot, 'src/index.css'), CSS.replace('#ff6600', '#123456')) // manual edit
    const before = tread()
    const e = await tapi({ t: 'token', id: 'tk3', name: '--color-brand', value: '#00ff00', hash: c.tokens['--color-brand'].hash })
    expect(e).toMatchObject({ t: 'refused', reason: 'hash-mismatch' })
    expect(tread()).toBe(before)
    // …and a re-read of config unlocks it again
    const c2 = await tapi({ t: 'config' })
    const ok = await tapi({ t: 'token', id: 'tk3b', name: '--color-brand', value: '#00ff00', hash: c2.tokens['--color-brand'].hash })
    expect(ok.t).toBe('edited')
  })

  it('refuses a token write carrying NO lock hash at all', async () => {
    // the design system is the widest write in the product: it is gated on the client having
    // just read the file it rewrites, so an unlocked write is never accepted (defence in depth
    // behind the origin allowlist — an unauthenticated caller cannot guess the hash either)
    const e = await tapi({ t: 'token', id: 'tk3c', name: '--color-brand', value: '#00ff00' })
    expect(e).toMatchObject({ t: 'refused', reason: 'hash-mismatch' })
    expect(tread()).toBe(CSS)
  })

  it('an unknown token is refused — tokens are edited, never created', async () => {
    const c = await tapi({ t: 'config' })
    const e = await tapi({ t: 'token', id: 'tk4', name: '--color-nope', value: '#000', hash: 'whatever' })
    expect(e).toMatchObject({ t: 'refused', reason: 'unknown-edit' })
    expect(tread()).toBe(CSS)
    // and a value that would escape the declaration never reaches disk
    const bad = await tapi({ t: 'token', id: 'tk5', name: '--color-brand', value: 'red; --font-display: none', hash: c.tokens['--color-brand'].hash })
    expect(bad).toMatchObject({ t: 'refused', reason: 'parse-error' })
    expect(tread()).toBe(CSS)
  })

  it('the journal lists the token edit, and undo restores the file AND the scale', async () => {
    const c = await tapi({ t: 'config' })
    await tapi({ t: 'token', id: 'tk6', name: '--color-brand', value: '#00ff00', hash: c.tokens['--color-brand'].hash })
    const j = await tapi({ t: 'journal' })
    expect(j.entries).toContainEqual({ id: 'tk6', file: 'src/index.css', summary: '+  --color-brand: #00ff00;' })
    expect((await tapi({ t: 'config' })).colors.brand).toBe('#00ff00')

    const u = await tapi({ t: 'undo', id: 'tk6' })
    expect(u.t).toBe('edited')
    expect(tread()).toBe(CSS) // byte-identical
    expect((await tapi({ t: 'config' })).colors.brand).toBe('#ff6600') // the scale came back too
  })

  it('the session changelog carries the token diff', async () => {
    const c = await tapi({ t: 'config' })
    await tapi({ t: 'token', id: 'tk7', name: '--color-brand', value: '#00ff00', hash: c.tokens['--color-brand'].hash })
    const md = await (await fetch(`http://127.0.0.1:${tport}/export`)).text()
    expect(md).toContain('## src/index.css')
    expect(md).toContain('+  --color-brand: #00ff00;')
  })
})

/**
 * Feature D: checkpoint. Needs a REAL git repository, so it gets its own root (and its own
 * bridge, since the journal it commits is bridge state). The hard bar this suite exists to
 * hold is the safety one: the checkpoint must leave the checked-out branch, HEAD, the index
 * and the working tree exactly as it found them — a snapshot, never a state change.
 */
describe('checkpoint (Feature D)', () => {
  let groot: string
  let gclose: () => void
  let gport = 7421
  const gapi = async (msg: any) =>
    (await fetch(`http://127.0.0.1:${gport}/api`, { method: 'POST', body: JSON.stringify(msg) })).json() as any
  const git = (...args: string[]) => spawnSync('git', args, { cwd: groot, encoding: 'utf8' })
  const gitOut = (...args: string[]) => git(...args).stdout.trim()
  const gread = (rel: string) => readFileSync(join(groot, rel), 'utf8')
  const gwrite = (rel: string, body: string) => {
    mkdirSync(join(groot, rel, '..'), { recursive: true })
    writeFileSync(join(groot, rel), body)
  }
  const gloc = (rel: string, needle: string) => ({
    file: rel,
    line: gread(rel).split('\n').findIndex((l) => l.includes(needle)) + 1,
    col: 0,
  })
  /** resolve + edit one element, so the journal has something to checkpoint */
  const edit = async (id: string, rel: string, needle: string, group: string, value: string) => {
    const r = await gapi({ t: 'resolve', loc: gloc(rel, needle) })
    const e = await gapi({ t: 'edit', id, loc: r.loc, hash: r.hash, op: op(group, value) })
    expect(e.t).toBe('edited')
  }

  beforeEach(async () => {
    gport++ // fresh port per test: http.close() does not wait for the socket to drain
    groot = mkdtempSync(join(tmpdir(), 'wb-ckpt-'))
    for (const [rel, body] of Object.entries(FILES)) gwrite(rel, body)
    git('init', '-q')
    // hermetic identity + no signing, so the fixture never depends on the developer's config
    git('config', 'user.email', 'wb@example.test')
    git('config', 'user.name', 'Writeback Test')
    git('config', 'commit.gpgsign', 'false')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    gclose = startBridge(groot, gport)
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${gport}/health`)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 20))
      }
    }
  })
  afterEach(() => {
    gclose?.()
    rmSync(groot, { recursive: true, force: true })
  })

  it('commits exactly the journal-touched files, and leaves branch/HEAD/tree untouched', async () => {
    await edit('d1', 'src/App.tsx', '{button()}', 'p', '8') // writes the cva DEFINITION file
    await edit('d2', 'src/Nav.tsx', '<a className=', 'p', '4')

    const branchBefore = gitOut('rev-parse', '--abbrev-ref', 'HEAD')
    const headBefore = gitOut('rev-parse', 'HEAD')
    const statusBefore = gitOut('status', '--porcelain')

    const r = await gapi({ t: 'checkpoint', id: 'ck1' })
    expect(r.t).toBe('checkpointed')
    expect(r.branch).toMatch(/^writeback\/\d{8}-\d{6}$/)
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/)

    // the branch holds the files as they are on disk RIGHT NOW, parented on the current HEAD
    expect(gitOut('rev-parse', r.branch)).toBe(r.commit)
    expect(gitOut('rev-parse', r.branch + '^')).toBe(headBefore)
    expect(gitOut('show', `${r.branch}:src/ui/button.ts`)).toBe(gread('src/ui/button.ts').trim())
    expect(gitOut('show', `${r.branch}:src/Nav.tsx`)).toBe(gread('src/Nav.tsx').trim())
    expect(gitOut('diff', '--name-only', 'HEAD', r.branch).split('\n').sort()).toEqual(['src/Nav.tsx', 'src/ui/button.ts'])

    // …and nothing about the user's working state moved
    expect(gitOut('rev-parse', '--abbrev-ref', 'HEAD')).toBe(branchBefore)
    expect(gitOut('rev-parse', 'HEAD')).toBe(headBefore)
    expect(gitOut('status', '--porcelain')).toBe(statusBefore) // same dirty files, still dirty
    expect(gread('src/ui/button.ts')).toContain('p-8') // the edit is still in the tree
  })

  it('never commits a file the session did not write', async () => {
    // a manual edit sitting in the tree is the user's business — a checkpoint must not adopt it
    gwrite('src/Other.tsx', FILES['src/Other.tsx'].replace('o</button>', 'manual</button>'))
    await edit('d3', 'src/Nav.tsx', '<a className=', 'p', '4')
    const r = await gapi({ t: 'checkpoint', id: 'ck2' })
    expect(r.t).toBe('checkpointed')
    expect(gitOut('diff', '--name-only', 'HEAD', r.branch)).toBe('src/Nav.tsx')
    expect(gitOut('status', '--porcelain')).toContain('src/Other.tsx') // still uncommitted
    expect(gitOut('status', '--porcelain', '--', 'src/Other.tsx')).not.toBe('') // and still dirty
  })

  it('an empty journal refuses and creates no branch at all', async () => {
    const r = await gapi({ t: 'checkpoint', id: 'ck3' })
    expect(r).toMatchObject({ t: 'refused', reason: 'unknown-edit' })
    expect(gitOut('branch', '--list', 'writeback/*')).toBe('')
  })

  it('the message becomes the subject; the body is always the session changelog', async () => {
    await edit('d4', 'src/Nav.tsx', '<a className=', 'p', '4')
    const r = await gapi({ t: 'checkpoint', id: 'ck4', message: 'tighten the nav' })
    expect(gitOut('log', '-1', '--format=%s', r.branch)).toBe('tighten the nav')
    const body = gitOut('log', '-1', '--format=%B', r.branch)
    expect(body).toContain('# Writeback session changes')
    expect(body).toContain('## src/Nav.tsx')
    expect(body).toContain('p-4')
  })

  it('with no message the subject counts the session edits', async () => {
    await edit('d5', 'src/Nav.tsx', '<a className=', 'p', '4')
    const one = await gapi({ t: 'checkpoint', id: 'ck5' })
    expect(gitOut('log', '-1', '--format=%s', one.branch)).toBe('writeback: 1 edit')
    await edit('d6', 'src/App.tsx', '{button()}', 'gap', '2')
    const two = await gapi({ t: 'checkpoint', id: 'ck6' })
    expect(gitOut('log', '-1', '--format=%s', two.branch)).toBe('writeback: 2 edits')
  })

  it('two checkpoints in the same second get distinct branches', async () => {
    await edit('d7', 'src/Nav.tsx', '<a className=', 'p', '4')
    const a = await gapi({ t: 'checkpoint', id: 'ck7' })
    const b = await gapi({ t: 'checkpoint', id: 'ck8' })
    expect(b.t).toBe('checkpointed')
    expect(b.branch).not.toBe(a.branch)
    expect(gitOut('branch', '--list', 'writeback/*').split('\n').length).toBe(2)
  })

  it('refuses git-unavailable outside a repository, without losing the journal', async () => {
    // the non-git fixture root at the top of this file: same bridge code, no repo
    const before = await api({ t: 'resolve', loc: locOf('src/Nav.tsx', '<a className=') })
    await api({ t: 'edit', id: 'ng1', loc: before.loc, hash: before.hash, op: op('p', '8') })
    const r = await api({ t: 'checkpoint', id: 'ck9' })
    expect(r).toMatchObject({ t: 'refused', reason: 'git-unavailable' })
    const j = await api({ t: 'journal' })
    expect(j.entries.some((e: any) => e.id === 'ng1')).toBe(true) // the session survives a failed checkpoint
  })
})
