// 阶段 0 · 第五项：maxExtractPerTrigger=N 时实际提取数绝不超过 N
// 对应《向Codex原版系统看齐》§14.2 不变量 / 阶段0 MUST「修复 maxExtractPerTrigger=1 边界超额」。
// 触发会话始终是第一个候选；旧实现在次级循环里「push 后再 break」，导致
// maxExtractPerTrigger=1 时仍可能再加入一个次级候选（总数=2）。
// 修复后：循环顶部先判断预算已满则结束，触发+次级总量 ≤ N。
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
const statePath = () => path.join(memoryRoot(), '.pipeline-state.json')
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) } catch { return { sessions: {} } } }
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 36e5).toISOString()

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  const config = { autoTrigger: 'sessionEnd', minIdleHours: 0, maxDraftAgeDays: 10, maxExtractPerTrigger: 1, maxPipelineRunsPerDay: 100, precompactAuto: false }
  await apply(ctx, config)
  console.log('apply() OK; maxExtractPerTrigger=1')

  // sec1: summarized long ago + recent activity → would qualify as a secondary
  // candidate if the budget allowed. With maxExtract=1 the trigger consumes the
  // whole budget, so sec1 must NOT be distilled.
  fs.mkdirSync(memoryRoot(), { recursive: true })
  fs.writeFileSync(statePath(), JSON.stringify({
    sessions: { sec1: { sessionId: 'sec1', lastActivityAt: iso(1), summarizedAt: iso(20), lastExtractStatus: '' } },
    global: { lastPhase2At: '', runsToday: 0, runDay: '' },
  }), 'utf8')

  eventHandlers['session/disposed']({ id: 'trig', header: { cwd: 'C:/trig' } })
  await new Promise((r) => setTimeout(r, 250))

  const st = readState()
  console.log('  trigger:', JSON.stringify(st.sessions.trig))
  console.log('  sec1:', JSON.stringify(st.sessions.sec1))

  check(!!(st.sessions.trig && st.sessions.trig.lastExtractStatus), 'trigger session was distilled (it is the primary candidate)')
  check(!(st.sessions.sec1 && st.sessions.sec1.lastExtractStatus), 'sec1 was NOT distilled — budget of 1 counted the trigger, total ≤ 1')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL MAXEXTRACT-BOUNDARY TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
