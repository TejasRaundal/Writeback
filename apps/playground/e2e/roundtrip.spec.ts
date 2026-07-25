import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// M1 gate: click path → edit → source file changed → HMR updated DOM → undo → byte-identical file.
// Drives the wire protocol directly (per brief, extension is QA'd manually).

const APP = join(__dirname, '..', 'src', 'App.tsx')
const WS_URL = 'ws://127.0.0.1:7331'

function connect(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => res(ws)
    ws.onerror = rej
  })
}

function request(ws: WebSocket, msg: object, expectT: string): Promise<any> {
  return new Promise((res) => {
    const on = (e: MessageEvent) => {
      const m = JSON.parse(String(e.data))
      if (m.t === expectT || m.t === 'refused') {
        ws.removeEventListener('message', on)
        res(m)
      }
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify(msg))
  })
}

test('the round trip', async ({ page }) => {
  const original = readFileSync(APP, 'utf8')

  await page.goto('http://localhost:5173')
  const card = page.locator('.grid > div').first()
  await expect(card).toBeVisible()

  // the tagging transform gave the card's host div its source loc
  const stamp = await card.getAttribute('data-wb')
  expect(stamp).toBeTruthy()
  const parts = stamp!.split(':')
  const loc = { col: Number(parts.pop()), line: Number(parts.pop()), file: parts.join(':') } as any
  const locOk = { file: loc.file, line: loc.line, col: loc.col }
  expect(locOk.file).toBe('src/App.tsx')

  const ws = await connect()
  try {
    // resolve: source truth, not computed style
    const resolved = await request(ws, { t: 'resolve', loc: locOk }, 'resolved')
    expect(resolved.classes).toContain('p-6')

    // edit p-6 → p-8
    const edited = await request(
      ws,
      { t: 'edit', id: 'e2e-1', loc: locOk, hash: resolved.hash, op: { kind: 'tw', group: 'p', variants: [], value: '8' } },
      'edited',
    )
    expect(edited.t).toBe('edited')
    expect(edited.diff).toContain('+')

    // source file now has the token
    expect(readFileSync(APP, 'utf8')).toContain('bg-slate-900 p-8')

    // HMR updated the DOM
    await expect(card).toHaveClass(/p-8/, { timeout: 10_000 })

    // stale-hash edits are refused
    const stale = await request(
      ws,
      { t: 'edit', id: 'e2e-stale', loc: locOk, hash: resolved.hash, op: { kind: 'tw', group: 'p', variants: [], value: '2' } },
      'edited',
    )
    expect(stale.t).toBe('refused')
    expect(stale.reason).toBe('hash-mismatch')

    // undo restores the file byte-identically
    const undone = await request(ws, { t: 'undo', id: 'e2e-1' }, 'edited')
    expect(undone.t).toBe('edited')
    expect(readFileSync(APP, 'utf8')).toBe(original)
    await expect(card).toHaveClass(/p-6/, { timeout: 10_000 })
  } finally {
    ws.close()
    const now = readFileSync(APP, 'utf8')
    if (now !== original) writeFileSync(APP, original)
  }
})

