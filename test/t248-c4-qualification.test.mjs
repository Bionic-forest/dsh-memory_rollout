// t248（本批 C4 · 契约 §C4）：**统一自动资格** —— 两条自动入口（静置扫描 / `session/disposed`）
//   都不能让"刚更新"的会话立刻启动提炼；静置够 6h 后由**同一**资格判定正常纳入，且**恰好一次**。
//
// 契约落点（`lib/index.js`，SHA 见交付报告文首）：
//   · `qualifiesForAutoIngest(...)` = **唯一的**自动资格判定（静置 ≥ minRolloutIdleHours、年龄 ≤ maxRolloutAgeDays）；
//   · `ingestSessionById` 对**自动入口**（`explicit !== true`）加资格前置，不合格 ⇒ `{queued:false, reason:'not-idle-enough'}`、**不进 stage1_jobs**；
//   · `session/disposed` 改为**只请求复查**（留痕 `stage1_meta.meta.idleRecheck`，并把下一次唤醒提前），**不再直接入队**；
//   · **空监听** `session/event` 已删。
//
// ⚠️ 牙齿说明（队长口径 6）：本文件在**打补丁前的树**（`lib\index.js.pre-c4c6-2026-09-30`）必红 ——
//   那时 disposed 处理器直接 `ingestSessionById`、**没有任何时间门**，故"刚更新 ⇒ 不入队"必假；
//   且 `idleRecheck` 留痕键不存在。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedContentClock } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t248-' + Math.random().toString(36).slice(2, 8))
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
const HOUR = 3600000
const ID_LIVE = 'e1111111-0000-4000-8000-000000000001'
const ID_OLD = 'e2222222-0000-4000-8000-000000000002'
const ID_NOSNAP = 'e3333333-0000-4000-8000-000000000003'

/** 快照：`idleHours` = 该会话"最后写入"距今多少小时（走 revision 第 4 段）。 */
const snap = (id, idleHours) => ({
  header: { version: 4, isSeeded: false, id, cwd: 'C:/t248', createdAt: 0 },
  revision: '1:2:3:' + Math.round((NOW - idleHours * HOUR) * 1e6) + ':4',
  sizeBytes: 128,
})
const msgEvent = (id) => ({
  type: 'user/message', seq: 0, time: 0, surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '会话 ' + id + '：' + '细节'.repeat(40) }] },
})
const readSession = async (id) => ({
  session: { version: 4, isSeeded: false, id, cwd: 'C:/t248', createdAt: 0 },
  events: [msgEvent(id)],
})
const llmMock = {
  stream: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', text: JSON.stringify({ rollout_summary: 's', raw_memory: 'r', slug: 's', keywords: '', title: '' }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }),
}
/**
 * 起一个可**动态改快照**（模拟"会话后来静置够了"）的假宿主。
 * `list()` 第 1 次为启动趟（返回空，便于只看手动扫描）。
 */
