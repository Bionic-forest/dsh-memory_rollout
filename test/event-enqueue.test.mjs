// 阶段 A · 接线第①步：session/disposed 只入队（落盘 .stage1-state.json）
// 验证：事件回调把该会话的 stage-1 作业持久化（watermark=内容指纹），不跑模型；
// 同一 session+watermark 重复触发去重。保留 kickPipeline（测试兼容），此处只验入队落盘。
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
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: () => undefined, // no sessionQuery, no llm -> trigger is a no-no (empty transcript)
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

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, { autoTrigger: 'sessionEnd' })
  assert.ok(eventHandlers['session/disposed'], 'session/disposed handler registered')

  console.log('[1] session/disposed enqueues a persistent stage-1 job (event-only)')
  const sess = { id: 's1', header: { cwd: 'C:/s1' }, deriveMessages: () => [] }
  eventHandlers['session/disposed'](sess)
  await new Promise((r) => setTimeout(r, 120))
  const jobs = readJobs()
  const keys = Object.keys(jobs)
  check(keys.some((k) => k.startsWith('s1::')), 'a job for session s1 (key=session::watermark) was persisted')
  const j1 = keys.filter((k) => k.startsWith('s1::'))[0]
  check(j1 && jobs[j1].status === 'pending', 'the persisted job is pending')

  console.log('[2] duplicate session+watermark is deduped on re-trigger')
  eventHandlers['session/disposed'](sess)
  await new Promise((r) => setTimeout(r, 120))
  const jobs2 = readJobs()
  check(Object.keys(jobs2).filter((k) => k.startsWith('s1::')).length === 1, 'still exactly one s1 job (deduped, no duplicate)')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL EVENT-ENQUEUE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
