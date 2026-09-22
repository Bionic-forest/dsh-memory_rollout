// t237（T29 · A 静置扫描）：**统一摄入口的自动入口** —— 官方 sessionPersistence + 根会话 + 静置/年龄窗口
// + 每趟有界 + 不重复入队。
//
// 对齐 codex（`_ref-codex` 的 `memories/README.md` L29-51 与 `state/src/runtime/memories.rs` L159-172/L243-252）：
//   摄取只按"根会话 + 时间/空闲窗口 + 启动扫"选取，**与会话是否销毁无关**；本插件此前只挂 `session/disposed`
//   ⇒ 归档/漏事件的会话永远不进队列。T29 把入口改成"统一摄入口 + 三个触发面"，本测试盯 **A 面**。
//
// 现测口径：
//   · 静置时间取"会话日志最后写入"：首选官方 `locate(header).path` + `fs.stat`；测试里让 `locate`
//     指向不存在的路径 ⇒ 走 `revision` 的 mtimeNs 段（官方 `fileRevision` 形状 dev:ino:size:mtimeNs:ctimeNs）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t237-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
/** 改前树上"缺新面"时给**断言级红**，不要 TypeError 崩掉整份文件。 */
const section = async (label, fn) => {
  try { return await fn() } catch (err) {
    check(false, `${label} 中断（改前树上属预期的断言级红）：${err && err.message ? err.message : err}`)
  }
}

const NOW = Date.now()
const HOUR = 3600000
const snap = (id, idleHours, opts = {}) => ({
  header: { version: 0, id, cwd: 'C:/t237', createdAt: 0, ...(opts.header || {}) },
  revision: `1:2:3:${Math.round((NOW - idleHours * HOUR) * 1e6)}:4`,   // 第 4 段 = mtimeNs
  sizeBytes: 128,
})
const msgEvent = (id, text) => ({
  type: 'user/message', seq: 0, time: 0, surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const readSession = async (id) => ({
  session: { version: 0, id, cwd: 'C:/t237', createdAt: 0 },
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
const boot = async (snapshots, cfg = {}) => {
  // 启动趟本身也会扫一遍（A 入口在 boot 就生效）——为了在本测试里观察"手动扫描"的计数，
  // 让**第一次** list（= 启动趟）返回空，之后的调用返回真清单。
  let calls = 0
  const persistence = {
    list: async () => { calls += 1; return calls === 1 ? [] : snapshots },
    locate: () => ({ path: 'Z:\\t237-not-exist\\log.jsonl' }),
  }
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'sessionQuery' ? { readSession }
      : k === 'sessionPersistence' ? persistence
        : k === 'llm' ? llmMock
          : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  })
  await apply(ctx, cfg)
  return { ctx, domain, tools: ctx.tools }
}

const ID_ROOT = '11111111-0000-4000-8000-000000000001'
const ID_FRESH = '22222222-0000-4000-8000-000000000002'
const ID_OLD = '33333333-0000-4000-8000-000000000003'
const ID_CHILD = '44444444-0000-4000-8000-000000000004'

await section('[t237] 静置扫描：根会话 + 窗口 + 有界 + 不重复', async () => {
  const { domain, tools } = await boot([
    snap(ID_ROOT, 12),                                        // 根 + 静置 12h（窗口 6h）⇒ 候选
    snap(ID_FRESH, 1),                                        // 根但只静置 1h ⇒ fresh
    snap(ID_OLD, 24 * 20),                                    // 根但静置 20 天（年龄窗 10 天）⇒ tooOld
    snap(ID_CHILD, 12, { header: { parentSession: 'p', origin: 'subagent' } }), // 非根 ⇒ 跳过
  ], { minRolloutIdleHours: 6, maxRolloutAgeDays: 10 })

  const scanTool = tools['memory__ingest_scan']
  check(!!scanTool, '注册了 memory__ingest_scan（A 的把手）')
  const r = await scanTool.execute({})
  check(r.ran === true, `扫描跑过（ran=${r.ran} reason=${r.reason}）`)
  check(r.candidates === 1 && r.enqueued === 1, `只入队 1 个候选（candidates=${r.candidates} enqueued=${r.enqueued}）`)
  check(r.fresh === 1 && r.tooOld === 1 && r.nonRoot === 1, `分类计数正确（fresh=${r.fresh} tooOld=${r.tooOld} nonRoot=${r.nonRoot}）`)

  const jobs = jobListOf(domain)
  const rootKeys = Object.keys(jobs).filter((k) => k.startsWith(ID_ROOT))
  check(rootKeys.length === 1, `stage1_jobs 里该会话恰好 1 条（实测 ${rootKeys.length}）`)
  check(!Object.keys(jobs).some((k) => k.startsWith(ID_FRESH) || k.startsWith(ID_OLD) || k.startsWith(ID_CHILD)),
    '未静置 / 超龄 / 非根 的会话都没有入队')

  const r2 = await scanTool.execute({})
  check(r2.enqueued === 0 && r2.done >= 1, `再扫不重复入队（enqueued=${r2.enqueued} done=${r2.done}）`)
  check(Object.keys(jobListOf(domain)).filter((k) => k.startsWith(ID_ROOT)).length === 1,
    '同（或更旧）活动只留一个 job 键（去重靠既有 <sid>::<watermark>）')
})

await section('[t237b] 窗口可配 + 每趟有界', async () => {
  // (a) 把静置窗口调到 24h ⇒ 同一条"静置 12h"的会话变成 fresh、不入队
  {
    const { tools } = await boot([snap(ID_ROOT, 12)], { minRolloutIdleHours: 24, maxRolloutAgeDays: 10 })
    const r = await tools['memory__ingest_scan'].execute({})
    check(r.enqueued === 0 && r.fresh === 1, `minRolloutIdleHours=24 ⇒ 静置 12h 不入队（enqueued=${r.enqueued} fresh=${r.fresh}）`)
  }
  // (b) 每趟有界：两个候选 + maxSourcesPerStartup=1 ⇒ 只入队 1
  {
    const ID_A = '55555555-0000-4000-8000-000000000005'
    const ID_B = '66666666-0000-4000-8000-000000000006'
    const { tools } = await boot([snap(ID_A, 12), snap(ID_B, 13)], { minRolloutIdleHours: 6, maxRolloutAgeDays: 10, maxSourcesPerStartup: 1 })
    const r = await tools['memory__ingest_scan'].execute({})
    check(r.enqueued === 1, `maxSourcesPerStartup=1 ⇒ 本趟只入队 1（实测 ${r.enqueued}）`)
  }
})

console.log(`\n${failed === 0 ? 'ALL T237 IDLE-INGEST-SCAN TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
