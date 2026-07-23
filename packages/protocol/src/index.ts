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

export type ClientMsg =
  | { t: 'hello'; root: string }
  | { t: 'config' }
  | { t: 'resolve'; loc: Loc }
  | { t: 'edit'; id: string; loc: Loc; hash: string; op: TwOp; dry?: boolean }
  | { t: 'bulk'; id: string; edits: { loc: Loc; hash: string; op: TwOp }[] }   // all-or-nothing
  | { t: 'undo'; id: string }
  | { t: 'journal' }
  | { t: 'open'; loc: Loc }                                                    // jump-to-source

export type RefuseReason = 'hash-mismatch' | 'computed-classname' | 'parse-error' | 'unknown-edit' | 'file-not-found' | 'off-scale'

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
    }
  | { t: 'edited'; id: string; loc: Loc; diff: string; dry?: boolean; warn?: string; hash?: string }
  | { t: 'refused'; id: string; loc: Loc; reason: RefuseReason }
  | { t: 'journal'; entries: { id: string; file: string; summary: string }[] }

export const BRIDGE_PORT = 7331
