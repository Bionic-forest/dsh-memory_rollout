// One-off isolated test for stale semantics (P#7 / GPT P1 "maxDraftAgeDays 否决新活动").
// 原意：很久以前总结、最近又有新活动的会话，应被当作候选（旧代码按 summary 年龄算 stale
// 而否决它）；真正休眠的会话保持排除。
//
// 接线③：disposer 只 enqueue「被处置的那个会话」，pipelinePhase1 的次级候选选择不再由
// disposer 驱动。stale-veto 的选择逻辑现在发生在「是否入队」的决策层（非 drain 消费者）。
// 本测试迁移为：手动 enqueue 'old'（新活动会话 → 候选）让其经 drain 提炼为 with_output，
// 而 'dormant'（无新活动）不 enqueue → 无作业（被排除）；trigger → no_output 无操作。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply, enqueueStage1JobFile } = await import(PLUGIN)

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
// Replay a real 'user/message' event so the persistence path gets a non-empty
// transcript for the candidate session.
const msgEvent = (id, text) => ({
  type: 'user/message',
  seq: 0,
  time: 0,
  surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const readSession = async (id) => ({
  session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 },
  events: id === 'old' ? [msgEvent(id, 'this is a genuinely long message for the old session so the extraction runs and it is re-drafted')] : [],
})
const EXTRACTION = { rollout_summary: 'summary for ' + 'x', raw_memory: 'raw', slug: 'note', keywords: 'k', title: 't' }
const streaming = (obj) => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'text-delta', text: JSON.stringify(obj) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})
const llmMock = { stream: () => streaming(EXTRACTION) }
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : k === 'sessionQuery' ? { readSession } : undefined),
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
}

const tmpHome = path.join(os.tmpdir(), 'dsh-rollout-stale-' + Date.now())
process.env.DSH_HOME = tmpHome
fs.mkdirSync(tmpHome, { recursive: true })
const memoryRoot = () => path.join(tmpHome, 'memories')
const statePath = () => path.join(memoryRoot(), '.stage1-state.json')
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) } catch { return { jobs: {}, outputs: {} } } }
const summariesDir = () => path.join(memoryRoot(), 'rollout_summaries')
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
  const config = { autoTrigger: 'sessionEnd', minIdleHours: 0, maxDraftAgeDays: 10, maxExtractPerTrigger: 2, maxPipelineRunsPerDay: 100, precompactAuto: false }
  await apply(ctx, config)
  console.log('apply() OK; maxDraftAgeDays=10, now≈' + new Date().toISOString())

  // 接线③：'old' 是候选（旧 summary + 近期新活动）→ 手动入队让其被 drain 提炼；
  // 'dormant' 无新活动 → 不入队（被排除）。先 enqueue 'old'，再 fire trigger，确保同一轮 drain 可见。
  enqueueStage1JobFile(statePath(), 'old', 'old-wm', new Date())

  // Fire the trigger (empty transcript → no-op trigger), which drives the drain.
  eventHandlers['session/disposed']({ id: 'trigger', header: { cwd: 'C:/trigger' } })
  const done = await waitUntil(() => {
    const jobs = readState().jobs || {}
    const old = Object.values(jobs).find((x) => String(x.session_id) === 'old')
    const trig = Object.values(jobs).find((x) => String(x.session_id) === 'trigger')
    return old && old.status !== 'pending' && trig && trig.status !== 'pending'
  }, 3000)

  const st = readState()
  const jobs = st.jobs || {}
  const oldJob = Object.values(jobs).find((x) => String(x.session_id) === 'old')
  const trigJob = Object.values(jobs).find((x) => String(x.session_id) === 'trigger')
  console.log('  observed old:', JSON.stringify(oldJob))
  console.log('  observed dormant: (not enqueued)')
  console.log('  observed trigger:', JSON.stringify(trigJob))

  check(done && oldJob && oldJob.status === 'succeeded_with_output', "'old' (OLD summary + RECENT activity) was re-drafted — stale no longer vetoes new activity")
  check(!Object.keys(jobs).some((k) => k.startsWith('dormant::')), "'dormant' (no new activity since summary) stays excluded — no stage-1 job")
  check(trigJob && trigJob.status === 'succeeded_no_output', 'trigger ran as a no-output no-op')
  const oldOutput = oldJob ? (st.outputs || {})[oldJob.id] : undefined
  check(!!(oldOutput && oldOutput.rollout_summary), "'old' got a refined summary written")
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL STALE-SEMANTICS TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
