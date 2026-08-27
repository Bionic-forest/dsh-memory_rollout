// One-off isolated test for stale semantics (P#7 / GPT P1 "maxDraftAgeDays 否决新活动").
// Verifies a session that was summarized long ago but has RECENT new activity is
// still picked as a secondary candidate (the old code used the *summary age* to
// compute staleness and wrongly vetoed it), while a truly dormant session stays
// excluded.
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
// Replay a real 'user/message' event so pipelinePhase1's secondary path gets a
// non-empty transcript from the persistence (sessionQuery.readSession) path.
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
const statePath = () => path.join(memoryRoot(), '.pipeline-state.json')
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) } catch { return { sessions: {} } } }
const summariesDir = () => path.join(memoryRoot(), 'rollout_summaries')

// Relative date helper so the test is robust to the real clock.
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 36e5).toISOString()

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  const config = { autoTrigger: 'sessionEnd', minIdleHours: 0, maxDraftAgeDays: 10, maxExtractPerTrigger: 2, maxPipelineRunsPerDay: 100, precompactAuto: false }
  await apply(ctx, config)
  console.log('apply() OK; maxDraftAgeDays=10, now≈' + new Date().toISOString())

  fs.mkdirSync(summariesDir(), { recursive: true })
  // 'old'  : summarized 26 days ago, last activity 2 days ago → has NEW activity
  //          since summary. OLD code: stale (summary age 26d>10) → vetoed. NEW code:
  //          not stale (2d<10 since last activity) → candidate.
  // 'dormant': summarized 20 days ago, last activity 40 days ago → no new activity →
  //          excluded by hasNewActivitySinceSummary regardless.
  const state = {
    sessions: {
      old: { sessionId: 'old', lastActivityAt: iso(2), summarizedAt: iso(26), lastExtractStatus: '' },
      dormant: { sessionId: 'dormant', lastActivityAt: iso(40), summarizedAt: iso(20), lastExtractStatus: '' },
    },
    global: { lastPhase2At: '', runsToday: 0, runDay: '' },
  }
  fs.writeFileSync(statePath(), JSON.stringify(state), 'utf8')

  // Fire the trigger (empty transcript → no-op trigger), which drives the pipeline.
  eventHandlers['session/disposed']({ id: 'trigger', header: { cwd: 'C:/trigger' } })
  await new Promise((r) => setTimeout(r, 250))

  const st = readState()
  console.log('  observed old:', JSON.stringify(st.sessions.old))
  console.log('  observed dormant:', JSON.stringify(st.sessions.dormant))
  console.log('  observed trigger:', JSON.stringify(st.sessions.trigger))

  check(!!(st.sessions.old && st.sessions.old.lastExtractStatus), "'old' (OLD summary + RECENT activity) was re-drafted — stale no longer vetoes new activity")
  check(!(st.sessions.dormant && st.sessions.dormant.lastExtractStatus), "'dormant' (no new activity since summary) stays excluded")
  check(!!(st.sessions.trigger && st.sessions.trigger.lastExtractStatus === 'succeeded_no_output'), 'trigger ran as a no-output no-op')
  const oldDraftExists = fs.existsSync(path.join(summariesDir(), 'old.md'))
  check(oldDraftExists, "'old' got a fresh draft written")
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL STALE-SEMANTICS TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
