// 阶段 B（真 Phase 2 全局整合）：memory__phase2_integrate 工具端到端。
// 覆盖三种情形：
//  1. 无变化：stage1_outputs 无增量（产物的 selected_for_phase2 已消费）
//     → 返回 ran:false / no-change，且不调用模型（llm.mock 计数 0）。
//  2. 有增量 + LLM 正常：llm.mock 返回合法 {memory_summary, registry}
//     → 发布（memory_summary.md 写入）+ ran:true ok:true + lastSuccessWatermark 推进。
//  3. 有增量 + LLM 输出含未脱敏秘密：llm.mock 的 memory_summary 含 sk-…
//     → validatePhase2Output 失败 → 不发布（memory_summary.md 保持旧内容）+ ok:false + errors。
// 注：用例 3 用真实长度的 sk- 前缀（>=6 字符），因为 redactSecrets 的规则(5) 只对
// `sk-<6+ 位>` 触发；`sk-xxx`（3 位）不满足，会漏警（用更真实的 secret 才测得到拦截）。
// 迁移：.stage1-state.json 的 outputs/global 改由 stage1_outputs / stage1_meta 表预置
// （seedOutput + setMeta），断言的 global 字段改用 metaOf(domain) 读取。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, setMeta, metaOf } from './lib/helpers.mjs'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply } = await import(PLUGIN)

// LLM mock: `stream` returns an async-iterable of {text-delta, finish}. A mutable
// `llmResponse` lets each case hand back a different payload; `llmCalls` counts
// actual model attempts (the no-change case must yield 0).
let llmCalls = 0
let llmResponse = { memory_summary: 'v1\nok', registry: '# MEMORY.md\nok' }
const llmMock = {
  stream: () => {
    llmCalls++
    const payload = JSON.stringify(llmResponse)
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: payload }
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

const tmp = path.join(os.tmpdir(), 'dsh-rollout-phase2-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const root = () => path.join(tmp, 'memories')
const summaryFile = () => path.join(root(), 'memory_summary.md')
const registryFile = () => path.join(root(), 'MEMORY.md')
const readSummary = () => { try { return fs.readFileSync(summaryFile(), 'utf8') } catch { return '' } }
const readRegistry = () => { try { return fs.readFileSync(registryFile(), 'utf8') } catch { return '' } }
// 用表预置：outputs → stage1_outputs 表；global → stage1_meta 表。
const seedState = async (outputs, global) => {
  for (const [jobId, o] of Object.entries(outputs || {})) await seedOutput(domain, jobId, o)
  await setMeta(domain, global || {})
}

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, {})
  assert.ok(tools['memory__phase2_integrate'], 'memory__phase2_integrate tool registered')

  console.log('[1] 无变化：无增量 outputs → ran:false / no-change，不调用模型')
  {
    const startupSummary = readSummary()
    // M1: 已消费的产物 selected_for_phase2: true → selectPhase2Inputs 挑不出增量 → no-change
    await seedState(
      { 'j-1': { source_watermark: 'wm1', session_id: 's1', rollout_summary: 'x', selected_for_phase2: true, generated_at: '2026-01-01T00:00:00.000Z' } },
      { lastSuccessWatermark: 'wm1', lastPhase2At: '' },
    )
    llmCalls = 0
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === false && r.reason === 'no-change', 'ran:false, reason=no-change')
    check(llmCalls === 0, 'no model call on no-change')
    check(readSummary() === startupSummary, 'memory_summary.md unchanged on no-change')
  }

  console.log('[2] 有增量 + LLM 正常：发布 + ran:true ok:true + 水印推进')
  {
    await seedState(
      { 'j-1': { source_watermark: 'wm2', session_id: 's1', rollout_summary: 'new summary', rollout_slug: 'slug1', keywords: 'a,b', generated_at: '2026-01-02T00:00:00.000Z' } },
      { lastSuccessWatermark: '', lastPhase2At: '' },
    )
    const NEW_SUMMARY = 'v1\n## new consolidated summary'
    const NEW_REGISTRY = '# MEMORY.md\nnew registry'
    llmResponse = { memory_summary: NEW_SUMMARY, registry: NEW_REGISTRY }
    llmCalls = 0
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === true, 'ran:true, ok:true')
    check(Array.isArray(r.watermarks) && r.watermarks.includes('wm2'), 'watermarks includes wm2')
    check(readSummary() === NEW_SUMMARY, 'memory_summary.md published with LLM content')
    check(readRegistry() === NEW_REGISTRY, 'MEMORY.md published with LLM content')
    check(metaOf(domain).lastSuccessWatermark === 'wm2', 'lastSuccessWatermark advanced to wm2')
    check(llmCalls === 1, 'exactly 1 LLM call')
  }

  console.log('[3] 有增量 + LLM 输出含秘密：校验失败 → 不发布 + ok:false + errors')
  {
    const oldSummary = readSummary() // 前一用例发布的版本，作「旧版」对照
    await seedState(
      { 'j-2': { source_watermark: 'wm3', session_id: 's2', rollout_summary: 'secret-y', generated_at: '2026-01-03T00:00:00.000Z' } },
      { lastSuccessWatermark: 'wm2', lastPhase2At: '' },
    )
    llmResponse = { memory_summary: 'v1\ncontains sk-abcDEF123456abcdef secret', registry: '# MEMORY.md\nok' }
    llmCalls = 0
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === false, 'secret output → ok:false')
    check(Array.isArray(r.errors) && r.errors.length > 0, 'errors returned')
    check(readSummary() === oldSummary, 'memory_summary.md NOT published (kept old)')
    check(metaOf(domain).lastSuccessWatermark === 'wm2', 'watermark NOT advanced on secret fail')
    check(llmCalls === 1, 'exactly 1 LLM call (attempt still counted)')
  }

  console.log('[4] 发布第二个文件失败：原子提交 → 旧版保留 + 水印未推进 + phase2_last_error（M2）')
  {
    const oldSummary = readSummary()
    const oldRegistry = readRegistry()
    await seedState(
      { 'j-3': { source_watermark: 'wm4', session_id: 's3', rollout_summary: 'new2', generated_at: '2026-01-04T00:00:00.000Z' } },
      { lastSuccessWatermark: 'wm3', lastPhase2At: '' },
    )
    llmResponse = { memory_summary: 'v1\n## atomic new', registry: '# MEMORY.md\natomic new' }
    llmCalls = 0
    // 注入：把 MEMORY.md.tmp 变成一个目录，使原子发布的第二个文件写出必然 EISDIR 失败。
    const rTmpDir = registryFile() + '.tmp'
    fs.mkdirSync(rTmpDir, { recursive: true })
    let r
    try {
      r = await tools['memory__phase2_integrate'].execute({})
    } finally {
      try { fs.rmSync(rTmpDir, { recursive: true, force: true }) } catch {}
    }
    check(r && r.ran === true && r.ok === false, 'publish failure -> ok:false')
    check(Array.isArray(r.errors) && r.errors.some((e) => /publish-failed/.test(e)), 'errors indicate publish-failed')
    check(readSummary() === oldSummary, 'memory_summary.md kept old version (no partial publish)')
    check(readRegistry() === oldRegistry, 'MEMORY.md kept old version (no partial publish)')
    check(metaOf(domain).lastSuccessWatermark === 'wm3', 'watermark NOT advanced on publish failure')
    check(/publish-failed/.test(metaOf(domain).phase2_last_error || ''), 'phase2_last_error recorded on publish failure')
    check(llmCalls === 1, 'exactly 1 LLM call (consolidation attempted)')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PHASE2-INTEGRATE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
