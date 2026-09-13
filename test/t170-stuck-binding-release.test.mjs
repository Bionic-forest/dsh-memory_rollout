// t170：**failed_terminal 批的绑定输入永不释放** —— 释放 + 有界 + 显式登记 的可复现验证。
//
// 缺陷链路（修前）：
//   ① 领取侧 `claimNextPhase2Job`：`if (o.phase2_batch_id) continue` ⇒ 绑定即永不再选；
//   ② 释放侧 `reconcilePhase2Bindings`：`orphan = !j && !archived` 只释放"批**不存在**"的绑定；
//      而 failed_terminal 批仍在表里 ⇒ **永不释放**（归档也不解决）⇒ 来源永久卡死且**无人登记**。
//
// 修法：`reconcilePhase2Bindings` 增加"批为 failed_terminal 且输出未消费 ⇒ 释放绑定"，
//      并用 `phase2_release_count` + `MAX_PHASE2_RELEASES` 给上界；达上界置
//      `phase2_abandoned=true`（显式登记、不再重选、不静默丢）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

let failed = 0
const check = (c, m) => { if (c) console.log('  ✓ ', m); else { failed++; console.error('  ✗ ', m) } }

function makeEnv() {
  const HOME = path.join(os.tmpdir(), 't170-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(path.join(HOME, 'memories'), { recursive: true })
  process.env.DSH_HOME = HOME
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'llm'
      ? {
          stream: () => {
            const payload = JSON.stringify({ memory_summary: 'v1\n## 索引\n- 结论 T170 → memories/x.md', registry: '# MEMORY.md\n- 结论 T170' })
            return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
          },
        }
      : k === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined),
  })
  return { HOME, ctx, domain }
}

const seedBatch = async (domain, id, status, inputIds) => {
  const now = new Date()
  await domain.table('phase2_jobs').put(id, {
    id, status, input_ids: inputIds, change_ids: [],
    lease_owner: '', lease_token: '', lease_expires_at: '',
    attempt_count: status === 'failed_terminal' ? 3 : 0, max_attempts: 3,
    available_at: new Date(now.getTime() - 1000).toISOString(),
    staging_version: '',
    last_error: status === 'failed_terminal' ? 'unredacted secret in registry' : '',
    created_at: now.toISOString(), updated_at: now.toISOString(),
  })
  for (const oid of inputIds) {
    await domain.table('stage1_outputs').update(oid, (o) => ({ ...o, phase2_batch_id: id }))
  }
}

const out = (domain, id) => domain.table('stage1_outputs').get(id) || {}
const allBatches = (domain) => [...domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v }))

