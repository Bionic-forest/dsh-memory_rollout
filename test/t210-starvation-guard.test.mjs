// t210：修「提炼吃光全天额度 ⇒ 整合被门二饿死」。
//
// 真机事实（2026-09-14 01:37 实测）：本地日界翻转（runDay=2026-09-14）后，**日界唤醒趟**把
//   `modelAttemptsToday` 从 0 吃到 **24**（当天额度全光）、提炼产出 +24 条（未消费产物 16→40），
//   而 `lastPhase2At` 仍停在 09-13T03:51:30Z、`current.json` 未变、总纲 mtime 仍 09-13 11:51:48。
//   ⇒ 提炼的一趟吞掉当天全部额度 ⇒ 门二（剩余 <25%）此后**永远**拦住整合 ⇒ 总纲停止更新。
//
// 本批两处改动：
//   ① `stage1QuotaPlan`：**为整合保底额度** —— 有未整合产物时，提炼只在「这一发用掉后剩余仍 ≥
//      门二所需的最小整数剩余」时才开工（与门二同阈值推导 ⇒ 提炼停下时门二必然放行）。
//   ② per-pass 上限对齐 codex（文档原文 "per pass"）：唤醒趟 / 事件趟也带 `maxSourcesPerStartup`。
//
// 覆盖：
//   T1 纯函数 `stage1QuotaPlan` 边界（含 cap=1 与阈值=0 的退化）
//   T2 【核心牙齿】假域复现「39 条待提炼 + 24 次额度」⇒ 提炼停手、**门二放行、整合真跑、总纲真发布**
//   T3 per-pass 上限：事件趟一次最多处理 `maxSourcesPerStartup` 条（改前树不设限 ⇒ 必红）
// 靶目录一律 os.tmpdir()；测试后清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const m = await import(PLUGIN)
const { apply } = m
// 安全包装：缺导出 ⇒ 断言红（不中途崩溃）。
const stage1QuotaPlan = typeof m.stage1QuotaPlan === 'function' ? m.stage1QuotaPlan : null
const bootQuotaPlan = typeof m.bootQuotaPlan === 'function' ? m.bootQuotaPlan : null

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

// ── T1：纯函数边界（不需要宿主环境） ────────────────────────────────────────
console.log('[T1] stage1QuotaPlan —— 为整合保底的额度判定（纯函数）')
{
  const q = stage1QuotaPlan
  check(!!q, '导出 `stage1QuotaPlan`（改前树无此导出 ⇒ 必红）')
  check(!!q && q({ attemptsToday: 17, maxAttemptsPerDay: 24, minRemainingPercent: 25, hasPendingConsolidation: true }).allowed === true,
    'cap=24/阈值=25、已用 17、有未整合产物 ⇒ **放行**（这一发用掉后剩 6 = 门二所需）')
  check(!!q && q({ attemptsToday: 18, maxAttemptsPerDay: 24, minRemainingPercent: 25, hasPendingConsolidation: true }).allowed === false,
    '已用 18 ⇒ **停手**（再发一发就只剩 5 < 门二所需的 6）')
  check(!!q && q({ attemptsToday: 18, maxAttemptsPerDay: 24, minRemainingPercent: 25, hasPendingConsolidation: true }).reserve === 6,
    'reserve = ceil(24 × 25%) = 6（与门二同阈值推导）')
  check(!!q && q({ attemptsToday: 18, maxAttemptsPerDay: 24, minRemainingPercent: 25, hasPendingConsolidation: true }).reason === 'reserved-for-consolidation',
    '停手原因标为 `reserved-for-consolidation`（可观测）')
  check(!!q && q({ attemptsToday: 23, maxAttemptsPerDay: 24, minRemainingPercent: 25, hasPendingConsolidation: false }).allowed === true,
    '**没有**未整合产物 ⇒ 不保留（已用 23 仍放行 ⇒ 不损失提炼吞吐）')
  check(!!q && q({ attemptsToday: 0, maxAttemptsPerDay: 1, minRemainingPercent: 25, hasPendingConsolidation: true }).allowed === true,
    '退化边界：cap=1 ⇒ reserve=min(1, cap−1=0)=0 ⇒ 仍放行（不把提炼全关掉；与 drain-quota 既有契约一致）')
  check(!!q && q({ attemptsToday: 23, maxAttemptsPerDay: 24, minRemainingPercent: 0, hasPendingConsolidation: true }).allowed === true,
    '可调关闭：阈值=0 ⇒ reserve=0 ⇒ 不保留（该护栏可配置关掉）')
  check(!!q && q({ attemptsToday: 24, maxAttemptsPerDay: 24, minRemainingPercent: 25, hasPendingConsolidation: false }).reason === 'daily-cap-reached',
    '额度确实用尽时原因标为 `daily-cap-reached`（与"为整合保留"区分）')
  check(!!bootQuotaPlan, '（**假阳性/健全性**）`bootQuotaPlan`（门二用的纯函数）仍在，供交叉验证')
}

// ── 假域环境 ────────────────────────────────────────────────────────────────
const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-t210-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })
process.env.DSH_HOME = tmp

let extractionCalls = 0
let consolidationCalls = 0
const msgEvent = (id, text) => ({ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [msgEvent(id, 'this is a long enough message for session ' + id + ' that definitely reaches the model extraction step now')] })
const EXTRACTION = { rollout_summary: 'sum ' + Math.random().toString(36).slice(2, 8), raw_memory: 'raw', slug: 'note', keywords: '', title: 't' }
const CONSOLIDATION = { memory_summary: 'v1\n## consolidated', registry: '# MEMORY.md\nok' }
const llmMock = {
  stream: (opts) => {
    const isExtraction = !!(opts && String(opts.system).includes('memory-extraction'))
    if (isExtraction) extractionCalls++; else consolidationCalls++
    const payload = isExtraction ? EXTRACTION : CONSOLIDATION
    return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(payload) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  },
}
const eventHandlers = {}
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : k === 'sessionQuery' ? { readSession } : undefined),
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
})

