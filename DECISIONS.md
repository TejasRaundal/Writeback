# Decisions

Format: date — decision — why — alternatives rejected.

## 2026-07-22 — Committed by brief (not revisitable without human sign-off)

- pnpm workspaces; `packages/{protocol,vite-plugin,extension,panel}` + `apps/playground`.
- Panel in iframe served by bridge at `http://127.0.0.1:7331/panel`; panel owns the WS.
- Bridge in-process via `configureServer`; Vite's watcher does the HMR half (no manual reload).
- v1 className support: static string literals only, conflict-group aware. `clsx`/`cva`/expressions → `editable: false`.
- Tagging transform is parser-based (`@babel/parser` + `magic-string`), not a Babel preset, so it works under both plugin-react and plugin-react-swc.

## 2026-07-22 — M0 choices

- **Playground on Tailwind v4 + React 19** — the newer/harder target; a v3 fixture project gets added in M2 for the adapter, per brief.
- **Workspace packages export raw `.ts` (`exports: "./src/index.ts"`), no build step.** All three consumers (Vite plugin in Vite's Node process, panel via Vite, extension via its bundler) can consume TS source in dev. Publishing builds can come when we publish.
- **pnpm installed via `npm i -g`** — corepack shim install needs admin on this machine (EPERM in Program Files).
- **Playwright M1 gate drives the protocol directly** (WS client in the test) rather than loading the MV3 extension in CI, per brief's explicit allowance; extension QA'd manually.

## 2026-07-23 — Feature-sweep choices (user requested all roadmap features)

- **Drift radar scans DOM class attributes**, not source — DOM mirrors source for class strings, and it keeps the radar zero-bridge-traffic. Upgrade path: resolve-backed scan when CSS-in-JS support lands.
- **Contrast math converts any CSS color via the browser** (hidden probe element + getComputedStyle), so v4's oklch palette works without a color library.
- **Prop-chain attribution v0 is a name-match scan** (call sites of the enclosing component that pass className), not import-graph tracing. Full attribution is its own milestone per brief §OP3.
- **Variant blast-radius v0 is an informational list** of cva variant combos in the file, not rendered previews — rendering isolated variant grids needs a component-mount harness we don't have yet.
- **MCP server is dependency-free stdio JSON-RPC** proxying the bridge WS — same constrained pipeline, ~150 lines, no SDK.
- **Instance-vs-component v0**: clicking always edits the definition (the stamp lives on the definition's root host element) and the panel says so explicitly every time; call-site links offer the per-instance edit; non-forwarding components say so. Automatic call-site *editing* (adding a className prop) is deferred to full M4.
- **Deferred: CSS Modules / styled-components / vanilla CSS write-back (OP10).** Routing by styling system + CSSOM winning-rule resolution is a separate subsystem; half-shipping file writes into CSS would violate "refuse loudly, never guess". Tailwind-path refusal already covers these elements safely (`computed-classname`).
- **Deferred: branch/PR mode and the LLM mode** (M6) — `/export` markdown changelog is the seed for both.
- **Still owed for the full M2 gate**: a real Tailwind v3 fixture project (v3 path is implemented via `resolveConfig` + unit-tested logic, but not proven against a real v3 app).

## 2026-07-23 (later) — cva editing, typography groups, agent transports

- **cva editing (M5) ships for the same-file case**: `className={button()}` resolves to the cva base + the *active* variant slots (defaultVariants merged with literal call args); edits target the slot that owns the group, new groups land in the base. Dynamic variant args, non-literal bases, and cross-file cva imports refuse. Cross-file resolution is the known ceiling.
- **Typography/appearance conflict groups added to the engine** (text-size, font-weight, font-family, tracking, leading, rounded*, shadow, opacity) — required so panel font controls can't blind-append `text-lg` beside `text-sm`. `font-<custom>`, `shadow-<color>`, and `text-[arbitrary]` deliberately parse as "not ours" and are left untouched.
- **`POST /api` agent transport**: the WS message handler is shared with a plain HTTP endpoint so Codex/Cursor/CI can drive the pipeline with curl; same origin policy as WS. `AGENTS.md` is the agent-facing contract.
- **Panel defaults to light theme** with a persisted sun/moon toggle (user preference); token lists for typography/appearance are the standard Tailwind sets, hardcoded in the panel (they're spec, not project config — spacing/colors remain config-driven).

## 2026-07-23 (later) — Opus multi-agent audit: 23 confirmed bugs fixed

Ran a 6-dimension Opus finder + adversarial-verify workflow (30 agents). 23 confirmed bugs fixed, 1 refuted (a timing race that same-thread task ordering prevents). All have regression coverage (57 engine unit + 3 e2e).

Engine (source-corruption class — highest priority): text-align/wrap/overflow no longer misclassified as text-color (`TEXT_NON_COLOR`); bg-blend/opacity/clip added to `BG_NON_COLOR`; cross-segment clsx duplicates now stripped from all args (`removeTokenGroup`); segment content spliced from raw source not babel's cooked `.value` (HTML entities/escapes preserved); unified-diff hunk header now counts context lines (valid `git apply`).

Bridge/MCP: WS handler wrapped in try/catch (malformed frame no longer crashes the process) + empty-bulk guard; bulk undo resolves composite keys and undo always replies (`unknown-edit` reason added to protocol — no more silent client hang); `/health` no longer leaks the absolute root; `/api` body capped at 1 MB; MCP requests serialized + id-matched (no cross-talk on concurrent tool calls).

Extension: per-inspect nonce on the fiber round-trip (page scripts can't forge `wb-fiber`).

Panel: serialized edit queue fixes paste-only-first-token and rapid-click stale-hash refusals; multi-select re-resolves all elements after a bulk; `matchGroup` bg/text/shadow sets synced with the engine; copy guards against refused elements; `MANAGED` trimmed to groups that actually have editors (no phantom "editable" chips); `resolved` guarded by loc.

**UX shipped from the review:** hover label badge (tag + dimensions), bridge connection dot + auto-reconnect + disabled controls when down, Escape to deselect (then exit), approve bar scrolls into view, success toast on commit, keyboard-operable collapsible sections (role/tabindex/aria-expanded), aria-labels on icon controls, journal-undo reachable on focus.

**UX deferred (low value / larger):** roving-tabindex in the swatch grid, an explicit apply button on the custom-color input, "mixed" value display when multi-selected elements disagree, a drift-radar toggle button in the panel header. (All four subsequently shipped in the staging/UX pass below.)

## 2026-07-23 (later) — Renamed to "Writeback"; staging model; agent-experience tuning

- **Product renamed VCE → Writeback** across packages (`@writeback/*`), the plugin export (`writeback()`), the DOM stamp (`data-wb`), the journal dir (`.writeback/`), the MCP bin (`writeback-mcp`), health (`{writeback:true}`), env (`WRITEBACK_PORT`), and all docs. Logo: a "return-caret" mark (assets/logo-*.svg), embedded in the panel header + extension icons (rasterized to PNG); brand sheet kept editable in `artifacts/brand.html`.
- **Panel switched to a stage → Save/Reset model** (user requirement: don't write on every click). Controls preview live via inline styles; Save writes the whole draft through the serialized queue; Reset discards. Custom bracketed values flag `raw`.
- **Agent-experience pass, driven by an Opus A/B test (traditional vs Writeback on an identical task).** First run: Writeback LOST (10 calls / ~4200 tokens vs 3 / ~1450) — the agent wasted a config fetch (~3.5k tokens) and hit a misleading `computed-classname` on a wrong path. Fixes:
  - `file-not-found` refusal reason (was misreported as `computed-classname`), and the resolve reply carries `root` so path errors self-correct without a `config` call.
  - **Column-tolerant resolve**: pass just a line (`col:0`); if one JSX element is on it, snap to it and echo the element's real `loc`. Agents grep→line→resolve→edit without reading the whole file.
  - **Post-edit `hash` in every `edited` reply** + documented **`bulk` with multiple ops on one loc** → multi-property edits in one call, no re-resolve.
  - **Server-side off-scale enforcement** (`reason:"off-scale"`) so the "agents can't emit off-scale values" guarantee is real over /api+MCP, not UI-only. Bracketed values need `raw:true`. This lets agents skip `config` for known tokens (off-scale is the safety net).
  - AGENTS.md now leads with the fast path. Re-test: Writeback WINS — 0 full-file reads (vs 1), ~1050 task tokens (vs ~1450), risk none (vs low); and the gap widens with file size since traditional cost scales with the file while Writeback's stays flat (grep+resolve). Locked into e2e.
