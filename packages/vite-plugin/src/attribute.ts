import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Loc } from '@writeback/protocol'
import { parseJsx, walk } from './tag.ts'

/** Name of the component function enclosing the element at loc. */
function enclosingComponent(ast: any, loc: Loc): string | null {
  let result: string | null = null
  const visit = (node: any, fnName: string | null) => {
    if (!node || typeof node.type !== 'string') return
    let name = fnName
    if (node.type === 'FunctionDeclaration' && node.id) name = node.id.name
    if ((node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') && node._wbName) name = node._wbName
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init?.type?.includes('FunctionExpression')) {
      node.init._wbName = node.id.name
    }
    if (node.type === 'JSXOpeningElement' && node.loc.start.line === loc.line && node.loc.start.column === loc.col) {
      result = name
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue
      const child = node[key]
      if (Array.isArray(child)) child.forEach((c) => visit(c, name))
      else if (child && typeof child.type === 'string') visit(child, name)
    }
  }
  visit(ast.program, null)
  return result
}

function* sourceFiles(dir: string, depth = 4): Generator<string> {
  if (depth === 0 || !existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* sourceFiles(p, depth - 1)
    else if (/\.[jt]sx$/.test(e.name)) yield p
  }
}

/**
 * Prop-chain attribution v0: when an element's className is computed (often
 * `cn(base, props.className)`), find call sites of its enclosing component that
 * pass a className — the places the class actually comes from.
 * ponytail: name-match scan, no import graph; full attribution is its own milestone.
 */
export function callSiteHints(root: string, source: string, loc: Loc): { component: string; loc: Loc }[] {
  let ast
  try {
    ast = parseJsx(source)
  } catch {
    return []
  }
  const component = enclosingComponent(ast, loc)
  if (!component || !/^[A-Z]/.test(component)) return []
  const hints: { component: string; loc: Loc }[] = []
  for (const file of sourceFiles(join(root, 'src'))) {
    let fileAst
    try {
      fileAst = parseJsx(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    walk(fileAst.program, (node) => {
      if (node.type !== 'JSXOpeningElement') return
      if (node.name.type !== 'JSXIdentifier' || node.name.name !== component) return
      if (!node.attributes.some((a: any) => a.type === 'JSXAttribute' && a.name.name === 'className')) return
      hints.push({
        component,
        loc: {
          file: relative(root, file).replace(/\\/g, '/'),
          line: node.loc.start.line,
          col: node.loc.start.column,
        },
      })
    })
    if (hints.length >= 10) break
  }
  return hints
}

/**
 * M4 instance-vs-component: does the component enclosing loc forward a className
 * prop to its markup? If not, only definition edits are meaningful.
 */
export function forwardsClassName(source: string, loc: Loc): { component: string; forwards: boolean } | null {
  let ast
  try {
    ast = parseJsx(source)
  } catch {
    return null
  }
  const component = enclosingComponent(ast, loc)
  if (!component || !/^[A-Z]/.test(component)) return null
  // ponytail: textual check within the component's body would need scoping; a
  // whole-file mention of a className identifier/prop read is the v0 signal
  const forwards = /(?:props\.className|\bclassName\s*[,}:)]|\.\.\.props)/.test(source)
  return { component, forwards }
}

/** Variant combos defined by cva() calls in this file — the blast radius of a definition edit. */
export function cvaBlast(source: string): string[] {
  if (!source.includes('cva(')) return []
  let ast
  try {
    ast = parseJsx(source)
  } catch {
    return []
  }
  const out: string[] = []
  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'cva') return
    const cfg = node.arguments[1]
    if (cfg?.type !== 'ObjectExpression') return
    const variants = cfg.properties.find((p: any) => p.key?.name === 'variants')
    if (variants?.value?.type !== 'ObjectExpression') return
    for (const v of variants.value.properties) {
      if (v.value?.type !== 'ObjectExpression') continue
      const options = v.value.properties.map((o: any) => o.key?.name ?? o.key?.value).filter(Boolean)
      out.push(`${v.key?.name}: ${options.join(' | ')}`)
    }
  })
  return out
}