const metaOf = () => domain.table('stage1_meta').get('meta') || {}
const unconsumed = () => [...domain.table('stage1_outputs').entries()].filter(([, o]) => o && o.selected_for_phase2 !== true).length

try {
  await apply(ctx, { maxModelAttemptsPerDay: 24, minRemainingQuotaPercent: 25, maxSourcesPerStartup: 2 })

  console.log('[T2] 【核心牙齿】假域复现「39 条待提炼 + 当天 24 次额度」⇒ 整合不会被饿死')
  {
    // 39 条待提炼（= 真机当时的 backlog），额度从 0 起（新的一天）
    for (let i = 0; i < 39; i++) await seedJob(domain, 'starve-' + i, 'w' + i)
    check(jobListOf(domain) && Object.keys(jobListOf(domain)).length === 39, '预置 39 条 pending 提炼作业（= 真机 backlog 数）')
    const before = metaOf()
    check(Number(before.modelAttemptsToday || 0) === 0, `起始当日额度已用 = ${before.modelAttemptsToday || 0}（新的一天）`)

    const res = await ctx.tools['memory__stage1_drain'].execute({})
    const used = Number(metaOf().modelAttemptsToday || 0)
    const cap = 24
    const reserve = 6
    // ① 提炼没有吃光额度
    check(used <= cap - reserve,
      `提炼**为整合留住了额度**：用掉 ${used} ≤ ${cap - reserve}（cap ${cap} − 保留 ${reserve}；改前树应 = ${cap} ⇒ 必红）`)
    // ② 门二必然放行（用门二自己的纯函数交叉验证）
    const gate = bootQuotaPlan({ attemptsToday: used, maxAttemptsPerDay: cap, minRemainingPercent: 25 })
    check(!!gate && gate.allowed === true,
      `门二**放行**（剩余 ${gate && gate.remainingPercent.toFixed(1)}% ≥ 阈值 25%；改前树 0% ⇒ 必红）`)
    // ③ 整合真的跑了（自动路径：drain 产出后自触发 Phase 2）
    check(consolidationCalls >= 1,
      `**整合至少跑了一次**（实测 consolidation LLM 调用 ${consolidationCalls} 次；改前树 0 次 ⇒ 必红）`)
    // ④ 总纲真的发布（版本指针真的前进）
    const curPath = path.join(tmp, 'memories', 'current.json')
    const cur = fs.existsSync(curPath) ? JSON.parse(fs.readFileSync(curPath, 'utf8')) : null
    check(!!cur && !!cur.version,
      `**总纲发布了新版本**（current.json = ${cur && cur.version}；改前树不存在/未推进 ⇒ 必红）`)
    // ⑤（假阳性：两树都过）到顶即止，不会把 39 条全吃
    check(Object.values(jobListOf(domain)).filter((j) => j.status === 'pending').length > 0 && res.processed <= cap,
      `（**假阳性**：两树都过）到顶即止：本趟处理 ${res.processed} 条，仍有 pending 留待后续趟次`)
    // ⑥ 这一趟产出的未整合产物被整合**消化掉**了（管线真的追上了，而不是留一堆积压）
    check(unconsumed() === 0,
      `未整合产物被整合消化（实测剩 ${unconsumed()} 条；改前树整合被门二挡住 ⇒ 应剩 24 条 ⇒ 必红）`)
  }

  console.log('[T3] per-pass 上限对齐 codex（**源码级接线锚点**，非行为级）')
  {
    // 为什么用源码级锚点：行为级验证「一趟只处理 N 条」在快速测试里做不到 —— 唤醒趟要等 30s 间隔
    //   （`STARTUP_SOURCE_SPACING_MS`），而事件趟会先领走它自己刚入队的 no-output 作业（实测：
    //   事件趟的 `extractionCalls` 增量与预置作业数不成正比，故不能拿它当行为级判据）。
    //   启动趟已有行为级覆盖（`t189-boot-gates`）；这里只锁**接线**：唤醒趟 + 事件趟都必须带预算。
    const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    const budgetSites = (src.match(/perPassSourceBudget\(\)/g) || []).length
    check(budgetSites >= 3,
      `**接线锚点**：\`perPassSourceBudget()\` 出现 ${budgetSites} 处（定义 1 + 启动/唤醒/事件各 1；改前树 0 处 ⇒ 必红）`)
    check(/drainStage1Jobs\(\{ budget: perPassSourceBudget\(\) \}\)/.test(src),
      '唤醒趟（含日界）的 drain 显式带 per-pass 预算（改前树 `drainStage1Jobs()` 不设限 ⇒ 必红）')
    check((src.match(/scheduleStage1Drain\(perPassSourceBudget\(\)\)/g) || []).length >= 2,
      '启动趟与事件趟都走 `scheduleStage1Drain(perPassSourceBudget())`（改前树事件趟不传 ⇒ 必红）')
    check(/scheduleStage1Drain\(\)/.test(src),
      '（**假阳性**：两树都过）显式工具 `memory__stage1_drain` 仍**不设限**（保留显式入口不受门约束的既有约定）')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T210 STARVATION-GUARD TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
