#!/usr/bin/env node
// MCP server mode: agents edit through the same constrained pipeline — they
// cannot emit off-scale values (unless raw) or unparseable files.
// Usage: node packages/mcp/dist/mcp.js   (bridge must be running)
// Register in Claude Code: claude mcp add writeback -- node <repo>/packages/mcp/dist/mcp.js
import { createInterface } from 'node:readline'

const WS_URL = `ws://127.0.0.1:${process.env.WRITEBACK_PORT ?? 7331}`
const GROUPS = new Set(['p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'gap', 'gap-x', 'gap-y', 'bg', 'text', 'text-size', 'font-weight', 'font-family', 'tracking', 'leading', 'rounded', 'shadow', 'opacity'])
const READ_ONLY = { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
const WRITES_SOURCE = { readOnlyHint: false, openWorldHint: false, destructiveHint: true }
const OBJECT_OUTPUT = { type: 'object', additionalProperties: true }

const TOOLS = [
  {
    name: 'get_scale',
    description: "The project's resolved design scale (spacing tokens + color palette) and its `root` path. Call ONCE and cache — the palette is large. All file paths in resolve/edit are relative to `root` (e.g. 'src/App.tsx') or absolute.",
    inputSchema: { type: 'object', properties: {} },
    outputSchema: OBJECT_OUTPUT,
    annotations: READ_ONLY,
  },
  {
    name: 'resolve',
    description: "What is editable at a source location. `file` is relative to the project root from get_scale (e.g. 'src/App.tsx'), or an absolute path — NOT repo-relative. line is 1-based, col 0-based (the position of the JSX opening `<`). Returns {classes, hash} if editable, or {classes:null, reason}: 'file-not-found' (wrong path), 'computed-classname'/'no-classname' (genuinely not editable). Always resolve before edit and reuse the hash.",
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' }, line: { type: 'number' }, col: { type: 'number' } },
      required: ['file', 'line', 'col'],
    },
    outputSchema: OBJECT_OUTPUT,
    annotations: READ_ONLY,
  },
  {
    name: 'edit',
    description: 'Apply one constrained Tailwind edit. group: p|px|py|pt|pr|pb|pl|m*|gap*|bg|text|text-size|font-weight|font-family|tracking|leading|rounded|shadow|opacity. value: a token from get_scale (or [arbitrary] with raw=true). Use the opaque hash from resolve; for another edit to the same file, reuse the post-edit hash returned by edited. Set target="callsite" with the loc of a <Component …> usage to style that ONE instance instead of the shared component (only for components that forward className; otherwise refused with reason "not-forwarded"). Returns a unified diff, or {t:refused, reason: hash-mismatch|file-not-found|parse-error|not-forwarded|locked-group}. For a cva imported from another module the hash locks both the definition file and call site; never compute it yourself. locked-group means the element is editable but that group is owned by a conditional branch (resolve lists them in locked). variants is an optional state/breakpoint chain; base and variant values of one group are independent.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' }, line: { type: 'number' }, col: { type: 'number' },
        hash: { type: 'string' }, group: { type: 'string' }, value: { type: 'string' },
        variants: { type: 'array', items: { type: 'string' } }, raw: { type: 'boolean' },
        target: { type: 'string', enum: ['callsite'] },
      },
      required: ['file', 'line', 'col', 'hash', 'group', 'value'],
    },
    outputSchema: OBJECT_OUTPUT,
    annotations: WRITES_SOURCE,
  },
  {
    name: 'undo',
    description: 'Undo a previous edit by its id (reverts the file if unchanged since).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    outputSchema: OBJECT_OUTPUT,
    annotations: WRITES_SOURCE,
  },
]

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

const objectArgs = (name: string, value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError(-32602, `Invalid arguments for ${name}: expected an object`)
  return value as Record<string, unknown>
}
const stringArg = (tool: string, args: Record<string, unknown>, key: string) => {
  const value = args[key]
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new RpcError(-32602, `Invalid arguments for ${tool}: ${key} must be a non-empty string`)
  return value
}
const locArgs = (tool: string, value: unknown) => {
  const args = objectArgs(tool, value)
  const file = stringArg(tool, args, 'file')
  if (!/^(?:[A-Za-z]:[\\/]|[/])/.test(file) && file.split(/[\\/]+/).includes('..')) throw new RpcError(-32602, `Invalid arguments for ${tool}: relative file paths cannot contain ..`)
  if (!Number.isInteger(args.line) || Number(args.line) < 1) throw new RpcError(-32602, `Invalid arguments for ${tool}: line must be an integer >= 1`)
  if (!Number.isInteger(args.col) || Number(args.col) < 0) throw new RpcError(-32602, `Invalid arguments for ${tool}: col must be an integer >= 0`)
  return args
}

