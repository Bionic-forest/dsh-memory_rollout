// 阶段 0 · 第六项：额度按模型尝试计数
// 对应《向Codex原版系统看齐》阶段0 MUST「每日额度按模型尝试计数」/ §12.3。
// 过去 runsToday 只在 integrate() 有产物变化时 +1；本项改为按真实 LLM 尝试计数，
// 且尝试达上限后停止继续提炼（即使还会产出）。
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
let llmCalls = 0
const msgEvent = (id, text) => ({ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [msgEvent(id, 'this is a long enough message for session ' + id + ' that triggers the model extraction')] })
const EXTRACTION = { rollout_summary: 'sum', raw_memory: 'raw', slug: 'note', keywords: '', title: '' }
const llmMock = { stream: () => { llmCalls++; return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(EXTRACTION) }; yield { type: 'finish', reason: { kind: 'stop' } } } } } }
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : k === 'sessionQuery' ? { readSession } : undefined),
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
}

const tmp = path.join(os.tmpdir(), 'dsh-rollout-attempt-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const memoryRoot = () => path.join(tmp, 'memories')
const statePath = () => path.join(memoryRoot(), '.pipeline-state.json')
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) } catch { return { sessions: {}, global: {} } } }
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 36e5).toISOString()

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  // Daily LLM attempt cap = 1. Trigger + one qualifying secondary would both try,
  // but after the trigger's 1 attempt the budget is spent → secondary is not tried.
  const config = { autoTrigger: 'sessionEnd', minIdleHours: 0, maxDraftAgeDays: 10, maxExtractPerTrigger: 2, maxPipelineRunsPerDay: 100, maxModelAttemptsPerDay: 1, precompactAuto: false }
  await apply(ctx, config)

  fs.mkdirSync(memoryRoot(), { recursive: true })
  fs.writeFileSync(statePath(), JSON.stringify({
    sessions: { sec1: { sessionId: 'sec1', lastActivityAt: iso(1), summarizedAt: iso(20), lastExtractStatus: '' } },
    global: { lastPhase2At: '', runsToday: 0, runDay: '', modelAttemptsToday: 0 },
  }), 'utf8')

  eventHandlers['session/disposed']({ id: 'trig', header: { cwd: 'C:/trig' } })
  await new Promise((r) => setTimeout(r, 250))

  const st = readState()
  console.log('  trigger:', JSON.stringify(st.sessions.trig))
  console.log('  sec1:', JSON.stringify(st.sessions.sec1))
  console.log('  global.modelAttemptsToday =', st.global.modelAttemptsToday, '| llmCalls =', llmCalls)

  check(llmCalls === 1, 'only 1 LLM attempt made (cap = 1 even though 2 candidates qualify)')
  check(st.global.modelAttemptsToday === 1, 'modelAttemptsToday == 1 (counted by attempts, not outputs)')
  check(!!(st.sessions.trig && st.sessions.trig.lastExtractStatus), 'trigger distilled (consumed the 1 attempt)')
  check(!(st.sessions.sec1 && st.sessions.sec1.lastExtractStatus), 'sec1 NOT distilled — budget reached, stopped before trying it')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL MODEL-ATTEMPT-BUDGET TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
