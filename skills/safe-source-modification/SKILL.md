---
name: safe-source-modification
description: Review diffs, handle Writeback refusals, and undo unsuccessful source edits when changing React UI code through Writeback.
---

# Safe source modification

Use this workflow whenever an edit will write source code.

- Treat `resolve` plus its hash as the approval boundary for the exact file state.
- Before editing a dirty file, tell the user that manual changes already exist and keep the change narrowly scoped.
- After every successful edit, show the unified diff and verify it matches the request. Writeback reparses JSX before writing, but semantic intent still needs review.
- If verification fails, call `undo` with the edit id returned by the edit. Undo succeeds only while the file still has the expected post-edit hash; surface a refusal instead of reverse-editing.
- Never retry `hash-mismatch`, `computed-classname`, `not-forwarded`, `locked-group`, or `parse-error` blindly. Re-resolve only for a stale hash; otherwise explain the limitation and stop or edit manually with care.

Example recovery:

```text
edit id mcp-3 -> diff changes the wrong shared component -> undo {"id":"mcp-3"}
```

The MCP `edit` tool writes immediately and returns the resulting diff; it has no dry-run flag. The browser panel and HTTP wire protocol support dry-run previews and bulk atomic edits. Do not claim MCP preview support that the tool does not expose.

Undo is journal-based and is not a substitute for version control. Git checkpoints are available only through the wire protocol/panel, not through the four MCP tools.
