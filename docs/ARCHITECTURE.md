# Architecture

Writeback is a local, constrained edit pipeline rather than a general-purpose code-writing service.

## Packages

| Package | Responsibility |
|---|---|
| `@writeback/protocol` | Shared wire message and location types. |
| `@writeback/vite-plugin` | Development-only source stamping, bridge, AST editing, scale resolution, journal, undo, and checkpoints. |
| `@writeback/mcp` | Local stdio MCP adapter for four constrained bridge operations. |
| `@writeback/panel` | Browser staging, preview, diff, token, undo, and checkpoint UI. |
| `@writeback/extension` | Chromium selection overlay and React fiber/source-location discovery. |
| `playground` | React/Tailwind v4 integration and Playwright round-trip fixture. |

## Edit flow

1. Vite adds `data-wb="file:line:col"` to development host JSX.
2. The extension selects an element and opens the bridge-served panel.
3. The bridge resolves the location through Babel ASTs and supported import/component patterns.
4. The client sends the opaque hash and one edit operation.
5. The bridge checks confinement, hash freshness, token syntax, scale membership, ownership, and forwarding.
6. The editor replaces the relevant conflict group, reparses, writes, journals pre/post hashes, and returns a diff.
7. Vite HMR reflects the source change.

Bulk wire-protocol edits are staged in memory and written only after every operation validates. Imported `cva` edits lock both the call site and definition.

## Deployment modes

- Local visual editing: extension/panel → loopback bridge.
- Local agent editing: MCP client → stdio adapter → loopback bridge.
- Desktop Agent Plugin: packaged skills and optional bundled stdio adapter.
- Remote ChatGPT MCP: not implemented; it requires authenticated HTTPS Streamable HTTP or a secure user-specific tunnel/relay.

The local bridge must never be exposed directly to the public internet.
