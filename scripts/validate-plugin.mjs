#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
const CATEGORIES = new Set(['Productivity', 'Creativity', 'Developer Tools', 'Business & Operations', 'Data & Analytics', 'Communication', 'Education & Research', 'Security', 'Finance', 'Healthcare', 'Travel', 'Entertainment', 'Other'])
const FORBIDDEN_PARTS = new Set(['node_modules', '.git', '.writeback', '__MACOSX'])
const SECRET_NAMES = /^(?:\.env(?:\..+)?|.*\.(?:pem|p12|pfx|key)|id_(?:rsa|ed25519))$/i
const SECRET_CONTENT = /(?:^|\n)\s*(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY)\s*=\s*['"]?[A-Za-z0-9_/-]{16,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i

async function filesUnder(root, sourceTree) {
  const output = []
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const rel = relative(root, path).replace(/\\/g, '/')
      if (entry.isDirectory() && sourceTree && (FORBIDDEN_PARTS.has(entry.name) || entry.name === 'dist' || entry.name === '.superpowers')) continue
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) output.push(rel)
    }
  }
  await visit(root)
  return output
}

async function jsonAt(path, errors) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { errors.push(`${relative(process.cwd(), path)}: invalid JSON (${error.message})`); return null }
}

function inside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !rel.includes(':' + sep))
}

function validateInterface(value, prefix, root, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return errors.push(`${prefix}: interface is required`)
  const limits = { displayName: 30, shortDescription: 30, longDescription: 4000, developerName: 80 }
  for (const [key, limit] of Object.entries(limits)) {
    if (typeof value[key] !== 'string' || !value[key].trim()) errors.push(`${prefix}.${key}: required non-empty string`)
    else if (value[key].length > limit) errors.push(`${prefix}.${key}: exceeds ${limit} characters`)
  }
  if (value.category !== undefined && !CATEGORIES.has(value.category)) errors.push(`${prefix}.category: unsupported category`)
  if (value.defaultPrompt !== undefined && (!Array.isArray(value.defaultPrompt) || value.defaultPrompt.length > 3 || new Set(value.defaultPrompt).size !== value.defaultPrompt.length || value.defaultPrompt.some((p) => typeof p !== 'string' || !p.trim() || p.length > 128 || /[\r\n]/.test(p)))) errors.push(`${prefix}.defaultPrompt: expected up to three unique single-line prompts <= 128 characters`)
  for (const key of ['composerIcon', 'composerIconDark', 'logo', 'logoDark']) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'string' || !value[key].startsWith('./')) { errors.push(`${prefix}.${key}: expected a ./ relative path`); continue }
    const target = resolve(root, value[key])
    if (!inside(root, target) || !existsSync(target)) errors.push(`${prefix}.${key}: referenced file does not exist inside the plugin (${value[key]})`)
  }
}

function validatePortableManifest(manifest, root, errors) {
  if (manifest.$schema !== PLUGIN_SCHEMA) errors.push(`plugin.json: $schema must be ${PLUGIN_SCHEMA}`)
  const allowed = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'])
  for (const key of Object.keys(manifest)) if (!allowed.has(key)) errors.push(`plugin.json: unsupported Agent Plugins property ${key}`)
  if (typeof manifest.name !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(manifest.name) || manifest.name.includes('--') || manifest.name.includes('..') || manifest.name.length > 64) errors.push('plugin.json: invalid name')
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) errors.push('plugin.json: version must be semantic versioning')
  if (typeof manifest.description !== 'string' || !manifest.description.trim() || manifest.description.length > 1024) errors.push('plugin.json: description is required and must be <= 1024 characters')
  if (!manifest.author || typeof manifest.author.name !== 'string' || !manifest.author.name.trim()) errors.push('plugin.json: author.name is required')
  const openai = manifest.extensions?.['com.openai']
  validateInterface(openai?.interface, 'plugin.json extensions.com.openai.interface', root, errors)
}

