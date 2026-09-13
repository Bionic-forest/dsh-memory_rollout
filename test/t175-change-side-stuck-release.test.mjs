// t175：**第三档卡死（变更侧）** —— `memory_changes.pending` × 绑 `failed_terminal` 批。
//
// 修前（老机制少覆盖一张表）：
//   · 不被领取：`claimNextPhase2Job` 的 change 收集 `if (ch.status !== 'pending' || ch.phase2_batch_id) continue`；
//   · 不被释放：t170/t172 的释放循环**只遍历 `stage1OutputsTable`**，没有 change 分支；
//   · 不触发唤醒：`immediatelyProcessableKind` 的 change 分支要求 pending **且无绑定**。
//   ⇒ 而 `unbindOrphan` 本来就是**双表通用**的 ⇒ 缺的正是"变更侧那次调用"。
//   变更**不参与** `PROMPT_MAX_INPUTS` 裁剪 ⇒ 一旦触发，单批可静默丢多条。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply, immediatelyProcessableKind } = await import(PLUGIN)

let failed = 0
const check = (c, m) => { if (c) console.log('  ✓ ', m); else { failed++; console.error('  ✗ ', m) } }

// ── ⑥ 纯函数：变更侧也要有 failed-bound 档 ──
console.log('\n[t175 ⑥] 纯函数：变更侧 failed-bound 档')
{
  const chBoundFailed = [['c1', { status: 'pending', phase2_batch_id: 'b-failed' }]]
  const chBoundLive = [['c1', { status: 'pending', phase2_batch_id: 'b-live' }]]
  const chFree = [['c1', { status: 'pending', phase2_batch_id: '' }]]
  const chConsumed = [['c1', { status: 'consumed', phase2_batch_id: '' }]]
  const chAbandoned = [['c1', { status: 'pending', phase2_batch_id: '', phase2_abandoned: true }]]
  const failedIds = new Set(['b-failed'])
  const K = (ch) => immediatelyProcessableKind([], ch, false, failedIds)
  check(K(chBoundFailed) === 'failed-bound', "pending × 绑 failed 批 ⇒ 'failed-bound'（t175 新增档）")
  check(K(chBoundLive) === '', "pending × 绑非失败批 ⇒ ''（不误唤醒）")
  check(K(chFree) === 'unbound', "pending × 无绑定 ⇒ 'unbound'（原语义不变）")
  check(K(chConsumed) === '', "consumed ⇒ ''（不误唤醒）")
  check(K(chAbandoned) === '', "已 abandoned ⇒ ''（不空转）")
}

function makeEnv() {
  const HOME = path.join(os.tmpdir(), 't175-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(path.join(HOME, 'memories'), { recursive: true })
  process.env.DSH_HOME = HOME
  let llmCalls = 0
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'llm'
      ? {
          stream: () => {
            llmCalls++
            const payload = JSON.stringify({ memory_summary: 'v1\n## 索引\n- 结论 T175 → memories/x.md', registry: '# MEMORY.md\n- 结论 T175' })
            return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
          },
        }
      : k === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined),
  })
  return { HOME, ctx, domain, llmCalls: () => llmCalls }
}

/** 塞一条 pending 变更（R5 统一变更流），可选绑到某批。 */
const seedChange = async (domain, id, opts = {}) => {
  const now = new Date().toISOString()
  await domain.table('memory_changes').put(id, {
    id, kind: opts.kind || 'note',
    payload: { content: 'T175 change content ' + id },
    source_ref: '', status: opts.status || 'pending',
    phase2_batch_id: opts.batchId || '', priority: 10,
    created_at: now, updated_at: now,
    ...(opts.extra || {}),
  })
}

/** 把批写进活跃表或归档表；可选把某条 change 绑上去。 */
const seedBatch = async (domain, id, status, opts = {}) => {
  const now = new Date().toISOString()
  const rec = {
    id, status, input_ids: [], change_ids: opts.changeIds || [],
    lease_owner: '', lease_token: '', lease_expires_at: '',
    attempt_count: status === 'failed_terminal' ? 3 : 0, max_attempts: 3,
    available_at: '', staging_version: '',
    last_error: status === 'failed_terminal' ? 'unredacted secret in registry' : '',
    created_at: now, updated_at: now,
  }
  if (opts.archived) await domain.table('phase2_jobs_archive').put(id, { ...rec, archived_at: now, archive_reason: 'phase2_terminal' })
  else await domain.table('phase2_jobs').put(id, rec)
}

const chg = (domain, id) => domain.table('memory_changes').get(id) || {}
const allBatches = (domain) => [...domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v }))

