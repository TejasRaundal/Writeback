import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { EditHost } from './edit.ts'

const IMPORT_EXTS = ['.ts', '.tsx', '.js', '.jsx']

/**
 * Feature 2: resolve a RELATIVE import specifier (written in the project-relative
 * `fromFile`) to a project file — `.ts/.tsx/.js/.jsx` + `/index.*` resolution.
 * Refuses (null) for: bare / node_modules specifiers, anything that resolves
 * outside `root`, and anything that isn't a readable file.
 *
 * This is the ONLY place cross-file cva touches the filesystem — edit.ts stays pure
 * and just follows what this returns, so the confinement rule has a single choke point.
 */
export function resolveImport(
  root: string,
  spec: string,
  fromFile: string,
): { file: string; abs: string; source: string } | null {
  if (!spec.startsWith('.')) return null // bare / node_modules specifier
  const rootAbs = resolve(root)
  const fromAbs = resolve(rootAbs, fromFile)
  if (!fromAbs.startsWith(rootAbs + sep)) return null // call site itself is outside root
  const base = resolve(dirname(fromAbs), spec)
  const candidates = [
    base,
    ...IMPORT_EXTS.map((e) => base + e),
    ...IMPORT_EXTS.map((e) => join(base, 'index' + e)),
  ]
  for (const abs of candidates) {
    if (!abs.startsWith(rootAbs + sep)) continue // confinement — never leave root
    // case-insensitively — macOS/Windows filesystems happily serve `Node_Modules`
    if (abs.split(sep).some((seg) => seg.toLowerCase() === 'node_modules')) continue
    try {
      if (!statSync(abs).isFile()) continue
      const source = readFileSync(abs, 'utf8')
      return { file: abs.slice(rootAbs.length + 1).replace(/\\/g, '/'), abs, source }
    } catch {
      continue
    }
  }
  return null
}

/**
 * The host handed to edit.ts for cross-file cva. `overlay` (abs path → pending code)
 * lets a bulk op read edits it has staged-but-not-yet-written, so two edits landing in
 * one definition file compose instead of clobbering each other.
 */
export function makeEditHost(root: string, overlay?: Map<string, string>): EditHost {
  return {
    resolve: (spec, fromFile) => {
      const r = resolveImport(root, spec, fromFile)
      if (!r) return null
      return { file: r.file, source: overlay?.get(r.abs) ?? r.source }
    },
  }
}
