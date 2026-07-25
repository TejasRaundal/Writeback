import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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

test('variant-chain edits write a prefixed token beside the base one (Feature A)', async ({ page }) => {
  const original = readFileSync(APP, 'utf8')
  await page.goto('http://localhost:5173')
  const link = page.locator('nav a').filter({ hasText: 'Overview' })
  const stamp = await link.getAttribute('data-wb')
  const parts = stamp!.split(':')
  const loc = { col: Number(parts.pop()), line: Number(parts.pop()), file: parts.join(':') }

  const ws = await connect()
  try {
    const resolved = await request(ws, { t: 'resolve', loc }, 'resolved')
    // variant tokens are ordinary classes to resolve — the panel's chip row scopes them
    expect(resolved.classes).toContain('hover:text-white')

    // an md: op appends a prefixed token; the base classes are a different conflict group
    const edited = await request(
      ws,
      { t: 'edit', id: 'var-1', loc, hash: resolved.hash, op: { kind: 'tw', group: 'p', variants: ['md'], value: '2' } },
      'edited',
    )
    expect(edited.t).toBe('edited')
    const after = readFileSync(APP, 'utf8')
    expect(after).toContain('text-slate-400 hover:text-white text-sm md:p-2')
    await expect(link).toHaveClass(/md:p-2/, { timeout: 10_000 })

    // and the variant token itself is editable in place, base left alone
    const reresolved = await request(ws, { t: 'resolve', loc }, 'resolved')
    const hovered = await request(
      ws,
      { t: 'edit', id: 'var-2', loc, hash: reresolved.hash, op: { kind: 'tw', group: 'text', variants: ['hover'], value: 'slate-100' } },
      'edited',
    )
    expect(hovered.t).toBe('edited')
    expect(readFileSync(APP, 'utf8')).toContain('text-slate-400 hover:text-slate-100 text-sm md:p-2')

    await request(ws, { t: 'undo', id: 'var-2' }, 'edited')
    await request(ws, { t: 'undo', id: 'var-1' }, 'edited')
    expect(readFileSync(APP, 'utf8')).toBe(original)
  } finally {
    ws.close()
    if (readFileSync(APP, 'utf8') !== original) writeFileSync(APP, original)
  }
})

/**
 * Feature B: the panel's per-instance mode, driven through the real panel UI (served by the
 * bridge at /panel, so it can be loaded top-level and postMessage'd exactly like the
 * extension does). This is the only test that proves the CLIENT half: that the controls in
 * instance mode reflect the USAGE's own className (resolved.own) and that every edit leaves
 * with target:'callsite'.
 */
test('the panel switches into per-instance mode and writes the call site (Feature B)', async ({ page }) => {
  const original = readFileSync(APP, 'utf8')
  // the Badge DEFINITION's root span — a cn(base, className) refusal that nonetheless
  // forwards className, which is exactly what per-instance editing exists for
  const defLine = original.split('\n').findIndex((l) => l.includes("<span className={clsx('rounded-full"))
  // an exact line:col, the way the picker's data-wb stamp gives it — the panel matches the
  // resolve reply against the loc it asked for, and a tolerant col-0 match echoes a different one
  const defLoc = { file: 'src/App.tsx', line: defLine + 1, col: original.split('\n')[defLine].indexOf('<span') }

  await page.goto('http://127.0.0.1:7331/panel')
  // the panel only speaks once its own socket is up — the journal reply is the proof
  await expect(page.locator('.histhead')).toBeVisible()

  try {
    await page.evaluate((loc) => window.postMessage({ t: 'wb-select', loc, components: ['Badge'], computed: {} }, '*'), defLoc)

    // the definition refuses, but offers the switch per call site
    await expect(page.locator('.refused .code')).toHaveText('computed-classname')
    const go = page.locator('.instbtn').first()
    await expect(go).toBeVisible()
    await go.click()

    // mode pill names the usage being edited, and the controls now show ITS classes
    await expect(page.locator('.modepill')).toContainText('instance edit')
    await expect(page.locator('.modepill .loc')).toContainText('App.tsx:')
    await expect(page.locator('.tokens')).toContainText('px-3')

    // bump `pad x` — the same stepper as definition mode, now addressing the usage
    const padx = page.locator('.row').filter({ has: page.getByText('pad x', { exact: true }) })
    await padx.locator('.stepper button').last().click()
    await expect(page.locator('#rail')).toBeVisible()

    // Review runs a server dry-run with target:'callsite' — the diff must be the USAGE line
    await page.locator('#review').click()
    await expect(page.locator('#dryrun')).toBeVisible()
    await expect(page.locator('#drypre')).toContainText('<Badge className="px-3.5">Live</Badge>')
    expect(readFileSync(APP, 'utf8')).toBe(original) // dry-run wrote nothing

    await page.locator('#save').click()
    await expect.poll(() => readFileSync(APP, 'utf8')).toContain('<Badge className="px-3.5">Live</Badge>')
    // the Badge COMPONENT is untouched — only this one instance moved
    expect(readFileSync(APP, 'utf8')).toContain("clsx('rounded-full px-2 py-0.5 text-xs")

    // leaving instance mode returns to the component, which still refuses
    await page.locator('.modepill .exit').click()
    await expect(page.locator('.modepill')).toHaveCount(0)
    await expect(page.locator('.refused .code')).toHaveText('computed-classname')

    // undo from the panel's own history restores the file byte-identically
    await page.locator('.journal .e button').first().click()
    await expect.poll(() => readFileSync(APP, 'utf8')).toBe(original)
  } finally {
    if (readFileSync(APP, 'utf8') !== original) writeFileSync(APP, original)
  }
})

