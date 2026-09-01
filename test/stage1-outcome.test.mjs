// One-off isolated test for the no-op / failure fallback fix (P0 #2).
// 接线③：disposer 只入队，drainStage1Jobs 消费并分类 outcome（with_output / no_output /
// failed_retryable）。验证 raw transcript 从不以「原始字面快照」被写成记忆草稿：
//  - 失败/无信号 → 无产物（no_output / failed_retryable），不落任何输出；
//  - with_output → 输出的是提炼后的摘要，而非原始 transcript。
// 原先断言「草稿文件内容 / lastExtractStatus」迁移为「.stage1-state.json 的 job.status 与
// outputs[job.id].rollout_summary」。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, outputListOf } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

const msgEvent = (id, text) => ({
  type: 'user/message', seq: 0, time: 0, surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

// Fake LLM: `mode` ∈ 'ok' (real summary) | 'empty' (no summary) | 'fail' (throws).
function makeLlm(mode) {
  return {
    stream: () => {
      if (mode === 'fail') throw new Error('simulated llm failure')
      const doc =
        mode === 'ok'
          ? JSON.stringify({ rollout_summary: 'good durable summary', raw_memory: 'trace line', slug: 'ok-session', keywords: 'a,b', title: 'OK' })
          : JSON.stringify({ rollout_summary: '', raw_memory: '' }) // empty → no-op
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'text-delta', text: doc }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
}

const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return false
}

async function runScenario({ sessionId, messageText, llmMode }) {
  const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-noop-' + sessionId + '-' + Date.now())
  fs.mkdirSync(tmp, { recursive: true })
  process.env.DSH_HOME = tmp
  const eventHandlers = {}
  const llm = makeLlm(llmMode)
  const readSession = async (id) => ({
    session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 },
    events: [msgEvent(id, messageText)],
  })
  const { ctx, domain } = makeCtx({
    get: (k) => {
      if (k === 'sessionQuery') return { readSession }
      if (k === 'llm') return llm
      if (k === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) }
      return undefined
    },
    on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
  })
  const config = {
    autoTrigger: 'sessionEnd',
    precompactAuto: false,
    extractProvider: '',
    extractModel: '',
    extractReasoningEffort: 'low',
  }

  await apply(ctx, config)
  const trigger = {
    id: sessionId,
    header: { cwd: 'C:/' + sessionId },
    deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: messageText }] }],
  }
  assert.ok(eventHandlers['session/disposed'], 'session/disposed handler registered')
  eventHandlers['session/disposed'](trigger)
  const done = await waitUntil(() => {
    const j = Object.values(jobListOf(domain)).find((x) => String(x.session_id) === sessionId)
    return j && j.status !== 'pending'
  }, 3000)

  const job = Object.values(jobListOf(domain)).find((x) => String(x.session_id) === sessionId)
  const output = job ? outputListOf(domain)[job.id] : undefined
  fs.rmSync(tmp, { recursive: true, force: true })
  return { done, job, output }
}

// ── scenario 1: LLM fails → failed_retryable, no output, raw transcript NOT written ──
console.log('[1] LLM failure → failed_retryable, raw transcript NOT written')
{
  const r = await runScenario({ sessionId: 'fail-session', messageText: 'credential secret here is a long enough message to attempt real extraction of the api key sk-abcdef1234567890', llmMode: 'fail' })
  check(r.done, 'job submitted (drain completed)')
  check(r.job && r.job.status === 'failed_retryable', 'status recorded as failed_retryable')
  check(r.job && (!r.job.completed_at), 'failed_retryable NOT completed (pending retry)')
  check(r.output === undefined, 'no output written on LLM failure')
}

// ── scenario 2: short session (<60) → no-op, no output, no draft ──
console.log('[2] short session (<60 chars) → no-op, no output')
{
  const r = await runScenario({ sessionId: 'short-session', messageText: 'hi', llmMode: 'ok' })
  check(r.done, 'job submitted (drain completed)')
  check(r.job && r.job.status === 'succeeded_no_output', 'status recorded as succeeded_no_output')
  check(r.job && !!r.job.completed_at, 'completed_at set (terminal no-op)')
  check(r.output === undefined, 'no output written for short session')
}

// ── scenario 3: model returns empty summary → no-op, no output ──
console.log('[3] empty model summary → no-op, no output')
{
  const r = await runScenario({ sessionId: 'empty-session', messageText: 'this message is definitely long enough to be eligible for a real extraction attempt by the model', llmMode: 'empty' })
  check(r.done, 'job submitted (drain completed)')
  check(r.job && r.job.status === 'succeeded_no_output', 'status recorded as succeeded_no_output')
  check(r.job && !!r.job.completed_at, 'completed_at set (terminal no-op)')
  check(!(r.output && r.output.rollout_summary), 'no output written when model returns empty summary')
}

// ── scenario 4: normal session → with_output, refined summary (no raw transcript) ──
console.log('[4] normal session → with_output, refined summary written (no regression)')
{
  const r = await runScenario({ sessionId: 'ok-session', messageText: 'the user decided to use pnpm for this project and set up a build config so we can test the pipeline', llmMode: 'ok' })
  check(r.done, 'job submitted (drain completed)')
  check(r.job && r.job.status === 'succeeded_with_output', 'status recorded as succeeded_with_output')
  check(r.output && r.output.rollout_summary === 'good durable summary', 'output carries the refined summary')
  check(r.output && r.output.rollout_summary.indexOf('the user decided') === -1, 'output is refined, does NOT contain raw transcript')
}

console.log(`\n${failed === 0 ? 'ALL NO-OP TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
