// 阶段 A · 接线第①步：session/disposed 只入队（落盘 .stage1-state.json）
// 接线③：disposer 入队后由 setImmediate 调度的 drainStage1Jobs 消费到期 pending 作业。
// 验证：disposer 入队 → job 经 drain 消费完成（status 非 pending）；同 session+watermark 去重。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply } = await import(PLUGIN)

const table = (() => {
  const m = new Map()
  return {
    put: (k, v) => { m.set(k, v); return Promise.resolve() },
    delete: (k) => Promise.resolve(m.delete(k)),
    keys: () => m.keys(),
    entries: () => m.entries(),
    get size() { return m.size },
  }
})()
const eventHandlers = {}
const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [] })
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  // sessionQuery present (persistence path): s1 empty transcript -> drain no_output.
  get: (k) => (k === 'sessionQuery' ? { readSession } : undefined),
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
}

const tmp = path.join(os.tmpdir(), 'dsh-rollout-eventenq-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const stateFile = () => path.join(tmp, 'memories', '.stage1-state.json')
const readJobs = () => {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')).jobs || {} } catch { return {} }
}
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return false
}

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, { autoTrigger: 'sessionEnd' })
  assert.ok(eventHandlers['session/disposed'], 'session/disposed handler registered')

  console.log('[1] session/disposed enqueues then drain consumes to a terminal status')
  const sess = { id: 's1', header: { cwd: 'C:/s1' }, deriveMessages: () => [] }
  eventHandlers['session/disposed'](sess)
  const drained1 = await waitUntil(() => {
    const j = Object.values(readJobs()).find((x) => String(x.session_id) === 's1')
    return j && j.status !== 'pending'
  }, 3000)
  check(drained1, 'the s1 job was drained to a terminal status (no longer pending)')
  const jobs = readJobs()
  const j1 = Object.values(jobs).find((x) => String(x.session_id) === 's1')
  check(j1 && j1.status === 'succeeded_no_output', 'the s1 job succeeded (no-output, empty transcript)')

  console.log('[2] duplicate session+watermark is deduped on re-trigger')
  eventHandlers['session/disposed'](sess)
  await new Promise((r) => setTimeout(r, 120))
  const jobs2 = readJobs()
  check(Object.values(jobs2).filter((x) => String(x.session_id) === 's1').length === 1, 'still exactly one s1 job (deduped, no duplicate)')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL EVENT-ENQUEUE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
