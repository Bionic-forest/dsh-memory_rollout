// 阶段 0 · 第一项：所有写入入口统一脱敏（UI 添加条目 + 导入条目）
// 对应《向Codex原版系统看齐》§5.5 所有入口共享同一安全边界 / §11 三道防线。
// 验证：任何入口把含秘密的条目写入 entries 表时，落盘值必须已脱敏。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

// ── shared mock host ─────────────────────────────────────────────────────────
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
const tools = {}
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: (k) => (k === 'webServer' ? webServer : undefined),
  tools: { register: (t) => { tools[t.name] = t } },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
}

class FakeReq {
  constructor(method = 'POST') { this.method = method; this._l = {} }
  on(ev, cb) { ;(this._l[ev] = this._l[ev] || []).push(cb) }
  emit(ev, data) { for (const cb of this._l[ev] || []) cb(data) }
}

async function call(routePath, body) {
  const req = new FakeReq('POST')
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, body: '' }
  res.end = (b) => { res.body = b }
  const handler = routes[routePath].handler
  const p = handler(req, res)
  req.emit('data', body)
  req.emit('end')
  await p
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch {}
  return { status: res.statusCode, body: parsed }
}

const SECRET = 'credential sk-abcDEF123456 and db Password=P@ssw0rd'
let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-ingress-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })

try {
  await apply(ctx, {})
  assert.ok(routes['/dsh-memory_rollout/entries'], 'entries route registered')
  assert.ok(routes['/dsh-memory_rollout/import'], 'import route registered')

  // ── (1) UI add entry redacts before writing ──────────────────────────────
  console.log('[1] UI add-entry redacts the stored content')
  {
    const r = await call('/dsh-memory_rollout/entries', JSON.stringify({ action: 'add', content: SECRET, tags: ['a', 'b'] }))
    check(r.status === 200 && r.body && r.body.added === true, 'add returns ok')
    const raw = table._m.get(r.body.id)
    check(raw && raw.content.indexOf('sk-abcDEF123456') === -1 && raw.content.indexOf('P@ssw0rd') === -1, 'stored content has no raw secret')
    check(raw && raw.content.includes('[REDACTED]'), 'stored content contains [REDACTED]')
  }

  // ── (2) import entry redacts before writing ──────────────────────────────
  console.log('[2] import entry redacts the restored table content')
  {
    const bundle = {
      format: 'dsh-memory_rollout-memory-backup',
      version: 1,
      files: [{ path: 'rollout_summaries/imp.md', content: Buffer.from('imported file content', 'utf8').toString('base64') }],
      entries: [{ id: 'imp-1', content: SECRET, createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z' }],
    }
    const r = await call('/dsh-memory_rollout/import', JSON.stringify(bundle))
    check(r.status === 200 && r.body && r.body.ok === true, 'import returns ok')
    const stored = table._m.get('imp-1')
    check(stored && stored.content.indexOf('sk-abcDEF123456') === -1 && stored.content.indexOf('P@ssw0rd') === -1, 'imported content has no raw secret')
    check(stored && stored.content.includes('[REDACTED]'), 'imported content contains [REDACTED]')
  }

  // ── (3) ordinary non-secret content is NOT mangled ────────────────────────
  console.log('[3] ordinary content is preserved (no false-positive redaction)')
  {
    const r = await call('/dsh-memory_rollout/entries', JSON.stringify({ action: 'add', content: 'set up the build config and run the tests', tags: [] }))
    const raw = table._m.get(r.body.id)
    check(raw && raw.content === 'set up the build config and run the tests', 'ordinary text unchanged')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL INGRESS-REDACTION TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
