// 阶段 0 · 第五项：maxExtractPerTrigger=N 时实际提取数绝不超过 N
// 对应《向Codex原版系统看齐》§14.2 不变量 / 阶段0 MUST「修复 maxExtractPerTrigger=1 边界超额」。
// 触发会话始终是第一个候选；旧实现在次级循环里「push 后再 break」，导致
// maxExtractPerTrigger=1 时仍可能再加入一个次级候选（总数=2）。
//
// 接线③：disposer 只入队「被处置的那个会话」（触发），不再由 pipelinePhase1 选择次级候选。
// 因此 maxExtractPerTrigger=1 时，实际被 drain 提炼的只有 trigger 一个 → 总数 ≤ 1。
// 本测试迁移为：确认 trigger 被 drain 消费完成，且 sec1 没有产生/消费任何作业。
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
const msgEvent = (id, text) => ({
  type: 'user/message',
  seq: 0,
  time: 0,
  surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const readSession = async (id) => ({
  session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 },
  events: [msgEvent(id, 'this is a long enough message for session ' + id + ' that triggers the model extraction')],
})
const EXTRACTION = { rollout_summary: 'sum', raw_memory: 'raw', slug: 'note', keywords: '', title: '' }
const llmMock = { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(EXTRACTION) }; yield { type: 'finish', reason: { kind: 'stop' } } } }) }
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : k === 'sessionQuery' ? { readSession } : undefined),
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
}

const tmp = path.join(os.tmpdir(), 'dsh-rollout-maxextract-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const memoryRoot = () => path.join(tmp, 'memories')
const stateFile = () => path.join(memoryRoot(), '.stage1-state.json')
const readJobs = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')).jobs || {} } catch { return {} } }
const readOutputs = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')).outputs || {} } catch { return {} } }
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
  const config = { autoTrigger: 'sessionEnd', minIdleHours: 0, maxDraftAgeDays: 10, maxExtractPerTrigger: 1, maxPipelineRunsPerDay: 100, precompactAuto: false }
  await apply(ctx, config)
  console.log('apply() OK; maxExtractPerTrigger=1')

  // trigger（被处置会话）是唯一被 enqueue 的作业；sec1 不在 stage-1 队列里 → 不提炼。
  eventHandlers['session/disposed']({ id: 'trig', header: { cwd: 'C:/trig' } })
  const trigDone = await waitUntil(() => {
    const j = Object.values(readJobs()).find((x) => String(x.session_id) === 'trig')
    return j && j.status !== 'pending'
  }, 3000)
  if (trigDone) console.log('  trigger drained:', JSON.stringify(Object.values(readJobs()).find((x) => String(x.session_id) === 'trig')))

  const jobs = readJobs()
  const trigJob = Object.values(jobs).find((x) => String(x.session_id) === 'trig')
  const hasSec1Job = Object.keys(jobs).some((k) => k.startsWith('sec1::'))

  check(trigDone && trigJob, 'trigger session was distilled (primary candidate, drained to terminal)')
  check(trigJob && trigJob.status === 'succeeded_with_output', 'trigger drained with output (llm returned a summary)')
  check(!hasSec1Job, 'sec1 was NOT distilled — budget of 1 counted the trigger, total ≤ 1')
  if (trigJob) {
    const out = readOutputs()[trigJob.id]
    check(!!(out && out.rollout_summary === 'sum'), 'trigger output rollout_summary reflects the extraction')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL MAXEXTRACT-BOUNDARY TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
