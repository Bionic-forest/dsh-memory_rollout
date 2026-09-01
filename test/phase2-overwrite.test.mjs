// H3b + M4 回归测试：
//  H3b —— phase2Integrate 发布的「LLM 权威产物」不得被随后的确定性 integrate()
//         覆盖。覆盖两个场景：
//          (A) phase2 发布后，草稿/entries 未变 → integrate() skip，LLM 内容保留。
//          (B) phase2 发布后，草稿/entries 变了（新增草稿）→ integrate() 仍必须 skip，
//              不得用确定性重建覆盖 LLM 内容（这是 H3b 的真实覆盖冲突）。
//         对照：phase2 之前，integrate() 照常确定性重建（证明确定性路径未被破坏）。
//  M4 —— phase2Integrate 的 LLM 调用发生在写锁外：模型执行期间全局写锁不被占，
//         一个并发写（memory_forget）能成功而不抛「另一个写进行中」冲突。
// 迁移：.stage1-state.json 的 outputs/global 改由 stage1_outputs / stage1_meta 表预置
// （seedOutput + setMeta）；entries 表写入改 domain.table('entries')；断言的 global
// 字段改用 metaOf(domain)。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, setMeta } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

// Controlled LLM mock. `pauseConsolidation` lets Scenario [4] hold the model call
// open so we can probe the write lock during the consolidation; the default is
// off so the other scenarios run at full speed.
let pauseConsolidation = false
let consolidationInFlight = false
let releaseConsolidation = () => {}
let consolidationCalls = 0
const llmMock = {
  stream: () => {
    const payload = JSON.stringify({ memory_summary: 'v1\n## LLM SUMMARY', registry: '# MEMORY.md\nLLM registry' })
    return {
      async *[Symbol.asyncIterator]() {
        consolidationCalls++
        yield { type: 'text-delta', text: payload }
        if (pauseConsolidation) {
          consolidationInFlight = true
          await new Promise((r) => { releaseConsolidation = r })
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

const tools = {}
const { ctx, domain } = makeCtx({
  get: (k) =>
    k === 'llm'
      ? llmMock
      : k === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined,
  tools: { register: (t) => { tools[t.name] = t } },
})

const tmp = path.join(os.tmpdir(), 'dsh-memory-rollout-ph2ow-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const root = () => path.join(tmp, 'memories')
const summaryFile = () => path.join(root(), 'memory_summary.md')
const registryFile = () => path.join(root(), 'MEMORY.md')
const authorityFile = () => path.join(root(), '.phase2-authoritative')
const readSummary = () => { try { return fs.readFileSync(summaryFile(), 'utf8') } catch { return '' } }
const readRegistry = () => { try { return fs.readFileSync(registryFile(), 'utf8') } catch { return '' } }
// 用表预置：outputs → stage1_outputs 表；global → stage1_meta 表。
const seedState = async (outputs, global) => {
  for (const [jobId, o] of Object.entries(outputs || {})) await seedOutput(domain, jobId, o)
  await setMeta(domain, global || {})
}
const writeDraft = (name) => {
  const d = path.join(root(), 'rollout_summaries')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, name), 'session_id: s-b\nupdated_at: 2026-01-02\ncwd: C:/s-b\n\n# 会话草稿 ' + name + '\n\nnew draft body here')
}

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return false
}

try {
  await apply(ctx, {})
  assert.ok(tools['memory_integrate'], 'memory_integrate tool registered')
  assert.ok(tools['memory__phase2_integrate'], 'memory__phase2_integrate tool registered')
  assert.ok(tools['memory_forget'], 'memory_forget tool registered')

  console.log('[0] 对照：phase2 之前，integrate() 照常确定性重建（草稿/entries 变化 → changed:true）')
  {
    writeDraft('a.md')
    await domain.table('entries').put('e1', { content: 'a durable preference', tags: ['pref'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sessionId: 's1' })
    const r = await tools['memory_integrate'].execute({})
    check(r.changed === true && r.skipped === false, 'before phase2, integrate() regenerates (changed:true)')
    check(readSummary().includes('a durable preference'), 'deterministic summary reflects the entry')
    check(!fs.existsSync(authorityFile()), 'no phase2-authoritative marker before phase2')
  }

  console.log('[1] H3b(A)：phase2 发布 → 草稿/entries 未变 → integrate() skip，LLM 内容保留')
  {
    const prePhase2Summary = readSummary() // 场景 [0] 的确定性内容（作为旧版对照）
    await seedState(
      { 'j-p2': { source_watermark: 'wm-p2', session_id: 's-a', rollout_summary: 'new incremental', generated_at: '2026-01-02T00:00:00.000Z' } },
      { lastSuccessWatermark: '', lastPhase2At: '' },
    )
    const p2 = await tools['memory__phase2_integrate'].execute({})
    check(p2.ran === true && p2.ok === true, 'phase2 publish succeeds (ran:true ok:true)')
    check(readSummary() === 'v1\n## LLM SUMMARY', 'memory_summary.md now holds LLM content')
    check(fs.existsSync(authorityFile()), '.phase2-authoritative marker written on publish')
    // 草稿/entries 未变 → memory_integrate 必须 skip，不得重建
    const r = await tools['memory_integrate'].execute({})
    check(r.skipped === true && r.changed === false, 'integrate() skips when inputs unchanged after phase2')
    check(readSummary() === 'v1\n## LLM SUMMARY', 'summary stays LLM (A: not clobbered)')
    check(readRegistry() === '# MEMORY.md\nLLM registry', 'registry stays LLM (A: not clobbered)')
    void prePhase2Summary
  }

  console.log('[2] H3b(B)：phase2 发布 → 新增草稿（草稿变了）→ integrate() 仍跳过，不覆盖 LLM')
  {
    // 新增一个草稿 → memoryFingerprint 变化，正落在当前代码会覆盖的区间（真实 H3b bug）
    writeDraft('b.md')
    const before = readSummary()
    const r = await tools['memory_integrate'].execute({})
    check(r.skipped === true && r.changed === false, 'integrate() skips even after a new draft (H3b fix)')
    check(readSummary() === 'v1\n## LLM SUMMARY', 'summary STAYS LLM (B: never clobbered by deterministic rebuild)')
    check(before === 'v1\n## LLM SUMMARY', 'pre- and post-integrate summary identical (LLM-owned)')
    check(readRegistry() === '# MEMORY.md\nLLM registry', 'registry STAYS LLM (B: never clobbered)')
  }

  console.log('[3] M4：LLM 整合期间全局写锁不被占，并发写可成功')
  {
    // 再预置一个未被消费的增量，让 phase2 有输入；打开“暂停模型”开关。
    pauseConsolidation = true
    await seedState(
      { 'j-m4': { source_watermark: 'wm-m4', session_id: 's-m4', rollout_summary: 'm4 incremental', generated_at: '2026-01-03T00:00:00.000Z' } },
      { lastSuccessWatermark: '', lastPhase2At: '' },
    )
    await domain.table('entries').put('m4-id', { content: 'entry to forget', tags: ['x'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sessionId: 's-m4' })
    consolidationCalls = 0
    const p = tools['memory__phase2_integrate'].execute({})
    const entered = await waitUntil(() => consolidationInFlight, 2000)
    check(entered === true, 'consolidation model call is in flight (querying the write lock now)')
    check(consolidationCalls === 1, 'exactly 1 consolidation LLM call started')
    let forgetOk = false
    let forgetErr = ''
    try {
      const f = await tools['memory_forget'].execute({ id: 'm4-id' })
      forgetOk = f.deleted === 1
    } catch (e) { forgetErr = String((e && e.message) || e) }
    check(forgetOk, 'concurrent write (memory_forget) succeeds during the LLM call — write lock NOT held (M4)')
    if (forgetErr) check(false, 'concurrent write threw: ' + forgetErr)
    // release the model call, let phase2 finish publishing
    releaseConsolidation()
    const p2 = await p
    check(p2.ran === true && p2.ok === true, 'phase2 completes after the LLM call is released')
    check(readSummary() === 'v1\n## LLM SUMMARY', 'summary stays LLM after M4 publish')
    pauseConsolidation = false
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PHASE2-OVERWRITE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
