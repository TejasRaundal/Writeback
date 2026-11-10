import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePluginDirectory } from '../validate-plugin.mjs'

const roots = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'writeback-plugin-test-'))
  roots.push(root)
  await mkdir(join(root, 'skills', 'inspect'), { recursive: true })
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'icon.png'), 'png')
  await writeFile(join(root, 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'writeback', version: '0.1.0', description: 'Safe edits', author: { name: 'Tejas Raundal' },
    extensions: { 'com.openai': { interface: { displayName: 'Writeback', shortDescription: 'Edit React UI at source', longDescription: 'Safe source editing.', developerName: 'Tejas Raundal', category: 'Developer Tools', composerIcon: './assets/icon.png' } } },
  }))
  await writeFile(join(root, 'skills', 'inspect', 'SKILL.md'), '---\nname: inspect\ndescription: Inspect React source.\n---\n\nUse resolve.\n')
  return root
}

test('accepts a minimal root-level portable plugin', async () => {
  const root = await fixture()
  assert.deepEqual(await validatePluginDirectory(root), [])
})

test('rejects an archive nested below an unnecessary wrapper directory', async () => {
  const root = await fixture()
  const wrapper = await mkdtemp(join(tmpdir(), 'writeback-plugin-wrapper-'))
  roots.push(wrapper)
  await mkdir(join(wrapper, 'writeback'))
  await writeFile(join(wrapper, 'writeback', 'plugin.json'), await (await import('node:fs/promises')).readFile(join(root, 'plugin.json')))
  assert.match((await validatePluginDirectory(wrapper)).join('\n'), /plugin content must be at the archive root/i)
})

test('rejects secret-like files and broken icon references', async () => {
  const root = await fixture()
  await writeFile(join(root, '.env'), 'OPENAI_API_KEY=secret')
  await rm(join(root, 'assets', 'icon.png'))
  const errors = (await validatePluginDirectory(root)).join('\n')
  assert.match(errors, /secret-like file/i)
  assert.match(errors, /referenced file does not exist/i)
})

test('rejects skill names that differ from their directory', async () => {
  const root = await fixture()
  await writeFile(join(root, 'skills', 'inspect', 'SKILL.md'), '---\nname: other\ndescription: Inspect React source.\n---\n')
  assert.match((await validatePluginDirectory(root)).join('\n'), /must match its directory/i)
})

test('rejects mismatched compatibility identity and missing stdio executable', async () => {
  const root = await fixture()
  await mkdir(join(root, '.codex-plugin'))
  await writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'other', version: '9.0.0', description: 'Other', skills: './skills/', mcpServers: './.mcp.json' }))
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { writeback: { command: 'node', args: ['${PLUGIN_ROOT}/server/missing.js'] } } }))
  const errors = (await validatePluginDirectory(root)).join('\n')
  assert.match(errors, /identity must match/i)
  assert.match(errors, /stdio executable does not exist/i)
})
