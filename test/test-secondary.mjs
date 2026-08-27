// One-off isolated test for the secondary-candidate no-op fix (P0 #2 follow-up).
// Verifies that a SECONDARY candidate never writes its raw transcript as a summary:
//   - with no LLM and real content → 'failed' (nothing written)
//   - with LLM ok → with_output (refined summary written)
//   - with LLM empty summary → no_output (nothing written)
//   - with no LLM and short content → no_output (nothing written)
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

  // Seed 'sec' as an idle session WITH new activity (so it's a secondary candidate).
  const now = Date.now()
  const seededSummarizedAt = new Date(now - 3 * 86400e3).toISOString()
  const statePath = path.join(tmp, 'memories', '.pipeline-state.json')
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      sessions: {
        sec: {
          sessionId: 'sec',
          lastActivityAt: new Date(now - 2 * 3600e3).toISOString(),
          summarizedAt: seededSummarizedAt,
          lastExtractStatus: '',
        },
      },
      global: { lastPhase2At: '', runsToday: 0, runDay: '' },
    }),
    'utf8',
  )

  assert.ok(eventHandlers['session/disposed'], 'session/disposed handler registered')
  eventHandlers['session/disposed']({ id: 'trig', header: { cwd: 'C:/trig' } })
  await new Promise((r) => setTimeout(r, 220))

  let state = null
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch {}
  const secDraft = path.join(tmp, 'memories', 'rollout_summaries', 'sec.md')
  const existsDraft = fs.existsSync(secDraft)
  const draftText = existsDraft ? fs.readFileSync(secDraft, 'utf8') : ''
  fs.rmSync(tmp, { recursive: true, force: true })
  return { existsDraft, draftText, sec: state && state.sessions.sec, seededSummarizedAt }
}

const LONG = 'the deployment used a stable release with all the tests passing in one go today'
const SHORT = 'hi'

// ── 1) secondary + no LLM + real content → failed, raw NOT written ────────
console.log('[1] secondary, no LLM, real content → failed, raw transcript NOT written')
{
  const r = await runSecondary({ secMessage: LONG, llmMode: 'none' })
  check(r.existsDraft === false, 'no draft written for secondary (no LLM)')
  check(r.sec && r.sec.lastExtractStatus === 'failed', 'secondary status = failed')
  check(r.sec && r.sec.summarizedAt === r.seededSummarizedAt, 'secondary summarizedAt not advanced (pending retry)')
}

// ── 2) secondary + LLM ok → with_output, refined summary written ──────────
console.log('[2] secondary, LLM ok → with_output, refined summary written')
{
  const r = await runSecondary({ secMessage: LONG, llmMode: 'ok' })
  check(r.existsDraft === true, 'draft written for secondary')
  check(r.draftText.includes('good durable summary'), 'secondary draft has refined summary (not raw)')
  check(r.draftText.indexOf('the deployment used a stable') === -1, 'secondary draft does NOT contain raw transcript')
  check(r.sec && r.sec.lastExtractStatus === 'succeeded_with_output', 'secondary status = succeeded_with_output')
  check(r.sec && !!r.sec.summarizedAt, 'secondary summarizedAt advanced')
}

// ── 3) secondary + LLM empty summary → no_output, nothing written ─────────
console.log('[3] secondary, LLM empty summary → no_output, nothing written')
{
  const r = await runSecondary({ secMessage: LONG, llmMode: 'empty' })
  check(r.existsDraft === false, 'no draft written for secondary (empty summary)')
  check(r.sec && r.sec.lastExtractStatus === 'succeeded_no_output', 'secondary status = succeeded_no_output')
}

// ── 4) secondary + no LLM + short content → no_output, nothing written ────
console.log('[4] secondary, no LLM, short content → no_output, nothing written')
{
  const r = await runSecondary({ secMessage: SHORT, llmMode: 'none' })
  check(r.existsDraft === false, 'no draft written for short secondary')
  check(r.sec && r.sec.lastExtractStatus === 'succeeded_no_output', 'secondary status = succeeded_no_output')
}

console.log(`\n${failed === 0 ? 'ALL SECONDARY-NOOP TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
