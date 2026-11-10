---
name: design-system
description: Inspect Writeback's resolved Tailwind scale and choose existing spacing and color tokens before making UI styling changes.
---

# Design-system-aware edits

Use this workflow before choosing a spacing or color value that is not already known.

1. Call `get_scale` once per session and cache its `root`, `spacing`, `colors`, and `fonts` response.
2. Choose an existing spacing or color key that matches the user's intent. Report the chosen token in the proposed change.
3. Resolve the target and edit it with that scale token.
4. Use `raw: true` only when the user deliberately requests an off-system bracketed Tailwind value such as `[17px]`.

For Tailwind v4, Writeback reads the installed default theme plus project CSS variables under `src/`; editable `@theme` tokens may appear in the wire-protocol config but the MCP adapter does not expose token mutation. For Tailwind v3, it resolves supported `tailwind.config.js`, `.cjs`, or `.mjs` files with Tailwind's resolver.

An `off-scale` refusal means the value is absent from the enforced scale or is malformed. Fetch the scale if it was not already cached, then choose a real token. Do not bypass validation merely to make the edit succeed.

Example: inspect the scale, select spacing token `6`, resolve the component, then call `edit` with `group: "p"` and `value: "6"`.
