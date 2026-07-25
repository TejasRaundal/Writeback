import { createServer } from 'node:http'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ClientMsg, ServerMsg, Loc } from '@writeback/protocol'
import { BRIDGE_PORT } from '@writeback/protocol'
import { resolveLoc, applyEdit, applyCallSiteEdit, hashOf } from './edit.ts'
import { makeEditHost } from './imports.ts'
import { getScale } from './theme.ts'
import { callSiteHints, cvaBlast, forwardsClassName } from './attribute.ts'

type JournalEntry = { id: string; file: string; preHash: string; postHash: string; pre: string; diff: string }

export function startBridge(root: string, port = BRIDGE_PORT) {
  const scale = getScale(root)
  const journalDir = join(root, '.writeback')
  const journalPath = join(journalDir, 'journal.jsonl')
  const journal = new Map<string, JournalEntry>()
  if (existsSync(journalPath)) {
    for (const line of readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line)
      if (e.undoOf) journal.delete(e.undoOf)
      else journal.set(e.id, e)
    }
  }
  const logJournal = (obj: object) => {
    mkdirSync(journalDir, { recursive: true })
    appendFileSync(journalPath, JSON.stringify(obj) + '\n')
  }

  // loc.file is root-relative (or absolute); keep writes inside root
  const safePath = (file: string): string | null => {
    const abs = resolve(root, file)
    return abs.startsWith(resolve(root) + sep) ? abs : null
  }
  const rootPosix = resolve(root).replace(/\\/g, '/')

  // Feature 2: cross-file cva follows relative imports through `makeEditHost` (src/imports.ts),
  // which owns extension/index resolution and the never-leave-root confinement.
  const makeHost = (overlay?: Map<string, string>) => makeEditHost(root, overlay)

  /**
   * The optimistic-concurrency token. A cross-file cva edit is decided by TWO files: the
   * CALL SITE picks the element and the active variant slot, the DEFINITION receives the
   * write. Hashing only the definition would let the call site change underneath us and
   * silently retarget the write to a different slot, so the token covers both files.
   * Clients treat it as opaque: whatever `resolved` handed back is what `edit` echoes.
   */
  const lockHash = (callSource: string, editSource: string, sameFile: boolean) =>
    sameFile ? hashOf(editSource) : hashOf(hashOf(callSource) + ':' + hashOf(editSource))

  // Enforce the design system server-side, so the "agents can't emit off-scale
  // values" guarantee is real over /api and MCP, not just in the panel UI.
  // Only the axes the bridge holds authoritatively (spacing, colors) are checked;
  // arbitrary [..] values require raw:true.
  const SPACING_GROUPS = new Set(['p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'gap', 'gap-x', 'gap-y'])
  const offScale = (op: { group: string; value: string; raw?: boolean }): boolean => {
    if (op.raw || op.value.startsWith('[')) return op.value.startsWith('[') && !op.raw // bracketed needs raw
    if (SPACING_GROUPS.has(op.group)) {
      const v = op.value.startsWith('-') ? op.value.slice(1) : op.value
      return !scale.spacing.includes(v)
    }
    if (op.group === 'bg' || op.group === 'text') return !(op.value in scale.colors)
    if (op.group === 'font-family') return !(op.value in scale.fonts)
    return false // remaining typography/appearance: fixed Tailwind enums chosen by the client, not enforced here
  }

  // git guardrail: does this file have uncommitted changes we didn't make?
  const gitDirty = (file: string): boolean => {
    try {
      const r = spawnSync('git', ['status', '--porcelain', '--', file], { cwd: root, encoding: 'utf8', timeout: 3000 })
      if (r.status !== 0 || !r.stdout.trim()) return false
      return ![...journal.values()].some((e) => e.file === file) // our own edits don't count
    } catch {
      return false
    }
  }

  const exportMarkdown = (): string => {
    const lines = ['# Writeback session changes', '']
    for (const e of journal.values()) {
      lines.push(`## ${e.file}`, '', '```diff', e.diff, '```', '')
    }
    return lines.join('\n')
  }

  const http = createServer((req, res) => {
    if (req.url === '/health') {
      // liveness only — never leak the absolute project root cross-origin
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify({ writeback: true }))
    } else if (req.url === '/api' && req.method === 'POST') {
      // agent/CI transport: one ClientMsg in, the ServerMsg replies out as JSON.
      // Same origin rule as WS: browser origins must be local; no origin = local tool.
      if (!originOk(req.headers.origin)) {
        res.writeHead(403)
        res.end()
        return
      }
      let body = ''
      let tooBig = false
      req.on('data', (c) => {
        if (tooBig) return
        body += c
        if (body.length > 1_000_000) { // 1 MB cap — a ClientMsg is never remotely this large
          tooBig = true
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end('{"error":"payload too large"}')
          req.destroy()
        }
      })
      req.on('end', () => {
        if (tooBig) return
        let msg: ClientMsg
        try {
          msg = JSON.parse(body)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end('{"error":"invalid json"}')
          return
        }
        const replies: ServerMsg[] = []
        try {
          handle(msg, (m) => replies.push(m))
        } catch {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end('{"error":"internal"}')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(replies.length === 1 ? replies[0] : replies))
      })
    } else if (req.url === '/export') {
      // text/plain so the browser shows the changelog in the tab instead of
      // downloading an extensionless blob; filename set for those who save it.
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'inline; filename="writeback-changes.md"',
      })
      res.end(exportMarkdown())
    } else if (req.url === '/' || req.url?.startsWith('/panel')) {
      // monorepo: src|dist → ../../panel; published npm package: dist → ../panel
      let html: string | null = null
      for (const rel of ['../../panel/index.html', '../panel/index.html']) {
        try {
          html = readFileSync(new URL(rel, import.meta.url), 'utf8')
          break
        } catch { /* try next */ }
      }
      if (html) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(html)
      } else {
        res.writeHead(404)
        res.end('panel not found')
      }
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  const wss = new WebSocketServer({ server: http })

  // Any webpage can attempt ws://127.0.0.1 — reject browser origins we don't know.
  // Non-browser clients (no Origin header) are the local user, not a CSRF vector.
  const originOk = (origin: string | undefined) => {
    if (!origin) return true
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true
    if (origin.startsWith('chrome-extension://')) return true
    return false
  }

  const doEdit = (msg: Extract<ClientMsg, { t: 'edit' }>, send: (m: ServerMsg) => void) => {
    const abs = safePath(msg.loc.file)
    if (!abs || !existsSync(abs)) {
      send({ t: 'refused', id: msg.id, loc: msg.loc, reason: 'file-not-found' })
      return
    }
    if (offScale(msg.op)) {
      send({ t: 'refused', id: msg.id, loc: msg.loc, reason: 'off-scale' })
      return
    }
    const source = readFileSync(abs, 'utf8')
    // target:'callsite' (M4) edits the component USAGE at loc; default edits what it renders
    const apply = msg.target === 'callsite' ? applyCallSiteEdit : applyEdit
    const r = apply(source, msg.loc, msg.op, msg.loc.file, makeHost())
    if (!r.ok) {
      send({ t: 'refused', id: msg.id, loc: msg.loc, reason: r.reason })
      return
    }
    // hash-mismatch covers the file we WRITE (r.file) *and*, for a cross-file cva, the
    // call-site file that chose what to write — see lockHash.
    const sameFile = r.file === msg.loc.file
    if (lockHash(source, r.preSource, sameFile) !== msg.hash) {
      send({ t: 'refused', id: msg.id, loc: msg.loc, reason: 'hash-mismatch' })
      return
    }
    if (msg.dry) {
      send({ t: 'edited', id: msg.id, loc: r.loc, diff: r.diff, dry: true, hash: msg.hash })
      return
    }
    const targetAbs = safePath(r.file)
    if (!targetAbs) {
      send({ t: 'refused', id: msg.id, loc: msg.loc, reason: 'file-not-found' })
      return
    }
    const warns = [r.warn, gitDirty(r.file) ? 'file has uncommitted manual changes' : undefined].filter(Boolean)
    writeFileSync(targetAbs, r.code) // Vite's watcher does the HMR half — never trigger a manual reload
    const entry: JournalEntry = { id: msg.id, file: r.file, preHash: hashOf(r.preSource), postHash: hashOf(r.code), pre: r.preSource, diff: r.diff }
    journal.set(msg.id, entry)
    logJournal(entry)
    // echo the ELEMENT's loc (never a cva definition site, which is not an element and
    // would refuse on the next call) + the new lock token, so an agent can chain edits
    send({ t: 'edited', id: msg.id, loc: r.loc, diff: r.diff, hash: lockHash(source, r.code, sameFile), ...(warns.length ? { warn: warns.join('; ') } : {}) })
  }

  // one handler for both transports: WS (extension/panel) and POST /api (agents, curl, CI)
  const handle = (msg: ClientMsg, send: (m: ServerMsg) => void) => {
    {
      switch (msg.t) {
        case 'config':
          // include root so agents can build correct loc.file paths (relative to it, or absolute)
          send({ t: 'config', spacing: scale.spacing, colors: scale.colors, fonts: scale.fonts, root: resolve(root).replace(/\\/g, '/') })
          break
        case 'resolve': {
          const abs = safePath(msg.loc.file)
          if (!abs || !existsSync(abs)) {
            // distinct from a real refusal: the path was wrong, not the className.
            // hand back the root so the agent can fix the path without a config round-trip.
            send({ t: 'resolved', loc: msg.loc, hash: '', classes: null, reason: 'file-not-found', root: rootPosix })
            break
          }
          const source = readFileSync(abs, 'utf8')
          const r = resolveLoc(source, msg.loc, makeHost())
          const mloc = r.loc ?? msg.loc // the element's real loc (tolerant match may differ from requested)
          // for a cross-file cva the editable source (and its hash) is the DEFINITION file;
          // hashing/blast follow it so the client edits + verifies the right file.
          const editSource = (r as any).editSource ?? source
          const editFile = (r as any).editFile ?? msg.loc.file
          const extras: any = {}
          if (r.classes === null && r.reason === 'computed-classname') {
            const hints = callSiteHints(root, source, mloc)
            if (hints.length) extras.hints = hints
          }
          const blast = cvaBlast(editSource)
          if (blast.length) extras.blast = blast
          const instance = forwardsClassName(source, mloc)
          if (instance) {
            extras.instance = instance
            if (instance.forwards && !extras.hints) {
              const hints = callSiteHints(root, source, mloc)
              if (hints.length) extras.hints = hints
            }
          }
          // dirtiness that matters is the file the edit will TOUCH (def file for a cross-file cva)
          if (gitDirty(editFile)) extras.dirty = true
          // name the file the edit would write when it is not loc.file, so the client can
          // see (and show) that a cva definition, not the clicked element, is the target
          if (editFile !== msg.loc.file) extras.editFile = editFile
          // Feature 1: groups a conditional branch owns — refuse them HERE, not only on write
          if ((r as any).locked) extras.locked = (r as any).locked
          // echo the element's REAL loc (may differ from the requested col when the
          // agent passed just a line) so the follow-up edit uses the exact position.
          const echoLoc = r.loc ?? msg.loc
          send({
            t: 'resolved', loc: echoLoc,
            hash: lockHash(source, editSource, editFile === msg.loc.file),
            classes: r.classes, ...(r.classes === null ? { reason: r.reason } : {}), ...extras,
          })
          break
        }
        case 'edit':
          doEdit(msg, send)
          break
        case 'bulk': {
          if (!Array.isArray(msg.edits) || msg.edits.length === 0) {
            send({ t: 'refused', id: msg.id, loc: { file: '', line: 0, col: 0 }, reason: 'unknown-edit' })
            break
          }
          // all-or-nothing: verify every edit against current file state, then write all.
          // `staged` (abs → pending code) doubles as the host overlay, so several edits
          // that land in the SAME file — including one cva definition file reached from
          // different call sites — compose instead of clobbering each other.
          const staged = new Map<string, string>()
          // every file's ON-DISK content at the start of the batch: hashes must be checked
          // against what the CLIENT saw, never against a sibling edit's staged output —
          // otherwise one valid edit launders the stale hashes of every edit after it
          const originals = new Map<string, string>()
          const original = (abs: string) => {
            if (!originals.has(abs)) originals.set(abs, readFileSync(abs, 'utf8'))
            return originals.get(abs)!
          }
          const diffs: string[] = []
          let failed: ServerMsg | null = null
          for (const e of msg.edits) {
            const abs = safePath(e.loc.file)
            if (!abs || !existsSync(abs)) {
              failed = { t: 'refused', id: msg.id, loc: e.loc, reason: 'file-not-found' }
              break
            }
            if (offScale(e.op)) {
              failed = { t: 'refused', id: msg.id, loc: e.loc, reason: 'off-scale' }
              break
            }
            const source = staged.get(abs) ?? original(abs)
            const apply = e.target === 'callsite' ? applyCallSiteEdit : applyEdit
            const r = apply(source, e.loc, e.op, e.loc.file, makeHost(staged))
            if (!r.ok) {
              failed = { t: 'refused', id: msg.id, loc: e.loc, reason: r.reason }
              break
            }
            const targetAbs = safePath(r.file)
            if (!targetAbs || !existsSync(targetAbs)) {
              failed = { t: 'refused', id: msg.id, loc: e.loc, reason: 'file-not-found' }
              break
            }
            // every edit is verified against the pre-batch content of BOTH files it depends
            // on (see lockHash) — being the second edit into an already-staged file is not
            // an excuse to skip the check
            if (lockHash(original(abs), original(targetAbs), targetAbs === abs) !== e.hash) {
              failed = { t: 'refused', id: msg.id, loc: e.loc, reason: 'hash-mismatch' }
              break
            }
            staged.set(targetAbs, r.code)
            diffs.push(r.diff)
          }
          if (failed) {
            send(failed)
            break
          }
          for (const [abs, code] of staged) {
            const pre = readFileSync(abs, 'utf8')
            writeFileSync(abs, code)
            const file = abs.slice(resolve(root).length + 1).replace(/\\/g, '/')
            const entry: JournalEntry = { id: msg.id + ':' + file, file, preHash: hashOf(pre), postHash: hashOf(code), pre, diff: '' }
            journal.set(entry.id, entry)
            logJournal(entry)
          }
          send({ t: 'edited', id: msg.id, loc: msg.edits[0].loc, diff: diffs.join('\n') })
          break
        }
        case 'undo': {
          // single edits journal under the bare id; bulk edits under composite `${id}:${file}`
          const entries = journal.has(msg.id)
            ? [journal.get(msg.id)!]
            : [...journal.values()].filter((e) => e.id.startsWith(msg.id + ':'))
          if (!entries.length) {
            // always reply — a silent break would hang a client awaiting a response
            send({ t: 'refused', id: msg.id, loc: { file: '', line: 0, col: 0 }, reason: 'unknown-edit' })
            break
          }
          let reverted = 0
          for (const entry of entries) {
            const abs = safePath(entry.file)
            if (!abs || !existsSync(abs)) continue
            if (hashOf(readFileSync(abs, 'utf8')) !== entry.postHash) continue // changed since — leave it
            writeFileSync(abs, entry.pre)
            journal.delete(entry.id)
            logJournal({ undoOf: entry.id })
            reverted++
          }
          const loc: Loc = { file: entries[0].file, line: 0, col: 0 }
          if (reverted) send({ t: 'edited', id: msg.id, loc, diff: '' })
          else send({ t: 'refused', id: msg.id, loc, reason: 'hash-mismatch' })
          break
        }
        case 'journal':
          send({
            t: 'journal',
            entries: [...journal.values()].map((e) => ({
              id: e.id,
              file: e.file,
              summary: e.diff.split('\n').find((l) => l.startsWith('+') && !l.startsWith('+++'))?.trim() ?? '',
            })),
          })
          break
        case 'open': {
          // jump-to-source: same mechanism family as Vite's error overlay
          const abs = safePath(msg.loc.file)
          if (abs) {
            import('launch-editor').then(({ default: launch }) => launch(`${abs}:${msg.loc.line}:${msg.loc.col + 1}`)).catch(() => {})
          }
          break
        }
      }
    }
  }

  wss.on('connection', (ws: WebSocket, req) => {
    if (!originOk(req.headers.origin)) {
      ws.close(1008, 'origin not allowed')
      return
    }
    const send = (msg: ServerMsg) => ws.send(JSON.stringify(msg))
    ws.on('message', (data) => {
      let msg: ClientMsg
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      // a malformed-but-valid-JSON frame must never crash the dev bridge
      try {
        handle(msg, send)
      } catch {
        /* swallow: one bad frame shouldn't take down the socket or the process */
      }
    })
  })

  http.listen(port, '127.0.0.1')
  return () => http.close()
}
