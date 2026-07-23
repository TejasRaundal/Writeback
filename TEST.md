# Writeback Step-by-Step Test Guide

Work through the parts in order — each builds on the previous one. Every step is
**Do** → **Expect**. If what you see differs from Expect, stop and note the step number;
that's a bug. The rule under test everywhere: Writeback either edits correctly or refuses
loudly — silent wrong behavior is always a failure.

Total time: ~45 min for everything, ~10 min for Parts 1–3 only.

---

## Part 1 — Setup (once)

**Step 1.** Open a terminal in the repo and run:
```powershell
pnpm --filter @writeback/vite-plugin test
pnpm test
```
> **Expect:** all unit tests pass (currently 60+), then 3 Playwright tests pass. If these fail, fix before any browser testing — the browser can't work if the engine doesn't.

**Step 2.** Run `pnpm dev` and leave it running.
> **Expect:** Vite prints `Local: http://localhost:5173/`.

**Step 3.** Open http://localhost:5173 in Chrome.
> **Expect:** a dark "Acme Dashboard" page: nav bar, 3 stat cards, 3 buttons, an activity list.

**Step 4.** Open http://127.0.0.1:7331/health in a new tab.
> **Expect:** `{"writeback":true}`. This is the bridge. Close the tab.

**Step 5.** Go to `chrome://extensions` → toggle **Developer mode** (top right) → **Load unpacked** → select the `packages\extension` folder.
> **Expect:** "Writeback — Visual Code Editor" appears in the list with no errors.

**Step 6.** Click the puzzle-piece icon in Chrome's toolbar and pin **Writeback**.
> **Expect:** the Writeback icon is now visible in the toolbar.

---

## Part 2 — The core round trip

**Step 7.** On the playground tab, click the Writeback toolbar icon, then move your mouse over the page.
> **Expect:** a blue outline follows whatever element you hover.

**Step 8.** Click the **Revenue** card.
> **Expect:** a dark panel opens top-right. Breadcrumb shows `App › Card · src/App.tsx:35` (line may vary). Below it, the card's real classes: `rounded-lg border border-slate-800 bg-slate-900 p-6`.

**Step 9.** Open `apps/playground/src/App.tsx` in your editor, side by side with the browser. In the panel, click **+** on the `padding` stepper a few times, then click **Reset**.
> **Expect:** while stepping, the card padding changes **live on screen**, the value turns accent-colored, and a bottom bar shows "**N unsaved changes**" — but the source file is **not** touched yet (staged preview). **Reset** snaps it back; `git diff` stays clean.

**Step 10.** Stage padding again (never `p-11`/`p-[..px]` — only scale tokens), then click **Save**.
> **Expect:** now the source line changes in your editor, HMR repaints, a green "✓ Saved App.tsx" toast shows, a diff appears, and the History list gains an entry.

**Step 11.** In the `bg` swatch grid, click a different color (hover previews it live), then **Save**.
> **Expect:** the background changes and `bg-slate-900` is **replaced** (not appended) in source — the diff shows exactly one token changed.

**Step 12.** In the History list, hover a row and click **undo** on each until empty.
> **Expect:** each undo reverts the file; after the last, `git diff apps/playground/src/App.tsx` is byte-identical to the original.

---

## Part 3 — Refusal (correct "no")

**Step 13.** Click the **Toggle state** button (the third button).
> **Expect:** panel shows `not editable: computed-classname` and **no steppers**. Its className is a conditional `clsx()` — refusing is the correct behavior, at selection time, before you try anything.

**Step 14.** Click the **New report** button.
> **Expect:** refused as well (its class comes from `cva()`), **plus** a line listing the cva blast radius: `intent: primary | ghost · size: sm | md`.

**Step 15.** Click the Revenue card again. Now, in your **editor**, manually change its `p-6` to `p-7` and save. Back in the panel, click **+** on the `p` stepper *without re-clicking the card*.
> **Expect:** refused with `hash-mismatch` — the file changed under Writeback and it will not guess. Re-click the card in the page; editing works again. Manually revert your `p-7`.

---

## Part 4 — Power features

**Step 16.** Click the Revenue card. Press **↑** a few times, then **↓**. Then hold **Alt** and press **↑**. Then **Shift + ↑**.
> **Expect:** plain arrows step padding along the scale; Alt-arrows add/step margin (`m-…` appears); Shift-arrows step gap. Every value is a scale token. Undo everything via the journal.

**Step 17.** In your editor, change the Revenue card's `p-6` to `p-[17px]` and save. In the browser press **Escape**-free: just press **d** (with nothing selected — reload the page, toggle Writeback on, don't click anything, press `d`).
> **Expect:** the card gets an **amber dashed outline** — the drift radar flagging an off-scale value. Press `d` again → outline clears. Revert `p-[17px]` in your editor.

**Step 18.** Click the Revenue card, then **Shift+click** the "Active users" card.
> **Expect:** breadcrumb shows `(+1 selected)`.

