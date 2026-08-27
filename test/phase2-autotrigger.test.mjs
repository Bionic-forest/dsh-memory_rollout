// 阶段 B（H3）：drainStage1Jobs 产出 succeeded_with_output 后，自动触发一次真 Phase 2 整合。
// 验证：memory__stage1_drain 消费一个可提炼(≥60字符)的 pending job → 产出增量产物
// （selected_for_phase2: false）→ 自动跑 memory__phase2_integrate（consolidation LLM）：
// 发布 memory_summary.md（LLM 内容）、推进 lastSuccessWatermark、设置 lastPhase2At、
// 并把已消费产物置 selected_for_phase2: true。
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
const tools = {}

let extractionCalls = 0
let consolidationCalls = 0
const msgEvent = (id, text) => ({ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
// ≥60 字符的持久会话消息，确保 drain 提炼阶段真的触发
const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [msgEvent(id, 'this session analyzed the rollout plugin architecture and decided on the phase two flow across many turns')] })
const EXTRACTION = { rollout_summary: 'a durable summary', raw_memory: 'raw line', slug: 'phase2-autotrigger', keywords: 'k1,k2', title: 'title' }
const CONSOLIDATION = { memory_summary: 'v1\n## auto consolidated', registry: '# MEMORY.md\nauto registry' }
const llmMock = {
  stream: (opts) => {
    const isExtract = opts && String(opts.system).includes('memory-extraction')
    if (isExtract) extractionCalls++
    else consolidationCalls++
    const payload = isExtract ? EXTRACTION : CONSOLIDATION
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: JSON.stringify(payload) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: (k) =>
    k === 'llm' ? llmMock
      : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : k === 'sessionQuery' ? { readSession } : undefined,
  tools: { register: (t) => { tools[t.name] = t } },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
}

const tmp = path.join(os.tmpdir(), 'dsh-rollout-ph2auto-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const root = () => path.join(tmp, 'memories')
const stateFile = () => path.join(root(), '.stage1-state.json')
const summaryFile = () => path.join(root(), 'memory_summary.md')
const registryFile = () => path.join(root(), 'MEMORY.md')
const readSummary = () => { try { return fs.readFileSync(summaryFile(), 'utf8') } catch { return '' } }
const readRegistry = () => { try { return fs.readFileSync(registryFile(), 'utf8') } catch { return '' } }
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch { return {} } }
const findOutputByWatermark = (w) => Object.values(readState().outputs || {}).find((o) => o && String(o.source_watermark) === w)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, {})
  assert.ok(tools['memory__stage1_drain'], 'memory__stage1_drain tool registered')
  assert.ok(tools['memory__phase2_integrate'], 'memory__phase2_integrate tool registered')

  // 预置一个可提炼的 pending job（available now）。
  enqueueStage1JobFile(stateFile(), 's1', 'wm-auto', new Date())

  const res = await tools['memory__stage1_drain'].execute({})
  console.log('  drain processed:', res.processed)

  // drain 消费了作业并产出增量产物
  check(res.processed >= 1, 'drain processed at least one job')
  const output = findOutputByWatermark('wm-auto')
  // 注意：drain 工具调用是同步完成「提炼 + 自动 phase2」的，因此此刻该产物已被消费
  // （selected_for_phase2:true）。它「初始未消费」这一事实由下面「能被自动选择并消费」间接证明。
  check(!!output, 'drain produced an incremental output (source_watermark=wm-auto)')
  check(output && !!output.rollout_summary, 'incremental output carries a rollout_summary')

  // H3：自动触发了真 Phase 2 整合
  check(extractionCalls === 1, 'exactly 1 extraction LLM call (drain distill)')
  check(consolidationCalls === 1, 'exactly 1 consolidation LLM call (auto phase2 after output)')
  check(readSummary() === CONSOLIDATION.memory_summary, 'memory_summary.md published with LLM consolidation content')
  check(readRegistry() === CONSOLIDATION.registry, 'MEMORY.md published with LLM consolidation content')

  const st = readState()
  check(st.global.lastSuccessWatermark === 'wm-auto', 'lastSuccessWatermark advanced to wm-auto')
  check(!!st.global.lastPhase2At, 'lastPhase2At set by auto phase2')
  check(st.global.phase2_last_error === '', 'phase2_last_error cleared on success')

  // 已消费产物被标记，下次不再重选
  const consumed = findOutputByWatermark('wm-auto')
  check(consumed && consumed.selected_for_phase2 === true, 'consumed output marked selected_for_phase2:true (no re-integrate)')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PHASE2-AUTOTRIGGER TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