function validateToolArgs(name: string, value: unknown): Record<string, unknown> {
  if (name === 'get_scale') return objectArgs(name, value)
  if (name === 'undo') {
    const args = objectArgs(name, value)
    stringArg(name, args, 'id')
    return args
  }
  if (name === 'resolve') return locArgs(name, value)
  if (name === 'edit') {
    const args = locArgs(name, value)
    stringArg(name, args, 'hash')
    const group = stringArg(name, args, 'group')
    if (!GROUPS.has(group)) throw new RpcError(-32602, `Invalid arguments for ${name}: unsupported group ${group}`)
    stringArg(name, args, 'value')
    if (args.variants !== undefined && (!Array.isArray(args.variants) || args.variants.some((v) => typeof v !== 'string'))) throw new RpcError(-32602, `Invalid arguments for ${name}: variants must be an array of strings`)
    if (args.raw !== undefined && typeof args.raw !== 'boolean') throw new RpcError(-32602, `Invalid arguments for ${name}: raw must be boolean`)
    if (args.target !== undefined && args.target !== 'callsite') throw new RpcError(-32602, `Invalid arguments for ${name}: target must be callsite`)
    return args
  }
  throw new RpcError(-32602, `Unknown tool: ${name}`)
}

let ws: WebSocket | null = null
function bridge(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    if (ws && ws.readyState === WebSocket.OPEN) return res(ws)
    const s = new WebSocket(WS_URL)
    s.onopen = () => { ws = s; res(s) }
    s.onerror = () => rej(new Error('Writeback bridge not running — start the dev server first'))
  })
}

// Serialize requests: exactly one is outstanding at a time, so a reply of the
// expected type is unambiguously ours. When the request carries an id, also
// require the reply's id to match (defense in depth). A timeout prevents a lost
// reply from wedging the queue forever.
let chain: Promise<unknown> = Promise.resolve()

function ask(msg: { id?: string; [k: string]: unknown }, expectT: string[]): Promise<any> {
  const run = () =>
    bridge().then(
      (s) =>
        new Promise((res, rej) => {
          const timer = setTimeout(() => {
            s.removeEventListener('message', on)
            rej(new Error('Writeback bridge did not reply in time'))
          }, 10_000)
          const on = (e: MessageEvent) => {
            const m = JSON.parse(String(e.data))
            if (!expectT.includes(m.t)) return
            if (msg.id !== undefined && m.id !== undefined && m.id !== msg.id) return
            clearTimeout(timer)
            s.removeEventListener('message', on)
            res(m)
          }
          s.addEventListener('message', on)
          s.send(JSON.stringify(msg))
        }),
    )
  const result = chain.then(run, run)
  chain = result.then(
    () => {},
    () => {},
  )
  return result
}

let editSeq = 0
async function callTool(name: string, args: any): Promise<any> {
  switch (name) {
    case 'get_scale':
      return ask({ t: 'config' }, ['config'])
    case 'resolve':
      return ask({ t: 'resolve', loc: { file: args.file, line: args.line, col: args.col } }, ['resolved'])
    case 'edit': {
      const id = `mcp-${++editSeq}`
      const r = await ask({
        t: 'edit', id, loc: { file: args.file, line: args.line, col: args.col }, hash: args.hash,
        op: { kind: 'tw', group: args.group, variants: args.variants ?? [], value: args.value, raw: args.raw },
        ...(args.target ? { target: args.target } : {}),
      }, ['edited', 'refused'])
      return { ...r, id }
    }
    case 'undo':
      return ask({ t: 'undo', id: args.id }, ['edited', 'refused'])
    default:
      throw new Error(`unknown tool ${name}`)
  }
}

const out = (obj: object) => process.stdout.write(JSON.stringify(obj) + '\n')

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let req: any
  try {
    req = JSON.parse(line)
  } catch {
    return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  const reply = (result: object) => out({ jsonrpc: '2.0', id: req.id, result })
  try {
    switch (req.method) {
      case 'initialize':
        reply({
          protocolVersion: req.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'writeback', version: '0.0.1' },
        })
        break
      case 'tools/list':
        reply({ tools: TOOLS })
        break
      case 'tools/call': {
        const name = typeof req.params?.name === 'string' ? req.params.name : ''
        const args = validateToolArgs(name, req.params?.arguments ?? {})
        const result = await callTool(name, args)
        reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: result?.t === 'refused' })
        break
      }
      case 'ping':
        reply({})
        break
      default:
        if (req.id !== undefined) out({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } })
    }
  } catch (err: any) {
    if (req.id !== undefined) out({ jsonrpc: '2.0', id: req.id, error: { code: err instanceof RpcError ? err.code : -32000, message: String(err?.message ?? err) } })
  }
})
