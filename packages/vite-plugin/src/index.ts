import type { Plugin } from 'vite'
import { relative } from 'node:path'
import { tagSource } from './tag.ts'
import { startBridge } from './bridge.ts'
import { BRIDGE_PORT } from '@writeback/protocol'

export function writeback(opts: { port?: number } = {}): Plugin {
  let root = ''
  return {
    name: 'writeback',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      root = config.root
    },
    configureServer() {
      startBridge(root, opts.port ?? BRIDGE_PORT)
    },
    transform(code, id) {
      if (!/\.[jt]sx$/.test(id) || id.includes('node_modules')) return null
      const tagged = tagSource(code, relative(root, id))
      return tagged ? { code: tagged, map: null } : null
    },
  }
}
