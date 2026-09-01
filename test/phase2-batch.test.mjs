// 阶段 B（第三轮返工第 3 步）：Phase 2 持久批次 + 版本化发布（R3/R4/P0-6/P0-7/P0-8）。
// 覆盖设计 §13 / 《第三轮》§11.3 的 6 个验收点：
//   ① 模型调用期间新增 stage1_output，不被本批误标已消费（input_ids 冻结）。
//   ② 同批重试不重复消费（input_ids 幂等，同 batch 只 commit 一次）。
//   ③ 切换的第一份文件完成、第二份失败 → 读取方仍见旧完整版本（版本目录隔离，P0-7）。
//   ④ current 切换后、消费记录提交前退出 → 重启能识别并补提交（published 未 committed，P0-8）。
//   ⑤ 失败后即使无新 stage1 输出，也按退避自动重试（retry_wait→claim）。
//   ⑥ 权威标记/manifest 写失败不报成功。
import assert from 'node:assert'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, setMeta, metaOf, outputListOf } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

// ── controllable LLM mock ───────────────────────────────────────────────────
let consolidationCalls = 0
let pauseConsolidation = false
let consolidationInFlight = false
let releaseConsolidation = () => {}
let llmReturnNull = false
let lastConsolidationPrompt = ''
let llmResponse = { memory_summary: 'v1\n## consolidated', registry: '# MEMORY.md\nconsolidated registry' }
const llmMock = {
  stream: (opts) => {
    const isExtract = opts && String(opts.system).includes('memory-extraction')
    if (isExtract) return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    consolidationCalls++
    lastConsolidationPrompt = (opts && opts.messages && opts.messages[0] && opts.messages[0].content && opts.messages[0].content[0] && opts.messages[0].content[0].text) || ''
    if (llmReturnNull) throw new Error('llm down')
    const payload = JSON.stringify(llmResponse)
    return {
      async *[Symbol.asyncIterator]() {
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

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-phase2batch-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const root = () => path.join(tmp, 'memories')
const summaryFile = () => path.join(root(), 'memory_summary.md')
const registryFile = () => path.join(root(), 'MEMORY.md')
const currentFile = () => path.join(root(), 'current.json')
const readSummary = () => { try { return fs.readFileSync(summaryFile(), 'utf8') } catch { return '' } }
const readRegistry = () => { try { return fs.readFileSync(registryFile(), 'utf8') } catch { return '' } }
const readCurrent = () => { try { return JSON.parse(fs.readFileSync(currentFile(), 'utf8')) } catch { return null } }
const verSummary = (v) => { try { return fs.readFileSync(path.join(root(), 'versions', v, 'memory_summary.md'), 'utf8') } catch { return '' } }
const verRegistry = (v) => { try { return fs.readFileSync(path.join(root(), 'versions', v, 'MEMORY.md'), 'utf8') } catch { return '' } }
const outputByWm = (w) => Object.values(outputListOf(domain)).find((o) => o && String(o.source_watermark) === w)
const seedState = async (outputs, global) => {
  for (const [jobId, o] of Object.entries(outputs || {})) await seedOutput(domain, jobId, o)
  await setMeta(domain, global || {})
}
const putPhase2Job = (id, over = {}) =>
  domain.table('phase2_jobs').put(id, {
    id,
    status: 'pending',
    input_ids: [],
    lease_owner: '',
    lease_expires_at: '',
    attempt_count: 0,
    max_attempts: 3,
    available_at: new Date().toISOString(),
    staging_version: '',
    last_error: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  })
const jobById = (id) => domain.table('phase2_jobs').get(id)
const sha256 = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex')
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return false
}

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, {})
  assert.ok(tools['memory__phase2_integrate'], 'memory__phase2_integrate tool registered')

  // ── ① 模型调用期间新增 stage1_output 不被本批误标已消费（input_ids 冻结）──
  console.log('[①] 模型运行期间新增输出不被本批误消费（本批 input_ids 固定）')
  {
    pauseConsolidation = true
    await seedState(
      { 'j-1': { source_watermark: 'wm1', session_id: 's1', rollout_summary: 'A', generated_at: '2026-01-01T00:00:00.000Z' } },
      { lastSuccessWatermark: '', lastPhase2At: '' },
    )
    consolidationCalls = 0
    const p = tools['memory__phase2_integrate'].execute({})
    const entered = await waitUntil(() => consolidationInFlight, 2000)
    check(entered === true, 'batch A consolidation is in flight（写入锁未占，锁外调用）')
    // 模型运行期间新增一个未消费输出
    await seedOutput(domain, 'j-new', { source_watermark: 'wm-new', session_id: 's-new', rollout_summary: 'B', generated_at: '2026-01-01T00:00:01.000Z' })
    releaseConsolidation()
    const r = await p
    check(r.ran === true && r.ok === true, 'batch A committed')
    check(!!outputByWm('wm1') && outputByWm('wm1').selected_for_phase2 === true, 'A consumed (selected_for_phase2 true)')
    check(!!outputByWm('wm-new') && outputByWm('wm-new').selected_for_phase2 !== true, 'new output B NOT consumed by batch A')
    check(!!outputByWm('wm-new') && !outputByWm('wm-new').phase2_batch_id, 'new output B still phase2_batch_id empty (belongs to no batch)')
    check(consolidationCalls === 1, 'exactly 1 consolidation call for batch A')
    // 第二次调度会处理 B（成为新批）
    pauseConsolidation = false
    const r2 = await tools['memory__phase2_integrate'].execute({})
    check(r2.ran === true && r2.ok === true, 'batch B committed on next schedule')
    check(!!outputByWm('wm-new') && outputByWm('wm-new').selected_for_phase2 === true, 'B consumed after its own batch')
  }

  // ── ② 同批重试不重复消费（input_ids 幂等，同 batch 只 commit 一次）──
  console.log('[②] 同批重试不重复消费（input_ids 幂等，同 batch 只 commit 一次）')
  {
    await seedState(
      { 'j-2': { source_watermark: 'wm2', session_id: 's2', rollout_summary: 'C', generated_at: '2026-01-02T00:00:00.000Z' } },
      { lastSuccessWatermark: '', lastPhase2At: '' },
    )
    consolidationCalls = 0
    llmReturnNull = true // 首次失败
    const r1 = await tools['memory__phase2_integrate'].execute({})
    check(r1.ran === true && r1.ok === false, 'first attempt fails (llm-unavailable)')
    const retryBatch = Array.from(domain.table('phase2_jobs').entries()).find(([, j]) => j.status === 'retry_wait')
    check(!!retryBatch, 'a retry_wait batch exists after failure')
    const batchId = retryBatch[0]
    check(!!outputByWm('wm2') && outputByWm('wm2').phase2_batch_id === batchId, 'output owned by the failed batch (input_ids idempotent)')
    check(outputByWm('wm2').selected_for_phase2 !== true, 'output NOT consumed after failure')
    check(consolidationCalls === 1, 'one failed consolidation attempt')
    // 让退避到期（把 available_at 拨回过去），验证同一 batch 被复用而不再新建
    await domain.table('phase2_jobs').update(batchId, (cur) => ({
      ...cur,
      available_at: '2020-01-01T00:00:00.000Z',
    }))
    llmReturnNull = false
    llmResponse = { memory_summary: 'v1\n## retry ok', registry: '# MEMORY.md\nretry ok' }
    const r2 = await tools['memory__phase2_integrate'].execute({})
    check(r2.ran === true && r2.ok === true, 'retry of the SAME batch succeeds')
    check(jobById(batchId) && jobById(batchId).status === 'committed', 'same batch committed (not a duplicate batch)')
    check(!!outputByWm('wm2') && outputByWm('wm2').phase2_batch_id === batchId, 'output stays owned by the SAME batch id (no re-consume elsewhere)')
    check(!!outputByWm('wm2') && outputByWm('wm2').selected_for_phase2 === true, 'output consumed exactly once, via the same batch')
    check(consolidationCalls === 2, 'two consolidation attempts total (one failed, one success) — no extra batch')
    // 再调度 → no-change，不重复 commit / 不重复消费
    const r3 = await tools['memory__phase2_integrate'].execute({})
    check(r3.ran === false && r3.reason === 'no-change', 'third dispatch no-change (already committed)')
    check(outputByWm('wm2').selected_for_phase2 === true, 'output still consumed once')
  }

  // ── ③ 第二份文件失败 → 读取方仍见旧完整版本（版本目录隔离，P0-7）──
  console.log('[③] 第二份文件完成、第二份失败 → 读取方仍见旧完整版本（版本目录隔离）')
  {
    // 构造一个旧已发布版本 verA + current.json 指向它（读取方权威）
    const verA = 'v-old-a'
    const vdA = path.join(root(), 'versions', verA)
    fs.mkdirSync(vdA, { recursive: true })
    const oldSummary = 'v1\n## OLD SUMMARY'
    const oldRegistry = '# MEMORY.md\nOLD REGISTRY'
    fs.writeFileSync(path.join(vdA, 'memory_summary.md'), oldSummary)
    fs.writeFileSync(path.join(vdA, 'MEMORY.md'), oldRegistry)
    fs.writeFileSync(
      path.join(vdA, 'manifest.json'),
      JSON.stringify({ version: verA, summary_sha256: sha256(oldSummary), registry_sha256: sha256(oldRegistry), phase2_authoritative: true, created_at: new Date().toISOString() }),
    )
    await domain.table('publish_versions').put(verA, {
      id: verA,
      summary_file: `versions/${verA}/memory_summary.md`,
      registry_file: `versions/${verA}/MEMORY.md`,
      manifest_file: `versions/${verA}/manifest.json`,
      status: 'published',
      created_at: new Date().toISOString(),
    })
    fs.writeFileSync(currentFile(), JSON.stringify({ version: verA }))
    fs.writeFileSync(summaryFile(), oldSummary)
    fs.writeFileSync(registryFile(), oldRegistry)
    // 预置一个 pending 批 b3 + 第二文件（MEMORY.md.tmp）为目录 → 写出必然 EISDIR。
    const b3 = 'b3'
    await seedState(
      { 'j-3': { source_watermark: 'wm3', session_id: 's3', rollout_summary: 'D', generated_at: '2026-01-03T00:00:00.000Z' } },
      { lastSuccessWatermark: '', lastPhase2At: '' },
    )
    await putPhase2Job(b3, { input_ids: ['j-3'] })
    const rTmpDir = path.join(root(), 'versions', b3, 'MEMORY.md.tmp')
    fs.mkdirSync(rTmpDir, { recursive: true })
    consolidationCalls = 0
    llmResponse = { memory_summary: 'v1\n## new broken', registry: '# MEMORY.md\nbroken registry' }
    let r
    try {
      r = await tools['memory__phase2_integrate'].execute({})
    } finally {
      try { fs.rmSync(rTmpDir, { recursive: true, force: true }) } catch {}
    }
    check(r.ran === true && r.ok === false, 'publish of the new batch fails (second file)')
    check(readCurrent() && readCurrent().version === verA, 'current.json still points to OLD version (no switch)')
    check(verSummary(verA) === oldSummary, 'old version summary intact (reader sees old)')
    check(verRegistry(verA) === oldRegistry, 'old version registry intact (reader sees old)')
    check(readSummary() === oldSummary, 'root stable mirror still old summary (no partial publish)')
    check(readRegistry() === oldRegistry, 'root stable mirror still old registry (no partial publish)')
    // 读取方校验回退（P0-7 第 5 点）：把 current.json 指向一个「坏版本」，读取方应回退到上一可用版本 verA。
    const vBroken = 'v-broken'
    fs.mkdirSync(path.join(root(), 'versions', vBroken), { recursive: true })
    fs.writeFileSync(path.join(root(), 'versions', vBroken, 'memory_summary.md'), 'bad summary')
    fs.writeFileSync(path.join(root(), 'versions', vBroken, 'MEMORY.md'), 'bad registry')
    // 故意不给 manifest / 给错误校验和，让 versionIsUsable 判坏。
    fs.writeFileSync(
      path.join(root(), 'versions', vBroken, 'manifest.json'),
      JSON.stringify({ version: vBroken, summary_sha256: sha256('WRONG'), registry_sha256: sha256('WRONG') }),
    )
    fs.writeFileSync(currentFile(), JSON.stringify({ version: vBroken }))
    await seedState(
      { 'j-fb': { source_watermark: 'wm-fb', session_id: 's-fb', rollout_summary: 'FALLBACK', generated_at: '2026-01-03T01:00:00.000Z' } },
      { lastSuccessWatermark: '', lastPhase2At: '' },
    )
    await putPhase2Job('b-fb', { input_ids: ['j-fb'] })
    consolidationCalls = 0
    llmResponse = { memory_summary: 'v1\n## fallback published', registry: '# MEMORY.md\nfallback' }
    const rfb = await tools['memory__phase2_integrate'].execute({})
    check(rfb.ran === true && rfb.ok === true, 'batch b-fb published using the FALLBACK current version')
    check(lastConsolidationPrompt.includes(oldSummary), 'reader fed the fallback (old) version summary, not the broken current')
    // 恢复 current 指针，避免影响后续场景读源。
    fs.writeFileSync(currentFile(), JSON.stringify({ version: verA }))
  }

  // ── ④ current 已切换、消费未提交 → 重启识别并补提交（published 未 committed，P0-8）──
  console.log('[④] current 切换后、消费记录提交前退出 → 重启识别并补提交（published 未 committed）')
  {
    const b4 = 'b4'
    await seedState(
      { 'j-4': { source_watermark: 'wm4', session_id: 's4', rollout_summary: 'E', generated_at: '2026-01-04T00:00:00.000Z' } },
      { lastSuccessWatermark: '', lastPhase2At: '' },
    )
    await putPhase2Job(b4, { status: 'published', input_ids: ['j-4'], lease_owner: 'old-' + Date.now(), lease_expires_at: '2020-01-01T00:00:00.000Z' })
    consolidationCalls = 0
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === true, 'recovery round-trips the published batch')
    check(jobById(b4) && jobById(b4).status === 'committed', 'published → committed via recovery')
    check(!!outputByWm('wm4') && outputByWm('wm4').phase2_batch_id === b4, 'consumed output owned by b4')
    check(!!outputByWm('wm4') && outputByWm('wm4').selected_for_phase2 === true, 'output marked consumed by recovery')
    check(consolidationCalls === 0, 'recovery does NOT call the LLM (no re-integration)')
    check(metaOf(domain).lastSuccessWatermark === 'wm4', 'watermark advanced by recovery commit')
    // 幂等：再调度一次不重复 commit
    const r2 = await tools['memory__phase2_integrate'].execute({})
    check(r2.ran === false && r2.reason === 'no-change', 'idempotent: second dispatch no-change after recovery')
  }

  // ── ⑤ 失败后即使无新 stage1 输出，也按退避自动重试（retry_wait→claim）──
  console.log('[⑤] 失败后无新输出也按退避自动重试（retry_wait→claim）')
  {
    await seedState(
      { 'j-5': { source_watermark: 'wm5', session_id: 's5', rollout_summary: 'F', generated_at: '2026-01-05T00:00:00.000Z' } },
      { lastSuccessWatermark: '', lastPhase2At: '' },
    )
    consolidationCalls = 0
    llmReturnNull = true
    const r1 = await tools['memory__phase2_integrate'].execute({})
    check(r1.ran === true && r1.ok === false, 'batch fails (llm-unavailable) → retry_wait')
    const retry = Array.from(domain.table('phase2_jobs').entries()).filter(([, j]) => j.status === 'retry_wait')
    check(retry.length >= 1, 'at least one retry_wait batch')
    // 此时没有任何未消费输出（该批 inputs 已被本批持有），证明重试靠退避而非新输出触发
    const unconsumed = Object.values(outputListOf(domain)).filter((o) => !o.selected_for_phase2 && !o.phase2_batch_id)
    check(unconsumed.length === 0, 'no unconsumed stage1_output remains (backoff drives retry, not new output)')
    // 拨回退避期，验证调度能再次领取并成功
    const rid = retry[0][0]
    await domain.table('phase2_jobs').update(rid, (cur) => ({
      ...cur,
      available_at: '2020-01-01T00:00:00.000Z',
    }))
    llmReturnNull = false
    const r2 = await tools['memory__phase2_integrate'].execute({})
    check(r2.ran === true && r2.ok === true, 'retry_wait batch re-claimed and committed after backoff')
    check(jobById(rid) && jobById(rid).status === 'committed', 'the retried batch is now committed')
  }

  // ── ⑥ manifest 写失败不报成功（权威标记/manifest 与发布一致）──
  console.log('[⑥] manifest 写失败不报成功（权威标记/manifest 一致性）')
  {
    const b6 = 'b6'
    await seedState(
      { 'j-6': { source_watermark: 'wm6', session_id: 's6', rollout_summary: 'G', generated_at: '2026-01-06T00:00:00.000Z' } },
      { lastSuccessWatermark: '', lastPhase2At: '' },
    )
    // pre-set manifest.json as a directory → manifest write must fail
    const pre = path.join(root(), 'versions', b6, 'manifest.json')
    fs.mkdirSync(pre, { recursive: true })
    await putPhase2Job(b6, { input_ids: ['j-6'] })
    consolidationCalls = 0
    llmResponse = { memory_summary: 'v1\n## manifest fail', registry: '# MEMORY.md\nmanifest fail' }
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === false, 'manifest write failure → NOT reported success')
    check(Array.isArray(r.errors) && r.errors.some((e) => /publish-failed/.test(e)), 'errors indicate publish-failed (manifest)')
    check(jobById(b6) && jobById(b6).status !== 'committed', 'batch NOT marked committed on manifest write failure')
    check(!!readCurrent(), 'current.json still present (old version kept)')
    check(outputByWm('wm6').selected_for_phase2 !== true, 'output not consumed on manifest write failure')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PHASE2-BATCH TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
