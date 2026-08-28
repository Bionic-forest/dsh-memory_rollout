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

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
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

const tmp = path.join(os.tmpdir(), 'dsh-rollout-invariant-' + Date.now())
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

  // ── P0-4：stage1_output 的 batch 指向失败终态批次（孤儿）→ 接触绑定并重整 ──
  console.log('[P0-4] phase2「input 绑定到失败终态批次」孤儿 → 恢复扫描解除绑定并重新消费')
  {
    await seedOutput(domain, 'j-orphan', {
      session_id: 's4', source_watermark: 'wm4', rollout_summary: 'ORPHAN', generated_at: '2026-01-01T00:00:00.000Z',
      phase2_batch_id: 'b-failed', selected_for_phase2: false,
    })
    // 构造一个失败终态批次 b-failed，它的 input_ids 指回 j-orphan（孤儿占用：批不存在可消费路径）。
    await domain.table('phase2_jobs').put('b-failed', {
      id: 'b-failed', status: 'failed_terminal', input_ids: ['j-orphan'], change_ids: [], lease_owner: '', lease_expires_at: '',
      attempt_count: 3, max_attempts: 3, available_at: '', staging_version: '', last_error: 'llm-down', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })
    consolidationCalls = 0
    const r = await ctx.tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === true, 'phase2 rescue round-trips (orphan re-consumed)')
    const o = readOutputs(domain)['j-orphan']
    check(o && o.selected_for_phase2 === true, 'orphan output now consumed (rescued into a new batch)')
    check(o && o.phase2_batch_id && o.phase2_batch_id !== 'b-failed', 'orphan rebound to a live batch, no longer pointing at failed_terminal')
    const live = Array.from(domain.table('phase2_jobs').entries()).find(([, j]) => j && j.status === 'committed' && Array.isArray(j.input_ids) && j.input_ids.includes('j-orphan'))
    check(!!live, 'a COMMITTED batch owns the orphan input (not stuck at failed_terminal)')
    // 孤儿 output 的当前绑定必须指向一个「存在且非失败终态」的批（不再悬空/不再卡死）。
    const curBinding = readOutputs(domain)['j-orphan'].phase2_batch_id
    const curJob = curBinding ? domain.table('phase2_jobs').get(curBinding) : null
    check(curJob && curJob.status !== 'failed_terminal', 'orphan currently bound to a live (non-failed-terminal) batch')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL INVARIANT-RECOVERY TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