const boot = async (initial, cfg = {}) => {
  let calls = 0
  let current = initial
  const persistence = {
    list: async () => { calls += 1; return calls === 1 ? [] : current },
    locate: () => ({ path: 'Z:\\t248-not-exist\\log.jsonl' }),
  }
  const handlers = {}
  const { ctx, domain, tools } = makeCtx({
    on: (ev, cb) => { handlers[ev] = cb; return () => {} },
    get: (k) => (k === 'sessionQuery' ? { readSession }
      : k === 'sessionPersistence' ? persistence
        : k === 'llm' ? llmMock
          : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
    tools: { register: (t) => { tools[t.name] = t } },
  })
  await apply(ctx, cfg)
  return { ctx, domain, tools, handlers, setSnapshots: (s) => { current = s } }
}
const metaOf = (domain) => domain.table('stage1_meta').get('meta')
const jobsOf = (domain, id) => Object.keys(jobListOf(domain) || {}).filter((k) => k.startsWith(id + '::'))

// ── ① 静置扫描入口：刚更新 ⇒ 不入队 ──────────────────────────────────────────────
await section('[t248-1] 扫描入口：刚更新（1h）的会话进不了准备序列', async () => {
  const { domain, tools } = await boot([snap(ID_LIVE, 1)], { minRolloutIdleHours: 6, maxRolloutAgeDays: 10 })
  const r = await tools['memory__ingest_scan'].execute({})
  check(r.fresh === 1 && r.enqueued === 0, `静置 1h < 6h ⇒ 不入队（fresh=${r.fresh} enqueued=${r.enqueued}）`)
  check(jobsOf(domain, ID_LIVE).length === 0, `stage1_jobs 里没有它（实测 ${jobsOf(domain, ID_LIVE).length}）`)
})

// ── ② disposed 入口：**刚更新也不得绕过 6h**（本批核心契约判据）────────────────────
await section('[t248-2] disposed 入口：刚更新（1h）⇒ 不直接入队，只请求复查', async () => {
  const b = await boot([snap(ID_LIVE, 1)], { minRolloutIdleHours: 6, maxRolloutAgeDays: 10 })
  check(typeof b.handlers['session/disposed'] === 'function', '订阅了 session/disposed')
  await b.handlers['session/disposed']({ id: ID_LIVE })
  check(jobsOf(b.domain, ID_LIVE).length === 0,
    `★ 刚更新的会话经 disposed **没有**被提炼（jobs=${jobsOf(b.domain, ID_LIVE).length}；改前树此处为 1 ⇒ 必红）`)
  const m = metaOf(b.domain)
  check(!!m.idleRecheck && typeof m.idleRecheck === 'object',
    `落了一条"复查请求"留痕（idleRecheck=${JSON.stringify(m.idleRecheck)}；改前树该键不存在）`)
  check(!!m.idleRecheck && String(m.idleRecheck.source || '').includes('not-qualified'),
    `留痕写明原因（source=${m.idleRecheck && m.idleRecheck.source}）`)
})

// ── ③ 静置够 6h ⇒ 正常纳入，且**恰好一次** ────────────────────────────────────────
await section('[t248-3] 静置 ≥6h 后：经同一资格判定纳入，且只消费一次', async () => {
  const b = await boot([snap(ID_OLD, 12)], { minRolloutIdleHours: 6, maxRolloutAgeDays: 10 })
  await b.handlers['session/disposed']({ id: ID_OLD })
  check(jobsOf(b.domain, ID_OLD).length === 1, `静置 12h ⇒ 恰好 1 条作业（实测 ${jobsOf(b.domain, ID_OLD).length}）`)
  // 去重锚点 = 既有 `<sid>::<contentWatermark>`（stage1_jobs 的键）；同内容再触发不得新增**键**。
  const keys1 = jobsOf(b.domain, ID_OLD)
  // 再 disposed 一次（内容/水位未变）⇒ 去重，不新增
  await b.handlers['session/disposed']({ id: ID_OLD })
  const keys2 = jobsOf(b.domain, ID_OLD)
  check(keys2.length === 1, `重复 disposed 不重复入队（实测 ${keys2.length}）`)
  check(keys1.join(',') === keys2.join(','), `job 键完全相同（去重靠 <sid>::<watermark>）：${keys2.join(',')}`)
})

// ── ④ 动态：同一会话"刚更新 → 静置够"⇒ 先不入队、后恰好一次 ─────────────────────
await section('[t248-4] 同一会话：先刚更新（不入队）、再静置够（恰好一次）', async () => {
  const b = await boot([snap(ID_LIVE, 0.5)], { minRolloutIdleHours: 6, maxRolloutAgeDays: 10 })
  await b.handlers['session/disposed']({ id: ID_LIVE })
  check(jobsOf(b.domain, ID_LIVE).length === 0, `静置 0.5h ⇒ 不入队（实测 ${jobsOf(b.domain, ID_LIVE).length}）`)
  // 时间推进：同一条会话现在"静置 12h"。
  // **F2（2026-10-01）语义变更**：静置基准是**内容观测时刻**（`stage1_meta.meta.contentSeen.firstSeenAt`），
  //   不再是物理文件时间 ⇒ 夹具**不能靠"改 revision/mtime"制造静置**，必须直接**播种内容计时起点**
  //   （等价于"这份内容在 12h 前就被观察到"；`sizeBytes` 与快照一致 ⇒ 走 'unchanged' 分支）。
  // R1（2026-10-01）：夹具要表达"**有可靠基线**的 12h 前内容" ⇒ 必须同时给非空 `watermark` 与**当前快照的
  //   `revision`**（否则"线索变 ⇒ 基线未知 ⇒ 不重置"不成立，会被按新内容重置）。
  const snap12 = snap(ID_LIVE, 12)
  await seedContentClock(b.domain, ID_LIVE, new Date(NOW - 12 * HOUR).toISOString(), 128, 'wm-live', snap12.revision)
  b.setSnapshots([snap12])
  await b.handlers['session/disposed']({ id: ID_LIVE })
  check(jobsOf(b.domain, ID_LIVE).length === 1, `静置够后恰好 1 条（实测 ${jobsOf(b.domain, ID_LIVE).length}）`)
  // 再扫一趟：该键已存在 ⇒ 不重复（`stage1_seen` 语义由既有去重承担；此处以 job 键面为准）。
  const r = await b.tools['memory__ingest_scan'].execute({})
  check(r.enqueued === 0 && jobsOf(b.domain, ID_LIVE).length === 1,
    `下一趟扫描不重复入队（enqueued=${r.enqueued} jobs=${jobsOf(b.domain, ID_LIVE).length}）`)
})

// ── ⑤ 拿不到快照 ⇒ 保守不放行（不猜、不入队）────────────────────────────────────
await section('[t248-5] 取不到快照 ⇒ 保守不放行', async () => {
  const b = await boot([snap(ID_OLD, 12)], { minRolloutIdleHours: 6, maxRolloutAgeDays: 10 })
  await b.handlers['session/disposed']({ id: ID_NOSNAP })
  check(jobsOf(b.domain, ID_NOSNAP).length === 0, `不在持久清单里的会话 ⇒ 不入队（实测 ${jobsOf(b.domain, ID_NOSNAP).length}）`)
  const m = metaOf(b.domain)
  check(!!m.idleRecheck && String(m.idleRecheck.source || '').includes('no-snapshot'),
    `留痕写明"无快照"（source=${m.idleRecheck && m.idleRecheck.source}）`)
})

// ── ⑥ 空监听 `session/event` 已删（契约 §C4 ④）──────────────────────────────────
await section('[t248-6] 空监听 session/event 已删；disposed 之外没有自动入队入口', async () => {
  const b = await boot([snap(ID_OLD, 12)], { minRolloutIdleHours: 6, maxRolloutAgeDays: 10 })
  check(b.handlers['session/event'] === undefined,
    `不再注册 session/event（实测 ${typeof b.handlers['session/event']}；改前树此处为 function ⇒ 必红）`)
  // 语义等义断言（原"compaction/start 不自动入队"的意图）：派发一次也不产生 job。
  let threw = ''
  try {
    if (typeof b.handlers['session/event'] === 'function') {
      await b.handlers['session/event']({ id: ID_OLD }, { type: 'compaction/start' })
    }
  } catch (err) { threw = String((err && err.message) || err) }
  check(threw === '' && jobsOf(b.domain, ID_OLD).length === 0,
    `compaction/start 不产生作业（jobs=${jobsOf(b.domain, ID_OLD).length}${threw ? '；抛错=' + threw : ''}）`)
})

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n${failed === 0 ? 'ALL T248 C4-QUALIFICATION TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
