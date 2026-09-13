// t172：**同族残余缺陷** —— 绑定到**已归档** `failed_terminal` 批的未消费输出也卡死。
//
// 修前（两条释放路径都跳过归档批）：
//   · `unbindOrphan`：`orphan = !j && !archived` ⇒ 批在归档表 ⇒ 不释放；
//   · `releaseFromFailedBatch`：**只查活跃表** ⇒ 批已归档 ⇒ `!j` ⇒ 直接 return。
//   ⇒ 归档失败批的未消费来源**静默死角**（重启也不解除：唤醒计划只看"无绑定的残余"，而它们有绑定）。
//
// 修后：① 释放判据同时查**活跃表 + 归档表**；② 唤醒计划把"绑在 failed_terminal 批上"也算立即可处理
//      ⇒ 即使没有任何其它调度事件，也会**自动**跑一轮 reconcile 把它们放出来。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply, immediatelyProcessableKind, hasImmediatelyProcessableWork } = await import(PLUGIN)

let failed = 0
const check = (c, m) => { if (c) console.log('  ✓ ', m); else { failed++; console.error('  ✗ ', m) } }

// ── ⑥ 先测纯函数（唤醒侧判据）──
console.log('\n[t172 ⑥] 纯函数：failed-bound 也算"立即可处理"')
{
  const outs = [['o1', { selected_for_phase2: false, phase2_batch_id: 'b-arch-failed' }]]
  const outsPlain = [['o1', { selected_for_phase2: false, phase2_batch_id: 'b-live-running' }]]
  const outsFree = [['o1', { selected_for_phase2: false, phase2_batch_id: '' }]]
  const outsAb = [['o1', { selected_for_phase2: false, phase2_batch_id: '', phase2_abandoned: true }]]
  const failedIds = new Set(['b-arch-failed'])
  check(immediatelyProcessableKind(outs, [], false, failedIds) === 'failed-bound', "绑在 failed_terminal 批上 ⇒ 'failed-bound'")
  check(hasImmediatelyProcessableWork(outs, [], false, failedIds) === true, '对应的布尔版返回 true')
  check(immediatelyProcessableKind(outsPlain, [], false, failedIds) === '', "绑在非失败批上 ⇒ '' （不算可处理，避免误唤醒）")
  check(immediatelyProcessableKind(outsFree, [], false, failedIds) === 'unbound', "无绑定 ⇒ 'unbound'（t164 原语义不变）")
  check(immediatelyProcessableKind(outsAb, [], false, failedIds) === '', "已 abandoned ⇒ ''（t170 语义不变）")
  check(immediatelyProcessableKind(outs, [], true, failedIds) === '', '有活跃批 ⇒ 不立即唤醒（t164 语义不变）')
}

function makeEnv() {
  const HOME = path.join(os.tmpdir(), 't172-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(path.join(HOME, 'memories'), { recursive: true })
  process.env.DSH_HOME = HOME
  let llmCalls = 0
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'llm'
      ? {
          stream: () => {
            llmCalls++
            const payload = JSON.stringify({ memory_summary: 'v1\n## 索引\n- 结论 T172 → memories/x.md', registry: '# MEMORY.md\n- 结论 T172' })
            return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
          },
        }
      : k === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined),
  })
  return { HOME, ctx, domain, llmCalls: () => llmCalls }
}

/** 把批写进**归档表**（phase2_jobs_archive），并把输出绑上去。 */
const seedArchivedBatch = async (domain, id, status, inputIds) => {
  const now = new Date()
  await domain.table('phase2_jobs_archive').put(id, {
    id, status, input_ids: inputIds, change_ids: [],
    lease_owner: '', lease_token: '', lease_expires_at: '',
    attempt_count: status === 'failed_terminal' ? 3 : 0, max_attempts: 3,
    available_at: '', staging_version: '',
    last_error: status === 'failed_terminal' ? 'unredacted secret in registry' : '',
    created_at: now.toISOString(), updated_at: now.toISOString(),
    archived_at: now.toISOString(), archive_reason: 'phase2_terminal',
  })
  for (const oid of inputIds) {
    await domain.table('stage1_outputs').update(oid, (o) => ({ ...o, phase2_batch_id: id }))
  }
}

const out = (domain, id) => domain.table('stage1_outputs').get(id) || {}
const allBatches = (domain) => [...domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v }))

