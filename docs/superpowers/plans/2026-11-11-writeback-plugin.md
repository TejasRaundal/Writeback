# Writeback Agent Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship validated skills-only and desktop-local Writeback plugin archives while hardening and testing the existing MCP adapter.

**Architecture:** Keep the existing application packages intact. Add portable plugin metadata and skills at the repository root, improve the local stdio MCP boundary, and build clean archives from an explicit allowlist.

**Tech Stack:** TypeScript, Node.js, MCP JSON-RPC over stdio, WebSocket bridge, Vitest, Agent Plugins 1.0 JSON schemas.

**Spec:** `docs/superpowers/specs/2026-11-11-writeback-plugin-design.md`

## Global Constraints

- Do not invent a hosted MCP URL, credentials, or legal/support URLs.
- Preserve uncommitted user changes and existing behavior.
- Add no dependency unless existing platform or workspace tooling cannot perform the work.
- Public-submission ZIPs contain no `.app.json` or lifecycle hooks.
- All new behavior follows red-green TDD.

## Review Focus

- Malformed MCP tool arguments must return JSON-RPC errors without reaching the bridge.
- Unknown tools and methods must return correct protocol errors.
- Tool results must provide both model-readable text and structured content.
- Archives must have plugin files at root and exclude sensitive/unrelated files.
- Missing hosted infrastructure must be reported as a blocker, never represented by a placeholder endpoint.

---

### Task 1: MCP boundary hardening

**Files:**
- Modify: `packages/mcp/src/mcp.ts`
- Create: `packages/mcp/test/mcp.test.ts`
- Modify: `packages/mcp/package.json`

**Interfaces:**
- Consumes: existing Writeback bridge messages.
- Produces: validated MCP `tools/list` and `tools/call` responses for `get_scale`, `resolve`, `edit`, and `undo`.

- [ ] Write process-level tests for discovery, annotations, structured output, rejected inputs, unknown tools, and bridge errors.
- [ ] Run the focused tests and confirm the new assertions fail.
- [ ] Add strict validation, protocol errors, annotations, and structured results without changing bridge semantics.
- [ ] Run focused and workspace tests.

### Task 2: Portable manifests and agent skills

**Files:**
- Create: `plugin.json`
- Create: `.codex-plugin/plugin.json`
- Create: `plugin.local-mcp.json`
- Create: `skills/*/SKILL.md`

**Interfaces:**
- Consumes: verified MCP tool behavior and OpenAI/Agent Plugins schemas.
- Produces: portable plugin identity, compatibility metadata, and four workflows matching actual capabilities.

- [ ] Add validation fixtures/assertions for required metadata and skill frontmatter.
- [ ] Confirm validation fails while files are absent.
- [ ] Add the smallest schema-supported manifests and focused skills.
- [ ] Validate names, paths, listing limits, and examples.

### Task 3: Release validator and archive builder

**Files:**
- Create: `scripts/validate-plugin.mjs`
- Create: `scripts/build-plugin-archives.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `dist/writeback-chatgpt-plugin.zip` and `dist/writeback-local-mcp-plugin.zip` from explicit file allowlists.

- [ ] Add self-tests/assertions for invalid paths, secrets, nested roots, and exclusions.
- [ ] Confirm validation fails on an intentionally incomplete staged package.
- [ ] Implement validation and deterministic staging/archive creation using Node and available system ZIP support.
- [ ] Inspect both ZIP entry lists and run validation against extracted contents.

### Task 4: Documentation and release report inputs

**Files:**
- Modify: `README.md`
- Create: `docs/ARCHITECTURE.md`
- Create: `docs/INSTALLATION.md`
- Create: `docs/CHATGPT_SETUP.md`
- Create: `docs/MCP_SETUP.md`
- Create: `docs/SECURITY.md`
- Create: `docs/AUDIT.md`

- [ ] Document verified architecture, supported modes, security model, tests, limitations, and blockers.
- [ ] Check every command and relative link.
- [ ] Run build, unit tests, e2e tests, plugin validation, and archive inspection.