**Step 19.** Click **+** on the `p` stepper.
> **Expect:** wait — both selections are the *same* source element (`Card` renders 3×), so one file edit changes all three cards at once. This is also a lesson in the instance-vs-component note the panel shows: "editing Card definition — all instances." Undo.

**Step 20.** Click the nav bar (`<nav>`), click **copy styles**. Click the "Recent activity" section, click **paste styles**.
> **Expect:** the nav's managed tokens (px-8, py-4 …) are applied to the section as normal journal-visible edits. Undo them all.

**Step 21.** Click a card, stage several different changes (padding, a text color, a radius), then click **Save** once.
> **Expect:** all staged changes are written together and the diff shows every one. History gains entries you can undo. (Staging is always on — there's no separate preview mode to toggle.)

**Step 22.** With a card selected showing both `bg` and `text` values, look above the swatch grids.
> **Expect:** a live contrast ratio (e.g. `contrast vs text (white): 12.63 AA`). Click **AA only** → failing swatches grey out and become unclickable.

**Step 23.** Click the **export** link at the panel's top-right (do a couple of edits first).
> **Expect:** a markdown changelog of the session's diffs opens. Undo your edits after.

**Step 24.** Click the `src/App.tsx:35` link in the breadcrumb.
> **Expect:** your editor jumps to that exact file and line.

---

## Part 5 — Where it must do nothing

**Step 25.** Open any non-localhost site (e.g. github.com), click the Writeback icon, hover, click around.
> **Expect:** absolutely nothing — the extension only matches localhost/127.0.0.1. No console errors from Writeback (check DevTools console).

**Step 26.** Stop `pnpm dev` (Ctrl+C). Reload the playground tab (it will error — fine). Click the Writeback icon.
> **Expect:** nothing activates — no bridge, extension stays dormant by design.

**Step 27.** Restart `pnpm dev`. Run `pnpm --filter playground exec vite build && pnpm --filter playground exec vite preview` in a second terminal and open the preview URL (usually :4173). View page source.
> **Expect:** zero `data-wb` attributes — the plugin is serve-only and ships nothing to production. Stop the preview.

**Step 28.** (Security) On the playground tab's DevTools console run:
```js
new WebSocket('ws://127.0.0.1:7331').onopen = () => console.log('open')
```
then do the same from a non-localhost site's console.
> **Expect:** "open" logs from the playground (allowed origin); from the foreign site the socket closes immediately (code 1008) — any random webpage probing your bridge is rejected before a single message is processed.

---

## Part 6 — Other browsers

**Step 29.** Repeat Part 1 steps 5–6 and Part 2 (steps 7–12) in **Edge** (`edge://extensions`).
> **Expect:** identical behavior — same Chromium MV3 engine.

**Step 30.** Repeat the same in **Brave** if you use it.
> **Expect:** identical; if edits fail, click the Brave Shields icon and allow localhost connections — Shields can block `ws://127.0.0.1`.

**Step 31.** Firefox / Safari: don't bother.
> **Expect (documented, not tested):** unsupported — Firefox lacks the MV3 MAIN-world content script setup we use; Safari needs an Xcode conversion. The extension should fail to load, not half-work.

---

## Part 7 — Real-world pages (the tests that matter most)

**Step 32.** Take one of **your own** Vite + React + Tailwind projects. Add the plugin:
```ts
// vite.config.ts
import { writeback } from '@writeback/vite-plugin'   // link the workspace or copy packages/{protocol,vite-plugin}
export default defineConfig({ plugins: [writeback(), react(), tailwind()] })
```
Run its dev server, walk Part 2 on it.
> **Expect:** same round trip on real code. Any element it can't edit safely must be refused with a reason — if you ever see a wrong edit *written*, that's the worst-severity bug this product can have; save the element's JSX and report it.

**Step 33.** If the project uses a custom theme (v4 `@theme` block or v3 `theme.extend`), open the panel on any element.
> **Expect:** your custom colors appear in the swatch grid and custom spacing tokens in the steppers — the scale is read from *your* config, never hardcoded.

**Step 34.** If you have a shadcn/ui project, click through a few of its components.
> **Expect:** plain host elements editable; anything through `cn(..., props.className)` refused **with call-site links** ("class likely arrives from a call site — edit at Page.tsx:41"); clicking a link re-targets the panel to that call site. Flawlessness here is the credibility benchmark — log anything odd.

**Step 35.** Try a non-React localhost app if you have one (Streamlit, Flask, plain HTML).
> **Expect:** dormant or inert — no stamps, no selection, no errors. Permanently out of scope, and it must *know* that.

---

## When a step fails

1. Note the step number and what differed from Expect.
2. Grab the page console + the `pnpm dev` terminal output.
3. Check `.writeback/journal.jsonl` if a file ended up in a wrong state — every Writeback write is journaled and undoable.
4. Worst case: `git checkout -- <file>` restores any file; Writeback never touches anything outside the project root.