/**
 * Feature C: `@theme` design-token editing, driven through the real panel UI. This is the
 * only edit in the product that does NOT go through the write rail — it rewrites the design
 * system itself — so the things worth proving here are the ones the bridge tests cannot see:
 * that the affordance appears only on swatches the server called editable, that the panel
 * makes you confirm the unknowable blast radius, and that History undoes it like anything else.
 */
test('the panel edits an @theme token through its confirm step (Feature C)', async ({ page }) => {
  const CSS = join(__dirname, '..', 'src', 'index.css')
  const original = readFileSync(CSS, 'utf8')
  const app = readFileSync(APP, 'utf8').split('\n')
  // an ordinary editable element — any selection renders the Colors section
  const line = app.findIndex((l) => l.includes('>Overview</a>'))
  const loc = { file: 'src/App.tsx', line: line + 1, col: app[line].indexOf('<a') }

  await page.goto('http://127.0.0.1:7331/panel')
  await expect(page.locator('.histhead')).toBeVisible()

  try {
    await page.evaluate((l) => window.postMessage({ t: 'wb-select', loc: l, components: [], computed: {} }, '*'), loc)
    await expect(page.locator('.tokens')).toContainText('text-slate-400')

    // exactly one colour in the palette is a project token, and only it carries the ✎
    const pen = page.locator('.colorblock').first().locator('.swpen')
    await expect(pen).toHaveCount(1)
    await expect(page.locator('.colorblock').first().locator('.swcell.istok .sw')).toHaveAttribute('title', /project token/)
    await pen.click()

    // the editor names the token AND the file it will rewrite, prefilled with the real value
    await expect(page.locator('.tokedit .tname')).toHaveText('--color-brand · src/index.css')
    await expect(page.locator('.tokedit input')).toHaveValue('#ff6600')
    await page.locator('.tokedit input').fill('#00cc88')

    // the blast radius is unknowable from here, so it is stated, not counted
    await page.getByRole('button', { name: 'Save token…' }).click()
    await expect(page.locator('.tokedit .warn')).toContainText('Changes every use of this token')
    expect(readFileSync(CSS, 'utf8')).toBe(original) // nothing written until it is confirmed

    await page.getByRole('button', { name: 'Apply to design system' }).click()
    await expect.poll(() => readFileSync(CSS, 'utf8')).toContain('--color-brand: #00cc88;')
    // only the value moved — the surrounding declarations are byte-identical
    expect(readFileSync(CSS, 'utf8')).toBe(original.replace('#ff6600', '#00cc88'))

    // the panel re-fetched config, so the swatch now paints the NEW value
    await expect(page.locator('.colorblock').first().locator('.swcell.istok .sw'))
      .toHaveCSS('background-color', 'rgb(0, 204, 136)')

    // and it undoes from History like any other write
    await page.locator('.journal .e button').first().click()
    await expect.poll(() => readFileSync(CSS, 'utf8')).toBe(original)

    // …including in the panel's own head: undo restored the FILE, so the design system the
    // panel is holding has to come back with it. It used to keep the undone value (and the
    // undone lock hash, which then refused every later token write as hash-mismatch).
    await expect(page.locator('.colorblock').first().locator('.swcell.istok .sw'))
      .toHaveCSS('background-color', 'rgb(255, 102, 0)')
    await page.locator('.colorblock').first().locator('.swpen').click()
    await expect(page.locator('.tokedit input')).toHaveValue('#ff6600')
    await page.locator('.tokedit input').fill('#0044ff')
    await page.getByRole('button', { name: 'Save token…' }).click()
    await page.getByRole('button', { name: 'Apply to design system' }).click()
    await expect.poll(() => readFileSync(CSS, 'utf8')).toContain('--color-brand: #0044ff;')
    await page.locator('.journal .e button').first().click()
    await expect.poll(() => readFileSync(CSS, 'utf8')).toBe(original)
  } finally {
    if (readFileSync(CSS, 'utf8') !== original) writeFileSync(CSS, original)
  }
})

