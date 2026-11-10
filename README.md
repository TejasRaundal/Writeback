<div align="center">
  <img src="assets/logo-mark.svg" alt="Writeback" width="120" height="120" />
  <h1>Writeback</h1>
  <p><strong>Edit React UI at source.</strong></p>
  <p>Visual React inspection, Tailwind-aware AST edits, safe diffs, undo, and MCP integration for coding agents.</p>
</div>

> Status: local developer tool and desktop-local Agent Plugin. Writeback does not currently provide a hosted HTTPS MCP service.

Website: <https://tejasraundal.github.io/Teclops-AI/>

## What Writeback does

Writeback connects a rendered React element to the JSX that produced it. The Vite plugin stamps source locations during development, a local bridge resolves those locations, and the editor changes only supported Tailwind conflict groups. Every change is parsed, spliced, reparsed, journaled, and available for undo.

- Select host elements in React applications through the Chromium extension.
- Resolve exact JSX source locations and static classes.
- Replace Tailwind tokens within the correct conflict group.
- Preserve variant chains and existing class formatting.
- Reuse resolved Tailwind v3 or v4 design tokens.
- Preview changes in the browser panel and review unified diffs.
- Undo journaled changes and create non-disruptive Git checkpoints.
- Give Codex, Claude Code, and other local MCP clients the same constrained editing path.

> Screenshot placeholder: add a real product screenshot before public directory submission.

## Architecture

```text
React + Vite dev server
  └─ @writeback/vite-plugin
       ├─ stamps data-wb="file:line:col" on host JSX
       └─ starts 127.0.0.1:7331
            ├─ browser panel / extension ── visual edits
            ├─ HTTP + WebSocket protocol ─ constrained edit engine
            └─ local stdio MCP adapter ─── coding agents
                                      │
                                      └─ AST splice → reparse → write → journal → HMR
```

See [Architecture](docs/ARCHITECTURE.md) for package responsibilities and data flow.

## Install for a React project

```bash
pnpm add -D @writeback/vite-plugin
```

Put Writeback first in the Vite plugin list:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeback } from '@writeback/vite-plugin'

export default defineConfig({ plugins: [writeback(), react()] })
```

Start the dev server and verify `http://127.0.0.1:7331/health` returns `{"writeback":true}`. Load `packages/extension` as an unpacked Chromium extension for visual selection. Full instructions: [Installation](docs/INSTALLATION.md).

## MCP configuration

Build the packages, then register the local stdio server:

```json
{
  "mcpServers": {
    "writeback": {
      "command": "node",
      "args": ["/absolute/path/to/Writeback/packages/mcp/dist/mcp.js"]
    }
  }
}
```

The target application's Vite server must be running. The MCP adapter connects only to its loopback Writeback bridge.

| Tool | Behavior |
|---|---|
| `get_scale` | Read the resolved project root, spacing, colors, and fonts. |
| `resolve` | Inspect editable classes and the opaque optimistic-lock hash at a JSX location. |
| `edit` | Write one constrained Tailwind group and return a unified diff plus post-edit hash. |
| `undo` | Revert a journaled edit if the file still matches its expected post-edit state. |

See [MCP setup](docs/MCP_SETUP.md) and [ChatGPT setup](docs/CHATGPT_SETUP.md) for client-specific details.

## Plugin packages

```bash
pnpm build
pnpm pack:plugins
```

- `dist/writeback-chatgpt-plugin.zip` — skills-only, desktop-local plugin package.
- `dist/writeback-local-mcp-plugin.zip` — skills plus the bundled stdio MCP server for approved desktop-local distribution.

The local MCP archive is not a public HTTPS MCP service. OpenAI currently limits desktop-local MCP submissions to approved partners. A future hosted submission requires authenticated Streamable HTTP infrastructure and public policy/support material.

## Supported projects

- React JSX/TSX applications served by Vite 5 or newer.
- Tailwind CSS v4 themes discovered from installed theme CSS and project `@theme` variables.
- Tailwind CSS v3 configurations in `tailwind.config.js`, `.cjs`, or `.mjs`.
- Static strings, expression-free templates, selected `clsx` static segments, and supported `cva` definitions.
- Chromium browsers for the visual extension workflow.

Writeback deliberately refuses fully computed class names, ambiguous source ownership, unsupported component forwarding, stale hashes, malformed/off-scale tokens, parse failures, and paths outside the Vite root.

## Security model

- The bridge binds to `127.0.0.1` only.
- Browser requests are accepted only from the bridge's own origin; headerless local tools are treated as the local user.
- Source and token writes use lexical and realpath confinement to stop traversal and symlink escapes.
- Optimistic hashes prevent stale concurrent writes.
- JSX is reparsed before disk writes.
- No MCP tool executes arbitrary commands or accepts arbitrary filesystem roots.
- Git checkpoints use a temporary index and do not checkout, reset, or stash the working tree.

Read [Security](docs/SECURITY.md) before deploying or extending the bridge.

## Development

```bash
pnpm install
pnpm build
pnpm --filter @writeback/vite-plugin test
pnpm --filter @writeback/mcp test
pnpm test
pnpm validate:plugin
pnpm pack:plugins
```

The playground is in `apps/playground`; start it with `pnpm dev`. Manual acceptance steps are documented in [TEST.md](TEST.md).

## Troubleshooting

- `file-not-found`: use a path relative to the Vite root returned by `get_scale`, not the monorepo root.
- `hash-mismatch`: resolve again; never retry with a stale or self-computed hash.
- `off-scale`: select a token from `get_scale`, or deliberately use a bracketed value with `raw: true`.
- `computed-classname`: follow returned call-site hints when available; otherwise edit manually with care.
- MCP cannot connect: confirm the target Vite server and `127.0.0.1:7331/health`, then check `WRITEBACK_PORT`.

## Contributing

Keep changes narrow, add a failing regression test before changing behavior, and run the relevant package tests plus `pnpm test`. Security changes should include rejected-path or stale-state coverage. Do not weaken a refusal to make a demo pass.

## License

[MIT](LICENSE) © 2026 Tejas Raundal.
