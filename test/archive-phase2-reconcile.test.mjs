// P0-1 回归：归档 terminal phase2 批次后，reconcilePhase2Bindings 不得抛 TypeError（Phase2 不得停摆）。
// 覆盖 GPT《P1 归档验收结论》P0-1：reconcilePhase2Bindings 曾用 `Set.set` 预扫 phase2_jobs_archive，
// 只要归档表非空即抛 TypeError → Phase2 无法继续。现改为按 batch_id 直接 get 核对，本测试守护。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const { ctx, domain } = makeCtx({ get: () => undefined })
const tmp = path.join(os.tmpdir(), 'dsh-memory-rollout-p2reconcile-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })

let failed = 0
const check = (cond, msg) => { if (cond) console.log('  ✓ ', msg); else { failed++; console.error('  ✗ ', msg) } }
const put = (t, k, v) => domain.table(t).put(k, v)
const nowIso = () => new Date().toISOString()

try {
  await apply(ctx, {})
  assert.ok(ctx.tools['memory__archive_vault'] && ctx.tools['memory__phase2_integrate'], 'tools registered')

  // 种子：一个已消费 output（点了 p2-committed）+ 一个 committed phase2 批次
  await seedOutput(domain, 'o-cons', { session_id: 's1', source_watermark: 'wm1', rollout_summary: 'A', selected_for_phase2: true, phase2_batch_id: 'p2-committed' })
  await put('phase2_jobs', 'p2-committed', {
    id: 'p2-committed', status: 'committed', input_ids: ['o-cons'], change_ids: [], lease_owner: '', lease_expires_at: '',
    attempt_count: 1, max_attempts: 3, available_at: '', staging_version: '', last_error: '', created_at: nowIso(), updated_at: nowIso(),
  })

  // 归档（dryRun=false）→ p2-committed 进 phase2_jobs_archive（非空）
  const r = await ctx.tools['memory__archive_vault'].execute({ dryRun: false })
  check(r.archived >= 2, '归档了 output+phase2（phase2_jobs_archive 非空）')
  check(domain.table('phase2_jobs_archive').size >= 1, 'phase2_jobs_archive 非空（旧代码会在此预扫 TypeError）')

  // 关键：归档后调用真实 phase2_integrate → 不得抛错、Phase2 仍可运行
  console.log('[P0-1] 归档 terminal phase2 后调用真实 phase2_integrate 不抛 TypeError')
  let err = null
  let res = null
  try { res = await ctx.tools['memory__phase2_integrate'].execute({}) } catch (e) { err = e }
  check(err === null, 'phase2_integrate 未抛错：' + (err ? err.message : 'OK'))
  check(!!res && res.ran === false && res.reason === 'no-change', 'phase2_integrate 返回 no-change（无未消费输入，不空转/不重复消费）')
  // 未解绑：被归档批次的 input（现已归档，不影响活跃表）；活跃表无孤儿可解绑
  check(domain.table('phase2_jobs').size === 0, '归档后无活跃 phase2 批（不新建重复批）')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL ARCHIVE-PHASE2-RECONCILE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