/**
 * Review finding: a locked group (one a runtime conditional owns) rendered fully live controls.
 * Every such edit is refused server-side, and staging one alongside a good edit was what made a
 * REFUSED dry-run still render a diff and arm Write. The controls are inert now, so the whole
 * sequence is unreachable from the UI.
 */
test('locked groups render read-only controls that cannot be staged', async ({ page }) => {
  const original = readFileSync(APP, 'utf8')
  const app = original.split('\n')
  // the clsx element whose bg/text live in a `active ? … : …` branch
  const line = app.findIndex((l) => l.includes("active ? 'bg-amber-500 text-black'")) - 1
  const loc = { file: 'src/App.tsx', line: line + 1, col: app[line].indexOf('<button') }

  await page.goto('http://127.0.0.1:7331/panel')
  await expect(page.locator('.histhead')).toBeVisible()
  await page.evaluate((l) => window.postMessage({ t: 'wb-select', loc: l, components: [], computed: {} }, '*'), loc)

  // the server said `locked: [bg, text]`, and the banner says so for every variant chain
  await expect(page.locator('.banner.amber')).toContainText('read-only in every variant')
  const colors = page.locator('.colorblock').first()
  await expect(colors).toHaveClass(/locked/)
  await expect(colors.locator('.sw').first()).toBeDisabled()
  await expect(colors.locator('.custom')).toBeDisabled()

  // an editable group on the SAME element still stages normally — only the locked axes are inert
  const padx = page.locator('.row').filter({ has: page.getByText('pad x', { exact: true }) })
  await expect(padx).not.toHaveClass(/locked/)
  await padx.locator('.stepper button').last().click()
  await expect(page.locator('#rail')).toBeVisible()
  await expect(page.locator('#railn')).toHaveText(/1 change/) // the locked group never joined it
  expect(readFileSync(APP, 'utf8')).toBe(original) // staged only — nothing written
})

/**
 * Feature D: the checkpoint composer. The bridge tests own the git half (they run in a
 * throwaway repository); what only a browser can prove is the panel half — and specifically
 * that the subject is asked for INLINE. The panel really ships inside a cross-origin iframe,
 * where `prompt()` is ignored by the browser and returns undefined, so a dialog-based
 * composer would be dead on arrival in the one client that matters.
 *
 * This test deliberately never sends the frame: the playground root lives inside THIS
 * repository, so a real checkpoint would branch and commit the developer's own working copy.
 * The final assertion is that no `writeback/*` ref appeared.
 */
test('the checkpoint composer opens inline and never opens a browser dialog (Feature D)', async ({ page }) => {
  const original = readFileSync(APP, 'utf8')
  const app = original.split('\n')
  const line = app.findIndex((l) => l.includes('>Overview</a>'))
  const loc = { file: 'src/App.tsx', line: line + 1, col: app[line].indexOf('<a') }
  const branches = () =>
    execFileSync('git', ['branch', '--list', 'writeback/*'], { cwd: join(__dirname, '..', '..', '..'), encoding: 'utf8' }).trim()
  const before = branches()

  await page.goto('http://127.0.0.1:7331/panel')
  await expect(page.locator('.histhead')).toBeVisible()
  const button = page.locator('#checkpoint')

  try {
    // a write is what a checkpoint is made of: until the session has one, the button is inert
    await page.evaluate((l) => window.postMessage({ t: 'wb-select', loc: l, components: [], computed: {} }, '*'), loc)
    await expect(page.locator('.tokens')).toBeVisible()
    const padx = page.locator('.row').filter({ has: page.getByText('pad x', { exact: true }) })
    await padx.locator('.stepper button').last().click()
    await page.locator('#save').click()
    await expect.poll(() => readFileSync(APP, 'utf8')).not.toBe(original)
    await expect(button).toBeEnabled()

    // the composer is real DOM in the panel, not a browser dialog
    await button.click()
    const box = page.locator('#ckedit')
    await expect(box).toBeVisible()
    await expect(box.locator('.tname')).toHaveText('CHECKPOINT → NEW BRANCH')
    const input = box.locator('input')
    await expect(input).toBeFocused()
    await input.fill('tighten the nav')

    // Escape abandons it — nothing sent, nothing committed
    await input.press('Escape')
    await expect(box).toBeHidden()
    await expect(button).not.toHaveClass(/open/)

    // the header button toggles its own composer, and ✕ closes it — still nothing sent
    await button.click()
    await expect(box).toBeVisible()
    await button.click()
    await expect(box).toBeHidden()
    await button.click()
    await box.locator('.btn.ghost').click()
    await expect(box).toBeHidden()

    await page.locator('.journal .e button').first().click()
    await expect.poll(() => readFileSync(APP, 'utf8')).toBe(original)
  } finally {
    if (readFileSync(APP, 'utf8') !== original) writeFileSync(APP, original)
  }
  expect(branches()).toBe(before) // the composer never branched this repository
})
