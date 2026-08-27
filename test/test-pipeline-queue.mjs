// One-off isolated test for pipeline queueing (P#6 / GPT P1 "pipelineLock 丢触发").
// 原意：管线运行时又触发一次 — 绝不能丢；该触发会在当前管线完成后被再次执行。
// 接线③：管线已换成「disposer 只入队 + drainStage1Jobs 消费」。drain 没有 pipelineLock，
// 而是把作业持久化到 .stage1-state.json，每个到期 job 都会被消费（不丢）。
// 迁移：触发 A 后（A 在 LLM gate 上阻塞=在途），再触发 B —— B 被持久化（不丢）；
// 释放 gate 后 A、B 都被 drain 消费为 with_output。
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

// Gated LLM so run A can be held "in flight" (distillation in progress) until we
// release it. `open` flips to true once released, so later calls pass instantly.
let open = false
const waiters = []
const release = () => { open = true; for (const r of waiters.splice(0)) r() }
const gate = async () => { if (open) return; await new Promise((r) => waiters.push(r)) }
const EXTRACTION = { rollout_summary: 'summary of session', raw_memory: 'raw', slug: 'note', keywords: 'k', title: 't' }
const streaming = (obj) => ({
  async *[Symbol.asyncIterator]() {
    await gate()
    yield { type: 'text-delta', text: JSON.stringify(obj) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})
const llmMock = { stream: () => streaming(EXTRACTION) }

const longMsg = (id) => 'this is a reasonably long message for session ' + id + ' that is long enough to trigger the model extraction step'
const msgEvent = (id) => ({ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: longMsg(id) }] } })
const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [msgEvent(id)] })

const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : k === 'sessionQuery' ? { readSession } : undefined),
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
}

const tmpHome = path.join(os.tmpdir(), 'dsh-rollout-queue-' + Date.now())
process.env.DSH_HOME = tmpHome
fs.mkdirSync(tmpHome, { recursive: true })
const memoryRoot = () => path.join(tmpHome, 'memories')
const stage1File = () => path.join(memoryRoot(), '.stage1-state.json')
const readState = () => {
  try { return JSON.parse(fs.readFileSync(stage1File(), 'utf8')) } catch { return { jobs: {} } }
}
const session = (id) => ({
  id,
  header: { cwd: 'C:/' + id },
  deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: longMsg(id) }] }],
})

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return false
}

try {
  const config = { autoTrigger: 'sessionEnd', minIdleHours: 0, maxDraftAgeDays: 10, maxExtractPerTrigger: 2, maxPipelineRunsPerDay: 100, precompactAuto: false }
  await apply(ctx, config)
  console.log('apply() OK')

  // 1) Fire A; wait until A is actually in-flight (blocked at the LLM gate).
  eventHandlers['session/disposed'](session('a'))
  const startedA = await waitUntil(() => waiters.length >= 1, 2000)
  check(startedA, 'run A got in-flight (holding at the LLM gate)')

  // 2) Fire B while A is running -> must be persisted (enqueued), not dropped.
  eventHandlers['session/disposed'](session('b'))

  // 3) While A is in-flight, B must already be persisted as a stage-1 job (not dropped).
  const jobsWhileAInFlight = readState().jobs || {}
  check(Object.keys(jobsWhileAInFlight).some((k) => k.startsWith('b::')), 'B is persisted (enqueued) while A is in-flight — not dropped')

  // 4) Release the gate; A completes and B is eventually drained too.
  release()
  const bothDone = await waitUntil(() => {
    const jobs = readState().jobs || {}
    const aJob = Object.values(jobs).find((x) => String(x.session_id) === 'a')
    const bJob = Object.values(jobs).find((x) => String(x.session_id) === 'b')
    return aJob && aJob.status === 'succeeded_with_output' && bJob && bJob.status === 'succeeded_with_output'
  }, 4000)

  const jobs = readState().jobs || {}
  const aJob = Object.values(jobs).find((x) => String(x.session_id) === 'a')
  const bJob = Object.values(jobs).find((x) => String(x.session_id) === 'b')
  check(aJob && aJob.status === 'succeeded_with_output', 'A was processed (succeeded_with_output)')
  check(bothDone && bJob && bJob.status === 'succeeded_with_output', 'B was RE-RUN after A completed — queued trigger was NOT dropped')
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PIPELINE-QUEUE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
