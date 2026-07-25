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
  | { t: 'edit'; id: string; loc: Loc; hash: string; op: TwOp; dry?: boolean; target?: EditTarget }
  | { t: 'bulk'; id: string; edits: { loc: Loc; hash: string; op: TwOp; target?: EditTarget }[] }   // all-or-nothing
  | { t: 'undo'; id: string }
  | { t: 'journal' }
  | { t: 'open'; loc: Loc }                                                    // jump-to-source

/**
 * `not-forwarded`: an edit writing a className onto a component usage that does not forward it.
 * `locked-group`: the element IS editable, but this group is owned by a read-only conditional
 * branch (`cond ? 'bg-a' : 'bg-b'`) — distinct from `computed-classname`, which means the
 * element is not editable at all. `resolved.locked` lists these groups up front.
 */
export type RefuseReason =
  | 'hash-mismatch' | 'computed-classname' | 'parse-error' | 'unknown-edit'
  | 'file-not-found' | 'off-scale' | 'not-forwarded' | 'locked-group'

export type ServerMsg =
  | { t: 'config'; spacing: string[]; colors: Record<string, string>; fonts: Record<string, string>; root: string }
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
       * Feature 2: the file an edit here would actually WRITE, when that is not `loc.file`
       * (a cva imported from another module). `hash` covers both files in that case — echo
       * it back on the edit rather than re-hashing anything yourself.
       */
      editFile?: string
      /** Feature 1: groups a read-only conditional branch owns — editing them refuses `locked-group` */
      locked?: TwGroup[]
    }
  | { t: 'edited'; id: string; loc: Loc; diff: string; dry?: boolean; warn?: string; hash?: string }
  | { t: 'refused'; id: string; loc: Loc; reason: RefuseReason }
  | { t: 'journal'; entries: { id: string; file: string; summary: string }[] }

export const BRIDGE_PORT = 7331
