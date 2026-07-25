<div align="center">
  <img src="assets/logo-mark.svg" alt="" width="140" height="140" />
  <h1>Writeback</h1>
  <p><strong>DevTools that writes back.</strong></p>
  <p>Click any element in your running app, adjust it visually, and the change lands in your <em>real source file</em> — constrained to your design system.</p>
</div>

---

Inspect-element shows you `<div class="flex px-4">` and lets you nudge styles that vanish on reload. **Writeback** shows you `<CardHeader>` at `Card.tsx:23`, lets you edit its spacing, color, and typography from a panel, and writes the change back into the JSX `className` — safely, through an AST, never a regex. Vite HMR shows the result instantly. Undo reverts the file.

It's a closed loop: **screen → source → screen.** The same safe edit pipeline is exposed to AI coding agents (Claude Code, Cursor, Codex) over MCP, so agents get hands that physically cannot emit off-scale values or write an unparseable file.

## Why it's different

| | Browser DevTools | Writeback |
|---|---|---|
| Edits | Throwaway overrides, lost on reload | Written to the actual source file |
| Sees | The DOM (`div.flex.px-4`) | The component (`<CardHeader>` at `Card.tsx:23`) |
| Values | Any pixel you type | Steppers over *your* resolved design scale |
| Unsafe edit | Silently applied | **Refused**, with a jump-to-source link |
| Used by | Humans | Humans **and** AI agents (same pipeline) |

Three hard rules the tool never breaks: **never regex source** (parse → locate → splice → reparse-verify, or abort), **refuse loudly** rather than guess, and **never emit off-scale values** unless you explicitly opt into a marked custom value.

## How it works

```
npm run dev
  └─ Writeback Vite plugin
       ├─ stamps host JSX with data-wb="file:line:col"  (dev only)
       └─ runs a bridge on 127.0.0.1:7331 (WS + HTTP) that resolves & edits source
browser
  └─ extension: click an element → walk the React fiber → open the panel
       └─ panel: steppers/swatches from your real theme → stage edits → Save
            └─ bridge: AST-locate the className → group-aware splice → verify → write
                 └─ Vite HMR repaints the screen
```

## Install

**1. Add the plugin** (one line — put it first):

```ts
// vite.config.ts
import { writeback } from '@writeback/vite-plugin'

export default defineConfig({
  plugins: [writeback(), react(), tailwindcss()],
})
```

