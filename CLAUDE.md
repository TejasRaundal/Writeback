# Writeback — Visual Code Editor for local dev servers

DevTools that writes back, constrained to your design system. Browser extension +
in-process Vite bridge: click an element in the running app, adjust spacing/color
from the project's real design scale, and the edit lands in the actual source file
(JSX className) via AST splice. Vite HMR shows the result; undo reverts the file.

## Layout

- `packages/protocol` — wire types (`ClientMsg`/`ServerMsg`). The ONLY permitted coupling between packages.
- `packages/vite-plugin` — `data-wb="file:line:col"` tagging transform (host elements only, serve-only) + WS bridge on 127.0.0.1:7331 via `configureServer`.
- `packages/extension` — MV3 extension: picker + MAIN-world fiber walk. Dormant unless `GET /health` succeeds.
- `packages/panel` — React panel served by the bridge at `/panel` in an iframe; owns the WS.
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
M4 partial (static clsx args ✅, instance-vs-component v0) · M5 partial (cva base + active-slot editing ✅; `@theme` token editing pending) ·
Editable groups: spacing, bg/text color, text-size, font-weight/family, tracking, leading, rounded, shadow, opacity.
OP features: nudging ✅ drift radar ✅ attribution v0 ✅ contrast ✅ copy/paste ✅ blast-list v0 ✅ git guardrail ✅ MCP ✅ export ✅ · CSS Modules/styled-components deferred.
Agent transports: MCP (`src/mcp.ts`) + `POST /api` (same protocol over HTTP) — see `AGENTS.md`.
Panel: light/dark themed (toggle in header), collapsible Spacing/Typography/Colors/Appearance sections.
See `DECISIONS.md` for what "v0/deferred" means per feature.
