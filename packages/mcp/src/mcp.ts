#!/usr/bin/env node
// MCP server mode: agents edit through the same constrained pipeline — they
// cannot emit off-scale values (unless raw) or unparseable files.
// Usage: node packages/mcp/dist/mcp.js   (bridge must be running)
// Register in Claude Code: claude mcp add writeback -- node <repo>/packages/mcp/dist/mcp.js
import { createInterface } from 'node:readline'

const WS_URL = `ws://127.0.0.1:${process.env.WRITEBACK_PORT ?? 7331}`

const TOOLS = [
  {
    name: 'get_scale',
    description: "The project's resolved design scale (spacing tokens + color palette) and its `root` path. Call ONCE and cache — the palette is large. All file paths in resolve/edit are relative to `root` (e.g. 'src/App.tsx') or absolute.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resolve',
    description: "What is editable at a source location. `file` is relative to the project root from get_scale (e.g. 'src/App.tsx'), or an absolute path — NOT repo-relative. line is 1-based, col 0-based (the position of the JSX opening `<`). Returns {classes, hash} if editable, or {classes:null, reason}: 'file-not-found' (wrong path), 'computed-classname'/'no-classname' (genuinely not editable). Always resolve before edit and reuse the hash.",
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' }, line: { type: 'number' }, col: { type: 'number' } },
      required: ['file', 'line', 'col'],
    },
  },
  {
    name: 'edit',
    description: 'Apply one constrained Tailwind edit. group: p|px|py|pt|pr|pb|pl|m*|gap*|bg|text|text-size|font-weight|font-family|tracking|leading|rounded|shadow|opacity. value: a token from get_scale (or [arbitrary] with raw=true). hash comes from the latest resolve of this file; after each edit the file changes, so resolve again before the next edit to the same file. Set target="callsite" with the loc of a <Component …> usage to style that ONE instance instead of the shared component (only for components that forward className; otherwise refused with reason "not-forwarded"). Returns a unified diff, or {t:refused, reason: hash-mismatch|file-not-found|parse-error|not-forwarded|locked-group}. The hash is opaque: for a cva imported from another module it locks BOTH the definition file (which is written; resolve names it in editFile) and the call site, so echo the hash from resolve/edited rather than hashing a file yourself. locked-group means the element is editable but that group is owned by a conditional branch (resolve lists them in `locked`).',
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
  },
  {
    name: 'undo',
    description: 'Undo a previous edit by its id (reverts the file if unchanged since).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
]

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
    return
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
        const result = await callTool(req.params.name, req.params.arguments ?? {})
        reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
        break
      }
      case 'ping':
        reply({})
        break
      default:
        if (req.id !== undefined) out({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } })
    }
  } catch (err: any) {
    if (req.id !== undefined) out({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: String(err?.message ?? err) } })
  }
})