Run your dev server. Confirm the bridge is up: [`127.0.0.1:7331/health`](http://127.0.0.1:7331/health) → `{"writeback":true}`. The plugin is dev-only (`apply: 'serve'`) — nothing ships to production.

**2. Add the browser extension** (for the human, visual workflow):

Chrome / Edge / Brave → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `packages/extension` (or unzip `dist/wb-extension.zip` from `pnpm pack:extension`). Reload it and refresh your app tab.

## Use it

Click the Writeback toolbar icon, then click any element.

- **Stage → Review → Write.** Every control previews live on the page; staged changes collect in the **Write rail** as real diff lines (`− p-6  + p-8`). **Review diff** shows the server's dry-run of the exact source hunk before anything touches disk; **Write to <file>** commits it. **Discard** (or per-line ✕) restores the original. Staged values render inline as `6 → 8`; unset ones show the greyed computed value so you always see what you're changing *from*.
- **Text too.** An element with plain text gets a **Text** field — edit the copy, watch it live, and it writes back into the JSX (safely escaped, whatever you type). Works even when the element's *className* is refused — computed classes don't make the text dynamic.
- **Variants.** A chip row (`base · hover: · focus: · dark: · md: · lg:`) scopes every control to that state or breakpoint — edits write the prefixed token (`hover:bg-emerald-300`) and never clobber the base value. (No live preview off `base`; the Review diff is the feedback there.)
- **Per-instance edits.** Clicking inside a shared component edits its definition — the panel says so. When the component forwards `className`, an **"Edit only this instance"** action switches to the call site: edits land on that one usage (appending a `className` if it has none).
- **Steppers & swatches** are fed from your **actual** Tailwind theme (v3 config or v4 `@theme`) — spacing, colors, type scale, radius, shadow, opacity. Off-scale values require an explicit, amber-flagged custom entry. On Tailwind v4, project tokens get a pencil: **edit the token itself** (`--color-primary`) and every use of it updates — behind an explicit confirm, since that rewrites the design system.
- **Keyboard:** `↑`/`↓` step padding, `Alt`+arrows margin, `Shift`+arrows gap, `d` drift radar (outlines off-scale values), `Shift`+click multi-select, `Ctrl/⌘+Enter` review-then-write, `Esc` deselect.
- **Trust features:** live WCAG contrast with an AA-only filter, dry-run diffs before every write, an undo history that reverts the file, jump-to-source, a session changelog at `/export`, and one-click **checkpoint** — every file this session touched, committed to a fresh `writeback/<timestamp>` git branch without disturbing your working tree.
- **Refusals are a feature.** Fully-computed classNames are refused at click time with a link to the call site. Partially-dynamic ones (`clsx('p-2', cond && 'bg-x')`) stay editable — the static part is yours, the conditional groups render locked with a reason.

### Panel header controls

The buttons in the top-right of the panel:

- **◇ Drift radar** (or press `d`) — toggles a dashed amber outline around every element whose className uses an **arbitrary value** (`p-[13px]`, `bg-[#1e1e2e]`, `leading-[1.15]`) — the one-off values that have drifted off your design scale. It's a read-only audit: nothing is changed, it just shows you where to look. The radar stays live as you edit — HMR re-renders and route changes are re-scanned automatically — and the button tooltip reports the count (`3 off-scale values`).
- **export** — opens the **session changelog** in a new tab: a Markdown document of every edit Writeback has written to your source this session, one `## file` section per file with a `diff` block. Built from the journal (`.writeback/journal.jsonl`); handy to paste into a PR description or review before committing.
- **checkpoint** — commits every file this session touched to a new `writeback/<timestamp>` branch (optional message; the changelog becomes the commit body). Your working tree and current branch are never touched — no checkout, no reset, ever.
- **☾ / ☀ Theme** — switches the panel between light and dark (remembered across sessions); independent of your app's theme.

## Use it from an AI agent

The bridge exposes the same safe pipeline to agents — they edit styling without loading files into context and can't produce a broken file. See **[AGENTS.md](AGENTS.md)** for the full contract.

**Claude Code**
```sh
claude mcp add writeback -- node <repo>/packages/mcp/dist/mcp.js
```
**Cursor** — `.cursor/mcp.json`
```json
{ "mcpServers": { "writeback": { "command": "node", "args": ["<repo>/packages/mcp/dist/mcp.js"] } } }
```
**Anything else** — plain HTTP, same protocol:
```sh
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"config"}'   # the design scale
```

Tools: `get_scale`, `resolve`, `edit` (variants + per-instance `target:"callsite"`), `undo`. The full wire protocol — text edits, `@theme` token edits, checkpoints, bulk, dry-run — rides the `/api` transport; MCP deliberately stays a small surface. Port override: `WRITEBACK_PORT`.

## Scope

React 18/19 · Tailwind CSS v3 **and** v4 · Vite. JSX frameworks only — server-rendered stacks (Flask, Rails, Django) have no component tree in the browser and are out of scope by design. Anything Writeback can't edit safely it refuses with a reason.

## Packages

| Package | What it is |
|---|---|
| `@writeback/vite-plugin` | The core: source tagging, the edit bridge, and the served panel. |
| `@writeback/mcp` | MCP server for agents — protocol-only, works against any Writeback bridge. |
| `@writeback/protocol` | The wire types shared across everything (the only coupling between packages). |
| `packages/extension` | The MV3 browser extension (packaged to a zip, not published to npm). |
| `apps/playground` | A demo app used by the test suite. |

## Develop

```sh
pnpm i            # install the workspace
pnpm dev          # playground on :5173 + bridge on :7331
pnpm test         # engine unit tests + Playwright round-trip e2e
pnpm build        # compile @writeback/{protocol,vite-plugin,mcp} to dist/
pnpm pack:extension   # dist/wb-extension.zip
pnpm release      # build + pack + full test
```

## Docs

- **[AGENTS.md](AGENTS.md)** — the contract for AI agents (MCP + HTTP), message shapes, and rules.
- **[TEST.md](TEST.md)** — a 35-step manual QA walkthrough across browsers and page types.
- **[DECISIONS.md](DECISIONS.md)** — committed architecture decisions and deliberate v0 ceilings.
- **[CLAUDE.md](CLAUDE.md)** — repo map and the hard rules, for contributors and coding agents.

## Status

The core round trip, constrained inputs for both Tailwind v3 and v4, the Write rail (dry-run review → write), text editing, variant (`hover:`/`md:`/`dark:`) editing, cross-file `cva` editing, partial editing of conditional `clsx`, per-instance call-site edits, `@theme` token editing (v4), session checkpoints to a git branch, and the agent transports are all working — 266 engine unit tests plus a 10-scenario Playwright e2e gate. Deferred: CSS-Modules / styled-components write-back and full PR mode — see [DECISIONS.md](DECISIONS.md).

## License

Not yet licensed — add one before publishing.
