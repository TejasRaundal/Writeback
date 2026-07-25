# Writeback — Visual Code Editor for local dev servers

DevTools that writes back, constrained to your design system. Browser extension +
in-process Vite bridge: click an element in the running app, adjust spacing/color
from the project's real design scale, and the edit lands in the actual source file
(JSX className) via AST splice. Vite HMR shows the result; undo reverts the file.

## Layout

- `packages/protocol` — wire types (`ClientMsg`/`ServerMsg`). The ONLY permitted coupling between packages.
- `packages/vite-plugin` — `data-wb="file:line:col"` tagging transform (host elements only, serve-only) + WS bridge on 127.0.0.1:7331 via `configureServer`.
- `packages/extension` — MV3 extension: picker + MAIN-world fiber walk. Dormant unless `GET /health` succeeds.
- `packages/panel` — vanilla-JS panel (single `index.html`, no build) served by the bridge at `/panel` in an iframe; owns the WS.
- `apps/playground` — React 19 + Tailwind v4 test app with deliberate `clsx()`/`cva()` refusal targets.

## Hard rules

- Never regex against source. Every write: parse → locate (exact line:col) → magic-string splice → reparse-verify, abort on failure.
- Refuse loudly at resolve time (`classes: null` + reason) for anything not a static string literal.
- Conflict-group-aware replacement (never blind-append — stylesheet order decides winners, not class order).
- No `_debugSource` (removed in React 19). Location authority is the `data-wb` stamp.
- Fiber walk must run in the MAIN world (isolated world can't see `__reactFiber$`).
- Origin-allowlist the WS handshake — any webpage can try ws://127.0.0.1:7331.
- One-line setup: `writeback()` in vite.config.ts + extension. Guard this bar.

## Commands

- `pnpm dev` — boot the playground (M0 gate)
- `pnpm test` — all package tests

## Milestones

M0 ✅ M1 ✅ (gate: `pnpm test`) · M2 mostly ✅ (v3 fixture project still owed) · M3 ✅ (dry-run diff approval, journal UI, bulk) ·
M4 ✅ (static clsx args ✅, per-instance call-site edits via `target:'callsite'` — server-enforced forwards check, panel instance-mode UI) · M5 ✅ (cva base + active-slot editing, cross-file cva; `@theme` token editing via `{t:'token'}` — v4 only, existing tokens only, hash required) ·
M6 seeded (checkpoint mode: `{t:'checkpoint'}` → `writeback/<ts>` branch via temp index — working tree/branch NEVER touched; full PR mode pending) ·
Editable groups: spacing, bg/text color, text-size, font-weight/family, tracking, leading, rounded, shadow, opacity — each per variant chain (`op.variants`, chains compare as sets) · element text via `{kind:'text'}` op (single static JSXText child → `resolved.text`; works on class-refused elements).
Conditional clsx: static args editable; branch-owned groups surface as `resolved.locked`, refuse `locked-group` (all chains).
OP features: nudging ✅ drift radar ✅ attribution v0 ✅ contrast ✅ copy/paste ✅ blast-list v0 ✅ git guardrail ✅ MCP ✅ export ✅ · CSS Modules/styled-components deferred.
Agent transports: MCP (`packages/mcp/src/mcp.ts`, 4 tools — text/token/checkpoint are `/api`-only by choice) + `POST /api` (same protocol over HTTP) — see `AGENTS.md`.
Panel: light/dark themed (toggle in header), collapsible Text/Spacing/Typography/Colors/Appearance sections, variant chip row,
Write rail (staged edits as diff lines; Review = server dry-run diff, then Write; bulk multi-select writes directly — protocol bulk has no dry mode),
instance-edit mode, token pencil editors, checkpoint composer.
See `DECISIONS.md` for what "v0/deferred" means per feature.
