// One-off isolated test for import rollback reporting (P#4 / GPT P1).
// Verifies the import route distinguishes:
//   - switch failure + rollback success → {ok:false, rollbackFailed:false, error} (data restored)
//   - switch failure + rollback ALSO failure → {ok:false, rollbackFailed:true, backupPath, error} (manual recovery)
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply } = await import(PLUGIN)

// In-memory storage table; `putFailsRemaining` lets us inject a failure on the Nth put.
class FakeTable {
  constructor() {
    this._m = new Map()
    this.putFailsRemaining = 0
  }
  put(k, v) {
    if (this.putFailsRemaining > 0) {
      this.putFailsRemaining--
      throw new Error('simulated put failure')
    }
    this._m.set(k, v)
    return Promise.resolve()
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

const tmpHome = path.join(os.tmpdir(), 'dsh-rollout-rollback-' + Date.now())
process.env.DSH_HOME = tmpHome
fs.mkdirSync(tmpHome, { recursive: true })
const memoryRoot = () => path.join(tmpHome, 'memories')
const summariesDir = () => path.join(memoryRoot(), 'rollout_summaries')
const listFiles = () => { try { return fs.readdirSync(summariesDir()).filter((n) => !n.startsWith('.')) } catch { return [] } }
const listEntries = () => { const out = []; for (const [, v] of table.entries()) out.push(String(v.content)); return out.sort() }
function seedState() {
  fs.mkdirSync(summariesDir(), { recursive: true })
  fs.writeFileSync(path.join(summariesDir(), 'stale.md'), '# old draft')
  fs.writeFileSync(path.join(summariesDir(), 'keep.md'), '# keep me')
  table.put('old-entry', { content: 'old long-term entry', tags: ['old'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', source: 'tool', sessionId: 'old-s' })
}
const preFiles = () => listFiles().sort().join(',')
const preEntries = () => listEntries().join('|')
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const bundle = () => ({
  format: 'dsh-rollout-memory-backup',
  version: 1,
  files: [{ path: 'rollout_summaries/new.md', content: b64('should never land') }],
  entries: [{ id: 'new-entry', content: 'new entry that should not persist', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }],
})

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, {})

  // ── 1) switch failure + rollback SUCCESS → ok:false, rollbackFailed:false, data restored ──
  console.log('[1] switch fails, rollback succeeds → retryable, data restored')
  {
    seedState()
    const beforeFiles = preFiles()
    const beforeEntries = preEntries()
    table.putFailsRemaining = 1 // the switch's first table.put throws; restoreBackup's puts succeed
    const r = await callImport(JSON.stringify(bundle()))
    check(r.status === 400, 'returns HTTP 400 on import failure')
    check(r.body && r.body.ok === false, 'ok === false')
    check(r.body && r.body.rollbackFailed === false, 'rollbackFailed === false (rollback succeeded)')
    check(r.body && /restored|retry/i.test(r.body.error), 'error says data restored / retryable')
    check(preFiles() === beforeFiles, 'files restored (stale.md + keep.md back, new.md absent)')
    check(preEntries() === beforeEntries, 'entries restored (old-entry back, new-entry absent)')
    check(r.body && r.body.backupPath === undefined, 'no backupPath on rollback success (nothing to recover manually)')
    check(fs.existsSync(path.join(summariesDir(), 'new.md')) === false, 'import file did not land')
  }

  // ── 2) switch failure + rollback ALSO fails → ok:false, rollbackFailed:true, backupPath ──
  console.log('[2] switch fails, rollback ALSO fails → manual recovery surfaced')
  {
    seedState()
    table.putFailsRemaining = 2 // switch put #1 fails, restoreBackup put #2 also fails
    const r = await callImport(JSON.stringify(bundle()))
    check(r.status === 400, 'returns HTTP 400 on import failure')
    check(r.body && r.body.ok === false, 'ok === false')
    check(r.body && r.body.rollbackFailed === true, 'rollbackFailed === true')
    check(r.body && typeof r.body.backupPath === 'string' && r.body.backupPath.length > 0, 'backupPath provided')
    check(r.body && /manual|REQUIRED/i.test(r.body.error), 'error contains manual-recovery instruction')
    if (r.body && r.body.backupPath) {
      check(fs.existsSync(path.join(r.body.backupPath, 'files')), 'backupPath/files/ exists for manual restore')
      check(fs.existsSync(path.join(r.body.backupPath, 'entries.json')), 'backupPath/entries.json exists for manual restore')
    }
  }

  // ── 3) invalid bundle → rollbackFailed:false (not a rollback scenario) ────────────
  console.log('[3] invalid bundle → ok:false, rollbackFailed:false (distinguishable)')
  {
    const r = await callImport('not json')
    check(r.status === 400, 'returns 400 on invalid bundle')
    check(r.body && r.body.rollbackFailed === false, 'invalid bundle rollbackFailed === false')
    check(r.body && /not valid JSON/.test(r.body.error), 'error identifies invalid JSON')
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL ROLLBACK-REPORT TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
