# Repository audit

Audit date: 2026-11-11.

## Dependency map

```text
extension ──health/iframe──> Vite bridge <──WebSocket── panel
                                      ▲
                                      └──WebSocket── stdio MCP adapter

vite-plugin ──types/constants──> protocol
playground ──Vite plugin───────> vite-plugin
```

The edit engine uses Babel parser, MagicString, `ws`, `launch-editor`, Node filesystem/process primitives, the installed Tailwind theme/configuration, and Git for checkpoints. The MCP adapter has no runtime SDK dependency and implements the required stdio JSON-RPC surface directly.

## Verified working in source and tests

- Development JSX stamping and location resolution.
- Static class, selected `clsx`, same/cross-file `cva`, call-site, text, variant, and theme-token paths.
- Conflict-group replacement, parse-before-write, stale hashes, bulk staging, journal undo, and checkpoints.
- Tailwind v4 discovery and Tailwind v3 configuration resolution.
- Loopback bind, browser origin checks, traversal/symlink defenses, token validation, and import confinement.
- Four MCP tools with strict inputs, structured responses, and annotations.

## Constraints and missing release material

- Chromium-only extension.
- Tailwind v3 config filenames supported: `.js`, `.cjs`, and `.mjs`.
- CSS theme scanning is limited to bounded depth under `src`.
- MCP does not expose wire-protocol bulk, dry-run, text, token, journal, editor-open, or checkpoint operations.
- No CI workflow, real screenshot/demo recording, dedicated support contact, privacy policy, or terms page exists. The product website is <https://tejasraundal.github.io/Teclops-AI/>.

## Addressed

- Strict MCP validation and invalid-params errors.
- Read/write/open-world annotations and structured output.
- Correct post-edit hash reuse guidance.
- MCP discovery/execution/rejection tests.
- Portable/compatibility manifests and four capability-accurate skills.
- Allowlists for packaging and release validation.

## Not implemented

No hosted endpoint, relay, OAuth flow, or Streamable HTTP service was invented. No MCP App mapping was added because public ZIP submissions currently reject app references. A minimal Claude plugin compatibility manifest is included; Cursor and other clients use the standard stdio MCP configuration rather than a proprietary Writeback adapter.
