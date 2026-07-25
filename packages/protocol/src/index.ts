export type Loc = { file: string; line: number; col: number }

export type TwGroup =
  | 'p' | 'px' | 'py' | 'pt' | 'pr' | 'pb' | 'pl'
  | 'm' | 'mx' | 'my' | 'mt' | 'mr' | 'mb' | 'ml'
  | 'gap' | 'gap-x' | 'gap-y'
  | 'bg' | 'text'
  | 'text-size' | 'font-weight' | 'font-family'
  | 'tracking' | 'leading'
  | 'rounded' | 'shadow' | 'opacity'

export type TwOp = { kind: 'tw'; group: TwGroup; variants: string[]; value: string; raw?: boolean }

/**
 * Replaces an element's text content — only offered when the element has exactly one
 * static JSXText child (`resolved.text` is present). Values containing JSX-special
 * characters are written as a `{"…"}` expression, so any string is safe.
 */
export type TextOp = { kind: 'text'; value: string }

export type EditOp = TwOp | TextOp

/**
 * M4 per-instance editing. Default (absent) = edit whatever the element at `loc` renders,
 * which for a component instance is its DEFINITION. `'callsite'` says: `loc` is a JSX
 * component USAGE (`<Card …>`) — edit that usage's own className instead, adding the
 * attribute if it has none. Only honoured when the component forwards className
 * (`resolved.instance.forwards`); the server re-checks and refuses `not-forwarded`.
 */
export type EditTarget = 'callsite'

export type ClientMsg =
  | { t: 'hello'; root: string }
  | { t: 'config' }
  | { t: 'resolve'; loc: Loc }
  | { t: 'edit'; id: string; loc: Loc; hash: string; op: EditOp; dry?: boolean; target?: EditTarget }
  | { t: 'bulk'; id: string; edits: { loc: Loc; hash: string; op: EditOp; target?: EditTarget }[] }  // all-or-nothing
  | { t: 'undo'; id: string }
  | { t: 'journal' }
  | { t: 'open'; loc: Loc }                                                    // jump-to-source
  /**
   * M5 / Feature C: edit ONE `@theme` design token in place — the value of an existing CSS
   * custom property in the project's own stylesheet. `name` is the full property name
   * (`--color-primary`, `--spacing-lg`, `--font-display`); `value` replaces only that
   * declaration's value. Only EXISTING tokens are editable: there is no creation path, and
   * an unknown name refuses `unknown-edit`. `hash` is REQUIRED and locks the declaring CSS
   * file — echo `config.tokens[name].hash`; a missing or stale one refuses `hash-mismatch`.
   * This edits the DESIGN SYSTEM: every utility built on the token changes, so the write is
   * gated on having just read the file it rewrites, and a client should confirm before
   * sending. Replies `edited` (with a diff, journalled and undoable like any other edit)
   * or `refused`.
   */
  | { t: 'token'; id: string; name: string; value: string; hash: string }
  /**
   * M6 seed / Feature D: snapshot this session's writes onto a NEW branch without disturbing
   * anything the user is doing. The server commits exactly the journal-touched files (at their
   * current on-disk content) to `writeback/<yyyymmdd-HHmmss>`, built from the current HEAD via a
   * temporary index — it never checks out, resets or stashes, so the working tree, the index and
   * the checked-out branch are all untouched. `message` (optional) becomes the commit subject;
   * the body is always the session changelog. Replies `checkpointed`, or `refused`
   * (`unknown-edit` = nothing in the journal yet, `git-unavailable` = no repo/HEAD/git).
   */
  | { t: 'checkpoint'; id: string; message?: string }

/**
 * `not-forwarded`: an edit writing a className onto a component usage that does not forward it.
 * `locked-group`: the element IS editable, but this group is owned by a read-only conditional
 * branch (`cond ? 'bg-a' : 'bg-b'`) — distinct from `computed-classname`, which means the
 * element is not editable at all. `resolved.locked` lists these groups up front.
 * `git-unavailable`: a `checkpoint` could not be made — no git, no repository, or no HEAD to
 * branch from. Nothing was written; it never means a half-made branch.
 */
export type RefuseReason =
  | 'hash-mismatch' | 'computed-classname' | 'parse-error' | 'unknown-edit'
  | 'file-not-found' | 'off-scale' | 'not-forwarded' | 'locked-group'
  | 'git-unavailable'

export type ServerMsg =
  | {
      t: 'config'; spacing: string[]; colors: Record<string, string>; fonts: Record<string, string>; root: string
      /**
       * Feature C: the `@theme` tokens a `{t:'token'}` edit can rewrite — name → the project
       * CSS file declaring it and that file's lock hash (echo it back as `token.hash`).
       * Tokens declared twice, nested, or with a comment in their value are omitted: if it is
       * not in here, the server would refuse the write.
       */
      tokens?: Record<string, { file: string; hash: string }>
    }
  | {
      t: 'resolved'; loc: Loc; hash: string
      classes: string[] | null
      reason?: 'computed-classname' | 'no-classname' | 'file-not-found'
      /** on file-not-found: the project root that loc.file must be relative to */
      root?: string
      /** prop-chain attribution v0: candidate call sites when this element's class came through props */
      hints?: { component: string; loc: Loc }[]
      /** cva blast radius: variant combos defined in this file that a definition edit would touch */
      blast?: string[]
      /** file has uncommitted manual changes (git guardrail) */
      dirty?: boolean
      /** M4: the enclosing component and whether it forwards className (instance edits possible) */
      instance?: { component: string; forwards: boolean }
      /**
       * Feature B: the tokens on this element's OWN className attribute — the only thing a
       * `target:'callsite'` edit can write. Present only when `loc` is a PascalCase component
       * USAGE. Distinct from `classes`, which reports what the element RENDERS: for
       * `<Card className={card()} />` that is the cva DEFINITION's classes, in another file.
       *   `[]`   — no className attribute yet; editable, the write appends the attribute
       *   `null` — the usage's own className is computed, so a call-site edit would refuse
       */
      own?: { classes: string[] | null }
      /**
       * Feature 2: the file an edit here would actually WRITE, when that is not `loc.file`
       * (a cva imported from another module). `hash` covers both files in that case — echo
       * it back on the edit rather than re-hashing anything yourself.
       */
      editFile?: string
      /** Feature 1: groups a read-only conditional branch owns — editing them refuses `locked-group` */
      locked?: TwGroup[]
      /**
       * The element's editable text content — present only when it has exactly one static
       * JSXText child, so a `{kind:'text'}` edit is safe. Editable even when `classes` is
       * null (a computed className doesn't make the TEXT dynamic).
       */
      text?: string
    }
  | { t: 'edited'; id: string; loc: Loc; diff: string; dry?: boolean; warn?: string; hash?: string }
  | { t: 'refused'; id: string; loc: Loc; reason: RefuseReason }
  | { t: 'journal'; entries: { id: string; file: string; summary: string }[] }
  /** Feature D: the branch the session was snapshotted onto, and the commit it points at. */
  | { t: 'checkpointed'; id: string; branch: string; commit: string }

export const BRIDGE_PORT = 7331
