// t238（T29 · B 显式入口 + 三入口一致性）：`memory_ingest_session` 与 A/C **共用同一摄入口**。
//
// 断言：
//   ① 工具注册；入队走既有键 `<sid>::<contentWatermark>`；
//   ② **一致性**：同一会话内容经 A（静置扫描）与 B（显式点名）**只产生一个 job 键**、一条作业；
//   ③ `awaitDraft:true` ⇒ 等到**本次来源水位**的 stage-1 草稿落盘且证据可读才返回 `ingested:true`
//      （t241 / 评审 R1 收紧："已提炼"必须绑定**本次**水位，历史草稿不算）；
//   ④ 等不到（内容过短 ⇒ `succeeded_no_output`）⇒ `ingested:false` + 理由**逐字指出 stage-1 终态**
//      （**不做任何删除动作**）；
//   ⑤ 去重：显式点名一个已提炼过的内容 ⇒ `queued:false` / `already-ingested`，不新增作业。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t238-' + Math.random().toString(36).slice(2, 8))
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
const ID = '77777777-0000-4000-8000-000000000007'
const ID_SHORT = '88888888-0000-4000-8000-000000000008'
const snap = (id, idleHours) => ({
  header: { version: 4, isSeeded: false, id, cwd: 'C:/t238', createdAt: 0 },
  revision: `1:2:3:${Math.round((NOW - idleHours * 3600000) * 1e6)}:4`,
  sizeBytes: 128,
})
const LONG = '用户定了规矩：删除一律走回收站。' + '细节'.repeat(30)      // ≥60 字符 ⇒ 会调模型、能落草稿
const SHORT = '太短'                                                     // <60 字符 ⇒ no_output，不落草稿
const msgEvent = (id, text) => ({
  type: 'user/message', seq: 0, time: 0, surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const readSession = async (id) => ({
  session: { version: 4, isSeeded: false, id, cwd: 'C:/t238', createdAt: 0 },
  events: [msgEvent(id, id === ID_SHORT ? SHORT : LONG)],
})
const llmMock = {
  stream: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', text: JSON.stringify({ rollout_summary: '结论', raw_memory: '原文', slug: 's', keywords: '', title: 't' }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }),
}
const boot = async () => {
  // 启动趟会先扫一遍；让**第一次** list 返回空，保持"手动 A 面"可观察（入队计数/键由测试自己触发）。
  let calls = 0
  const persistence = {
    list: async () => { calls += 1; return calls === 1 ? [] : [snap(ID, 12)] },
    locate: () => ({ path: 'Z:\\t238-not-exist\\log.jsonl' }),
  }
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'sessionQuery' ? { readSession }
      : k === 'sessionPersistence' ? persistence
        : k === 'llm' ? llmMock
          : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  })
  await apply(ctx, { minRolloutIdleHours: 6, maxRolloutAgeDays: 10 })
  return { domain, tools: ctx.tools }
}

await section('[t238] B 显式入口 + 与 A 的一致性', async () => {
  const { domain, tools } = await boot()
  const ingest = tools['memory_ingest_session']
  check(!!ingest, '注册了 memory_ingest_session（B 入口）')

  // A 面先入队
  const scan = await tools['memory__ingest_scan'].execute({})
  check(scan.enqueued === 1, `A（静置扫描）先入队 1 条（实测 ${scan.enqueued}）`)
  const keysAfterA = Object.keys(jobListOf(domain)).filter((k) => k.startsWith(ID))

  // B 面点名同一会话的同一内容 ⇒ 不产生第二个键/第二条作业
  const r = await ingest.execute({ sessionId: ID })
  check(r.queued === false && r.reason === 'already-ingested', `B 对同内容不再入队（queued=${r.queued} reason=${r.reason}）`)
  const keysAfterB = Object.keys(jobListOf(domain)).filter((k) => k.startsWith(ID))
  check(keysAfterA.length === 1 && keysAfterB.length === 1 && keysAfterA[0] === keysAfterB[0],
    `A 与 B 共用同一键（${keysAfterA[0]}）⇒ 同一套入队/去重`)

  // awaitDraft：等**本次水位**的草稿 + 可读证据
  const r2 = await ingest.execute({ sessionId: ID, awaitDraft: true, timeoutMs: 15000 })
  const draft = path.join(HOME, 'memories', 'rollout_summaries', ID + '.md')
  check(fs.existsSync(draft), `stage-1 草稿已落盘（${draft}）`)
  check(r2.ingested === true && r2.draftFile === draft, `"已提炼本次内容"判定成立（ingested=${r2.ingested}）`)
  check(r2.key === keysAfterA[0], `返回值里带**本次水位**的 job 键（key=${r2.key}）⇒ 判据可绑定到来源版本`)
})

await section('[t238b] 等不到 ⇒ ingested:false（不删、不抢救）', async () => {
  const { tools } = await boot()
  const r = await tools['memory_ingest_session'].execute({ sessionId: ID_SHORT, awaitDraft: true, timeoutMs: 1500 })
  check(r.ingested === false, `内容过短 ⇒ 等不到草稿（ingested=${r.ingested}）`)
  // t241 收紧：不再接受笼统的 `timeout`，理由必须**逐字指出** stage-1 的终态（这里 = no_output）。
  check(/^stage1-job-succeeded_no_output$/.test(r.reason), `理由逐字指出 stage-1 终态（reason=${r.reason}）`)
  const draft = path.join(HOME, 'memories', 'rollout_summaries', ID_SHORT + '.md')
  check(!fs.existsSync(draft), '没有草稿 ⇒ "未提炼"（因此调用方不得删除）')
})

console.log(`\n${failed === 0 ? 'ALL T238 INGEST-SESSION TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
