# Writeback for AI agents

Writeback is a constrained edit pipeline for React + Tailwind + Vite apps. Agents should
prefer it over editing className strings directly: it resolves DOM positions to exact
source locations, replaces within the correct Tailwind conflict group (never blind-append),
verifies the file still parses before writing, and journals every change for undo.
It refuses (with a reason) instead of guessing — treat a refusal as a signal to edit
the source manually with care, not as an error to retry.

## Prerequisite

The target app's dev server must be running with the `writeback()` plugin in `vite.config.ts`.
Probe availability: `GET http://127.0.0.1:7331/health` → `{"writeback":true}`.

## The fast path (do this — it's fewer tokens than reading the file)

To change styling on an element, **do not read the whole file and do not fetch `config`**:

1. **Find the line** with one grep (`grep -n 'className="…the nav…"' src/App.tsx`). You need the line, not the column.
2. **`resolve`** with that line and `col: 0`. If a single JSX element is on the line, Writeback snaps to it and the reply echoes its **exact `loc`** plus the `classes` and a `hash`.
3. **`edit`** using the echoed `loc` and `hash`. To change several properties, send them as **one `bulk`** (multiple `op`s, same `loc`, same `hash`) — or chain single `edit`s using the `hash` returned in each `edited` reply (no re-resolve needed).

That's ~2–3 calls and a few hundred tokens, versus reading a whole component (often thousands of tokens) and reasoning about Tailwind conflict order yourself.

- You **don't need `config`** to use a token you already know (`p-8`, `bg-slate-900`). Off-scale values are refused server-side (`reason:"off-scale"`) — only then fetch `config` to see the real scale. `config` also returns `root`.
- Correctness is guaranteed: edits are group-aware (no conflicting duplicates), spliced through an AST, and re-parsed before writing. A traditional string edit can silently pick the wrong Tailwind winner; this can't.

```sh
# fast path, end to end
grep -n 'flex items-center' src/App.tsx        # → 22:    <nav className="...">
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"resolve","loc":{"file":"src/App.tsx","line":22,"col":0}}'
#   → {"t":"resolved","loc":{...,"col":4},"hash":"…","classes":["flex","px-8",…]}
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"bulk","id":"a1","edits":[
  {"loc":{"file":"src/App.tsx","line":22,"col":4},"hash":"<hash>","op":{"kind":"tw","group":"bg","variants":[],"value":"slate-900"}},
  {"loc":{"file":"src/App.tsx","line":22,"col":4},"hash":"<hash>","op":{"kind":"tw","group":"px","variants":[],"value":"6"}}]}'
#   → {"t":"edited","diff":"…"}   (both changes, one write, one undo)
```

## Transport 1 — MCP (Claude Code, MCP-capable tools)

```sh
claude mcp add writeback -- node <repo>/packages/mcp/dist/mcp.js
```
Tools: `get_scale`, `resolve`, `edit`, `undo`. Start with `get_scale`; only send scale values unless intentionally off-system (`raw: true`).

## Transport 2 — HTTP (Codex, Cursor, curl, CI, any tool)

`POST http://127.0.0.1:7331/api` with one JSON message; the reply is the response message
(or an array when a message produces several). Message shapes are `ClientMsg`/`ServerMsg`
in `packages/protocol/src/index.ts` — the single source of truth.

```sh
# 1. design scale (spacing tokens + palette)
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"config"}'

# 2. what is at a source location? (get loc from a data-wb attribute, or from reading the JSX)
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"resolve","loc":{"file":"src/App.tsx","line":35,"col":4}}'
# → {"t":"resolved","hash":"…","classes":["rounded-lg","p-6",…]}  or  classes:null + reason

# 3. edit — hash from resolve is an optimistic lock; group ∈ p|px|py|pt|pr|pb|pl|m*|gap*|bg|text|text-size|font-weight|font-family|tracking|leading|rounded|shadow|opacity
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"edit","id":"a1","loc":{"file":"src/App.tsx","line":35,"col":4},"hash":"<from resolve>","op":{"kind":"tw","group":"p","variants":[],"value":"8"}}'
# → {"t":"edited","diff":"--- a/src/App.tsx …"}  or  {"t":"refused","reason":"hash-mismatch|computed-classname|parse-error|not-forwarded|locked-group"}
#   add "target":"callsite" to style ONE component usage instead of the component itself

# 4. undo by edit id
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"undo","id":"a1"}'

# journal list / dry-run preview
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"journal"}'
#   add "dry":true to an edit for a no-write diff preview
```

