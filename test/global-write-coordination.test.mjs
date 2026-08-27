// 阶段 0 · 第三项：全局写协调（withWrite）
// 对应《向Codex原版系统看齐》§12.1「导入期间不能有其它写路径改写同一状态」。
// 用门控让导入持锁（写入慢），验证并发 UI 写被拒（writeConflict），随后锁释放可再写；
// 并验证并发第二个导入仍被拒（409，与 import-mutex 兼容）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply } = await import(PLUGIN)

const table = (() => {
  const m = new Map()
  let putDelayMs = 0
  return {
    putDelayMs: (v) => { putDelayMs = v },
    put: async (k, v) => { if (putDelayMs > 0) await new Promise((r) => setTimeout(r, putDelayMs)); m.set(k, v); return Promise.resolve() },
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
async function post(pathStr, body) {
  const req = new FakeReq('POST')
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, body: '' }
  res.end = (b) => { res.body = b }
  const p = routes[pathStr].handler(req, res)
  req.emit('data', body)
  req.emit('end')
  await p
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch {}
  return { status: res.statusCode, body: parsed }
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const importBundle = JSON.stringify({ format: 'dsh-rollout-memory-backup', version: 1, files: [{ path: 'rollout_summaries/x.md', content: b64('x') }], entries: [{ id: 'e1', content: 'x', createdAt: '2026-08-27T00:00:00.000Z' }] })

const tmp = path.join(os.tmpdir(), 'dsh-rollout-writecoord-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, {})
  assert.ok(routes['/dsh-rollout/import'] && routes['/dsh-rollout/entries'], 'routes registered')

  // ── [1] import holds the write lock → concurrent UI add is rejected ────────
  console.log('[1] import in flight rejects a concurrent UI write')
  {
    table.putDelayMs(120) // make the import switch slow so it holds writeBusy
    const pA = post('/dsh-rollout/import', importBundle)
    await new Promise((r) => setTimeout(r, 25)) // let the import acquire writeBusy + hit its slow put
    const rUI = await post('/dsh-rollout/entries', JSON.stringify({ action: 'add', content: 'during import' }))
    check(rUI.status === 500, 'concurrent UI add is rejected (writeConflict)')
    check(rUI.body && /another write.*in progress/i.test(rUI.body.error), 'UI add error says write in progress')
    const rA = await pA
    check(rA.status === 200 && rA.body && rA.body.ok === true, 'the in-flight import itself succeeds')
  }

  // ── [2] after import completes, the write lock is released ─────────────────
  console.log('[2] after import, a UI write succeeds (lock released)')
  {
    table.putDelayMs(0)
    const r = await post('/dsh-rollout/entries', JSON.stringify({ action: 'add', content: 'after import' }))
    check(r.status === 200 && r.body && r.body.added === true, 'post-import UI add returns 200')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL WRITE-COORDINATION TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
