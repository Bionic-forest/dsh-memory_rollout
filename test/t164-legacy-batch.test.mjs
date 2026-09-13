// t164（R1 §5.3）：**旧超限批兼容** —— 上限引入**之前**冻结的批可能 > PROMPT_MAX_INPUTS 条。
// 要求：升级期能检出；对 pending/retry_wait 走「截批（保留前 20、其余解绑留队）」；
//       **不得盲切 prepared/published**（按原有发布记录恢复，未见来源在提交侧放开重领）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply, PROMPT_MAX_INPUTS_CONST } = await import(PLUGIN).catch(() => ({}))
const mod = await import(PLUGIN)

let failed = 0
const check = (c, m) => { if (c) console.log('  ✓ ', m); else { failed++; console.error('  ✗ ', m) } }
const MAX = 20

function makeEnv(config = {}) {
  const HOME = path.join(os.tmpdir(), 't164-legacy-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(path.join(HOME, 'memories'), { recursive: true })
  process.env.DSH_HOME = HOME
  let llmCalls = 0
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'llm'
      ? {
          stream: () => {
            llmCalls++
            const payload = JSON.stringify({ memory_summary: 'v1\n## 索引\n- 结论 T164L → memories/x.md', registry: '# MEMORY.md\n- 结论 T164L' })
            return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
          },
        }
      : k === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined),
  })
  return { HOME, ctx, domain, llmCalls: () => llmCalls, memDir: path.join(HOME, 'memories') }
}

const seedLegacy = async (domain, status, ids, jobId) => {
  const now = new Date()
  const job = {
    id: jobId,
    status,
    input_ids: ids,
    change_ids: [],
    lease_owner: status === 'retry_wait' ? '' : 'boot-legacy',
    lease_token: status === 'retry_wait' ? '' : 'tok-legacy',
    lease_expires_at: status === 'retry_wait' ? '' : new Date(now.getTime() + 3600_000).toISOString(),
    attempt_count: 1,
    max_attempts: 3,
    available_at: new Date(now.getTime() - 1000).toISOString(),
    staging_version: '',
    last_error: status === 'retry_wait' ? 'legacy retry' : '',
    created_at: new Date(now.getTime() - 60_000).toISOString(),
    updated_at: now.toISOString(),
  }
  await domain.table('phase2_jobs').put(jobId, job)
  for (const oid of ids) {
    await domain.table('stage1_outputs').update(oid, (o) => ({ ...o, phase2_batch_id: jobId }))
  }
  return job
}

const consumedCount = (domain) => [...domain.table('stage1_outputs').entries()].filter(([, o]) => o && o.selected_for_phase2 === true).length
const boundCount = (domain, jobId) => [...domain.table('stage1_outputs').entries()].filter(([, o]) => o && o.phase2_batch_id === jobId).length

// ─────────── 场景 A：旧 retry_wait 批 = 21 条 ───────────
console.log('\n[t164 旧超限批] 场景 A：预置 **21 条旧 retry_wait 批**')
{
  const env = makeEnv()
  const ids = []
  for (let i = 1; i <= 21; i++) {
    const key = 't164L-a' + String(i).padStart(2, '0')
    await seedOutput(env.domain, key, { rollout_summary: `T164L-A-${i}`, selected_for_phase2: false })
    ids.push(key)
  }
  await apply(env.ctx, {})
  await seedLegacy(env.domain, 'retry_wait', ids, 'p2-legacy-retry')

  const res = await env.ctx.tools['memory__phase2_integrate'].execute({})
  const job = env.domain.table('phase2_jobs').get('p2-legacy-retry')
  const consumedNow = consumedCount(env.domain)
  console.log('  第一次整合:', JSON.stringify({ ran: res.ran, ok: res.ok, batchId: res.batchId }))
  console.log(`  旧批记录: input_ids=${job.input_ids.length} status=${job.status} legacy_split=${JSON.stringify(job.legacy_split || null)}`)
  console.log(`  已消费 = ${consumedNow}；仍绑在旧批 = ${boundCount(env.domain, 'p2-legacy-retry')}`)

  check(job.input_ids.length === MAX, `旧批被**截批**到 ≤ ${MAX} 条（实测 ${job.input_ids.length}）`)
  check(job.legacy_split && job.legacy_split.deferred === 1, `记录 legacy_split.deferred=1（实测 ${JSON.stringify(job.legacy_split || null)}）`)
  check(consumedNow <= MAX, `第一批只消费 ≤ ${MAX} 条（实测 ${consumedNow}）—— 没有「未见即消费」`)

  // 自动续跑把第 21 条处理掉
  const t0 = Date.now()
  while (Date.now() - t0 < 4000 && consumedCount(env.domain) < 21) await new Promise((r) => setTimeout(r, 25))
  const final = consumedCount(env.domain)
  console.log(`  自动续跑后已消费 = ${final}/21`)
  check(final === 21, `延后的那条最终被处理（21/21，实测 ${final}）—— 是「延后」不是「丢弃」`)
  check(job.status === 'committed', `旧批归终态 committed（实测 ${job.status}）`)
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

// ─────────── 场景 B：旧 published 批 = 21 条（不得盲切） ───────────
console.log('\n[t164 旧超限批] 场景 B：预置 **21 条旧 published 批**（不得盲切其 input_ids）')
{
  const env = makeEnv()
  const ids = []
  for (let i = 1; i <= 21; i++) {
    const key = 't164L-b' + String(i).padStart(2, '0')
    await seedOutput(env.domain, key, { rollout_summary: `T164L-B-${i}`, selected_for_phase2: false })
    ids.push(key)
  }
  await apply(env.ctx, {})
  await seedLegacy(env.domain, 'published', ids, 'p2-legacy-published')

  const before = env.domain.table('phase2_jobs').get('p2-legacy-published')
  const res = await env.ctx.tools['memory__phase2_integrate'].execute({})
  const job = env.domain.table('phase2_jobs').get('p2-legacy-published')
  const consumedNow = consumedCount(env.domain)
  const llmNow = env.llmCalls()
  console.log('  第一次整合:', JSON.stringify({ ran: res.ran, ok: res.ok, batchId: res.batchId }))
  console.log(`  published 批记录: input_ids 前=${before.input_ids.length} 后=${job.input_ids.length} status=${job.status} legacy_split=${JSON.stringify(job.legacy_split || null)}`)
  console.log(`  已消费 = ${consumedNow}；llmCalls = ${llmNow}（published 走"幂等补提交"，不重跑模型）`)

  check(job.input_ids.length === 21, `**未盲切** published 批的 input_ids（仍 ${job.input_ids.length} 条）`)
  check(!job.legacy_split, '未给 published 批打截批痕迹（legacy_split 为空）')
  check(consumedNow <= MAX, `补提交只消费 ≤ ${MAX} 条（实测 ${consumedNow}）—— 超出部分没被"未见即消费"`)
  check(llmNow === 0, `published 补提交没有重跑模型（llmCalls=${llmNow}）`)

  const t0 = Date.now()
  while (Date.now() - t0 < 4000 && consumedCount(env.domain) < 21) await new Promise((r) => setTimeout(r, 25))
  const final = consumedCount(env.domain)
  console.log(`  自动续跑后已消费 = ${final}/21，llmCalls = ${env.llmCalls()}`)
  check(final === 21, `无法确认的"未见来源"最终被重新处理（21/21，实测 ${final}）`)
  check(env.llmCalls() >= 1, `重领那条确实走了一次真实整合（llmCalls=${env.llmCalls()}）`)
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T164 LEGACY-BATCH TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
