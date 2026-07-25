import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveImport, makeEditHost } from '../src/imports'
import { resolveLoc, applyEdit } from '../src/edit'

// A real on-disk project, because the rules under test ARE filesystem rules
// (extension/index resolution, node_modules, never-leave-root). Built in a tmpdir
// so the tree can contain a node_modules/ and an outside-the-root sibling.
let tmp: string
let root: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wb-imports-'))
  root = join(tmp, 'project')
  const write = (rel: string, body: string) => {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  write('src/App.tsx', "import { button } from './ui/button'\n")
  write('src/ui/button.ts', "export const button = cva('rounded-md px-4', {})\n")
  write('src/ui/index.ts', "export { button } from './button'\n")
  write('src/ui/card.tsx', "export const card = cva('card-base', {})\n")
  write('src/legacy/thing.js', "export const thing = cva('js-base', {})\n")
  write('src/legacy/jsxthing.jsx', "export const jsxthing = cva('jsx-base', {})\n")
  write('src/pkgdir/index.jsx', "export const idx = cva('index-jsx', {})\n")
  write('node_modules/pkg/index.js', "export const pkgButton = cva('pkg-base', {})\n")
  // same guard, other spelling — Windows/macOS filesystems serve this happily
  write('Node_Modules/pkg/index.js', "export const pkgButton = cva('pkg-base', {})\n")
  // outside the project root entirely — must never be reachable
  mkdirSync(join(tmp, 'outside'), { recursive: true })
  writeFileSync(join(tmp, 'outside', 'secret.ts'), "export const secret = cva('secret-base', {})\n")
})

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('resolveImport', () => {
  it('resolves a relative specifier with an implicit .ts extension', () => {
    const r = resolveImport(root, './ui/button', 'src/App.tsx')
    expect(r?.file).toBe('src/ui/button.ts')
    expect(r?.source).toContain('rounded-md px-4')
  })

  it('resolves .tsx, .js and .jsx too', () => {
    expect(resolveImport(root, './ui/card', 'src/App.tsx')?.file).toBe('src/ui/card.tsx')
    expect(resolveImport(root, './legacy/thing', 'src/App.tsx')?.file).toBe('src/legacy/thing.js')
    expect(resolveImport(root, './legacy/jsxthing', 'src/App.tsx')?.file).toBe('src/legacy/jsxthing.jsx')
  })

  it('resolves a directory to its index.*', () => {
    expect(resolveImport(root, './ui', 'src/App.tsx')?.file).toBe('src/ui/index.ts')
    expect(resolveImport(root, './pkgdir', 'src/App.tsx')?.file).toBe('src/pkgdir/index.jsx')
  })

  it('resolves an explicit extension as written', () => {
    expect(resolveImport(root, './ui/button.ts', 'src/App.tsx')?.file).toBe('src/ui/button.ts')
  })

  it('resolves `..` relative to the importing file', () => {
    expect(resolveImport(root, '../ui/button', 'src/legacy/thing.js')?.file).toBe('src/ui/button.ts')
  })

  it('always reports a posix, project-relative path', () => {
    expect(resolveImport(root, './ui/button', 'src/App.tsx')?.file).not.toContain('\\')
  })

  it('refuses a bare / node_modules specifier', () => {
    expect(resolveImport(root, 'pkg', 'src/App.tsx')).toBeNull()
    expect(resolveImport(root, '@acme/ui', 'src/App.tsx')).toBeNull()
    expect(resolveImport(root, 'react', 'src/App.tsx')).toBeNull()
  })

  it('refuses a relative path that reaches into node_modules', () => {
    expect(resolveImport(root, '../node_modules/pkg', 'src/App.tsx')).toBeNull()
    expect(resolveImport(root, '../node_modules/pkg/index.js', 'src/App.tsx')).toBeNull()
  })

  it('refuses node_modules whatever its case (the fs does not care, nor may we)', () => {
    expect(resolveImport(root, '../Node_Modules/pkg', 'src/App.tsx')).toBeNull()
    expect(resolveImport(root, '../Node_Modules/pkg/index.js', 'src/App.tsx')).toBeNull()
  })

  it('refuses to escape the project root via ..', () => {
    expect(resolveImport(root, '../../outside/secret', 'src/App.tsx')).toBeNull()
    expect(resolveImport(root, '../outside/secret', 'src/App.tsx')).toBeNull()
  })

  it('refuses when the importing file is itself outside the root', () => {
    expect(resolveImport(root, './secret', '../outside/thing.ts')).toBeNull()
  })

  it('refuses a missing module and a directory with no index', () => {
    expect(resolveImport(root, './ui/nope', 'src/App.tsx')).toBeNull()
    expect(resolveImport(root, './legacy', 'src/App.tsx')).toBeNull()
  })
})

describe('makeEditHost', () => {
  const CALL = `import { button } from './ui/button'
export const A = () => (
  <button className={button()}>a</button>
)
`
  const APP = { file: 'src/App.tsx', line: 3, col: 2 }
  const op = { kind: 'tw' as const, group: 'p' as const, variants: [], value: '8' }

  it('drives a real cross-file cva resolve end to end', () => {
    expect(resolveLoc(CALL, APP, makeEditHost(root))).toMatchObject({
      classes: ['rounded-md', 'px-4'],
      editFile: 'src/ui/button.ts',
    })
  })

  it('writes to the definition file on disk-resolved edits', () => {
    const r = applyEdit(CALL, APP, op, 'src/App.tsx', makeEditHost(root))
    expect(r.ok && r.file).toBe('src/ui/button.ts')
    expect(r.ok && r.code).toContain(`cva('rounded-md px-4 p-8'`)
  })

  it('an overlay shadows the on-disk source (bulk staging)', () => {
    const overlay = new Map([[join(root, 'src', 'ui', 'button.ts'), "export const button = cva('staged-base', {})\n"]])
    expect(resolveLoc(CALL, APP, makeEditHost(root, overlay))).toMatchObject({ classes: ['staged-base'] })
    // ...and without the overlay the disk copy is still what is read
    expect(resolveLoc(CALL, APP, makeEditHost(root))).toMatchObject({ classes: ['rounded-md', 'px-4'] })
  })

  it('refuses out-of-root imports through the host as well', () => {
    const call = CALL.replace("./ui/button", "../../outside/secret")
    expect(resolveLoc(call, APP, makeEditHost(root))).toMatchObject({ classes: null, reason: 'computed-classname' })
  })
})
