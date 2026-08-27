// One-off isolated test for pipeline queueing (P#6 / GPT P1 "pipelineLock 丢触发").
// Verifies that a trigger fired while the pipeline is running is QUEUED (not
// dropped): it is re-run once the in-flight pipeline completes.
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

// Gated LLM so run A can be held "in flight" (holding the pipeline lock) until we
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

// No sessionQuery => the trigger uses the live-object path (session.deriveMessages),
// which is easy to fake with the object below.
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
}

const tmpHome = path.join(os.tmpdir(), 'dsh-rollout-queue-' + Date.now())
process.env.DSH_HOME = tmpHome
fs.mkdirSync(tmpHome, { recursive: true })
const memoryRoot = () => path.join(tmpHome, 'memories')
const statePath = () => path.join(memoryRoot(), '.pipeline-state.json')
const readState = () => {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) } catch { return { sessions: {} } }
}
const session = (id) => ({
  id,
  header: { cwd: 'C:/' + id },
  deriveMessages: () => [
    { role: 'user', content: [{ type: 'text', text: 'this is a reasonably long message for session ' + id + ' that is long enough to trigger the model extraction step' }] },
  ],
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

  // 1) Fire A; wait until it is actually in-flight (waiting at the LLM gate).
  eventHandlers['session/disposed'](session('a'))
  const startedA = await waitUntil(() => waiters.length >= 1, 2000)
  check(startedA, 'run A got in-flight (holding pipeline lock at the LLM gate)')

  // 2) Fire B while A is running -> must be queued, not dropped.
  eventHandlers['session/disposed'](session('b'))

  // 3) While A is in-flight, B must NOT have been processed yet (it is queued).
  const stBefore = readState()
  check(!(stBefore.sessions && stBefore.sessions.b && stBefore.sessions.b.lastExtractStatus), 'B is NOT processed while A is in-flight (queued, not yet run)')

  // 4) Release the gate; A completes and then drains the queued B.
  release()
  const bDone = await waitUntil(() => {
    const s = readState()
    return !!(s.sessions && s.sessions.b && s.sessions.b.lastExtractStatus)
  }, 4000)

  const st = readState()
  check(!!(st.sessions && st.sessions.a && st.sessions.a.lastExtractStatus), 'A was processed (succeeded_with_output)')
  check(bDone, 'B was RE-RUN after A completed — queued trigger was NOT dropped')
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PIPELINE-QUEUE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
