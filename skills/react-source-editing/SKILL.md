---
name: react-source-editing
description: Resolve React JSX and apply constrained Tailwind edits through Writeback when a user asks to change a component's source styling.
---

# React source editing

Use Writeback's tools for supported styling changes instead of directly appending `className` tokens.

1. Call `resolve` before the first edit and echo its opaque `hash`; never compute a hash.
2. Check `classes`, `locked`, `instance`, `own`, `editFile`, and `dirty`. Confirm whether the user intends a shared definition or one call site.
3. Call `edit` with one supported group, the exact location, and the hash. Use `target: "callsite"` only on a PascalCase component usage whose component forwards `className`.
4. Show the returned unified diff. For another edit to the same file, use the post-edit hash from the `edited` result.
5. If the result is refused, surface the reason. On `hash-mismatch`, resolve again; do not retry with the stale hash.

Example:

```json
{"file":"src/App.tsx","line":22,"col":4,"hash":"<opaque>","group":"px","value":"6","variants":[]}
```

Supported groups are padding, margin, gap, background, text color, text size, font weight/family, tracking, leading, radius, shadow, and opacity. Variant chains such as `["hover"]` or `["md","hover"]` are independent from base styles.

The MCP tool edits Tailwind classes only. Text edits, bulk edits, design-token edits, checkpoints, journal export, and jump-to-source exist on the Writeback wire protocol or panel but are not exposed by the four-tool MCP adapter. Use source editing manually only after Writeback refuses and only with the user's requested scope.
