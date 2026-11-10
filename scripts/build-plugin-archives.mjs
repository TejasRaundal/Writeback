#!/usr/bin/env node
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePluginDirectory } from './validate-plugin.mjs'

const COMMON = [
  'plugin.json',
  '.claude-plugin',
  'skills',
  'packages/extension/icons/icon128.png',
  'LICENSE',
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/INSTALLATION.md',
  'docs/CHATGPT_SETUP.md',
  'docs/MCP_SETUP.md',
  'docs/SECURITY.md',
  'docs/AUDIT.md',
]

export function packageFiles(kind) {
  if (kind === 'chatgpt') return [...COMMON]
  if (kind === 'local') return [...COMMON, '.codex-plugin', 'mcp.json', '.mcp.json', 'packages/mcp/dist/mcp.js']
  throw new Error(`Unknown package kind: ${kind}`)
}

async function stage(root, target, kind) {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const item of packageFiles(kind)) {
    const source = join(root, item)
    if (!existsSync(source)) throw new Error(`Required package file is missing: ${item}`)
    const destination = join(target, item)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true })
  }
  const errors = await validatePluginDirectory(target)
  if (errors.length) throw new Error(`Staged ${kind} package failed validation:\n${errors.join('\n')}`)
}

function zipDirectory(stageDir, archive) {
  const entries = execFileSync(process.execPath, ['-e', "require('fs').readdirSync('.').forEach(x=>console.log(x))"], { cwd: stageDir, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
  if (!entries.length) throw new Error(`Cannot archive empty directory: ${stageDir}`)
  if (process.platform === 'win32') execFileSync('tar.exe', ['-a', '-c', '-f', archive, ...entries], { cwd: stageDir, stdio: 'inherit' })
  else execFileSync('zip', ['-q', '-r', archive, ...entries], { cwd: stageDir, stdio: 'inherit' })
  const listed = execFileSync(process.platform === 'win32' ? 'tar.exe' : 'unzip', process.platform === 'win32' ? ['-tf', archive] : ['-Z1', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
  if (!listed.includes('plugin.json') || listed.some((entry) => entry.startsWith('../') || entry.startsWith('/'))) throw new Error(`Archive has an unsafe or nested root: ${basename(archive)}`)
  return listed.length
}

async function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const dist = join(root, 'dist')
  await mkdir(dist, { recursive: true })
  const outputs = [
    { kind: 'chatgpt', stage: join(dist, '.writeback-chatgpt-stage'), archive: join(dist, 'writeback-chatgpt-plugin.zip') },
    { kind: 'local', stage: join(dist, '.writeback-local-stage'), archive: join(dist, 'writeback-local-mcp-plugin.zip') },
  ]
  for (const output of outputs) {
    await stage(root, output.stage, output.kind)
    await rm(output.archive, { force: true })
    const count = zipDirectory(output.stage, output.archive)
    await rm(output.stage, { recursive: true, force: true })
    console.log(`${output.kind}: ${output.archive} (${count} entries)`)
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main()