test('dry-run previews without writing; bulk is all-or-nothing; export serves markdown', async ({ page }) => {
  const original = readFileSync(APP, 'utf8')
  await page.goto('http://localhost:5173')
  const stamp = await page.locator('.grid > div').first().getAttribute('data-wb')
  const parts = stamp!.split(':')
  const loc = { col: Number(parts.pop()), line: Number(parts.pop()), file: parts.join(':') }

  const ws = await connect()
  try {
    const resolved = await request(ws, { t: 'resolve', loc }, 'resolved')

    // dry-run: diff comes back, file untouched
    const dry = await request(
      ws,
      { t: 'edit', id: 'dry-1', loc, hash: resolved.hash, op: { kind: 'tw', group: 'p', variants: [], value: '10' }, dry: true },
      'edited',
    )
    expect(dry.dry).toBe(true)
    expect(dry.diff).toContain('p-10')
    expect(readFileSync(APP, 'utf8')).toBe(original)

    // bulk with one bad hash: nothing is written
    const bulk = await request(
      ws,
      {
        t: 'bulk', id: 'bulk-1', edits: [
          { loc, hash: resolved.hash, op: { kind: 'tw', group: 'p', variants: [], value: '10' } },
          { loc: { file: 'src/main.tsx', line: 1, col: 0 }, hash: 'bogus', op: { kind: 'tw', group: 'm', variants: [], value: '4' } },
        ],
      },
      'edited',
    )
    expect(bulk.t).toBe('refused')
    expect(readFileSync(APP, 'utf8')).toBe(original)

    // export endpoint
    const md = await (await fetch('http://127.0.0.1:7331/export')).text()
    expect(md).toContain('# Writeback session changes')

    // HTTP agent transport mirrors the WS protocol
    const apiResolved = await (await fetch('http://127.0.0.1:7331/api', {
      method: 'POST',
      body: JSON.stringify({ t: 'resolve', loc }),
    })).json()
    expect(apiResolved.t).toBe('resolved')
    expect(apiResolved.classes).toContain('p-6')

    // undo of an unknown id must REPLY (not silently hang the client)
    const unknownUndo = await request(ws, { t: 'undo', id: 'no-such-edit' }, 'edited')
    expect(unknownUndo.t).toBe('refused')
    expect(unknownUndo.reason).toBe('unknown-edit')

    // a wrong (repo-relative) path returns file-not-found WITH the root, not a misleading refusal
    const badPath = await request(ws, { t: 'resolve', loc: { file: 'apps/playground/src/App.tsx', line: 35, col: 4 } }, 'resolved')
    expect(badPath.reason).toBe('file-not-found')
    expect(badPath.root).toContain('playground')

    // off-scale values are refused server-side (the design system is enforced, not UI-only)
    const off = await request(ws, { t: 'edit', id: 'off-1', loc, hash: resolved.hash, op: { kind: 'tw', group: 'p', variants: [], value: '13' } }, 'edited')
    expect(off.t).toBe('refused')
    expect(off.reason).toBe('off-scale')
    expect(readFileSync(APP, 'utf8')).toBe(original)
    // but a bracketed value with raw:true is allowed through
    const raw = await request(ws, { t: 'edit', id: 'off-raw', loc, hash: resolved.hash, op: { kind: 'tw', group: 'p', variants: [], value: '[13px]', raw: true }, dry: true }, 'edited')
    expect(raw.t).toBe('edited')
    expect(raw.diff).toContain('p-[13px]')

    // /health must not leak the absolute project root
    const health = await (await fetch('http://127.0.0.1:7331/health')).json()
    expect(health.writeback).toBe(true)
    expect(health.root).toBeUndefined()

    // agent fast path: resolve with col 0 snaps to the element on that line and echoes its real col
    const tolerant = await request(ws, { t: 'resolve', loc: { file: loc.file, line: loc.line, col: 0 } }, 'resolved')
    expect(tolerant.classes).toEqual(resolved.classes)
    expect(tolerant.loc.col).toBe(loc.col)

    // one bulk applies two properties to the same element and reverts as a unit
    const two = await request(ws, {
      t: 'bulk', id: 'two-op', edits: [
        { loc, hash: tolerant.hash, op: { kind: 'tw', group: 'p', variants: [], value: '8' } },
        { loc, hash: tolerant.hash, op: { kind: 'tw', group: 'bg', variants: [], value: 'slate-800' } },
      ],
    }, 'edited')
    expect(two.t).toBe('edited')
    const twoEdited = readFileSync(APP, 'utf8')
    expect(twoEdited).toContain('p-8')
    expect(twoEdited).toContain('bg-slate-800')
    await request(ws, { t: 'undo', id: 'two-op' }, 'edited')
    expect(readFileSync(APP, 'utf8')).toBe(original)

    // cva-produced className resolves to base + active variant slots (M5)
    const cvaStamp = await page.getByRole('button', { name: 'New report' }).getAttribute('data-wb')
    const cvaParts = cvaStamp!.split(':')
    const cvaLoc = { col: Number(cvaParts.pop()), line: Number(cvaParts.pop()), file: cvaParts.join(':') }
    const cvaResolved = await request(ws, { t: 'resolve', loc: cvaLoc }, 'resolved')
    expect(cvaResolved.classes).toContain('bg-blue-600')
    expect(cvaResolved.classes).toContain('px-4')
  } finally {
    ws.close()
    if (readFileSync(APP, 'utf8') !== original) writeFileSync(APP, original)
  }
})

