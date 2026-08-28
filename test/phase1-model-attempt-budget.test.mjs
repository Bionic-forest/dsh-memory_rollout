// 阶段 0 · 第六项：额度按模型尝试计数
// 对应《向Codex原版系统看齐》阶段0 MUST「每日额度按模型尝试计数」/ §12.3。
// 过去 runsToday 只在 integrate() 有产物变化时 +1；本项改为按真实 LLM 尝试计数，
// 且尝试达上限后停止继续提炼（即使还会产出）。
//
// 接线③：disposer 只 enqueue「被处置的那个会话」（触发），drain 消费它 → 1 次 LLM 尝试。
// sec1 不进入 stage-1 队列 → 0 次尝试。实际 LLM 调用次数 = 1（额度=1 时的上界）。
// 迁移：断言 llmCalls===1、trigger 被消化、sec1 无作业；放弃对 pipeline-state 的
// modelAttemptsToday 断言（drain 不更新 pipeline-state，该字段属旧管线）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf } from './lib/helpers.mjs'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply } = await import(PLUGIN)

const eventHandlers = {}
let llmCalls = 0
let extractionCalls = 0
let consolidationCalls = 0
const msgEvent = (id, text) => ({ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [msgEvent(id, 'this is a long enough message for session ' + id + ' that triggers the model extraction')] })
const EXTRACTION = { rollout_summary: 'sum', raw_memory: 'raw', slug: 'note', keywords: '', title: '' }
const CONSOLIDATION = { memory_summary: 'v1\n## consolidated', registry: '# MEMORY.md\nok' }
const llmMock = { stream: (opts) => {
  llmCalls++
  if (opts && String(opts.system).includes('memory-extraction')) extractionCalls++
  else consolidationCalls++
  const payload = (opts && String(opts.system).includes('memory-extraction')) ? EXTRACTION : CONSOLIDATION
  return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(payload) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
} }
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : k === 'sessionQuery' ? { readSession } : undefined),
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
})

const tmp = path.join(os.tmpdir(), 'dsh-rollout-attempt-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const readJobs = () => jobListOf(domain)
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
  const config = { autoTrigger: 'sessionEnd', minIdleHours: 0, maxDraftAgeDays: 10, maxExtractPerTrigger: 2, maxPipelineRunsPerDay: 100, maxModelAttemptsPerDay: 1, precompactAuto: false }
  await apply(ctx, config)

  // 只有 trigger 被 enqueue → drain 恰好做 1 次 LLM 调用（额度=1 的上界）。
  eventHandlers['session/disposed']({ id: 'trig', header: { cwd: 'C:/trig' } })
  const trigDone = await waitUntil(() => {
    const j = Object.values(readJobs()).find((x) => String(x.session_id) === 'trig')
    return j && j.status !== 'pending'
  }, 3000)

  const jobs = readJobs()
  const trigJob = Object.values(jobs).find((x) => String(x.session_id) === 'trig')
  const hasSec1Job = Object.keys(jobs).some((k) => k.startsWith('sec1::'))
  console.log('  | llmCalls =', llmCalls, '| trig status =', trigJob && trigJob.status, '| hasSec1Job =', hasSec1Job)

  check(extractionCalls === 1, 'only 1 extraction LLM attempt made (cap = 1 — trigger consumed the budget)')
  // H3: drain 产出后自动触发一次真 Phase 2 整合（额外 consolidation 调用，不占提炼额度）
  check(consolidationCalls === 1, 'auto-triggered exactly 1 consolidation call after output')
  check(trigDone && trigJob && trigJob.status === 'succeeded_with_output', 'trigger distilled (consumed the 1 attempt)')
  check(!hasSec1Job, 'sec1 NOT distilled — budget reached, nothing queued for it')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL MODEL-ATTEMPT-BUDGET TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
