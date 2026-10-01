// t247（本批 C6 · 契约 §C6）：**10 天年龄上限 → 分批回补**（不再永久跳过）。
//
// 契约落点（`lib/index.js`，SHA 见交付报告文首）：`ingestIdleScan` 相 1 把"超龄"从
//   `stats.tooOld` 的**永久跳过**改成收进回补池（`tooOldDiscovered`）；相 2 按**最老优先**、
//   用**剩余预算**（`perPassSourceBudget()`，默认 2）经**同一资格判定**（`mode:'backfill'`：只放松
//   年龄上界、**静置 6h 下限照旧**）+ **同一去重**（`scanSeen` + `<sid>::<watermark>`）纳入，
//   并把游标落进 `stage1_meta.meta.backfill = { lastScannedAt, cursor }`。
//
// ⚠️ 牙齿说明（队长口径 6）：本文件在**打补丁前的树**（`lib\index.js.pre-c4c6-2026-09-30`）
//   必红——那时超龄会话被 `if (idleFor > ageMs) { stats.tooOld += 1; continue }` **永久跳过**，
//   三趟下来 `tooOldQueued` 字段不存在、超龄会话一条都进不了 `stage1_jobs`。
//
// ⚠️ 牙齿说明（D1 · 2026-10-01）：`[t247d]` 的 **①** 在 **D1 修复前的树**（`lib/index.js` = `BF74E413…`）
//   上**必红**（那时"已处理、只是后来超龄"仍被计成 `tooOldDiscovered`），修后全绿；**②** 两树皆绿
//   （回归护栏：证明收窄没有砍掉真正的回补入队路径）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t247-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const section = async (label, fn) => {
  try { return await fn() } catch (err) {
    check(false, `${label} 中断（改前树上属预期的断言级红）：${err && err.message ? err.message : err}`)
  }
}