test('fully-dynamic clsx elements are refused at resolve time', async ({ page }) => {
  await page.goto('http://localhost:5173')
  const dyn = page.getByRole('button', { name: 'Dynamic class' })
  const stamp = await dyn.getAttribute('data-wb')
  const parts = stamp!.split(':')
  const loc = { col: Number(parts.pop()), line: Number(parts.pop()), file: parts.join(':') }

  const ws = await connect()
  try {
    const resolved = await request(ws, { t: 'resolve', loc }, 'resolved')
    expect(resolved.classes).toBeNull()
    expect(resolved.reason).toBe('computed-classname')
  } finally {
    ws.close()
  }
})

test('per-instance call-site edits land on the usage, and undo (Feature 3)', async ({ page }) => {
  const original = readFileSync(APP, 'utf8')
  await page.goto('http://localhost:5173')
  await expect(page.getByText('Live', { exact: true })).toBeVisible()

  // component usages carry no data-wb stamp (only host elements do) — find the loc the
  // way an agent does: one grep for the line, then a col-0 resolve that snaps to it
  const lineOf = (needle: string) => original.split('\n').findIndex((l) => l.includes(needle)) + 1
  const withClass = { file: 'src/App.tsx', line: lineOf('<Badge className="px-3">'), col: 0 }
  const bare = { file: 'src/App.tsx', line: lineOf('<Badge>Beta</Badge>'), col: 0 }
  const card = { file: 'src/App.tsx', line: lineOf('<Card title="Revenue"'), col: 0 }

  const ws = await connect()
  try {
    // 1. usage that already has a className: normal group-aware replace, in App.tsx
    const r1 = await request(ws, { t: 'resolve', loc: withClass }, 'resolved')
    expect(r1.classes).toEqual(['px-3'])
    const e1 = await request(ws, {
      t: 'edit', id: 'inst-1', loc: r1.loc, hash: r1.hash, target: 'callsite',
      op: { kind: 'tw', group: 'px', variants: [], value: '6' },
    }, 'edited')
    expect(e1.t).toBe('edited')
    expect(readFileSync(APP, 'utf8')).toContain('<Badge className="px-6">Live</Badge>')
    await expect(page.getByText('Live', { exact: true })).toHaveClass(/px-6/, { timeout: 10_000 })

    // 2. usage with NO className: the sanctioned append of a brand-new attribute
    const r2 = await request(ws, { t: 'resolve', loc: bare }, 'resolved')
    expect(r2.reason).toBe('no-classname')
    const e2 = await request(ws, {
      t: 'edit', id: 'inst-2', loc: r2.loc, hash: r2.hash, target: 'callsite',
      op: { kind: 'tw', group: 'px', variants: [], value: '4' },
    }, 'edited')
    expect(e2.t).toBe('edited')
    expect(readFileSync(APP, 'utf8')).toContain('<Badge className="px-4">Beta</Badge>')

    // 3. a component that does NOT forward className is refused server-side
    const r3 = await request(ws, { t: 'resolve', loc: card }, 'resolved')
    const e3 = await request(ws, {
      t: 'edit', id: 'inst-3', loc: r3.loc, hash: r3.hash, target: 'callsite',
      op: { kind: 'tw', group: 'px', variants: [], value: '4' },
    }, 'edited')
    expect(e3.t).toBe('refused')
    expect(e3.reason).toBe('not-forwarded')

    // journal + undo behave like any other edit
    const journal = await request(ws, { t: 'journal' }, 'journal')
    expect(journal.entries.map((e: any) => e.id)).toEqual(expect.arrayContaining(['inst-1', 'inst-2']))
    await request(ws, { t: 'undo', id: 'inst-2' }, 'edited')
    await request(ws, { t: 'undo', id: 'inst-1' }, 'edited')
    expect(readFileSync(APP, 'utf8')).toBe(original)
  } finally {
    ws.close()
    if (readFileSync(APP, 'utf8') !== original) writeFileSync(APP, original)
  }
})

test('conditional clsx elements resolve their static arg (Feature 1)', async ({ page }) => {
  await page.goto('http://localhost:5173')
  const toggle = page.getByRole('button', { name: 'Toggle state' })
  const stamp = await toggle.getAttribute('data-wb')
  const parts = stamp!.split(':')
  const loc = { col: Number(parts.pop()), line: Number(parts.pop()), file: parts.join(':') }

  const ws = await connect()
  try {
    const resolved = await request(ws, { t: 'resolve', loc }, 'resolved')
    // the static 'rounded-md px-4 py-2 text-sm' arg is editable; the ternary bg/text
    // branch is read-only and never surfaced as editable classes
    expect(resolved.classes).toEqual(['rounded-md', 'px-4', 'py-2', 'text-sm'])
  } finally {
    ws.close()
  }
})
