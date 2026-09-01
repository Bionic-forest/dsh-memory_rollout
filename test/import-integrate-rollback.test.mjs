// 阶段 0 · 第二项：迁移后整合(integrate)失败也必须回滚
// 对应《向Codex原版系统看齐》§12.2「切换成功但整合失败也属于导入失败，必须在回滚保护范围内」。
// 注入：bundle 把派生物路径 memory_summary.md 当成目录（含子路径），导入切换成功后
// integrate() 写 memory_summary.md 会抛 EISDIR → 整个事务必须回滚到导入前状态。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const table = (() => {
  const m = new Map()
  return {
    put: (k, v) => { m.set(k, v); return Promise.resolve() },
    delete: (k) => Promise.resolve(m.delete(k)),
    keys: () => m.keys(),
    entries: () => m.entries(),
    get size() { return m.size },
    _m: m,
  }
})()

const routes = {}
const webServer = { register: (r) => { routes[r.path] = r; return () => {} } }
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: (k) => (k === 'webServer' ? webServer : undefined),
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
}

class FakeReq {
  constructor(method = 'POST') { this.method = method; this._l = {} }
  on(ev, cb) { ;(this._l[ev] = this._l[ev] || []).push(cb) }
  emit(ev, data) { for (const cb of this._l[ev] || []) cb(data) }
}
async function callImport(rawText) {
  const req = new FakeReq('POST')
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, body: '' }
  res.end = (b) => { res.body = b }
  const p = routes['/dsh-memory_rollout/import'].handler(req, res)
  req.emit('data', rawText)
  req.emit('end')
  await p
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-introllback-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const memoryRoot = () => path.join(tmp, 'memories')
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, {})
  assert.ok(routes['/dsh-memory_rollout/import'], 'import route registered')

  // Pre-seed a known-good prior state (old entry + old registry file).
  table.put('old-entry', { content: 'old long-term entry', tags: ['old'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', source: 'tool', sessionId: 's-old' })
  fs.mkdirSync(memoryRoot(), { recursive: true })
  fs.writeFileSync(path.join(memoryRoot(), 'memory_summary.md'), '# v1\nold good summary', 'utf8')
  fs.writeFileSync(path.join(memoryRoot(), 'MEMORY.md'), '# MEMORY.md\nold registry', 'utf8')

  // Bundle that makes memory_summary.md a DIRECTORY after switch → integrate() fails.
  const bundle = {
    format: 'dsh-memory_rollout-memory-backup',
    version: 1,
    files: [
      { path: 'memory_summary.md/sub', content: b64('nope') },
      { path: 'rollout_summaries/new.md', content: b64('new content') },
    ],
    entries: [{ id: 'new-entry', content: 'new entry that must be rolled back', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }],
  }

  const r = await callImport(JSON.stringify(bundle))
  console.log('  [debug] import response:', r.status, JSON.stringify(r.body))

  // The integrate failure must surface as a retryable rollback (rollbackFailed:false),
  // NOT as a success and NOT as rollback-failed.
  check(r.status === 400, 'returns HTTP 400 (transaction failed)')
  check(r.body && r.body.ok === false, 'ok === false')
  check(r.body && r.body.rollbackFailed === false, 'rollbackFailed === false (rollback succeeded)')
  check(r.body && /restored|retry/i.test(r.body.error), 'error says previous memory restored / retry')

  // Rollback restored the prior state.
  check(!!table._m.get('old-entry'), 'old-entry restored after integrate-failure rollback')
  check(!table._m.get('new-entry'), 'new-entry NOT present (imported entries rolled back)')
  const summaryText = fs.existsSync(path.join(memoryRoot(), 'memory_summary.md')) ? fs.readFileSync(path.join(memoryRoot(), 'memory_summary.md'), 'utf8') : ''
  check(summaryText.includes('old good summary'), 'memory_summary.md restored to the old good summary (not left as a broken dir)')
  check(!fs.existsSync(path.join(memoryRoot(), 'rollout_summaries', 'new.md')), 'imported new.md was rolled back')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL IMPORT-INTEGRATE-ROLLBACK TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
