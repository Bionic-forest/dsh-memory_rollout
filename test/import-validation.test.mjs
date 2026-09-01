// 阶段 0 · 第四项：严格导入校验（大小 / 路径 / Base64）
// 对应《向Codex原版系统看齐》阶段0 MUST「严格导入大小、路径和 Base64 校验」。
// 校验须在任何 live 状态被触碰前完成。
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
  const p = routes['/dsh-memory-rollout/import'].handler(req, res)
  req.emit('data', rawText)
  req.emit('end')
  await p
  return { status: res.statusCode, body: JSON.parse(res.body) }
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const bundle = (files, entries = []) => JSON.stringify({ format: 'dsh-memory-rollout-memory-backup', version: 1, files, entries })

const tmp = path.join(os.tmpdir(), 'dsh-memory-rollout-importval-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, {})
  assert.ok(routes['/dsh-memory-rollout/import'], 'import route registered')

  console.log('[1] invalid base64 rejected')
  {
    const r = await callImport(bundle([{ path: 'a.md', content: '%%%not-base64%%%' }]))
    check(r.status === 400 && /invalid base64/i.test(r.body.error), 'invalid base64 -> 400')
  }

  console.log('[2] path traversal rejected')
  {
    const r = await callImport(bundle([{ path: '../evil.md', content: b64('x') }]))
    check(r.status === 400 && /traversal|\.\./.test(r.body.error), 'traversal path -> 400')
  }

  console.log('[3] duplicate path rejected')
  {
    const r = await callImport(bundle([{ path: 'a.md', content: b64('x') }, { path: 'a.md', content: b64('y') }]))
    check(r.status === 400 && /duplicate path/i.test(r.body.error), 'duplicate path -> 400')
  }

  console.log('[4] single file over max size rejected')
  {
    // ~14MB of 'A' base64 decodes to ~10.5MB > 10MB single-file cap.
    const big = bundle([{ path: 'big.md', content: 'A'.repeat(14 * 1024 * 1024) }])
    const r = await callImport(big)
    check(r.status === 400 && /exceeds max size/i.test(r.body.error), 'oversized file -> 400')
  }

  console.log('[5] valid bundle still imports')
  {
    const r = await callImport(bundle([{ path: 'rollout_summaries/ok.md', content: b64('ok') }], [{ id: 'e1', content: 'hello', createdAt: '2026-08-27T00:00:00.000Z' }]))
    check(r.status === 200 && r.body && r.body.ok === true, 'valid bundle -> 200')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL IMPORT-VALIDATION TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
