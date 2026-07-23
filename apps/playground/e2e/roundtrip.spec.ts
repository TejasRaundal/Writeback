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

test('clsx elements are refused at resolve time', async ({ page }) => {
  await page.goto('http://localhost:5173')
  const toggle = page.getByRole('button', { name: 'Toggle state' })
  const stamp = await toggle.getAttribute('data-wb')
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