const NOW = Date.now()
const DAY = 86400000
const HOUR = 3600000
const snap = (id, idleDays) => ({
  header: { version: 4, isSeeded: false, id, cwd: 'C:/t247', createdAt: 0 },
  revision: '1:2:3:' + Math.round((NOW - idleDays * DAY) * 1e6) + ':4',
  sizeBytes: 128,
})
const msgEvent = (id, text) => ({
  type: 'user/message', seq: 0, time: 0, surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const readSession = async (id) => ({
  session: { version: 4, isSeeded: false, id, cwd: 'C:/t247', createdAt: 0 },
  events: [msgEvent(id, '会话 ' + id + ' 的正文：' + '细节'.repeat(40))],
})
const llmMock = {
  stream: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', text: JSON.stringify({ rollout_summary: 's', raw_memory: 'r', slug: 's', keywords: '', title: '' }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }),
}
/** 启动趟返回空清单，之后返回真清单（便于观察"手动扫描"读数）。 */
const boot = async (snapshots, cfg = {}) => {
  let calls = 0
  const persistence = {
    list: async () => { calls += 1; return calls === 1 ? [] : snapshots },
    locate: () => ({ path: 'Z:\\t247-not-exist\\log.jsonl' }),
  }
  const { ctx, domain, tools } = makeCtx({
    get: (k) => (k === 'sessionQuery' ? { readSession }
      : k === 'sessionPersistence' ? persistence
        : k === 'llm' ? llmMock
          : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
    tools: { register: (t) => { tools[t.name] = t } },
  })
  await apply(ctx, cfg)
  return { ctx, domain, tools }
}
const metaOf = (domain) => domain.table('stage1_meta').get('meta')
const jobsOf = (domain, id) => Object.keys(jobListOf(domain) || {}).filter((k) => k.startsWith(id + '::'))

// 三条**都超龄**（30 / 25 / 20 天 > 上限 10 天）；最老 = S1。
const S1 = 'c1111111-0000-4000-8000-000000000001'
const S2 = 'c2222222-0000-4000-8000-000000000002'
const S3 = 'c3333333-0000-4000-8000-000000000003'

await section('[t247] 超龄不再永久跳过：趟 1 只纳 2 条（最老优先）、趟 2 纳第 3 条', async () => {
  const { domain, tools } = await boot([snap(S3, 20), snap(S1, 30), snap(S2, 25)], {
    minRolloutIdleHours: 6, maxRolloutAgeDays: 10, maxSourcesPerStartup: 2,
  })
  const scan = tools['memory__ingest_scan']
  check(!!scan, '注册了 memory__ingest_scan')

  // ── 趟 1 ────────────────────────────────────────────────────────────────
  const r1 = await scan.execute({})
  check(r1.tooOldDiscovered === 3, `三条超龄都被**发现**（tooOldDiscovered=${r1.tooOldDiscovered}）`)
  check(r1.tooOldQueued === 2, `趟 1 只纳 2 条（tooOldQueued=${r1.tooOldQueued}；= perPassSourceBudget 默认 2）`)
  check(r1.enqueued === 2, `单趟新增 ≤ 预算（enqueued=${r1.enqueued}）`)
  check(jobsOf(domain, S1).length === 1 && jobsOf(domain, S2).length === 1 && jobsOf(domain, S3).length === 0,
    `**最老优先**：30 天与 25 天的入队、20 天的留到下一趟（S1=${jobsOf(domain, S1).length} S2=${jobsOf(domain, S2).length} S3=${jobsOf(domain, S3).length}）`)

  // ── 趟 2 ────────────────────────────────────────────────────────────────
  const r2 = await scan.execute({})
  check(r2.tooOldQueued === 1, `趟 2 纳第 3 条（tooOldQueued=${r2.tooOldQueued}）`)
  check(jobsOf(domain, S3).length === 1, `第 3 条（20 天）已入队（实测 ${jobsOf(domain, S3).length} 条）`)
  check(jobsOf(domain, S1).length === 1 && jobsOf(domain, S2).length === 1, '先入的两条不重复')

  // ── 趟 3：全部已处理 ⇒ 不重复入队 ────────────────────────────────────────
  const r3 = await scan.execute({})
  check(r3.tooOldQueued === 0 && r3.enqueued === 0, `再扫不重复入队（tooOldQueued=${r3.tooOldQueued} enqueued=${r3.enqueued}）`)
  check(jobsOf(domain, S1).length === 1 && jobsOf(domain, S2).length === 1 && jobsOf(domain, S3).length === 1,
    '三条各恰好 1 个 job 键（同一去重：scanSeen + <sid>::<watermark>）')
})

await section('[t247b] 回补游标与统计面落盘（可观测）', async () => {
  // 预算 1 ⇒ 趟 1 只纳最老 1 条，游标必须落在**被处理的那条**上（供审计"回补走到哪了"）。
  const { domain, tools } = await boot([snap(S1, 30), snap(S2, 25), snap(S3, 20)], {
    minRolloutIdleHours: 6, maxRolloutAgeDays: 10, maxSourcesPerStartup: 1,
  })
  const r = await tools['memory__ingest_scan'].execute({})
  const m = metaOf(domain)
  const bf = m && m.backfill
  check(!!bf && typeof bf === 'object', `backfill 游标已落进 stage1_meta（${JSON.stringify(bf)}）`)
  check(!!bf && typeof bf.lastScannedAt === 'string' && bf.lastScannedAt.length > 0, `backfill.lastScannedAt 是 ISO 串（${bf && bf.lastScannedAt}）`)
  check(!!bf && bf.cursor === S1, `游标指向本次纳入的那条（cursor=${bf && bf.cursor}；期望最老的 S1=${S1}）`)
  check(r.tooOldQueued === 1 && jobsOf(domain, S1).length === 1, `预算 1 ⇒ 趟 1 只纳最老 1 条（tooOldQueued=${r.tooOldQueued}）`)
  // 顺手收口①（评估 §六 · 2026-10-01）：`tooOldDeferred` / `notIdleDeferred` 是**结构性恒 0** 字段
  //   （其自增点在"已过资格门"的分支里），已按评估"删掉或改准含义"**删除** ⇒ 本断言随语义变更**翻转**
  //   （属评估授权的断言改动；改前树两者皆在且恒为 0）。
  check(!('tooOldDeferred' in r) && !('notIdleDeferred' in r),
    `★ 恒零字段已删（顺手收口①）：输出不再含 tooOldDeferred/notIdleDeferred（实测 ${('tooOldDeferred' in r)}/${('notIdleDeferred' in r)}；改前树两者存在 ⇒ 必红）`)
  check(r.noTimeSignal === 0 && typeof r.contentBodyReads === 'number',
    `顺手收口② + F2 新面可观测：noTimeSignal=${r.noTimeSignal} contentBodyReads=${r.contentBodyReads}`)
  const stats = m && m.scanLastStats
  check(!!stats && stats.tooOldDiscovered === 3, `scanLastStats 里"已发现"独立计数（tooOldDiscovered=${stats && stats.tooOldDiscovered}）`)
})

await section('[t247c] 静置下限在回补里**照旧强制**（只放松年龄上界）', async () => {
  // 一条"刚更新"（1h）的会话：**连回补都不该纳入**（它不是超龄类，而是 fresh 类）。
  const ID_FRESH = 'c4444444-0000-4000-8000-000000000004'
  const { domain, tools } = await boot([snap(ID_FRESH, 1 / 24)], {
    minRolloutIdleHours: 6, maxRolloutAgeDays: 10, maxSourcesPerStartup: 2,
  })
  const r = await tools['memory__ingest_scan'].execute({})
  check(r.fresh === 1 && r.tooOldDiscovered === 0, `刚更新的会话走 fresh、不进回补池（fresh=${r.fresh} tooOldDiscovered=${r.tooOldDiscovered}）`)
  check(jobsOf(domain, ID_FRESH).length === 0, `静置不足 ⇒ 一条都不入队（实测 ${jobsOf(domain, ID_FRESH).length}）`)
})

await section('[t247d] D1 收窄（2026-10-01）：完成水位先于"发现"计数', async () => {
  // ① 「已处理 + 超龄」：趟 1 纳入（queued:true 水位落盘）⇒ 趟 2 不得再被计成"发现"。
  {
    const ID_DONE = 'c5555555-0000-4000-8000-000000000005'
    const { domain, tools } = await boot([snap(ID_DONE, 30)], {
      minRolloutIdleHours: 6, maxRolloutAgeDays: 10, maxSourcesPerStartup: 2,
    })
    const scan = tools['memory__ingest_scan']
    const a1 = await scan.execute({})
    check(a1.tooOldDiscovered === 1 && a1.tooOldQueued === 1,
      `① 趟 1 未处理 ⇒ 发现并纳入（tooOldDiscovered=${a1.tooOldDiscovered} tooOldQueued=${a1.tooOldQueued}）`)
    const a2 = await scan.execute({})
    const bf2 = metaOf(domain).backfill
    check(a2.tooOldDiscovered === 0,
      `① 趟 2 已处理 ⇒ **不再计成"发现"**（tooOldDiscovered=${a2.tooOldDiscovered}；D1 修复前的树为 1）`)
    check(a2.done >= 1, `① 趟 2 它走"已处理"计数（done=${a2.done}）`)
    check(a2.tooOldQueued === 0 && a2.enqueued === 0, `① 趟 2 不重复入队（tooOldQueued=${a2.tooOldQueued} enqueued=${a2.enqueued}）`)
    check(jobsOf(domain, ID_DONE).length === 1, `① 只 1 个 job 键（实测 ${jobsOf(domain, ID_DONE).length}）`)
    check(!!bf2 && bf2.cursor === '',
      `① 池随"发现=0"为空 ⇒ 游标为空（cursor="${bf2 && bf2.cursor}"；口径＝本趟没走到尝试）`)
  }

  // ② 「未处理 + 超龄」：真正该回补的那类，必须照样被发现、纳入、写游标（收窄不得误伤）。
  {
    const ID_NEW = 'c6666666-0000-4000-8000-000000000006'
    const { domain, tools } = await boot([snap(ID_NEW, 30)], {
      minRolloutIdleHours: 6, maxRolloutAgeDays: 10, maxSourcesPerStartup: 1,
    })
    const b = await tools['memory__ingest_scan'].execute({})
    const bf = metaOf(domain).backfill
    check(b.tooOldDiscovered === 1, `② 未处理 + 超龄 ⇒ 仍然"发现"（tooOldDiscovered=${b.tooOldDiscovered}）`)
    check(b.tooOldQueued === 1, `② 仍然纳入（tooOldQueued=${b.tooOldQueued}）`)
    check(!!bf && bf.cursor === ID_NEW, `② 游标指向这条（cursor="${bf && bf.cursor}"；期望 ${ID_NEW}）`)
    check(jobsOf(domain, ID_NEW).length === 1, `② 已入队（实测 ${jobsOf(domain, ID_NEW).length}）`)
  }
})

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n${failed === 0 ? 'ALL T247 C6-BACKFILL TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
