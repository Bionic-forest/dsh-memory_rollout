// One-off isolated test for import atomicity (P#5 / GPT P1 "导入不原子").
// Verifies:
//   - a concurrent import while one is in flight is REJECTED (global mutex, 409)
//     instead of sharing tmp/backup dirs and deleting each other's state;
//   - a normal import still succeeds once the mutex is released (no stale lock);
//   - tmp/backup dirs use a per-import unique id (not a same-second timestamp).
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply } = await import(PLUGIN)

// In-memory storage table; `putDelayMs` lets an import stay "in flight" so a
// second concurrent import can be fired while the mutex is held.
class FakeTable {
  constructor() {
    this._m = new Map()
    this.putDelayMs = 0
  }
  async put(k, v) {
    if (this.putDelayMs > 0) await new Promise((r) => setTimeout(r, this.putDelayMs))
    this._m.set(k, v)
  }
  delete(k) {
    return Promise.resolve(this._m.delete(k))
  }
  keys() {
    return this._m.keys()
  }
  entries() {
    return this._m.entries()
  }
  get size() {
    return this._m.size
  }
}

const routes = {}
const webServer = { register: (route) => { routes[route.path] = route; return () => {} } }
const ctx = {
  storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
  get: (k) => (k === 'webServer' ? webServer : undefined),
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
}
const table = new FakeTable()

class FakeReq {
  constructor(method = 'POST') { this.method = method; this._l = {} }
  on(ev, cb) { ;(this._l[ev] = this._l[ev] || []).push(cb) }
  emit(ev, data) { for (const cb of this._l[ev] || []) cb(data) }
}

async function callImport(rawText) {
  const req = new FakeReq('POST')
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, body: '' }
  res.end = (b) => { res.body = b }
  const handler = routes['/dsh-rollout/import'].handler
  const p = handler(req, res)
  req.emit('data', rawText)
  req.emit('end')
  await p
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch {}
  return { status: res.statusCode, body: parsed }
}

const tmpHome = path.join(os.tmpdir(), 'dsh-rollout-mutex-' + Date.now())
process.env.DSH_HOME = tmpHome
fs.mkdirSync(tmpHome, { recursive: true })
const memoryRoot = () => path.join(tmpHome, 'memories')
const summariesDir = () => path.join(memoryRoot(), 'rollout_summaries')
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const bundle = (tag) => ({
  format: 'dsh-rollout-memory-backup',
  version: 1,
  files: [{ path: 'rollout_summaries/' + tag + '.md', content: b64('# ' + tag) }],
  entries: [{ id: tag + '-entry', content: 'entry ' + tag, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }],
})
const listBackupDirs = () => {
  try { return fs.readdirSync(tmpHome).filter((n) => n.startsWith('memories-backup-')) } catch { return [] }
}

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, {})

  // ── 1) happy path still succeeds (mutex released) ────────────────────────────
  console.log('[1] normal import succeeds (no stale lock)')
  {
    const r = await callImport(JSON.stringify(bundle('ok')))
    check(r.status === 200, 'returns HTTP 200 on success')
    check(r.body && r.body.ok === true, 'ok === true')
    check(r.body && r.body.rollbackFailed === false, 'rollbackFailed === false')
    check(r.body && r.body.fileCount === 1 && r.body.entryCount === 1, 'fileCount/entryCount correct')
    check(fs.existsSync(path.join(summariesDir(), 'ok.md')), 'imported file landed')
    const bd = listBackupDirs()
    check(bd.length === 1, 'one backup dir created')
    if (bd.length === 1) {
      // The suffix must be a per-import unique id, not the old 19-char timestamp
      // that would collide within the same second.
      const suffix = bd[0].replace('memories-backup-', '')
      check(suffix.length > 19 && /[a-z]/.test(suffix), 'backup dir uses a unique id suffix (not timestamp): ' + suffix)
    }
  }

  // ── 2) mutex: a concurrent import while one is in flight is REJECTED (409) ──
  console.log('[2] concurrent import rejected while an import is in flight (409, no mutual delete)')
  {
    // Pre-seed a backup dir + entry so the import has real state to touch.
    table.putDelayMs = 60 // keep the first import "in flight" at its switch put
    const pA = callImport(JSON.stringify(bundle('a'))) // starts; suspends at slow put holding the lock
    const rB = await callImport(JSON.stringify(bundle('b'))) // fires while A is in flight
    check(rB.status === 409, 'concurrent import returns HTTP 409 (conflict)')
    check(rB.body && rB.body.ok === false, 'concurrent import ok === false')
    check(rB.body && /already in progress|retry/i.test(rB.body.error), 'concurrent import error says "already in progress / retry"')
    const rA = await pA // A finishes after the slow put
    check(rA.status === 200 && rA.body && rA.body.ok === true, 'the in-flight import itself succeeds')
  }

  // ── 3) lock is released after the in-flight import completes ────────────────
  console.log('[3] after the in-flight import completes, a new import succeeds (no stale lock)')
  {
    table.putDelayMs = 0
    const r = await callImport(JSON.stringify(bundle('c')))
    check(r.status === 200 && r.body && r.body.ok === true, 'post-lock import returns 200')
    check(r.body && r.body.rollbackFailed === false, 'post-lock import rollbackFailed === false')
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL IMPORT-MUTEX TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
