// t198（F1）：用量读路径**兼容旧字段 `last_used_at`** —— 与 `last_usage` 取较新者；方向「宁可误保留」。
//
// 历史（本插件自证，非猜测）：`CHANGELOG-插件变更.md` L353 ——
//   「`memory_recall` 改为纯读：删除 `last_used_at` / `usage_count` 写回与按历史召回次数自我加权」。
//   即：该字段**曾由本插件写入、后被删除**；t195（④ 照 codex）重新引入了**同名 `usage_count` + 新名
//   `last_usage`**，但旧记录里的 `last_used_at` 成了无人读的遗痕 ⇒ 「真被用过」的证据被丢掉、
//   条目退化成「从未用过，只看 `updatedAt`」⇒ 在 30 天窗口下会被**误淘汰**（= 静默丢记忆，重）。
//
// 真实数据现状（只读实测 `…\.dsh\storages\dsh_rollout.json`，13 条 entries）：
//   · `usage_count` 存在 2 条 / 缺失 11 条；`last_usage` 存在 **0** 条；`last_used_at` 存在 **2** 条。
//   · 两条遗痕：`m-mtb8hgha-2ht8o0`（updatedAt 2026-08-27T08:01:17.23Z，last_used_at 2026-08-28T17:12:29.684Z）
//               `m-mtcay5xs-aerxa7`（updatedAt 2026-08-28T01:58:02.128Z，last_used_at 2026-08-28T17:12:29.678Z）
//     均为 `usage_count=1` + `status=active`。
//
// **如实声明（与契约的一处有意偏差）**：这两条记录以**字段级原样**投入假域（id / tags / createdAt /
//   updatedAt / last_used_at / usage_count / status 逐字照抄），但 `content` 用**同 token 的中性占位**——
//   本仓库是**公开仓库**，真实正文含用户私有的工程工作规则，不应因测试而发布出去。正文与淘汰判定无关
//   （判据只读时间戳/计数），占位不影响本文件任何一条断言。
//
// 本文件覆盖：
//   T1 纯函数：`lastUsedOf` 认旧字段 / 取较新者 / 一侧不可解析不影响另一侧 / 空值语义；旧计数保留的决策锚点
//   T2 真实遗痕 + 手算：在 `updatedAt` 已过期而 `last_used_at` 仍在窗口内的时刻 ⇒ 改前**误淘汰**、改后保留；
//      同时核实「零即时损失」「窗口仍成立」「旧计数不参与资格」
//   T3 行为级（真实 recall 路径）：旧字段能救回条目、能参与次级排序；交付后不重写旧字段
// 靶目录一律 os.tmpdir()；测试后清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const m = await import(PLUGIN)
const { apply } = m
// 安全包装：万一某导出缺席，表现为**断言红**而不是中途崩溃（与 t195 同法）。
const lastUsageOf = typeof m.lastUsageOf === 'function' ? m.lastUsageOf : null
const usageCountOf = typeof m.usageCountOf === 'function' ? m.usageCountOf : null
const entryEligible = typeof m.entryEligible === 'function' ? m.entryEligible : null
const DEFAULT_MAX_UNUSED_DAYS = m.DEFAULT_MAX_UNUSED_DAYS

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-t198-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DAY = 86400000
const at = (iso) => new Date(iso).getTime()
const ago = (days) => new Date(Date.now() - days * DAY).toISOString()
const approx = (v, iso, tolMs = 2000) => Number.isFinite(v) && Math.abs(v - at(iso)) <= tolMs

// ── 真实遗痕（字段级原样；content 为中性占位，理由见文首声明）──────────────────────────
const REAL_A = {
  id: 'm-mtb8hgha-2ht8o0',
  content: 'eratw legacyprobe (content 占位：真实正文含用户私有工作规则，不入公开仓库)',
  tags: ['eratw', '协作模式', '推送', '工作流'],
  createdAt: '2026-08-27T08:01:17.23Z',
  updatedAt: '2026-08-27T08:01:17.23Z',
  source: 'tool',
  last_used_at: '2026-08-28T17:12:29.684Z',
  usage_count: 1,
  status: 'active',
}
const REAL_B = {
  id: 'm-mtcay5xs-aerxa7',
  content: 'eratw legacyprobe (content 占位：真实正文含用户长期偏好，不入公开仓库)',
  tags: ['eratw', '拉取规则', '用户偏好', 'git', '教训'],
  createdAt: '2026-08-28T01:58:02.128Z',
  updatedAt: '2026-08-28T01:58:02.128Z',
  source: 'tool',
  last_used_at: '2026-08-28T17:12:29.678Z',
  usage_count: 1,
  status: 'active',
}
// 手算分歧时刻：此刻 A/B 的 updatedAt 已过 30 天窗口、last_used_at 仍在窗口内。
//   A：updatedAt 2026-08-27T08:01:17Z → +30d = 2026-09-26T08:01:17Z（T 时刻已过 31d4h）
//      last_used_at 2026-08-28T17:12:29Z → +30d = 2026-09-27T17:12:29Z（T 时刻仅过 29d18.8h ✓）
//   B：updatedAt 2026-08-28T01:58:02Z → +30d = 2026-09-27T01:58:02Z（已过 30d10h）
//      last_used_at 2026-08-28T17:12:29Z → 同上（29d18.8h ✓）
const T_DIVERGE = at('2026-09-27T12:00:00Z')

