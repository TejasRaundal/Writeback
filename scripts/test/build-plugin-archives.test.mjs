import test from 'node:test'
import assert from 'node:assert/strict'
import { packageFiles } from '../build-plugin-archives.mjs'

test('skills-only archive excludes local MCP files', () => {
  const files = packageFiles('chatgpt')
  assert.ok(files.includes('plugin.json'))
  assert.ok(files.includes('.claude-plugin'))
  assert.ok(files.includes('skills'))
  assert.ok(!files.includes('mcp.json'))
  assert.ok(!files.includes('packages/mcp/dist/mcp.js'))
})

test('local archive includes portable and Codex MCP files', () => {
  const files = packageFiles('local')
  assert.ok(files.includes('mcp.json'))
  assert.ok(files.includes('.mcp.json'))
  assert.ok(files.includes('.codex-plugin'))
  assert.ok(files.includes('packages/mcp/dist/mcp.js'))
})