// ─────────── ① pending × 绑【活跃】failed 批 ⇒ 释放 + 可被领取 ───────────
console.log('\n[t175 ①] pending change × 绑活跃 failed_terminal 批 ⇒ 释放并可被领取')
{
  const env = makeEnv()
  await seedChange(env.domain, 'c-a1')
  await seedBatch(env.domain, 'b-act-failed', 'failed_terminal', { changeIds: ['c-a1'] })
  await env.domain.table('memory_changes').update('c-a1', (c) => ({ ...c, phase2_batch_id: 'b-act-failed' }))
  console.log('  修前（apply 之前）:', JSON.stringify({ st: chg(env.domain, 'c-a1').status, bnd: chg(env.domain, 'c-a1').phase2_batch_id, rel: chg(env.domain, 'c-a1').phase2_release_count ?? '(无字段)' }))
  await apply(env.ctx, {})

  const res = await env.ctx.tools['memory__phase2_integrate'].execute({})
  const c = chg(env.domain, 'c-a1')
  console.log('  修后:', JSON.stringify({ st: c.status, bnd: c.phase2_batch_id, rel: c.phase2_release_count, ab: c.phase2_abandoned }), 'integrate:', JSON.stringify({ ran: res.ran, ok: res.ok }))
  check(c.phase2_release_count === 1, `变更释放计数 +1（实测 ${c.phase2_release_count}）`)
  check(c.status === 'consumed', '**被重新领取并消费**（status=consumed）⇒ 变更侧卡死解除')
  check(!c.phase2_abandoned, '未达上界 ⇒ 不标 abandoned')
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

// ─────────── ①b pending × 绑【归档】failed 批 ⇒ 同样释放 ───────────
console.log('\n[t175 ①b] pending change × 绑**归档** failed_terminal 批 ⇒ 同样释放并可被领取')
{
  const env = makeEnv()
  await seedChange(env.domain, 'c-b1')
  await seedBatch(env.domain, 'b-arch-failed', 'failed_terminal', { changeIds: ['c-b1'], archived: true })
  await env.domain.table('memory_changes').update('c-b1', (c) => ({ ...c, phase2_batch_id: 'b-arch-failed' }))
  await apply(env.ctx, {})
  const res = await env.ctx.tools['memory__phase2_integrate'].execute({})
  const c = chg(env.domain, 'c-b1')
  console.log('  修后:', JSON.stringify({ st: c.status, bnd: c.phase2_batch_id, rel: c.phase2_release_count }), 'integrate:', JSON.stringify({ ran: res.ran, ok: res.ok }))
  check(c.phase2_release_count === 1, '归档批同样释放（双表口径对齐）')
  check(c.status === 'consumed', '被重新领取并消费')
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

// ─────────── ② 已 consumed 的 change 不误伤 ───────────
console.log('\n[t175 ②] 反例：已 consumed 的 change ⇒ **不误伤**')
{
  const env = makeEnv()
  await seedChange(env.domain, 'c-c1', { status: 'consumed' })
  await seedBatch(env.domain, 'b-act-failed2', 'failed_terminal', { changeIds: ['c-c1'] })
  await env.domain.table('memory_changes').update('c-c1', (c) => ({ ...c, phase2_batch_id: 'b-act-failed2' }))
  await apply(env.ctx, {})
  await env.ctx.tools['memory__phase2_integrate'].execute({})
  const c = chg(env.domain, 'c-c1')
  console.log('  修后:', JSON.stringify({ st: c.status, bnd: c.phase2_batch_id, rel: c.phase2_release_count ?? 0, ab: c.phase2_abandoned ?? false }))
  check(c.phase2_batch_id === 'b-act-failed2', 'consumed 变更的绑定**保持不动**')
  check(!c.phase2_release_count, '释放计数未被改动')
  check(!c.phase2_abandoned, '未被标 abandoned')
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

// ─────────── ③ 上界达 3 ⇒ abandoned、不再重试 ───────────
console.log('\n[t175 ③] 上界：release_count=3 ⇒ abandoned、不再重试（不振荡）')
{
  const env = makeEnv()
  await seedChange(env.domain, 'c-d1', { extra: { phase2_release_count: 3 } })
  await seedBatch(env.domain, 'b-arch-failed3', 'failed_terminal', { changeIds: ['c-d1'], archived: true })
  await env.domain.table('memory_changes').update('c-d1', (c) => ({ ...c, phase2_batch_id: 'b-arch-failed3' }))
  await apply(env.ctx, {})
  await env.ctx.tools['memory__phase2_integrate'].execute({})
  const c = chg(env.domain, 'c-d1')
  console.log('  修后:', JSON.stringify({ st: c.status, bnd: c.phase2_batch_id, rel: c.phase2_release_count, ab: c.phase2_abandoned, reason: c.phase2_abandoned_reason }))
  check(c.phase2_abandoned === true, '超限 ⇒ **显式登记** abandoned')
  check(String(c.phase2_abandoned_reason || '').includes('exhausted'), '带可读原因')
  check(c.phase2_batch_id === '' && c.status === 'pending', '绑定已清、仍未消费（不假装成功）')
  check(!allBatches(env.domain).some((b) => Array.isArray(b.change_ids) && b.change_ids.includes('c-d1')), '没有被任何新批选中 ⇒ 不振荡')
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

// ─────────── ④ 零工具调用端到端 ───────────
console.log('\n[t175 ④] 端到端：**一次工具都不调** ⇒ 仅靠启动唤醒自动解除')
{
  const env = makeEnv()
  await seedChange(env.domain, 'c-e1')
  await seedBatch(env.domain, 'b-arch-failed-e', 'failed_terminal', { changeIds: ['c-e1'], archived: true })
  await env.domain.table('memory_changes').update('c-e1', (c) => ({ ...c, phase2_batch_id: 'b-arch-failed-e' }))
  const before = { st: chg(env.domain, 'c-e1').status, calls: env.llmCalls() }
  await apply(env.ctx, {})
  const t0 = Date.now()
  while (Date.now() - t0 < 4000 && chg(env.domain, 'c-e1').status !== 'consumed') await new Promise((r) => setTimeout(r, 25))
  const c = chg(env.domain, 'c-e1')
  console.log(`  apply 前: ${JSON.stringify(before)}`)
  console.log(`  仅等定时器 ${Date.now() - t0}ms 后: ${JSON.stringify({ st: c.status, rel: c.phase2_release_count, calls: env.llmCalls() })}`)
  check(before.st === 'pending', '前提：apply 前是卡死状态（pending）')
  check(c.status === 'consumed', '**未调用任何工具**即被自动释放并消费 ⇒ 唤醒侧也覆盖了变更')
  check(env.llmCalls() >= 1, `确实跑了一次真实整合（llmCalls=${env.llmCalls()}）`)
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T175 CHANGE-SIDE-RELEASE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
