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
  // scoped to THAT component's declaration — a className mention anywhere else in the
  // file (another component, an unrelated object literal) says nothing about this one
  return { component, forwards: componentForwardsIn(ast, source, component) === true }
}

/** The declaration node of a component named `name`: `function name(){}` or `const name = …`. */
function componentDecl(ast: any, name: string): any | null {
  let found: any = null
  walk(ast.program, (n) => {
    if (found) return
    if (n.type === 'FunctionDeclaration' && n.id?.name === name) found = n
    // `const name = (p) => …` / `function(){}` / `forwardRef(…)` / `memo(…)`
    else if (
      n.type === 'VariableDeclarator' &&
      n.id?.type === 'Identifier' &&
      n.id.name === name &&
      /^(ArrowFunctionExpression|FunctionExpression|CallExpression)$/.test(n.init?.type ?? '')
    ) {
      found = n
    }
  })
  return found
}

/** The function behind a component declaration, unwrapping forwardRef(…)/memo(…). */
function fnOf(decl: any): any | null {
  if (!decl || typeof decl.type !== 'string') return null
  if (/^(FunctionDeclaration|ArrowFunctionExpression|FunctionExpression)$/.test(decl.type)) return decl
  if (decl.type === 'VariableDeclarator') return fnOf(decl.init)
  if (decl.type === 'CallExpression') {
    for (const a of decl.arguments) {
      const f = fnOf(a)
      if (f) return f
    }
  }
  return null
}

/** The parameter bindings a forwarded className could arrive through. */
function propBindings(fn: any): { names: Set<string>; props: Set<string> } {
  const names = new Set<string>() // locals bound to the className prop
  const props = new Set<string>() // whole-props / rest objects
  const p = fn.params?.[0]
  const pattern = p?.type === 'AssignmentPattern' ? p.left : p
  if (pattern?.type === 'Identifier') props.add(pattern.name)
  else if (pattern?.type === 'ObjectPattern') {
    for (const prop of pattern.properties ?? []) {
      if (prop.type === 'RestElement' && prop.argument?.type === 'Identifier') props.add(prop.argument.name)
      if (prop.type !== 'ObjectProperty' || (prop.key?.name ?? prop.key?.value) !== 'className') continue
      const v = prop.value?.type === 'AssignmentPattern' ? prop.value.left : prop.value
      if (v?.type === 'Identifier') names.add(v.name)
    }
  }
  return { names, props }
}

/**
 * Does this component declaration forward a className prop onto the markup it renders?
 *
 * AST, not text: a className PARAM binding (or a whole-props object) must actually reach
 * a root-level JSX element — either read inside its `className` attribute or spread onto
 * it. That link is what makes the answer authoritative enough to gate a source write; a
 * mere mention of the word `className` (an unrelated object key, a prop the component
 * never renders) is not forwarding, and neither is a spread onto a nested child, which
 * would put the class somewhere the caller never meant.
 */
export function forwardsIn(_source: string, node: any): boolean {
  const fn = fnOf(node)
  if (!fn) return false
  const { names, props } = propBindings(fn)
  if (!names.size && !props.size) return false

  const mentions = (n: any): boolean => {
    if (!n || typeof n.type !== 'string') return false
    if (n.type === 'Identifier' && names.has(n.name)) return true
    if (
      n.type === 'MemberExpression' &&
      n.object?.type === 'Identifier' &&
      props.has(n.object.name) &&
      (n.property?.name ?? n.property?.value) === 'className'
    ) return true
    for (const k of Object.keys(n)) {
      if (k === 'loc') continue
      const c = n[k]
      if (Array.isArray(c) ? c.some(mentions) : mentions(c)) return true
    }
    return false
  }

  let found = false
  // depth counts JSX ELEMENT nesting only (fragments are transparent): the forwarded
  // class has to land on what the component returns, not on some inner child
  const visit = (n: any, depth: number) => {
    if (found || !n || typeof n.type !== 'string') return
    if (n.type === 'JSXOpeningElement' && depth === 0) {
      for (const a of n.attributes ?? []) {
        if (a.type === 'JSXSpreadAttribute' && a.argument?.type === 'Identifier' && props.has(a.argument.name)) found = true
        if (a.type === 'JSXAttribute' && a.name?.name === 'className' && mentions(a.value)) found = true
      }
    }
    if (n.type === 'JSXElement') {
      visit(n.openingElement, depth)
      for (const c of n.children ?? []) visit(c, depth + 1)
      return
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc') continue
      const c = n[k]
      if (Array.isArray(c)) c.forEach((x) => visit(x, depth))
      else visit(c, depth)
    }
  }
  visit(fn.body, 0)
  return found
}

/**
 * The static classes the component itself puts on its root element, plus whether it
 * composes them through a conflict-resolving merge (tailwind-merge). A call-site edit
 * that collides with one of these classes without a merge is decided by STYLESHEET
 * order, not by which class the caller wrote — the caller has to be told.
 */
export function ownRootClasses(source: string, node: any): { tokens: string[]; merges: boolean } {
  const fn = fnOf(node)
  if (!fn) return { tokens: [], merges: false }
  const merges = /\btw(Merge|Join)\b|tailwind-merge/.test(source.slice(node.start, node.end))
  const tokens: string[] = []
  const literals = (e: any) => {
    if (!e) return
    if (e.type === 'StringLiteral') tokens.push(...e.value.split(/\s+/).filter(Boolean))
    else if (e.type === 'TemplateLiteral' && e.expressions.length === 0)
      tokens.push(...e.quasis[0].value.raw.split(/\s+/).filter(Boolean))
    else if (e.type === 'JSXExpressionContainer') literals(e.expression)
    else if (e.type === 'CallExpression') e.arguments.forEach(literals)
  }
  const visit = (n: any, depth: number) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'JSXOpeningElement' && depth === 0) {
      for (const a of n.attributes ?? []) {
        if (a.type === 'JSXAttribute' && a.name?.name === 'className') literals(a.value)
      }
    }
    if (n.type === 'JSXElement') {
      visit(n.openingElement, depth)
      for (const c of n.children ?? []) visit(c, depth + 1)
      return
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc') continue
      const c = n[k]
      if (Array.isArray(c)) c.forEach((x) => visit(x, depth))
      else visit(c, depth)
    }
  }
  visit(fn.body, 0)
  return { tokens, merges }
}

export type CompInfo = { forwards: boolean; tokens: string[]; merges: boolean }

/** Everything the call-site path needs about one declaration node. */
export function infoOf(source: string, node: any): CompInfo {
  return { forwards: forwardsIn(source, node), ...ownRootClasses(source, node) }
}

/** `infoOf` for the component named `name` declared in this ast, or null if it isn't. */
export function componentInfoIn(ast: any, source: string, name: string): CompInfo | null {
  const node = componentDecl(ast, name)
  return node ? infoOf(source, node) : null
}

/**
 * M4 call-site editing: does the component `name` DEFINED in this ast/source forward a
 * className prop? Same v0 heuristic as `forwardsClassName`, but scoped to that component's
 * own declaration (a call site's file usually defines several components).
 * `null` = no such component here, so the caller can keep following imports — or refuse.
 */
export function componentForwardsIn(ast: any, source: string, name: string): boolean | null {
  const node = componentDecl(ast, name)
  return node ? forwardsIn(source, node) : null
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
