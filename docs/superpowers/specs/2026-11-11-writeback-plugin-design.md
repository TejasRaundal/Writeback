# Writeback Agent Plugin Design

## Intent

Package the existing Writeback React/Tailwind source-editing product as a portable Agent Plugin and a separately identified desktop-local MCP plugin, without weakening its edit safeguards or claiming that a loopback stdio bridge is a hosted ChatGPT service.

## Goals

- Preserve the Vite bridge, browser extension, protocol, AST editor, journal, undo, and checkpoint behavior.
- Provide a root Agent Plugins 1.0 manifest and four focused skills.
- Provide uploader-ready skills-only and desktop-local MCP ZIPs with plugin content at archive root.
- Harden the stdio MCP adapter with strict inputs, structured results, accurate tool annotations, and integration tests.
- Validate package identity, metadata, skills, paths, archive contents, and secret/build-artifact exclusions.
- Document local MCP, desktop-only ChatGPT, and future remote MCP as distinct deployment modes.

## Non-goals

- No public HTTPS MCP endpoint, authentication service, relay, or tunnel.
- No `.app.json`, MCP App UI, or lifecycle hooks in public-submission archives.
- No duplicate `.agent-plugin` or `.claude-plugin` manifests without a verified compatibility need.
- No unrelated rewrite of the tested AST engine or panel.

## Architecture

The repository root is the portable plugin package source. `plugin.json` carries the Agent Plugins identity and OpenAI listing metadata; `skills/` is discovered conventionally. The ChatGPT ZIP is skills-only and therefore omits `mcp.json`. The local archive overlays a portable stdio `mcp.json` and bundles the built dependency-free MCP entrypoint under `server/`.

The MCP process remains a local adapter: stdio JSON-RPC on one side and the Writeback loopback WebSocket bridge on the other. It exposes the existing four tools only: `get_scale`, `resolve`, `edit`, and `undo`. The bridge remains the sole authority for path confinement, optimistic locks, scale enforcement, AST verification, journaling, and undo.

## Security boundaries

- Source writes remain confined to the Vite project root, including realpath/symlink checks.
- Browser-originated bridge requests remain restricted to the bridge's own origin; headerless local tools remain supported.
- MCP inputs are validated before bridge calls and never become command execution.
- Archives exclude `.git`, environment files, journals, dependencies, temporary output, and unrelated development artifacts.
- Remote ChatGPT submission remains blocked until an authenticated HTTPS Streamable HTTP service and required legal/support URLs exist.

## Release classification

- Skills-only ChatGPT/Codex plugin: target READY after archive validation.
- Desktop-local MCP plugin: target PARTIALLY READY because public submission requires OpenAI partner allowlisting and clean-desktop testing.
- Public remote MCP plugin: BLOCKED on hosted infrastructure, authentication, domain verification, and required URLs/review assets.