try {
  // ── T0：导出与常量 ──────────────────────────────────────────────────────
  console.log('[T0] 导出与默认窗口')
  {
    check(DEFAULT_MAX_UNUSED_DAYS === 30, `（**假阳性/健全性**）默认窗口 30 天（= codex max_unused_days；实测 ${DEFAULT_MAX_UNUSED_DAYS}）`)
    check(!!lastUsageOf && !!usageCountOf && !!entryEligible, '（**假阳性/健全性**）lastUsageOf / usageCountOf / entryEligible 均已导出')
    check(typeof m.scoreMemory === 'function' && typeof m.freshnessWeight === 'function', '（**假阳性**：不回归护栏）t195 的召回打分接口未被本批破坏（scoreMemory / freshnessWeight 仍在）')
  }

  // ── T1：纯函数 —— 旧字段兼容读 ───────────────────────────────────────────
  console.log('[T1] lastUsageOf 兼容 `last_used_at`（与 `last_usage` 取较新者）')
  {
    const f = lastUsageOf
    check(!!f && f({ last_used_at: REAL_A.last_used_at }) === at(REAL_A.last_used_at),
      `只带旧字段也认（改前 ⇒ null；实测 ${f && f({ last_used_at: REAL_A.last_used_at })}）`)
    const newIso = ago(2)
    const oldIso = ago(10)
    check(!!f && approx(f({ last_usage: oldIso, last_used_at: newIso }), newIso),
      `两字段并存 ⇒ **取较新者**（new 在 last_used_at 侧；改前取旧的 ${oldIso} ⇒ 该断言在还原口树上必红）`)
    check(!!f && approx(f({ last_usage: newIso, last_used_at: oldIso }), newIso) && at(newIso) > at(oldIso),
      '（以下为**假阳性**：本断言改前也过）两字段并存 ⇒ 取较新者（new 在 last_usage 侧）')
    check(!!f && approx(f({ last_usage: 'not-a-date', last_used_at: newIso }), newIso),
      '一侧不可解析 ⇒ 安全忽略、不影响另一侧（改前得到 null ⇒ 必红）')
    check(!!f && approx(f({ last_usage: newIso, last_used_at: 'not-a-date' }), newIso),
      '（**假阳性**：改前也过）一侧不可解析 ⇒ 另一侧照常')
    check(!!f && f({}) === null && f({ last_usage: '' }) === null && f({ last_used_at: '' }) === null,
      '（**假阳性**）空字段 ⇒ null（= 从未使用，等价 `last_usage IS NULL`）')
    check(!!f && f(null) === null && f(undefined) === null && f('x') === null,
      '（**假阳性**）非对象入参 ⇒ null（不抛异常）')
    check(!!usageCountOf && usageCountOf({ usage_count: 1 }) === 1 && usageCountOf({}) === 0,
      '（**假阳性**）**决策锚点**：旧 `usage_count` 保留（1 就是 1，不当 0 抹掉）')
  }

  // ── T2：真实遗痕 + 手算 ──────────────────────────────────────────────────
  console.log('[T2] 真实两条遗痕 + 手算分歧时刻（updatedAt 过期 / last_used_at 未过期）')
  {
    const f = entryEligible
    check(!!f && f(REAL_A, T_DIVERGE) === true,
      '手算：A 在 T 时刻**仍具资格**（last_used_at 仅过 29d18.8h < 30d；改前只看 updatedAt=31d4h ⇒ 误淘汰 ⇒ 必红）')
    check(!!f && f(REAL_B, T_DIVERGE) === true,
      '手算：B 在 T 时刻**仍具资格**（last_used_at 29d18.8h；改前 updatedAt=30d10h ⇒ 误淘汰 ⇒ 必红）')
    check(!!f && f({ ...REAL_A, last_used_at: '' }, T_DIVERGE) === false && f({ ...REAL_B, last_used_at: '' }, T_DIVERGE) === false,
      '（**假阳性**：改前也过）复刻改前行为：抹掉旧字段后这两条在 T 时刻**确实会失格** ⇒ 证明上面的分歧是真分歧')
    check(!!f && f(REAL_A, Date.now()) === true && f(REAL_B, Date.now()) === true,
      '（**假阳性**）**零即时损失**（与 t196 实测 DELTA_LOST=0 一致）：此刻两条两字段都在窗口内 ⇒ 改前后均保留')
    check(!!f && f({ status: 'active', updatedAt: ago(45), last_used_at: ago(40) }, Date.now()) === false,
      '（**假阳性**）**没有放宽窗口**：旧字段也超 30 天 ⇒ 照样失格（兼容读不是"一律保留"）')
    check(!!f && f({ status: 'active', updatedAt: ago(45), usage_count: 99 }, Date.now()) === false,
      '（**假阳性**）旧计数**不参与资格判定**（计数 99 也换不来资格 ⇒ 保留它不可能造成误淘汰）')
  }

  // ── T3：行为级（真实 recall 路径 + 假域）────────────────────────────────
  const { ctx, domain, tools } = makeCtx({
    get: (k) => (k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
    tools: { register: (t) => { tools[t.name] = t } },
  })
  const home = path.join(tmp, 'h-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  await apply(ctx, { recallLimit: 20 })
  const table = domain.table('entries')
  const put = (id, rec) => table.put(id, { tags: [], source: 'ui', createdAt: ago(1), updatedAt: ago(1), ...rec })
  const entryOf = (id) => table.get(id)

  const RECENT_LEGACY_TS = ago(5)
  await put('legacy-used-recent', { content: 'the legacyprobe rule is alpha', tags: ['legacyprobe'], updatedAt: ago(40), last_used_at: RECENT_LEGACY_TS, usage_count: 1 })
  await put('legacy-used-stale', { content: 'the legacyprobe rule is beta', tags: ['legacyprobe'], updatedAt: ago(40), last_used_at: ago(40) })
  await put('fresh-never-used', { content: 'the legacyprobe rule is gamma', tags: ['legacyprobe'], updatedAt: ago(2) })
  await put('used-baseline-3d', { content: 'the orderprobe note is one', tags: ['orderprobe'], updatedAt: ago(40), last_used_at: ago(3), usage_count: 0 })
  await put('never-baseline-10d', { content: 'the orderprobe note is two', tags: ['orderprobe'], updatedAt: ago(10) })
  await put(REAL_A.id, { ...REAL_A })
  await put(REAL_B.id, { ...REAL_B })

  console.log('[T3] 行为级：旧字段把条目从"误淘汰"里救回来（真实 recall 路径）')
  {
    const r = await tools.memory_recall.execute({ query: 'legacyprobe', limit: 20 })
    const ids = r.entries.map((e) => e.id)
    check(ids.includes('legacy-used-recent'),
      `【本批核心牙齿】last_used_at 新鲜（5 天）+ updatedAt 过期（40 天）⇒ **仍被召回**（实测 ${JSON.stringify(ids)}；改前被硬淘汰 ⇒ 必红）`)
    check(!ids.includes('legacy-used-stale'),
      '（**假阳性**）旧字段也过期（40 天）⇒ 仍不召回（兼容读不制造"僵尸条目"）')
    check(ids.includes('fresh-never-used'),
      '（**假阳性**）从未用过但来源新鲜 ⇒ 照常召回（t195 的 OR 语义未被本批破坏）')
  }

  console.log('[T3b] 行为级：旧字段参与**次级排序键**（`COALESCE(last_usage, updatedAt) DESC`）')
  {
    const r = await tools.memory_recall.execute({ query: 'orderprobe', limit: 20 })
    const ids = r.entries.map((e) => e.id)
    const iUsed = ids.indexOf('used-baseline-3d')
    const iNever = ids.indexOf('never-baseline-10d')
    check(iUsed >= 0 && iNever >= 0 && iUsed < iNever,
      `两条资格/相关性/计数相同 ⇒ 上次使用基线更新者（3 天）排在更旧者（10 天）之前（实测顺序 ${JSON.stringify(ids)}；改前 used-baseline-3d 已失格 ⇒ 必红）`)
  }

  console.log('[T3c] 行为级：交付后**不重写**旧字段（读路径只读证据）')
  {
    await sleep(400) // 等 scheduleUsageBump 的异步写落盘
    const rec = entryOf('legacy-used-recent')
    check(!!rec && rec.last_used_at === RECENT_LEGACY_TS,
      `（**假阳性**：改前不交付故也不改）旧字段 last_used_at 原值原样保留（未被迁移/改写；实测 ${rec && rec.last_used_at}）`)
    check(!!rec && !!rec.last_usage && Math.abs(Date.now() - at(rec.last_usage)) < 120000,
      `既有写路径仍只写新字段 last_usage（交付后刷新为当前时刻；实测 ${rec && rec.last_usage}；改前该条根本不被交付 ⇒ 必红）`)
  }

  console.log('[T3d] 行为级：两条真实遗痕投入假域 ⇒ 无误淘汰（此刻真实 now）')
  {
    const r = await tools.memory_recall.execute({ query: 'eratw', limit: 20 })
    const ids = r.entries.map((e) => e.id)
    check(ids.includes(REAL_A.id) && ids.includes(REAL_B.id),
      `（**假阳性**）真实遗痕此刻被正常召回（实测 ${JSON.stringify(ids)}）`)
    await sleep(300)
    const recA = entryOf(REAL_A.id)
    check(!!recA && recA.last_used_at === REAL_A.last_used_at && (recA.usage_count || 0) >= REAL_A.usage_count,
      `（**假阳性**：改前也过）交付后真实记录的旧字段不被抹掉、旧计数只增不减（实测 last_used_at=${recA && recA.last_used_at} / usage_count=${recA && recA.usage_count}）`)
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T198 LEGACY-USAGE-FIELD TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
