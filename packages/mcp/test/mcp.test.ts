import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'

type RpcResponse = { id: number; result?: any; error?: { code: number; message: string } }

let child: ChildProcessWithoutNullStreams
let http: Server
let wss: WebSocketServer
let nextId = 0
let pending = new Map<number, (value: RpcResponse) => void>()

async function rpc(method: string, params?: unknown): Promise<RpcResponse> {
  const id = ++nextId
  const reply = new Promise<RpcResponse>((resolve) => pending.set(id, resolve))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n')
  return reply
}

beforeEach(async () => {
  http = createServer()
  wss = new WebSocketServer({ server: http })
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.t === 'config') {
        socket.send(JSON.stringify({ t: 'config', root: '/project', spacing: ['4'], colors: { white: '#fff' }, fonts: {} }))
      }
    })
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('test bridge did not bind')

  child = spawn(process.execPath, ['dist/mcp.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, WRITEBACK_PORT: String(address.port) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) break
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (!line) continue
      const message: RpcResponse = JSON.parse(line)
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  })
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } })
})

afterEach(async () => {
  child.kill()
  wss.close()
  http.close()
  pending.clear()
})

describe('Writeback MCP stdio server', () => {
  test('discovers four tools with explicit safety annotations', async () => {
    const response = await rpc('tools/list')
    expect(response.result.tools.map((tool: any) => tool.name)).toEqual(['get_scale', 'resolve', 'edit', 'undo'])
    expect(response.result.tools.map((tool: any) => tool.annotations)).toEqual([
      { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
      { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
    ])
  })

  test('returns successful tool data as text and structured content', async () => {
    const response = await rpc('tools/call', { name: 'get_scale', arguments: {} })
    expect(response.result.structuredContent).toMatchObject({ t: 'config', root: '/project', spacing: ['4'] })
    expect(JSON.parse(response.result.content[0].text)).toEqual(response.result.structuredContent)
    expect(response.result.isError).toBe(false)
  })

  test('rejects malformed arguments before contacting the bridge', async () => {
    const response = await rpc('tools/call', { name: 'resolve', arguments: { file: '../outside.tsx', line: 0, col: -1 } })
    expect(response.error).toEqual({ code: -32602, message: expect.stringContaining('resolve') })
  })

  test('reports unknown tools as invalid params', async () => {
    const response = await rpc('tools/call', { name: 'shell', arguments: {} })
    expect(response.error).toEqual({ code: -32602, message: 'Unknown tool: shell' })
  })
})
