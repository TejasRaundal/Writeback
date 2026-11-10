# Installation

Install `@writeback/vite-plugin`, call `writeback()` before React/Tailwind plugins in `vite.config.ts`, and run the Vite development server. The plugin uses `apply: "serve"`, so source stamps and the bridge are excluded from production builds.

The default bridge is `127.0.0.1:7331`. Pass `{ port }` to `writeback()` and set the same `WRITEBACK_PORT` for MCP when another port is required.

## Browser extension

Run `pnpm pack:extension`, open the Chromium extension manager, enable Developer Mode, and load `packages/extension` or the unpacked extension archive. Configure a non-default bridge port through extension options. Firefox and Safari are not currently supported.

## Codex and other MCP clients

Build `packages/mcp`, then register a stdio server using `node` and the absolute path to `packages/mcp/dist/mcp.js`.

Cursor, Windsurf, VS Code MCP extensions, and other standard MCP clients use the same configuration shape:

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

Place it in the MCP configuration location required by that client. No client-specific Writeback server is needed.

## Claude Code

```bash
claude mcp add writeback -- node /absolute/path/to/Writeback/packages/mcp/dist/mcp.js
```

The adapter does not start Vite or select a project; it talks to the bridge belonging to the running target app.
