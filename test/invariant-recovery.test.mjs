// GPT 第四轮复核 P0-3 / P0-4 回归：跨 key 半提交不变量恢复。
//   P0-3：stage1 作业「succeeded_with_output 但缺 stage1_outputs」→ reconcileStage1OutputInvariant
//         重置 pending 重提炼，最终 output 落盘、job 终态（不丢 Phase 2 输入）。
//   P0-4：stage1_output 的 phase2_batch_id 指向「失败终态/不存在」批次（孤儿）→
//         reconcilePhase2Bindings 解除绑定，使其可被新批重新选择消费（不误 consumed、不卡死）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, outputListOf, seedJob, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

// ── llm mock：区分 extraction 与 consolidation ─────────────────────────────
let extractionCalls = 0
let consolidationCalls = 0
const EXTRACTION = { rollout_summary: 'sum', raw_memory: 'raw', slug: 'note', keywords: '', title: '' }
const CONSOLIDATION = { memory_summary: 'v1\n## rescued', registry: '# MEMORY.md\nrescued' }
const msgEvent = (id, text) => ({ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [msgEvent(id, 'this is a long enough message for the model extraction step now')] })
const llmMock = { stream: (opts) => {
  const isExtract = opts && String(opts.system).includes('memory-extraction')
  if (!isExtract) consolidationCalls++
  else extractionCalls++
  const payload = isExtract ? EXTRACTION : CONSOLIDATION
  return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(payload) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
} }

const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : k === 'sessionQuery' ? { readSession } : undefined),
})

const tmp = path.join(os.tmpdir(), 'dsh-memory-rollout-invariant-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const readJobs = (d) => jobListOf(d)
const readOutputs = (d) => outputListOf(d)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, {})
  assert.ok(ctx.tools['memory__stage1_drain'] && ctx.tools['memory__phase2_integrate'], 'drain + phase2 tools registered')

  // ── P0-3：stage1 终态成功但缺 output → 重置重提炼，最终 output 落盘 ──
  console.log('[P0-3] stage1「succeeded_with_output 缺产物」半提交 → 恢复扫描重置并重提炼')
  {
    const { key, job } = await seedJob(domain, 's3', 'wm3', { id: 'j-p03', status: 'succeeded_with_output', completedAt: new Date().toISOString() })
    // 制造半提交：job 已终态成功，但 stage1_outputs 没有对应产物（key=job.id）。
    check(!readOutputs(domain)['j-p03'], 'precondition: no stage1_output for the succeeded job (half-write)')
    extractionCalls = 0
    const res = await ctx.tools['memory__stage1_drain'].execute({})
    check(res.processed >= 1, 'drain reparsed the half-written job')
    const out = readOutputs(domain)['j-p03']
    check(!!out, 'after re-extraction, stage1_output exists for job j-p03')
    check(out && out.rollout_summary === 'sum', 're-extracted output present (not lost)')
    const j = readJobs(domain)['s3::wm3']
    check(j && j.status === 'succeeded_with_output', 'job ended in a CONSISTENT succeeded_with_output (output present)')
    check(extractionCalls === 1, 'exactly one re-extraction attempt (the reset job consumed one attempt)')
    check(!(j.status === 'succeeded_with_output' && !out), 'invariant repaired: no succeeded_with_output without output')
  }

  // ── P0-4：真孤儿（批不存在）被解绑并重整；failed_terminal 批的 inputs 不被解绑（防无限重试）──
  console.log('[P0-4] phase2 孤儿绑定：真孤儿(批不存在)解绑重整；failed_terminal 批 inputs 不自动解绑')
  {
    // A：真孤儿——input 指向一个「不存在」的批 → 应被解绑并重新消费。
    await seedOutput(domain, 'j-orphan-a', {
      session_id: 's4a', source_watermark: 'wm4a', rollout_summary: 'ORPHAN_A', generated_at: '2026-01-01T00:00:00.000Z',
      phase2_batch_id: 'b-missing', selected_for_phase2: false,
    })
    // B：failed_terminal 批是「真实存在」的终态批——其 inputs 应保留绑定（不退化为无限重试）。
    await seedOutput(domain, 'j-orphan-b', {
      session_id: 's4b', source_watermark: 'wm4b', rollout_summary: 'ORPHAN_B', generated_at: '2026-01-01T00:00:01.000Z',
      phase2_batch_id: 'b-failed', selected_for_phase2: false,
    })
    await domain.table('phase2_jobs').put('b-failed', {
      id: 'b-failed', status: 'failed_terminal', input_ids: ['j-orphan-b'], change_ids: [], lease_owner: '', lease_expires_at: '',
      attempt_count: 3, max_attempts: 3, available_at: '', staging_version: '', last_error: 'llm-down', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })
    consolidationCalls = 0
    const r = await ctx.tools['memory__phase2_integrate'].execute({})
    // A 被解绑并重整为一个 committed 批
    const oa = readOutputs(domain)['j-orphan-a']
    check(oa && oa.selected_for_phase2 === true, '真孤儿 A 已解绑并被重新消费')
    check(oa && oa.phase2_batch_id && oa.phase2_batch_id !== 'b-missing', '真孤儿 A 重新绑定到新批（不再是 b-missing）')
    // B 保持绑定到 failed_terminal 批（不被解绑、不被重选）→ 不会退化成无限重试
    const ob = readOutputs(domain)['j-orphan-b']
    check(ob && ob.phase2_batch_id === 'b-failed', 'failed_terminal 批的 input B 仍绑定 b-failed（不解绑）')
    check(ob && ob.selected_for_phase2 !== true, 'B 未被消费（bound 到 failed_terminal，不自动重入队）')
    check(consolidationCalls === 1, '只发起 A 一个真实整合（B 不产生额外批，无无限重试）')
    const live = Array.from(domain.table('phase2_jobs').entries()).find(([, j]) => j && j.status === 'committed' && Array.isArray(j.input_ids) && j.input_ids.includes('j-orphan-a'))
    check(!!live, '真孤儿 A 整入一个 committed 批（批存在）')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL INVARIANT-RECOVERY TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
