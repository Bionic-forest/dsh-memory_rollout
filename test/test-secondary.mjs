// One-off isolated test for the secondary-candidate no-op fix (P0 #2 follow-up).
// 原意：次级候选绝不把原始 transcript 写成摘要：
//   - with no LLM and real content → 'failed' (nothing written)
//   - with LLM ok → with_output (refined summary written)
//   - with LLM empty summary → no_output (nothing written)
//   - with no LLM and short content → no_output (nothing written)
//
// 接线③：disposer 只 enqueue「被处置的那个会话」（trigger）；次级候选不再由 pipelinePhase1
// 选择，而是作为一条独立的 stage-1 作业被 enqueue 后由 drain 消费。本测试手动 enqueue 'sec'
// 模拟次级候选入队，让 drain 按与 trigger 相同的提炼流程分类 outcome，并断言「原始 transcript
// 从不被写成摘要」（输出的是 refined 摘要或为空）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply, enqueueStage1JobFile } = await import(PLUGIN)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

// A valid minimal persisted session that yields one text message.
function secEvents(messageText) {
  return [
    {
      type: 'user/message',
      seq: 0,
      time: 0,
      data: { id: 'm-1', role: 'user', content: [{ type: 'text', text: messageText }], source: { kind: 'user' } },
      surfaceOp: 'append',
    },
  ]
}
function headerOf(id, cwd) {
  return { version: 0, id, cwd, createdAt: Date.now() }
}

function makeLlm(mode) {
  return {
    stream: () => {
      if (mode === 'fail') throw new Error('simulated llm failure')
      const doc =
        mode === 'ok'
          ? JSON.stringify({ rollout_summary: 'good durable summary', raw_memory: 'trace line', slug: 'ok', keywords: '', title: '' })
          : JSON.stringify({ rollout_summary: '', raw_memory: '' })
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

async function runSecondary({ secMessage, llmMode /* 'none' | 'ok' | 'empty' */ }) {
  const tmp = path.join(os.tmpdir(), 'dsh-rollout-sec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
  fs.mkdirSync(tmp, { recursive: true })
  process.env.DSH_HOME = tmp
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
  const queryMock = {
    readSession: async (id) => {
      if (id === 'sec') return { session: headerOf('sec', 'C:/sec'), events: secEvents(secMessage) }
      return { session: headerOf(id, 'C:/' + id), events: [] } // trigger → empty
    },
  }
  const ctx = {
    storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
    get: (k) => {
      if (k === 'sessionQuery') return queryMock
      if (k === 'llm') return llmMode === 'none' ? undefined : makeLlm(llmMode)
      if (k === 'agentDefaultModel') return llmMode === 'none' ? undefined : { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) }
      return undefined
    },
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    effect: (fn) => fn(),
    on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
  }
  const config = {
    autoTrigger: 'sessionEnd',
    minIdleHours: 1,
    maxDraftAgeDays: 10,
    maxExtractPerTrigger: 2,
    maxPipelineRunsPerDay: 100,
    precompactAuto: false,
    extractProvider: '',
    extractModel: '',
    extractReasoningEffort: 'low',
  }
  await apply(ctx, config)

  const stage1File = path.join(tmp, 'memories', '.stage1-state.json')
  const readStage1 = () => { try { return JSON.parse(fs.readFileSync(stage1File, 'utf8')) } catch { return { jobs: {}, outputs: {} } } }

  // 接线③：次级候选不再是 pipelinePhase1 的选择结果 —— 这里手动 enqueue 一条 'sec' 作业，
  // 模拟「次级候选入队」，由 disposer 排定的同一轮 drain 消费。先 enqueue，再 fire trigger，
  // 确保 drain 开始时两条作业（trigger + sec）都已就绪。
  enqueueStage1JobFile(stage1File, 'sec', 'sec-wm', new Date())

  assert.ok(eventHandlers['session/disposed'], 'session/disposed handler registered')
  eventHandlers['session/disposed']({ id: 'trig', header: { cwd: 'C:/trig' } })
  const done = await waitUntil(() => {
    const st = readStage1().jobs || {}
    const trig = Object.values(st).find((x) => String(x.session_id) === 'trig')
    const sec = Object.values(st).find((x) => String(x.session_id) === 'sec')
    return sec && sec.status !== 'pending' && trig && trig.status !== 'pending'
  }, 3000)

  const st = readStage1()
  const jobs = st.jobs || {}
  const outputs = st.outputs || {}
  const secJob = Object.values(jobs).find((x) => String(x.session_id) === 'sec')
  const trigJob = Object.values(jobs).find((x) => String(x.session_id) === 'trig')
  const secOutput = secJob ? outputs[secJob.id] : undefined
  const secDraft = path.join(tmp, 'memories', 'rollout_summaries', 'sec.md')
  const existsDraft = fs.existsSync(secDraft)
  fs.rmSync(tmp, { recursive: true, force: true })
  return { done, secJob, secOutput, existsDraft, trigJob }
}

const LONG = 'the deployment used a stable release with all the tests passing in one go today'
const SHORT = 'hi'

// ── 1) secondary + no LLM + real content → failed, raw NOT written ────────
console.log('[1] secondary, no LLM, real content → failed, raw transcript NOT written')
{
  const r = await runSecondary({ secMessage: LONG, llmMode: 'none' })
  check(r.done, 'secondary job submitted (drain completed)')
  check(r.secJob && r.secJob.status === 'failed_retryable', 'secondary status = failed_retryable')
  check(r.secOutput === undefined, 'no output written for secondary (no LLM)')
  check(r.existsDraft === false, 'no draft written for secondary')
}

// ── 2) secondary + LLM ok → with_output, refined summary written ──────────
console.log('[2] secondary, LLM ok → with_output, refined summary written')
{
  const r = await runSecondary({ secMessage: LONG, llmMode: 'ok' })
  check(r.done, 'secondary job submitted (drain completed)')
  check(r.secJob && r.secJob.status === 'succeeded_with_output', 'secondary status = succeeded_with_output')
  check(r.secOutput && r.secOutput.rollout_summary === 'good durable summary', 'secondary output has refined summary (not raw)')
  check(r.secOutput && r.secOutput.rollout_summary.indexOf('the deployment used a stable') === -1, 'secondary output does NOT contain raw transcript')
  check(r.existsDraft === false, 'no draft file written (output lives in stage1-state)')
}

// ── 3) secondary + LLM empty summary → no_output, nothing written ─────────
console.log('[3] secondary, LLM empty summary → no_output, nothing written')
{
  const r = await runSecondary({ secMessage: LONG, llmMode: 'empty' })
  check(r.done, 'secondary job submitted (drain completed)')
  check(r.secJob && r.secJob.status === 'succeeded_no_output', 'secondary status = succeeded_no_output')
  check(r.secOutput === undefined, 'no output written for secondary (empty summary)')
  check(r.existsDraft === false, 'no draft written for secondary')
}

// ── 4) secondary + no LLM + short content → no_output, nothing written ────
console.log('[4] secondary, no LLM, short content → no_output, nothing written')
{
  const r = await runSecondary({ secMessage: SHORT, llmMode: 'none' })
  check(r.done, 'secondary job submitted (drain completed)')
  check(r.secJob && r.secJob.status === 'succeeded_no_output', 'secondary status = succeeded_no_output')
  check(r.secOutput === undefined, 'no output written for secondary (short content)')
  check(r.existsDraft === false, 'no draft written for secondary')
}

console.log(`\n${failed === 0 ? 'ALL SECONDARY-NOOP TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
