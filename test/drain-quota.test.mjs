// 阶段 A：drain 每日模型尝试上限（GPT §14.2：实际尝试数 ≤ N）
// 与 old pipelinePhase1 的单会话额度不同，这里验证 drain 消费时就地限额：
// cap=1 且有两个可提炼(≥60字符)的 job 时，drain 只消化 1 个（第 2 个仍 pending）。
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
let llmCalls = 0
const msgEvent = (id, text) => ({ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [msgEvent(id, 'this is a long enough message for session ' + id + ' that definitely reaches the model extraction step now')] })
const EXTRACTION = { rollout_summary: 'sum', raw_memory: 'raw', slug: 'note', keywords: '', title: '' }
const llmMock = { stream: () => { llmCalls++; return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(EXTRACTION) }; yield { type: 'finish', reason: { kind: 'stop' } } } } } }
const tools = {}
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : k === 'sessionQuery' ? { readSession } : undefined),
  tools: { register: (t) => { tools[t.name] = t } },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
}

const tmp = path.join(os.tmpdir(), 'dsh-rollout-quota-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const stateFile = () => path.join(tmp, 'memories', '.stage1-state.json')
const readJobs = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')).jobs || {} } catch { return {} } }

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, { maxModelAttemptsPerDay: 1 })
  assert.ok(tools['memory__stage1_drain'], 'drain tool registered')

  enqueueStage1JobFile(stateFile(), 's1', 'w1', new Date())
  enqueueStage1JobFile(stateFile(), 's2', 'w2', new Date())

  const res = await tools['memory__stage1_drain'].execute({})
  const jobs = readJobs()
  check(res.processed === 1, 'only 1 job consumed because daily attempt cap = 1')
  check(llmCalls === 1, 'only 1 LLM attempt made (cap enforced)')
  check(jobs['s1::w1'] && jobs['s1::w1'].status === 'succeeded_with_output', 's1 was distilled (consumed the single attempt)')
  check(jobs['s2::w2'] && jobs['s2::w2'].status === 'pending', 's2 stays pending — quota reached, not over-consumed')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL DRAIN-QUOTA TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