const captureWarn = async (fn) => {
  const warns = []
  const old = console.warn
  console.warn = (...a) => { warns.push(a.map(String).join(' ')) }
  try { return { val: await fn(), warns } } finally { console.warn = old }
}

// ─────────── ① 归档 failed_terminal ⇒ 必须释放并重选 ───────────
console.log('\n[t172 ①] 归档的 failed_terminal 批 + 未消费输出 ⇒ 释放、可重选、消费（t170 未覆盖的那档）')
{
  const env = makeEnv()
  await seedOutput(env.domain, 't172-a1', { rollout_summary: 'T172 A', selected_for_phase2: false })
  await apply(env.ctx, {})
  await seedArchivedBatch(env.domain, 'b-arch-failed', 'failed_terminal', ['t172-a1'])
  console.log('  修前:', JSON.stringify({ sel: out(env.domain, 't172-a1').selected_for_phase2, bnd: out(env.domain, 't172-a1').phase2_batch_id, rel: out(env.domain, 't172-a1').phase2_release_count }))

  const { val: res, warns } = await captureWarn(() => env.ctx.tools['memory__phase2_integrate'].execute({}))
  const o = out(env.domain, 't172-a1')
  console.log('  修后:', JSON.stringify({ sel: o.selected_for_phase2, bnd: o.phase2_batch_id, rel: o.phase2_release_count, ab: o.phase2_abandoned }))
  const w = warns.find((x) => x.includes('reconcile: released')) || ''
  console.log('  告警:', w.slice(0, 150))

  check(o.phase2_release_count === 1, `释放计数 +1（实测 ${o.phase2_release_count}）⇒ **归档批不再被跳过**`)
  check(o.selected_for_phase2 === true, '被重新入队并消费 ⇒ 卡死解除')
  check(!o.phase2_abandoned, '未达上界 ⇒ 不标 abandoned')
  // t177：**与文案解耦**的「归档来源被点名」断言。
  // 原版写死 `/archived:\s*1\s*input\(s\)/i` ⇒ 任何一次告警文案调整都会误报（t175 改文案时就误报过一次）。
  // 现在不匹配固定句式，只做两件事：
  //   ① 告警里出现 `archiv*` 这个词（= 点名了归档来源）；
  //   ② 该词**附近窗口**内的整数集合必须包含「归档侧释放条数」的期望值。
  // 已容纳的三套文案：t170（**无** archiv 词 ⇒ 本断言失败，正确）、t172（`N of them from ARCHIVED batches`）、
  // t175（`archived: N input(s) + M change(s)`）。⇒ 任何"不提归档"的文案都会被判失败 ⇒ **牙齿保住，没有放宽成"有告警就行"**。
  const EXPECTED_ARCHIVED_INPUTS = 1 // 本场景恰好 1 条未消费输出绑在**归档** failed_terminal 批上
  const archWindows = [...w.matchAll(/archiv\w*/gi)].map((m) => w.slice(Math.max(0, m.index - 40), m.index + 60))
  const archNumbers = new Set(archWindows.flatMap((s) => [...s.matchAll(/\d+/g)].map((mm) => Number(mm[0]))))
  check(archWindows.length > 0, '告警**点名了归档来源**（出现 `archiv*`，不依赖任何固定句式）')
  check(
    archNumbers.has(EXPECTED_ARCHIVED_INPUTS),
    `告警在归档来源处给出了条数 ${EXPECTED_ARCHIVED_INPUTS}（文案无关提取；实测候选 {${[...archNumbers].join(',')}}）`,
  )
  check(res && res.ok === true, `整合成功（ok=${res && res.ok}）`)
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

// ─────────── ② 归档 failed_terminal + 已达上界 ⇒ 显式 abandoned ───────────
console.log('\n[t172 ②] 归档 failed_terminal + release_count=3 ⇒ 显式 abandoned、不再重试')
{
  const env = makeEnv()
  await seedOutput(env.domain, 't172-b1', { rollout_summary: 'T172 B', selected_for_phase2: false })
  await apply(env.ctx, {})
  await seedArchivedBatch(env.domain, 'b-arch-failed2', 'failed_terminal', ['t172-b1'])
  await env.domain.table('stage1_outputs').update('t172-b1', (o) => ({ ...o, phase2_release_count: 3 }))

  const { warns } = await captureWarn(() => env.ctx.tools['memory__phase2_integrate'].execute({}))
  const o = out(env.domain, 't172-b1')
  console.log('  修后:', JSON.stringify({ sel: o.selected_for_phase2, bnd: o.phase2_batch_id, rel: o.phase2_release_count, ab: o.phase2_abandoned, reason: o.phase2_abandoned_reason }))
  check(o.phase2_abandoned === true, '超限 ⇒ 显式登记 abandoned（归档批同样走上界）')
  check(String(o.phase2_abandoned_reason || '').includes('exhausted'), '带可读原因')
  check(o.phase2_batch_id === '' && o.selected_for_phase2 !== true, '绑定已清、未被消费（不假装成功）')
  check(!allBatches(env.domain).some((b) => Array.isArray(b.input_ids) && b.input_ids.includes('t172-b1')), '没有被任何新批选中 ⇒ 不振荡')
  check(warns.some((x) => x.includes('abandoned after 3 releases')), '告警可见')
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

// ─────────── ③④ 反例：归档的 committed / published 批 ⇒ 不释放 ───────────
console.log('\n[t172 ③④] 反例：归档的 committed / published 批 ⇒ **不释放**')
{
  for (const [status, id, tag] of [['committed', 't172-c1', 'committed'], ['published', 't172-d1', 'published']]) {
    const env = makeEnv()
    await seedOutput(env.domain, id, { rollout_summary: 'T172 ' + tag, selected_for_phase2: false })
    await apply(env.ctx, {})
    await seedArchivedBatch(env.domain, 'b-arch-' + tag, status, [id])
    await env.ctx.tools['memory__phase2_integrate'].execute({})
    const o = out(env.domain, id)
    console.log(`  [${tag}]`, JSON.stringify({ bnd: o.phase2_batch_id, rel: o.phase2_release_count ?? 0, ab: o.phase2_abandoned ?? false }))
    check(o.phase2_batch_id === 'b-arch-' + tag, `归档 ${tag} 批的绑定**保持不动**`)
    check(!o.phase2_release_count, `${tag}：释放计数未被改动`)
    check(!o.phase2_abandoned, `${tag}：未被标 abandoned`)
    try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
  }
}

// ─────────── ⑤ 最强证据：**一次工具都不调**，只靠定时器自动解除 ───────────
console.log('\n[t172 ⑤] 端到端：seed 归档 failed 批 ⇒ **不调任何工具** ⇒ 靠启动唤醒自动跑完（"重启也不解除"必须被真正解决）')
{
  const env = makeEnv()
  await seedOutput(env.domain, 't172-e1', { rollout_summary: 'T172 E', selected_for_phase2: false })
  await env.domain.table('stage1_outputs').update('t172-e1', (o) => ({ ...o, phase2_batch_id: 'b-arch-failed-e' }))
  await env.domain.table('phase2_jobs_archive').put('b-arch-failed-e', {
    id: 'b-arch-failed-e', status: 'failed_terminal', input_ids: ['t172-e1'], change_ids: [],
    lease_owner: '', lease_token: '', lease_expires_at: '', attempt_count: 3, max_attempts: 3,
    available_at: '', staging_version: '', last_error: 'unredacted secret in registry',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    archived_at: new Date().toISOString(), archive_reason: 'phase2_terminal',
  })
  const before = { sel: out(env.domain, 't172-e1').selected_for_phase2, calls: env.llmCalls() }
  await apply(env.ctx, {})   // 启动即武装唤醒（不调任何工具）
  const t0 = Date.now()
  while (Date.now() - t0 < 4000 && out(env.domain, 't172-e1').selected_for_phase2 !== true) await new Promise((r) => setTimeout(r, 25))
  const o = out(env.domain, 't172-e1')
  console.log(`  apply 前: ${JSON.stringify(before)}`)
  console.log(`  仅等定时器 ${Date.now() - t0}ms 后: ${JSON.stringify({ sel: o.selected_for_phase2, rel: o.phase2_release_count, calls: env.llmCalls() })}`)

  check(before.sel === false, '前提：apply 前是卡死状态（sel=false）')
  check(o.selected_for_phase2 === true, '**未调用任何工具**即被自动释放并消费 ⇒ 唤醒侧也修好了')
  check(env.llmCalls() >= 1, `确实跑了一次真实整合（llmCalls=${env.llmCalls()}）`)
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T172 ARCHIVED-FAILED-RELEASE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
