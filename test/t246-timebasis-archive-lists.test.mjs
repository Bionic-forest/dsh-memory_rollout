// t246（定稿 §二 时间口径 / §五 验收组 1+2+3 的夹具层）：**时间基准与归档列表层级**。
//
// 目的（只读验证，不改实现）：把"资格到底由什么驱动"钉成可复跑断言。
//   现状实现（lib/index.js L3259-3272 `sessionSourceMtimeMs`）：
//     首选 `sessionPersistence.locate(header).path` + `fs.stat().mtimeMs`；回退 `snapshot.revision` 第 4 段（mtimeNs）。
//   ⇒ 判据是**物理文件时间**，不是"内容版本时间"。本测试把这个事实测出来（并作为"归档/复制/元数据变更是否重置计时"的证据）。
//
// 与定稿的关系：
//   · §二 时间口径：「6 小时是内容静置时间，不是距离归档、关闭窗口、重启软件**或复制文件**的时间」
//     ⇒ **F2（2026-10-01）已收口**：t246-b 改成**目标行为**断言（只改文件元信息 ⇒ **不重置**内容计时；
//     真实新内容 ⇒ 重置）。原"现状偏差"读数只作为**缺陷证据**保留在该段注释里（并作为改前树牙齿读数）。
//   · §二 时间口径：「归档、取消归档、重命名和移动列表等…不应重置内容计时」
//     ⇒ t246-a 证明**列表层级变化本身不影响**（插件根本不读归档账本，快照相同 ⇒ 不重置、不重复入队）。
//   · §二 行 3+4：「归档会话，版本尚未整理 ⇒ 完成一次；已整理 ⇒ 忽略」
//     ⇒ t246-a 的"达到门槛即纳入 + 再扫不重复"覆盖这两行。
//
// ⚠️ t246-d 断言的是**收口前**的现状（disposed 绕过 6h）。C4 落地后本组断言应**翻转**成
//    "disposed 不得绕过 6h"，并在报告里登记翻转前后读数（牙齿对照）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedContentClock } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t246-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const section = async (label, fn) => {
  try { return await fn() } catch (err) {
    check(false, `${label} 中断：${err && err.message ? err.message : err}`)
  }
}

const NOW = Date.now()
const HOUR = 3600000
const ID_ARCH = 'a1111111-0000-4000-8000-000000000001'
const ID_ACTIVE = 'a2222222-0000-4000-8000-000000000002'
const ID_LIVE = 'a3333333-0000-4000-8000-000000000003'
const CONTENT = '同一份正文：' + '细节'.repeat(40)