## Variants (`hover:` / `md:` / `dark:` …)

`op.variants` is a chain of state/breakpoint prefixes. `{"group":"bg","variants":["hover"],"value":"emerald-300"}`
writes `hover:bg-emerald-300`, replacing only within that same chain — base and variant values of one
group are independent tokens and never clobber each other (chains compare as sets, so `md:hover:` ==
`hover:md:`). Off-scale enforcement applies to variant ops exactly like base ones. A `locked` group is
locked for **every** chain.

## Editing an element's TEXT (`op: {"kind":"text","value":"…"}`)

When `resolved.text` is present (the element has exactly one static text child — also on elements whose
*className* is refused; computed classes don't make the text dynamic), an edit op of
`{"kind":"text","value":"New label"}` replaces that text. Same pipeline: AST splice, reparse-verify,
journal/undo, `dry` supported. Values containing `{ } < >` or meaningful whitespace are written as a
`{"…"}` JSX expression, so any string is safe. Never scale-checked. This is intentionally **not** an MCP
tool (an agent that wants to rewrite text at scale can edit the file); it exists on the wire because the
panel uses it — over `/api` it simply works.

## Design-token editing (`{"t":"token"}`) — Tailwind v4 `@theme`

Edit an existing design token itself (every utility using it updates):

```sh
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"config"}'                       # tokens + hash source
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"token","id":"t1","name":"--color-primary","value":"#0b7a6e","hash":"<from resolve/config flow>"}'
```

Only tokens that already exist in the project's `@theme` block are editable (no creation); duplicates or
ambiguity refuse. `hash` is **required** — this rewrites the design system, so it is never accepted
unlocked. Journal/undo/`/export` cover it like any other edit. v4 only.

## Session checkpoint (`{"t":"checkpoint"}`)

Snapshots every journal-touched file onto a new git branch `writeback/<timestamp>` **without touching
the working tree or current branch** (temporary index, no checkout/reset ever). Reply:
`{"t":"checkpointed","branch":"writeback/…","commit":"…"}`. Refused `unknown-edit` when the journal is
empty, `git-unavailable` outside a repo. The commit body is the session changelog (`/export`).

## Editing ONE instance instead of the shared component (`target:"callsite"`)

A `loc` inside a reusable component (`<Card>`'s own markup) edits the **component definition** —
every `<Card>` in the app changes. To restyle a single usage, send the edit with
`"target":"callsite"` and the `loc` of the **JSX usage** (`<Card title="…" />` in the parent file):

```sh
# resolve tells you the enclosing component and whether it accepts a className
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"resolve","loc":{"file":"src/App.tsx","line":36,"col":6}}'
#   → {"t":"resolved","classes":[…],"instance":{"component":"Card","forwards":true},
#      "hints":[{"component":"Card","loc":{"file":"src/App.tsx","line":55,"col":10}}]}

# `hints` are the call sites. resolve one to get ITS hash, then edit with target:"callsite"
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"resolve","loc":{"file":"src/App.tsx","line":55,"col":10}}'
curl -s -X POST 127.0.0.1:7331/api -d '{"t":"edit","id":"i1","target":"callsite",
  "loc":{"file":"src/App.tsx","line":55,"col":10},"hash":"<hash of the CALL-SITE file>",
  "op":{"kind":"tw","group":"px","variants":[],"value":"6"}}'
```

- The edit always lands in the **call-site file**, never the component's.
- Resolving a component USAGE also returns `own: {classes}` — the usage's **own** className attribute
  (`[]` = none yet, the write will append it; `null` = computed, a call-site edit would refuse). Its
  presence is the "is this call-site-editable" test.
- The usage's className is handled three ways: a **static string** (or expression-free template)
  gets the normal group-aware replacement; **no `className` at all** gets a brand-new
  `className="…"` attribute appended (still an AST splice + reparse-verify — the only place
  Writeback adds an attribute); anything **computed** is refused `computed-classname`.
- Guarded server-side: if the component doesn't forward className (no `className` prop, no
  `{...props}` spread), the edit is refused `not-forwarded` rather than writing a class the
  component would silently drop. Check `resolved.instance.forwards` first. The component is
  followed through relative imports and barrel re-exports; if its definition can't be read
  (bare/`node_modules` specifier, unresolvable module) the answer is also `not-forwarded`.
- A `warn` on the `edited` reply means the write went through but the component sets a class in
  the same conflict group on its own root and does not use tailwind-merge — both classes reach the
  DOM and stylesheet order, not source order, picks the winner. Surface it.
- `target` is only meaningful on a PascalCase component usage — a host element (`<div>`) with
  `target:"callsite"` is refused `unknown-edit`. Omit `target` and it edits normally.
- `bulk` edits accept the same optional `target` per entry. Journal, `undo` and `/export`
  treat these like any other edit.
- MCP exposes the same capability as the `edit` tool's `target: "callsite"` argument.

## `loc.file` — paths are relative to the dev-server root, NOT the repo

This trips agents up first, so get it right up front. `loc.file` is resolved against the **project root** (the directory the dev server runs from), or you may pass an **absolute** path. It is **not** repo-relative.

Call `{"t":"config"}` once — its `root` field tells you the base (e.g. `.../apps/playground`). So for a file at `<root>/src/App.tsx`, use `"file":"src/App.tsx"` (or the full absolute path) — **not** `"apps/playground/src/App.tsx"`.

If a `resolve`/`edit` comes back with `reason:"file-not-found"` and an empty hash, the path is wrong — fix the path, don't probe columns. (A genuine "can't edit this" is `computed-classname` or `no-classname`, and still carries a real hash.)

## Finding a `loc`

`loc` is the exact `line:col` (1-based line, 0-based col) of the JSX opening element.
Sources, in preference order:
1. In a browser context: the element's `data-wb="file:line:col"` attribute (dev-only stamp) — this path is already root-relative and correct.
2. Statically: read the file; the loc is the position of `<` of the opening tag. Multiple elements per line are normal — col must be exact.

## Rules for agents

- Always `resolve` before your FIRST `edit`; reuse the returned `hash`. A `hash-mismatch` refusal means the file changed — re-resolve, don't retry blindly.
- **`hash` is an opaque token — echo it, never compute it.** For a cva imported from another module the edit writes a DIFFERENT file than `loc.file` (`resolved.editFile` names it), and the token locks *both* files: the definition that receives the write, and the call site that decides which variant slot gets written. Re-hashing a file yourself will mismatch.
- `reason:"locked-group"` = the element is editable, but that one group is owned by a read-only conditional branch (`cond ? 'bg-a' : 'bg-b'`), so a static edit would lose at runtime. `resolved.locked` lists these groups up front — pick another group, or edit the branch by hand. This is distinct from `computed-classname`, which means the element is not editable at all.
- **Chaining edits to the same file:** every `edited` reply now includes the post-edit `hash`. Use it as the `hash` for your next `edit` on that file — no re-resolve needed between edits. (One `edit` = one conflict group, so multi-property changes are a short chain.)
- `reason:"file-not-found"` = wrong `loc.file` path; the reply includes `root` so you can fix it inline (no `config` call needed).
- `reason:"off-scale"` = your `value` isn't in the project's spacing scale or color palette. The design system is **enforced server-side** — pick a real token from `config`, or pass `raw:true` with a bracketed value (e.g. `"[17px]"`) to deliberately go off-scale.
- Call `config` **once** and cache it — the color palette is large; re-fetching it per edit wastes context.
- `classes: null` with `computed-classname`/`no-classname` means the className is computed (clsx with expressions, dynamic cva args, props). Follow the `hints` array (call sites) if present; otherwise edit the file conventionally.
- Styling a shared component changes every usage. When `resolved.instance.forwards` is `true` and the user meant "just this one", edit the call site with `target:"callsite"` (see above) instead.
- Every successful edit returns a unified `diff` — surface it to the user.
- Undo via the protocol (`{"t":"undo","id":…}`), not by reverse-editing.
- The playground for smoke-testing lives at `apps/playground` (`pnpm dev`).
- Verification commands: `pnpm --filter @writeback/vite-plugin test` (engine), `pnpm test` (e2e round trip).

- `reason:"off-scale"` also covers **malformed values**: whitespace, quotes, braces, `$`, backslashes
  and `:` inside a chain segment are refused before any splice — token values are class tokens, not
  markup.

## Security note

The bridge binds 127.0.0.1 only. Browser-originated requests must come from the bridge's **own
origin** (the served panel); every other web origin — including other localhost ports — is rejected.
Requests without an Origin header (curl, Node, MCP) are treated as the local user. Do not proxy or
tunnel the port.
