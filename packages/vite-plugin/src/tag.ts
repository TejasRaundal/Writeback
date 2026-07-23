import { parse } from '@babel/parser'
import MagicString from 'magic-string'

export function parseJsx(code: string): any {
  return parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  })
}

// Recursive AST walk — no @babel/traverse dependency needed
export function walk(node: any, visit: (node: any) => void) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
    const child = (node as any)[key]
    if (Array.isArray(child)) child.forEach((c) => walk(c, visit))
    else if (child && typeof child.type === 'string') walk(child, visit)
  }
}

/** Stamp data-wb="relPath:line:col" on host (lowercase) JSX elements. */
export function tagSource(code: string, relPath: string): string | null {
  let ast
  try {
    ast = parseJsx(code)
  } catch {
    return null // let Vite's own pipeline surface the syntax error
  }
  const s = new MagicString(code)
  const posix = relPath.replace(/\\/g, '/')
  let changed = false
  walk(ast.program, (node) => {
    if (node.type !== 'JSXOpeningElement') return
    const name = node.name
    if (name.type !== 'JSXIdentifier' || !/^[a-z]/.test(name.name)) return
    const { line, column } = node.loc.start
    s.appendLeft(name.end, ` data-wb="${posix}:${line}:${column}"`)
    changed = true
  })
  return changed ? s.toString() : null
}