const snap = (id, idleHours, revisionOverride, sizeOverride) => ({
  header: { version: 4, isSeeded: false, id, cwd: 'C:/t246', createdAt: 0, delegationDepth: 0 },
  revision: revisionOverride || `1:2:3:${Math.round((NOW - idleHours * HOUR) * 1e6)}:4`,
  sizeBytes: Number(sizeOverride) || 128,
})
const msgEvent = (id, text) => ({
  type: 'user/message', seq: 0, time: 0, surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const llmMock = {
  stream: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', text: JSON.stringify({ rollout_summary: 's', raw_memory: 'r', slug: 's', keywords: '', title: '' }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }),
}

/** 让启动趟返回空、之后返回真清单，以便观察"手动扫描"读数。 */
async function boot(snapshots, { locatePath, cfg = {}, contentOverride } = {}) {
  let calls = 0
  const persistence = {
    list: async () => { calls += 1; return calls === 1 ? [] : snapshots },
    locate: () => ({ path: locatePath || 'Z:\\t246-not-exist\\log.jsonl' }),
  }
  const handlers = {}
  const readSession = async (id) => ({
    session: { version: 4, isSeeded: false, id, cwd: 'C:/t246', createdAt: 0, delegationDepth: 0 },
    events: [msgEvent(id, contentOverride || CONTENT)],
  })
  const { ctx, domain, tools } = makeCtx({
    on: (ev, cb) => { handlers[ev] = cb; return () => {} },
    get: (k) => (k === 'sessionQuery' ? { readSession }
      : k === 'sessionPersistence' ? persistence
        : k === 'llm' ? llmMock
          : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  })
  await apply(ctx, { minRolloutIdleHours: 6, maxRolloutAgeDays: 10, ...cfg })
  return { ctx, domain, tools, persistence, handlers }
}

const IDLE_MSG = (h) => `静置 ${h}h（revision 第 4 段 = mtimeNs）`

// ── t246-a：归档列表层级本身不影响资格；达到门槛一次纳入；再扫不重复 ──────────────
await section('[t246-a] 归档：列表层级不重置计时、达到门槛一次纳入、再扫不重复', async () => {
  // 同一个快照（内容版本相同、静置 12h），"归档"与"活跃"对插件**没有区别**——
  // 插件只读 sessionPersistence，不读归档账本（lib/index.js L3367）。
  const { tools, domain } = await boot([snap(ID_ARCH, 12)], {})
  const r1 = await tools['memory__ingest_scan'].execute({})
  check(r1.candidates === 1 && r1.enqueued === 1, `静置 12h 的（归档）会话首扫即纳入（candidates=${r1.candidates} enqueued=${r1.enqueued}）——不从"归档时刻"重新等 6h`)
  check(jobListOf(domain) && Object.keys(jobListOf(domain)).filter((k) => k.startsWith(ID_ARCH)).length === 1,
    'stage1_jobs 恰好 1 条（§二 行 7：多入口/多扫合并为同一份工作）')
  const r2 = await tools['memory__ingest_scan'].execute({})
  check(r2.enqueued === 0 && r2.done >= 1, `再扫不重复入队（enqueued=${r2.enqueued} done=${r2.done}）——"已整理版本忽略"的机械前提（同 mtime 不再入队）`)
  check(Object.keys(jobListOf(domain)).filter((k) => k.startsWith(ID_ARCH)).length === 1, '始终只有 1 条作业')
})

// ── t246-b：**F2 目标行为**（2026-10-01 翻转）：管理操作不重置内容计时；真实新内容才重置 ──────────
//   改前树的旧读数（**缺陷证据**，只留档不再断言）：同内容、只把文件 mtime 改新 ⇒ 被判 fresh、不纳入
//   （`fresh=1 enqueued=0`）——即"复制/搬迁会重置 6h 计时"，正是定稿 §二要防的偏差。
await section('[t246-b] F2 目标行为：只改文件元信息 ⇒ 不重置；真实新内容 ⇒ 重置', async () => {
  const dir = path.join(HOME, 'real-log')
  fs.mkdirSync(dir, { recursive: true })
  const FILE_OLD = path.join(dir, 'old-mtime.jsonl')
  fs.writeFileSync(FILE_OLD, 'x')
  const old = new Date(NOW - 12 * HOUR)
  const fresh = new Date(NOW - 60 * 1000)
  fs.utimesSync(FILE_OLD, old, old)

  // (1) 首次观测：内容计时**一次性播种自既有物理时间**（并在记录里标明来源），静置 12h ⇒ 纳入
  const a = await boot([snap(ID_ACTIVE, 0, `1:2:3:${Math.round(NOW * 1e6)}:4`)], { locatePath: FILE_OLD })
  const ra = await a.tools['memory__ingest_scan'].execute({})
  check(ra.enqueued === 1, `首次观测：locate 指向"12h 前"的真文件 ⇒ 纳入（enqueued=${ra.enqueued} fresh=${ra.fresh}）`)
  const recA = ((a.domain.table('stage1_meta').get('meta') || {}).contentSeen || {})[ID_ACTIVE]
  check(!!recA && recA.firstSeenSource === 'seeded-from-file-mtime',
    `内容计时记录落盘且**标明来源**（firstSeenSource=${recA && recA.firstSeenSource} firstSeenAt=${recA && recA.firstSeenAt}）`)

  // (2) **管理操作**（复制/搬迁的典型形态）：文件 mtime 改成"现在"，**内容与物理长度都不变**
  //     ⇒ 目标行为 = **不重置内容计时**（改前树：物理 mtime 驱动 ⇒ fresh=1 ⇒ 本断言必红）
  fs.utimesSync(FILE_OLD, fresh, fresh)
  const a2 = await a.tools['memory__ingest_scan'].execute({})
  check(a2.fresh === 0, `★ 只改文件 mtime ⇒ **不重置**内容计时（fresh=${a2.fresh}；改前树为 1 ⇒ 必红）`)
  check(a2.enqueued === 0, `同内容也不重复入队（enqueued=${a2.enqueued} candidates=${a2.candidates}）`)

  // (3) **真实新内容**（正文变 + 物理长度变；mtime 仍写"现在"、revision 写"12h 前"）
  //     ⇒ 目标行为 = **重置计时**、判 fresh、不纳入。
  //     这一项同时是"物理时间不再驱动"的判别项：若按 revision 的 12h 判，就会入队（改前树 ⇒ 必红）。
  const b = await boot([snap(ID_ACTIVE, 12, undefined, 256)], { locatePath: FILE_OLD, contentOverride: '全新正文：' + '新内容'.repeat(40) })
  await seedContentClock(b.domain, ID_ACTIVE, new Date(NOW - 12 * HOUR).toISOString(), 128)
  const rb = await b.tools['memory__ingest_scan'].execute({})
  check(rb.fresh === 1 && rb.enqueued === 0,
    `★ 真实新内容 ⇒ **重置**计时、判 fresh（fresh=${rb.fresh} enqueued=${rb.enqueued}；改前树按 revision 的 12h 会入队 ⇒ 必红）`)
})

// ── t246-c：revision 回退路径（locate 指向不存在的文件） ─────────────────────────
await section('[t246-c] 时间基准：locate 落空时用 revision 第 4 段（同一物理信号的另一种读法）', async () => {
  const c = await boot([snap(ID_ACTIVE, 12)], { locatePath: 'Z:\\t246-not-exist\\x.jsonl' })
  const rc = await c.tools['memory__ingest_scan'].execute({})
  check(rc.enqueued === 1, `revision 写 12h ⇒ 首次观测播种后纳入（enqueued=${rc.enqueued}）`)
  // ★ 真断言（替代原 `check(true, ...)` 说明性断言 —— 评估 §五 Q7 点名"不能当独立证据"）：
  //   证明"revision 回退路径同样只播种一次、且标明来源、不加精度"。
  const recC = ((c.domain.table('stage1_meta').get('meta') || {}).contentSeen || {})[ID_ACTIVE]
  check(!!recC && recC.firstSeenSource === 'seeded-from-file-mtime' && Number(recC.sizeBytes) === 128,
    `revision 回退路径同样只**播种一次**并标明来源（firstSeenSource=${recC && recC.firstSeenSource} sizeBytes=${recC && recC.sizeBytes}）`)
  const d = await boot([snap(ID_ACTIVE, 0)], { locatePath: 'Z:\\t246-not-exist\\x.jsonl' })
  const rd = await d.tools['memory__ingest_scan'].execute({})
  check(rd.fresh === 1 && rd.enqueued === 0, `revision 写 0h ⇒ 不纳入（fresh=${rd.fresh}）`)
})

// ── t246-d：disposed **已收口**（C4 落地后：只复查、不直接入队）────────────────────
await section('[t246-d] disposed 收口：刚更新的会话**不得**绕过静置门（C4 后翻转）', async () => {
  const { handlers, domain } = await boot([snap(ID_LIVE, 0)], {})
  check(typeof handlers['session/disposed'] === 'function', '订阅了 session/disposed')
  await handlers['session/disposed']({ id: ID_LIVE, header: { version: 4, isSeeded: false, id: ID_LIVE, cwd: 'C:/t246', createdAt: 0, delegationDepth: 0 } })
  const jobs = Object.keys(jobListOf(domain)).filter((k) => k.startsWith(ID_LIVE))
  // ★ 翻转（原断言：`jobs.length === 1`，即"绕过 6h 直接入队成功"）：C4 起 disposed 只请求复查，
  //   资格判定（静置 ≥6h）不合格 ⇒ **不入队**。这正是定稿 §四-A「不得绕过 6h」的落点。
  check(jobs.length === 0,
    `★ C4 收口：刚更新（静置≈0h）的会话经 disposed **不入队**（jobs=${jobs.length}；翻转前此处为 1）`)
  // 静置够 6h 的同一条会话 ⇒ 由**同一**资格判定正常纳入（证"不绕过"不等于"收不到"）。
  {
    const good = await boot([snap(ID_LIVE, 12)], {})
    await good.handlers['session/disposed']({ id: ID_LIVE, header: { version: 4, isSeeded: false, id: ID_LIVE, cwd: 'C:/t246', createdAt: 0, delegationDepth: 0 } })
    const jobs2 = Object.keys(jobListOf(good.domain)).filter((k) => k.startsWith(ID_LIVE))
    check(jobs2.length === 1, `静置 12h ⇒ 恰好入队 1 条（jobs=${jobs2.length}）——收口不是"收不到"`)
  }
})

console.log(`\n${failed === 0 ? 'ALL T246 TIME-BASIS / ARCHIVE-LIST TESTS PASSED' : failed + ' TESTS FAILED'}`)
console.log('（t246-b 已改为 F2 **目标行为**断言：管理操作不重置内容计时、真实新内容才重置；旧"现状偏差"读数作为缺陷证据留在该段注释）')
process.exit(failed === 0 ? 0 : 1)
