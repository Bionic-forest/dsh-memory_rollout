// P1 归档协议（性能与减法审计 §六）：memory__archive_vault
//   ① dry-run=true：只统计各表可归档量，不动作（changes 仍留在原表）。
//   ② dry-run=false：仅把绝对安全的 consumed memory_changes 迁到 changes_archive（保留全字段、可恢复）；
//      stage1_outputs / phase2_jobs 不自动归档（需配套读路径/reconcile 改造，仅统计）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, seedJob } from './lib/helpers.mjs'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply } = await import(PLUGIN)

const { ctx, domain } = makeCtx({ get: () => undefined })
const tmp = path.join(os.tmpdir(), 'dsh-rollout-archive-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })

let failed = 0
const check = (cond, msg) => { if (cond) console.log('  ✓ ', msg); else { failed++; console.error('  ✗ ', msg) } }
const put = (t, k, v) => domain.table(t).put(k, v)

try {
  await apply(ctx, {})
  assert.ok(ctx.tools['memory__archive_vault'], 'memory__archive_vault registered')

  // 造数据：
  // - 3 条 consumed stage1_outputs / 1 条未消费
  await seedOutput(domain, 'o1', { session_id: 's1', source_watermark: 'wm1', rollout_summary: 'A', selected_for_phase2: true })
  await seedOutput(domain, 'o2', { session_id: 's2', source_watermark: 'wm2', rollout_summary: 'B', selected_for_phase2: true })
  await seedOutput(domain, 'o3', { session_id: 's3', source_watermark: 'wm3', rollout_summary: 'C', selected_for_phase2: true })
  await seedOutput(domain, 'o4', { session_id: 's4', source_watermark: 'wm4', rollout_summary: 'D', selected_for_phase2: false })
  // - 2 条终态 phase2_jobs（committed / failed_terminal）+ 1 条 running
  await put('phase2_jobs', 'p2-c', { id: 'p2-c', status: 'committed', input_ids: ['o1'], change_ids: [], lease_owner: '', lease_expires_at: '', attempt_count: 1, max_attempts: 3, available_at: '', staging_version: '', last_error: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  await put('phase2_jobs', 'p2-f', { id: 'p2-f', status: 'failed_terminal', input_ids: ['o2'], change_ids: [], lease_owner: '', lease_expires_at: '', attempt_count: 3, max_attempts: 3, available_at: '', staging_version: '', last_error: 'x', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  await put('phase2_jobs', 'p2-r', { id: 'p2-r', status: 'running', input_ids: ['o3'], change_ids: [], lease_owner: 'b', lease_expires_at: new Date(Date.now() + 60000).toISOString(), attempt_count: 0, max_attempts: 3, available_at: '', staging_version: '', last_error: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  // - 2 条 consumed change + 1 条 pending change
  await put('memory_changes', 'ch-1', { id: 'ch-1', kind: 'remember', payload: { content: 'x' }, source_ref: '', status: 'consumed', phase2_batch_id: 'p2-c', priority: 10, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  await put('memory_changes', 'ch-2', { id: 'ch-2', kind: 'forget', payload: { entryId: 'e' }, source_ref: '', status: 'consumed', phase2_batch_id: 'p2-c', priority: 100, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  await put('memory_changes', 'ch-3', { id: 'ch-3', kind: 'note', payload: { content: 'y' }, source_ref: '', status: 'pending', phase2_batch_id: '', priority: 10, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })

  // ── ① dry-run：只统计不动作 ──
  console.log('[①] dry-run=true：统计正确，不动作')
  const r1 = await ctx.tools['memory__archive_vault'].execute({ dryRun: true })
  check(r1.dryRun === true, 'dryRun=true')
  check(r1.candidates.stage1_outputs === 3, 'candidates.outputs=3（consumed outputs；未消费 o4 不算）')
  check(r1.candidates.changes === 2, 'candidates.changes=2（consumed changes；pending ch-3 不算）')
  check(r1.candidates.phase2_jobs === 2, 'candidates.phase2=2（committed+failed_terminal；running 不算）')
  check(domain.table('memory_changes').get('ch-1') && domain.table('memory_changes').get('ch-2'), 'dry-run 未移动 changes（ch-1/ch-2 仍在原表）')
  check(domain.table('changes_archive').size === 0, '归档表仍空（dry-run 不动作）')
  check(r1.archived === 0, 'dry-run 未归档任何记录')

  // ── ② 实际归档：只动 consumed changes ──
  console.log('[②] dry-run=false：仅安全归档 consumed changes')
  const r2 = await ctx.tools['memory__archive_vault'].execute({ dryRun: false })
  check(r2.archived === 2, '归档了 2 条（consumed ch-1/ch-2）')
  check(domain.table('memory_changes').get('ch-1') === undefined && domain.table('memory_changes').get('ch-2') === undefined, 'consumed changes 已从原表移除')
  check(!!domain.table('memory_changes').get('ch-3'), 'pending change ch-3 保留（不归档）')
  const a1 = domain.table('changes_archive').get('ch-1')
  check(!!a1 && a1.status === 'consumed' && a1.archived_at && a1.archive_reason === 'change_consumed', '归档实现在 changes_archive（保留全字段 + archived_at/reason）')
  // stage1/phase2 不自动归档（仅统计）
  check(domain.table('phase2_jobs').get('p2-c') && domain.table('phase2_jobs').get('p2-f'), 'phase2_jobs 未自动归档（需配套改造）')
  check(domain.table('stage1_outputs').get('o1') && domain.table('stage1_outputs').get('o3'), 'stage1_outputs 未自动归档（引用依赖）')

  // ── ③ dry-run 对归档后再次运行：候选减少 ──
  console.log('[③] 归档后 dry-run 候选减少（ch 已无 consumed）')
  const r3 = await ctx.tools['memory__archive_vault'].execute({ dryRun: true })
  check(r3.candidates.changes === 0, 'candidates.changes=0（已归档）')
  check(r3.candidates.stage1_outputs === 3, 'candidates.outputs 仍 3（未动）')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL ARCHIVE-VAULT TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