// ─────────── ① failed_terminal 批 ⇒ 释放 ⇒ 下一轮可重选 ───────────
console.log('\n[t170 ①] 1 条 failed_terminal 批 + 绑定输出 ⇒ 修复后释放、可重选')
{
  const env = makeEnv()
  await seedOutput(env.domain, 't170-a1', { rollout_summary: 'T170 A', selected_for_phase2: false })
  await apply(env.ctx, {})
  await seedBatch(env.domain, 'p2-t170-failed', 'failed_terminal', ['t170-a1'])
  console.log('  修前状态:', JSON.stringify({ sel: out(env.domain, 't170-a1').selected_for_phase2, bnd: out(env.domain, 't170-a1').phase2_batch_id, rel: out(env.domain, 't170-a1').phase2_release_count }))

  const res = await env.ctx.tools['memory__phase2_integrate'].execute({})
  const o = out(env.domain, 't170-a1')
  console.log('  integrate:', JSON.stringify({ ran: res.ran, ok: res.ok, batchId: res.batchId }))
  console.log('  修后状态:', JSON.stringify({ sel: o.selected_for_phase2, bnd: o.phase2_batch_id, rel: o.phase2_release_count, ab: o.phase2_abandoned }))

  check(o.phase2_release_count === 1, `释放计数 +1（实测 ${o.phase2_release_count}）⇒ 走了新的释放路径`)
  check(o.selected_for_phase2 === true, '释放后**被重选并消费**（sel=true）⇒ 卡死解除')
  check(o.phase2_abandoned !== true, '未被误标 abandoned')
  const nb = allBatches(env.domain).find((b) => Array.isArray(b.input_ids) && b.input_ids.includes('t170-a1') && b.id !== 'p2-t170-failed')
  check(!!nb, `确实建了新批承接它（${nb && nb.id} / status=${nb && nb.status}）`)
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

// ─────────── ② 超限 ⇒ 显式登记、不再无限重试 ───────────
console.log('\n[t170 ②] 已达上界（release_count=3）⇒ 显式 abandoned、不再重选')
{
  const env = makeEnv()
  await seedOutput(env.domain, 't170-b1', { rollout_summary: 'T170 B', selected_for_phase2: false })
  await apply(env.ctx, {})
  await seedBatch(env.domain, 'p2-t170-failed2', 'failed_terminal', ['t170-b1'])
  await env.domain.table('stage1_outputs').update('t170-b1', (o) => ({ ...o, phase2_release_count: 3 }))

  const res = await env.ctx.tools['memory__phase2_integrate'].execute({})
  const o = out(env.domain, 't170-b1')
  console.log('  integrate:', JSON.stringify({ ran: res.ran, reason: res.reason, batchId: res.batchId }))
  console.log('  修后状态:', JSON.stringify({ sel: o.selected_for_phase2, bnd: o.phase2_batch_id, rel: o.phase2_release_count, ab: o.phase2_abandoned, reason: o.phase2_abandoned_reason }))

  check(o.phase2_abandoned === true, '超限 ⇒ **显式登记** phase2_abandoned=true')
  check(String(o.phase2_abandoned_reason || '').includes('exhausted'), `带可读原因（${o.phase2_abandoned_reason}）`)
  check(o.phase2_batch_id === '', '绑定已清（不留陈旧绑定）')
  check(o.selected_for_phase2 !== true, '**未被消费** ⇒ 不会假装成功')
  check(!allBatches(env.domain).some((b) => b.id !== 'p2-t170-failed2' && Array.isArray(b.input_ids) && b.input_ids.includes('t170-b1')), '**没有被任何新批选中** ⇒ 不无限重试')

  // 再跑一轮 + 等一会儿，确认不再被拾起、也不会造成立即唤醒空转
  const before = allBatches(env.domain).length
  await env.ctx.tools['memory__phase2_integrate'].execute({})
  await new Promise((r) => setTimeout(r, 300))
  const after = allBatches(env.domain).length
  check(after === before, `再跑一轮批数不变（${before} → ${after}）⇒ 无振荡`)
  check(out(env.domain, 't170-b1').phase2_abandoned === true, 'abandoned 标记稳定保留')
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

// ─────────── ③ 反例：committed 批的输入不释放 ───────────
console.log('\n[t170 ③] 反例：committed 批的绑定输出 ⇒ **不释放**')
{
  const env = makeEnv()
  await seedOutput(env.domain, 't170-c1', { rollout_summary: 'T170 C', selected_for_phase2: false })
  await apply(env.ctx, {})
  await seedBatch(env.domain, 'p2-t170-committed', 'committed', ['t170-c1'])

  const res = await env.ctx.tools['memory__phase2_integrate'].execute({})
  const o = out(env.domain, 't170-c1')
  console.log('  integrate:', JSON.stringify({ ran: res.ran, reason: res.reason }))
  console.log('  修后状态:', JSON.stringify({ sel: o.selected_for_phase2, bnd: o.phase2_batch_id, rel: o.phase2_release_count, ab: o.phase2_abandoned }))

  check(o.phase2_batch_id === 'p2-t170-committed', `committed 批的绑定**保持不动**（实测 ${o.phase2_batch_id}）`)
  check(!o.phase2_release_count, '释放计数未被改动')
  check(o.phase2_abandoned !== true, '未被标 abandoned')
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T170 STUCK-BINDING-RELEASE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