function frontmatter(text) {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 4)
  if (end < 0) return null
  const result = {}
  for (const line of text.slice(4, end).split('\n')) {
    const colon = line.indexOf(':')
    if (colon > 0) result[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return result
}

async function validateSkills(root, errors) {
  const skills = join(root, 'skills')
  if (!existsSync(skills)) return errors.push('skills/: at least one skill is required')
  for (const entry of await readdir(skills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(skills, entry.name, 'SKILL.md')
    if (!existsSync(path)) { errors.push(`skills/${entry.name}: missing SKILL.md`); continue }
    const meta = frontmatter((await readFile(path, 'utf8')).replace(/\r\n/g, '\n'))
    if (!meta) { errors.push(`skills/${entry.name}/SKILL.md: invalid YAML frontmatter`); continue }
    if (meta.name !== entry.name) errors.push(`skills/${entry.name}/SKILL.md: name must match its directory`)
    if (!meta.description) errors.push(`skills/${entry.name}/SKILL.md: description is required`)
  }
}

async function validateMcp(path, portable, root, errors) {
  if (!existsSync(path)) return
  const value = await jsonAt(path, errors)
  if (!value) return
  if (portable && value.$schema !== MCP_SCHEMA) errors.push('mcp.json: invalid or missing Agent Plugins schema')
  if (!value.mcpServers || typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers)) errors.push(`${portable ? 'mcp.json' : '.mcp.json'}: mcpServers must be an object`)
  for (const [name, server] of Object.entries(value.mcpServers ?? {})) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) { errors.push(`${name}: invalid MCP server`); continue }
    if (portable && !['stdio', 'streamable-http', 'sse'].includes(server.type)) errors.push(`mcp.json ${name}: unsupported transport type`)
    if ((server.type === 'streamable-http' || server.type === 'sse') && (typeof server.url !== 'string' || !server.url.startsWith('https://'))) errors.push(`mcp.json ${name}: remote MCP URL must use HTTPS`)
    if ((server.type === 'stdio' || (!portable && server.command)) && typeof server.command !== 'string') errors.push(`mcp.json ${name}: stdio command is required`)
    if ((server.type === 'stdio' || (!portable && server.command)) && Array.isArray(server.args)) {
      for (const arg of server.args) {
        if (typeof arg !== 'string' || !arg.startsWith('${PLUGIN_ROOT}/')) continue
        const target = resolve(root, arg.slice('${PLUGIN_ROOT}/'.length))
        if (!inside(root, target) || !existsSync(target)) errors.push(`${portable ? 'mcp.json' : '.mcp.json'} ${name}: stdio executable does not exist (${arg})`)
      }
    }
  }
}

export async function validatePluginDirectory(inputRoot) {
  const root = resolve(inputRoot)
  const errors = []
  const sourceTree = existsSync(join(root, 'pnpm-workspace.yaml'))
  const files = await filesUnder(root, sourceTree)
  const hasRootContent = files.includes('plugin.json') || files.includes('.codex-plugin/plugin.json') || files.some((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file)) || files.includes('mcp.json') || files.includes('.mcp.json') || files.includes('.app.json')
  if (!hasRootContent) errors.push('Plugin content must be at the archive root, not inside a wrapper directory')
  for (const file of files) {
    const parts = file.split('/')
    if (parts.some((part) => FORBIDDEN_PARTS.has(part))) errors.push(`${file}: unnecessary build or local artifact`)
    if (SECRET_NAMES.test(parts.at(-1))) errors.push(`${file}: secret-like file is forbidden`)
    if (/\.(?:json|md|mjs|js|ts|txt|ya?ml|toml)$/i.test(file)) {
      const text = await readFile(join(root, file), 'utf8')
      if (SECRET_CONTENT.test(text)) errors.push(`${file}: possible secret value detected`)
    }
  }
  let manifest = null
  if (existsSync(join(root, 'plugin.json'))) {
    manifest = await jsonAt(join(root, 'plugin.json'), errors)
    if (manifest) validatePortableManifest(manifest, root, errors)
  }
  if (existsSync(join(root, '.codex-plugin', 'plugin.json'))) {
    const codex = await jsonAt(join(root, '.codex-plugin', 'plugin.json'), errors)
    if (manifest && codex && (codex.name !== manifest.name || codex.version !== manifest.version)) errors.push('.codex-plugin/plugin.json: name and version identity must match plugin.json')
  }
  if (existsSync(join(root, '.claude-plugin', 'plugin.json'))) {
    const claude = await jsonAt(join(root, '.claude-plugin', 'plugin.json'), errors)
    if (manifest && claude && (claude.name !== manifest.name || claude.version !== manifest.version)) errors.push('.claude-plugin/plugin.json: name and version identity must match plugin.json')
  }
  await validateSkills(root, errors)
  await validateMcp(join(root, 'mcp.json'), true, root, errors)
  await validateMcp(join(root, '.mcp.json'), false, root, errors)
  return [...new Set(errors)]
}

async function main() {
  const root = resolve(process.argv[2] ?? '.')
  const errors = await validatePluginDirectory(root)
  if (errors.length) {
    console.error(errors.map((error) => `ERROR ${error}`).join('\n'))
    process.exitCode = 1
  } else console.log(`Plugin validation passed: ${root}`)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main()
