// One-off isolated test for the rewritten importBundle (P0-1 + P0-2).
// Mocks the minimal DSH host surface and drives /dsh-rollout/import through the
// plugin's own apply() so we exercise the real closure logic.
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

// ── tiny in-memory storage table (matches how dsh-storage-domain table is used) ──
class FakeTable {
  constructor() {
    this._m = new Map()
    this._failNextPut = false
  }
  put(k, v) {
    if (this._failNextPut) {
      this._failNextPut = false
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

const table = new FakeTable()
const routes = {}
const webServer = {
  register: (route) => {
    routes[route.path] = route
    return () => {}
  },
}

const capturedDisposers = []
const ctx = {
  storageDomain: {
    open: async () => ({
      table: (name) => table,
      close: async () => {},
    }),
  },
  get: (key) => (key === 'webServer' ? webServer : undefined),
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  effect: (fn) => {
    capturedDisposers.push(fn)
    return () => {}
  },
  on: () => () => {},
}

// ── drive /dsh-rollout/import ────────────────────────────────────────────────
class FakeReq {
  constructor(method = 'POST') {
    this.method = method
    this._l = {}
  }
  on(ev, cb) {
    ;(this._l[ev] = this._l[ev] || []).push(cb)
  }
  emit(ev, data) {
    for (const cb of this._l[ev] || []) cb(data)
  }
}

async function callImport(rawText) {
  const req = new FakeReq('POST')
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, body: '' }
  res.end = (b) => { res.body = b }
  const handler = routes['/dsh-rollout/import'] && routes['/dsh-rollout/import'].handler
  assert.ok(handler, '/dsh-rollout/import route must be registered')
  const p = handler(req, res)
  req.emit('data', rawText)
  req.emit('end')
  await p
  let parsed = null
  try {
    parsed = JSON.parse(res.body)
  } catch {}
  return { status: res.statusCode, body: parsed }
}

// ── helpers ──────────────────────────────────────────────────────────────────
const dsHome = () => process.env.DSH_HOME
const memoryRoot = () => path.join(dsHome(), 'memories')
function listSummaries() {
  const d = path.join(memoryRoot(), 'rollout_summaries')
  try {
    return fs.readdirSync(d).filter((n) => n.startsWith('.') === false)
  } catch {
    return []
  }
}
function hasEntry(content) {
  const out = []
  for (const [, v] of table.entries()) out.push(String(v.content))
  return content === undefined ? out : out.includes(content)
}

const tmpHome = path.join(os.tmpdir(), 'dsh-rollout-p0-test-' + Date.now())
process.env.DSH_HOME = tmpHome
fs.mkdirSync(tmpHome, { recursive: true })

let failed = 0
const check = (cond, msg) => {
  if (cond) {
    console.log('  ✓ ', msg)
  } else {
    failed++
    console.error('  ✗ ', msg)
  }
}

try {
  // apply() seeds the empty memories layout (MEMORY.md, memory_summary.md, .watermark).
  await apply(ctx, {})
  console.log('plugin apply() OK, memoryRoot =', memoryRoot())

  // ── seed a "current state" that import must replace / protect ──────────────
  const summariesDir = path.join(memoryRoot(), 'rollout_summaries')
  fs.mkdirSync(summariesDir, { recursive: true })
  fs.writeFileSync(path.join(summariesDir, 'stale.md'), '# old draft that must be replaced')
  await table.put('old-entry', {
    content: 'old long-term entry',
    tags: ['old'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source: 'tool',
    sessionId: 'old-session',
  })

  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

  // ── TEST A: valid bundle replaces old tree + restores table ────────────────
  console.log('\n[Test A] success: replace old tree + restore entries table')
  const bundleA = {
    format: 'dsh-rollout-memory-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    fileCount: 1,
    files: [{ path: 'rollout_summaries/new.md', content: b64('brand new draft body') }],
    entries: [
      {
        id: 'new-entry',
        content: 'brand new long-term entry',
        tags: ['new'],
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
        source: 'ui',
        sessionId: 'new-session',
      },
    ],
  }
  const rA = await callImport(JSON.stringify(bundleA))
  check(rA.status === 200 && rA.body && rA.body.ok === true, 'import returns ok')
  check(rA.body.fileCount === 1 && rA.body.entryCount === 1, 'fileCount/entryCount correct')
  check(listSummaries().includes('new.md'), 'new.md present')
  check(listSummaries().includes('stale.md') === false, 'stale.md removed (no stale-tree residue)')
  check(fs.readFileSync(path.join(summariesDir, 'new.md'), 'utf8') === 'brand new draft body', 'new.md content intact')
  check(hasEntry('brand new long-term entry'), 'table has imported entry')
  check(hasEntry('old long-term entry') === false, 'old table entry replaced')

  // ── TEST B: invalid bundles are rejected, current state untouched ───────────
  console.log('\n[Test B] invalid bundles rejected, state unchanged')
  const snapshotFiles = listSummaries().map((f) => f)
  const snapshotEntries = hasEntry().join('|')

  let rb = await callImport('not valid json')
  check(rb.status === 400 && /not valid JSON/.test(rb.body.error), 'malformed JSON rejected')

  rb = await callImport(JSON.stringify({ format: 'something-else', files: [] }))
  check(rb.status === 400 && /not a dsh-rollout/.test(rb.body.error), 'wrong format rejected')

  rb = await callImport(JSON.stringify({ format: 'dsh-rollout-memory-backup', files: [{ path: '../../evil.md', content: b64('x') }] }))
  check(rb.status === 400 && /traversal/i.test(rb.body.error), 'path traversal rejected')

  rb = await callImport(JSON.stringify({ format: 'dsh-rollout-memory-backup', files: [], entries: [{ content: '' }] }))
  check(rb.status === 400 && /entry missing non-empty content/.test(rb.body.error), 'empty entry rejected')

  check(JSON.stringify(listSummaries()) === JSON.stringify(snapshotFiles), 'files unchanged after invalid imports')
  check(hasEntry().join('|') === snapshotEntries, 'entries unchanged after invalid imports')

  // ── TEST C: mid-switch failure rolls back to the pre-import state ───────────
  console.log('\n[Test C] mid-switch failure rolls back (files + table)')
  // seed again a distinct old state
  fs.writeFileSync(path.join(summariesDir, 'stale.md'), '# old draft rolled back')
  await table.put('old-entry', {
    content: 'old long-term entry',
    tags: ['old'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source: 'tool',
    sessionId: 'old-session',
  })
  const preFiles = listSummaries().sort().join(',')
  const preEntries = hasEntry().sort().join('|')

  table._failNextPut = true // the switch's first table.put throws
  const bundleC = {
    format: 'dsh-rollout-memory-backup',
    version: 1,
    files: [{ path: 'rollout_summaries/fromC.md', content: b64('should be rolled back') }],
    entries: [{ id: 'c-entry', content: 'new c entry', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' }],
  }
  const rC = await callImport(JSON.stringify(bundleC))
  check(rC.status === 400, 'failed import returns 400')
  check(/simulated put failure/.test(rC.body.error), 'reports the injected failure')

  check(listSummaries().sort().join(',') === preFiles, 'files rolled back (fromC.md absent, stale.md back)')
  check(fs.readFileSync(path.join(summariesDir, 'stale.md'), 'utf8') === '# old draft rolled back', 'old file content restored')
  check(hasEntry().sort().join('|') === preEntries, 'entries rolled back (old-entry back, c-entry absent)')
  check(fs.existsSync(path.join(summariesDir, 'fromC.md')) === false, 'new file from failed import absent')

  // ── cleanup temp import dirs left in dsHome ─────────────────────────────────
  const leftovers = fs.readdirSync(dsHome()).filter((n) => n.startsWith('memories-import-tmp-'))
  check(leftovers.length === 0, 'temp import dirs cleaned up')
} finally {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {}
}

console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
