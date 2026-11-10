---
name: visual-inspection
description: Inspect a selected React UI element, identify its stamped source location, and report what Writeback can safely edit.
---

# Visual inspection

Use this workflow when the user selects or points to an element in a React app running with the Writeback Vite plugin.

1. Confirm the bridge health endpoint reports `{"writeback":true}`. If it is unavailable, ask the user to start the Vite dev server; do not guess a source location.
2. Prefer the selected DOM element's `data-wb="file:line:col"` stamp. The file is relative to the Vite project root, the line is 1-based, and the column is 0-based.
3. Call `resolve` with that exact location. When only a source line is known and it contains one JSX element, `col: 0` lets Writeback snap to the opening element.
4. Report the resolved location, current classes, static text when present, locked groups, call-site hints, and whether the file is dirty. Do not edit unless the user requested a change.

Example:

```json
{"file":"src/App.tsx","line":22,"col":0}
```

A `file-not-found` result means the file path was not relative to the Vite root. A `computed-classname` or `no-classname` result is a safe refusal, not a reason to probe arbitrary columns. Component definitions affect every usage; when the user means one instance, follow a call-site hint and verify `instance.forwards` before using a call-site edit.

Writeback stamps host JSX elements only. It does not provide reliable selection for non-React pages, production builds, or components without a resolvable host element.
