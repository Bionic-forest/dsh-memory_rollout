// t240（T29 · D2）：**删除后只登记"未提炼"碑** —— 不读已删语料、不抢救、不拦删除、不催办，且不依赖 archive-flow。
//
// 两条路径都盯：
//   ① 摄取时发现源已不在（`sessionQuery` 读失败 ⇒ `sourceStatus='unavailable'`）⇒ 记碑，**不入队**、
//      且**只读一次**（零抢救：不重读、不重试读）；
//   ② drain 阶段发现源已不在 ⇒ 记碑（`source-unavailable-at-drain`），作业照既有机制退避重试/终态。
//
// 碑落在**既有** `stage1_meta.meta.unrefined`（不新增表/schema）：{sessionId, firstSeenAt, detectedAt,
// reason, wasEnqueued, attempts}。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, metaOf, jobListOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t240-' + Math.random().toString(36).slice(2, 8))
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
const ID_GONE = '99999999-0000-4000-8000-000000000009'
const ID_JOB = 'aaaaaaaa-0000-4000-8000-00000000000a'
const snap = (id) => ({
  header: { version: 0, id, cwd: 'C:/t240', createdAt: 0 },
  revision: `1:2:3:${Math.round((NOW - 12 * 3600000) * 1e6)}:4`,
  sizeBytes: 128,
})

/** 读源直接抛错（= 语料已不在/损坏）⇒ sessionMessagesByPersistence 返回 unavailable。 */
const makeGoneCtx = async ({ snapshots = [], seedJobFor = '' } = {}) => {
  let reads = 0
  const readSession = async () => { reads++; throw new Error('session log is gone') }
  // 启动趟会先扫一遍；让**第一次** list 返回空，使"扫描/记碑"由测试显式触发、计数可观察。
  let calls = 0
  const persistence = {
    list: async () => { calls += 1; return calls === 1 ? [] : snapshots },
    locate: () => ({ path: 'Z:\\t240-not-exist\\log.jsonl' }),
  }
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'sessionQuery' ? { readSession }
      : k === 'sessionPersistence' ? persistence
        : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  })
  await apply(ctx, { minRolloutIdleHours: 6, maxRolloutAgeDays: 10 })
  if (seedJobFor) await seedJob(domain, seedJobFor, 'wm-t240')
  return { ctx, domain, tools: ctx.tools, reads: () => reads }
}

await section('[t240] 摄取时源已不在 ⇒ 记碑、不入队、零抢救', async () => {
  const { domain, tools, reads } = await makeGoneCtx({ snapshots: [snap(ID_GONE)] })
  const scan = tools['memory__ingest_scan']
  check(!!scan, '注册了 memory__ingest_scan（A 的把手）')
  const r = await scan.execute({})
  check(r.sourceGone === 1 && r.enqueued === 0, `扫描：源已不在 1 条、入队 0（sourceGone=${r.sourceGone} enqueued=${r.enqueued}）`)
  const m = metaOf(domain)
  const tomb = m && m.unrefined ? m.unrefined[ID_GONE] : null
  check(!!tomb, '写下了 unrefined 碑（stage1_meta.meta.unrefined）')
  check(!!tomb && tomb.reason === 'source-unavailable-at-ingest', `碑的理由如实（reason=${tomb && tomb.reason}）`)
  check(!!tomb && tomb.wasEnqueued === false, '碑记明"未入队过"（wasEnqueued=false）')
  check(Object.keys(jobListOf(domain)).length === 0, '**没有**为此建任何 stage-1 作业（不抢救、不入队）')
  check(reads() === 1, `读源只发生 1 次（实测 ${reads()}；零抢救 = 不重读）`)
})

await section('[t240b] drain 时源已不在 ⇒ 记碑（作业照既有机制）', async () => {
  const { domain, tools, reads } = await makeGoneCtx({ seedJobFor: ID_JOB })
  const drain = tools['memory__stage1_drain']
  const r = await drain.execute({})
  check(r.processed >= 1, `drain 处理了作业（processed=${r.processed}）`)
  const job = jobListOf(domain)[ID_JOB + '::wm-t240']
  check(!!job && job.status === 'failed_retryable', `作业按既有机制退避重试（status=${job && job.status}）`)
  const m = metaOf(domain)
  const tomb = m && m.unrefined ? m.unrefined[ID_JOB] : null
  check(!!tomb && tomb.reason === 'source-unavailable-at-drain', `写下了 drain 侧碑（reason=${tomb && tomb.reason}）`)
  check(!!tomb && tomb.wasEnqueued === true, '碑记明"曾入队过"（wasEnqueued=true）')
  check(reads() === 1, `本条路径读源 1 次（实测 ${reads()}）`)
})

console.log(`\n${failed === 0 ? 'ALL T240 UNREFINED-TOMBSTONE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
