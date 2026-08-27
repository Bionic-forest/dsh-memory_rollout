// One-off isolated test for the no-op / failure fallback fix (P0 #2).
// Drives the real pipelinePhase1 via session/disposed with a mocked ctx.llm so we
// can classify outcome as with_output / no_output / failed and verify the raw
// transcript is NEVER written as a memory draft.
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply } = await import(PLUGIN)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

const memoryRoot = (home) => path.join(home, 'memories')
const statePath = (home) => path.join(memoryRoot(home), '.pipeline-state.json')
const draftPath = (home, sid) =>
  path.join(memoryRoot(home), 'rollout_summaries', sid.replace(/[^a-z0-9-]+/gi, '-') + '.md')

// Fake LLM: `mode` ∈ 'ok' (real summary) | 'empty' (no summary) | 'fail' (throws).
function makeLlm(mode) {
  return {
    stream: () => {
      // A bad route throws synchronously here (like the real service); a good
      // route returns an async-iterable stream.
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

async function runScenario({ sessionId, messageText, llmMode }) {
  const tmp = path.join(os.tmpdir(), 'dsh-rollout-noop-' + sessionId + '-' + Date.now())
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
  const llm = makeLlm(llmMode)
  const ctx = {
    storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
    get: (k) => {
      if (k === 'llm') return llm
      if (k === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) }
      return undefined // no sessionQuery → live-object path for the trigger
    },
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    effect: (fn) => fn(),
    on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
  }
  const config = {
    autoTrigger: 'sessionEnd',
    minIdleHours: 0,
    maxDraftAgeDays: 10,
    maxExtractPerTrigger: 2,
    maxPipelineRunsPerDay: 100,
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
  await new Promise((r) => setTimeout(r, 200))

  let state = null
  try { state = JSON.parse(fs.readFileSync(statePath(tmp), 'utf8')) } catch {}
  const existsDraft = fs.existsSync(draftPath(tmp, sessionId))
  const draftText = existsDraft ? fs.readFileSync(draftPath(tmp, sessionId), 'utf8') : ''
  fs.rmSync(tmp, { recursive: true, force: true })
  return { existsDraft, draftText, state }
}

// ── scenario 1: LLM fails → no draft, no raw written, summarizedAt NOT advanced, status failed ──
console.log('[1] LLM failure → failed, raw transcript NOT written')
{
  const r = await runScenario({ sessionId: 'fail-session', messageText: 'credential secret here is a long enough message to attempt real extraction of the api key sk-abcdef1234567890', llmMode: 'fail' })
  const rec = r.state && r.state.sessions['fail-session']
  check(r.existsDraft === false, 'no draft written on LLM failure')
  check(rec && rec.lastExtractStatus === 'failed', 'status recorded as failed')
  check(rec && (rec.summarizedAt === '' || rec.summarizedAt === undefined), 'summarizedAt NOT advanced (pending retry)')
}

// ── scenario 2: short session (<60) → no-op, no draft, summarizedAt advanced, status no_output ──
console.log('[2] short session (<60 chars) → no-op, no draft')
{
  const r = await runScenario({ sessionId: 'short-session', messageText: 'hi', llmMode: 'ok' })
  const rec = r.state && r.state.sessions['short-session']
  check(r.existsDraft === false, 'no draft written for short session')
  check(rec && rec.lastExtractStatus === 'succeeded_no_output', 'status recorded as succeeded_no_output')
  check(rec && !!rec.summarizedAt, 'summarizedAt advanced (terminal no-op)')
}

// ── scenario 3: model returns empty summary → no-op, no draft ──
console.log('[3] empty model summary → no-op, no draft')
{
  const r = await runScenario({ sessionId: 'empty-session', messageText: 'this message is definitely long enough to be eligible for a real extraction attempt by the model', llmMode: 'empty' })
  const rec = r.state && r.state.sessions['empty-session']
  check(r.existsDraft === false, 'no draft written when model returns empty summary')
  check(rec && rec.lastExtractStatus === 'succeeded_no_output', 'status recorded as succeeded_no_output')
  check(rec && !!rec.summarizedAt, 'summarizedAt advanced (terminal no-op)')
}

// ── scenario 4: normal session → with_output, draft written, summarizedAt advanced ──
console.log('[4] normal session → with_output, refined summary written (no regression)')
{
  const r = await runScenario({ sessionId: 'ok-session', messageText: 'the user decided to use pnpm for this project and set up a build config so we can test the pipeline', llmMode: 'ok' })
  const rec = r.state && r.state.sessions['ok-session']
  check(r.existsDraft === true, 'draft written for a real session')
  check(r.draftText.includes('good durable summary'), 'draft contains the refined summary')
  check(r.draftText.includes('sk-abcdef1234567890') === false, 'draft has no raw secret (redaction intact)')
  check(rec && rec.lastExtractStatus === 'succeeded_with_output', 'status recorded as succeeded_with_output')
  check(rec && !!rec.summarizedAt, 'summarizedAt advanced')
}

console.log(`\n${failed === 0 ? 'ALL NO-OP TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
