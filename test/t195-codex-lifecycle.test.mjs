// t195：④ 生命周期**照 codex** —— 30 天未用 ⇒ 失格（硬淘汰）+ `usage_count` 降序 + 撤销 freshness 软降权。
//
// 依据（本地镜像 `_ref-codex\`，commit a592c38c…）：`codex-rs/state/src/runtime/memories.rs`
//   L439-446（资格与排序文档）、L459（cutoff）、L473-477（WHERE 资格）、L479-482（ORDER BY）、
//   L70-80（usage_count 累加）；`codex-rs/config/src/types.rs` L55（max_unused_days = 30）。
//
// 本文件覆盖：
//   T1 资格纯函数边界（用过看 last_usage；从未用过看 updatedAt；forgotten/superseded；窗口=0；时间戳缺失）
//   T2 缺字段兼容（usage_count ⇒ 0 / last_usage ⇒ null）
//   T3 撤销降权：scoreMemory 不再吃 freshness（**改前树必红**：旧公式 0.7*rel+0.3*freshness）
//   T4 行为级：超过窗口的条目**不再被召回**（改前树会返回 ⇒ **必红**）
//   T5 行为级：排序首键 = usage_count DESC（改前树按 freshness 加权 ⇒ **必红**）
//   T6 行为级：被召回的条目异步累加 usage_count/last_usage + 10 分钟去抖
// 靶目录一律 os.tmpdir()；测试后清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const m = await import(PLUGIN)
const { apply } = m
// 改前树上没有这些导出 ⇒ 用安全包装让"缺导出"表现为**断言红**而不是中途崩溃。
const entryEligible = typeof m.entryEligible === 'function' ? m.entryEligible : null
const usageCountOf = typeof m.usageCountOf === 'function' ? m.usageCountOf : null
const lastUsageOf = typeof m.lastUsageOf === 'function' ? m.lastUsageOf : null
const DEFAULT_MAX_UNUSED_DAYS = m.DEFAULT_MAX_UNUSED_DAYS

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-t195-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DAY = 86400000
const ago = (days) => new Date(Date.now() - days * DAY).toISOString()

try {
  // ── T1：资格纯函数（codex 语义逐条） ──────────────────────────────────────
  console.log('[T1] entryEligible —— 用过看 last_usage / 从未用过看 updatedAt（照 codex）')
  {
    const f = entryEligible
    check(!!f && DEFAULT_MAX_UNUSED_DAYS === 30, `默认窗口 30 天（= codex max_unused_days；实测 ${DEFAULT_MAX_UNUSED_DAYS}）`)
    check(!!f && f({ status: 'active', updatedAt: ago(1) }, Date.now()) === true, '从未用过但更新时间新鲜 ⇒ 具资格（codex：never used + source fresh ⇒ 保留）')
    check(!!f && f({ status: 'active', updatedAt: ago(45) }, Date.now()) === false, '从未用过且更新时间超窗口 ⇒ **失格**（改前只会降权）')
    check(!!f && f({ status: 'active', updatedAt: ago(300), last_usage: ago(5) }, Date.now()) === true, '用过且在窗口内 ⇒ 具资格（即使 updatedAt 很旧；codex 的 OR 语义）')
    check(!!f && f({ status: 'active', updatedAt: ago(1), last_usage: ago(45) }, Date.now()) === false, '用过但超窗口 ⇒ 失格（last_usage 优先于 updatedAt）')
    check(!!f && f({ status: 'forgotten', updatedAt: ago(1) }, Date.now()) === false, 'forgotten ⇒ 永不具资格（本地更高优先的硬谓词）')
    check(!!f && f({ status: 'superseded', updatedAt: ago(1) }, Date.now()) === false, 'superseded ⇒ 默认不具资格')
    check(!!f && f({ status: 'superseded', updatedAt: ago(1) }, Date.now(), 30, { includeSuperseded: true }) === true, '审计模式（includeSuperseded）⇒ 放行（仍受窗口约束）')
    check(!!f && f({ status: 'active', updatedAt: ago(400), last_usage: new Date().toISOString() }, Date.now(), 0) === true, '窗口=0 ⇒ 只有"刚用过"的具资格（边界）')
    check(!!f && f({ status: 'active', updatedAt: ago(400) }, Date.now(), 0) === false, '窗口=0 + 从未用过 ⇒ 失格')
    check(!!f && f({ status: 'active' }, Date.now()) === true, '**兼容边界（登记的自决偏差）**：时间戳缺失/不可解析 ⇒ 按具资格处理（避免静默丢记忆）')
  }

  // ── T2：缺字段兼容 ──────────────────────────────────────────────────────
  console.log('[T2] usageCountOf / lastUsageOf 对缺字段的默认值（旧数据兼容）')
  {
    check(!!usageCountOf && usageCountOf({}) === 0 && usageCountOf({ usage_count: undefined }) === 0, '缺 usage_count ⇒ 0（等价 codex COALESCE(usage_count,0)）')
    check(!!usageCountOf && usageCountOf({ usage_count: 7 }) === 7, '有值 ⇒ 原样')
    check(!!lastUsageOf && lastUsageOf({}) === null && lastUsageOf({ last_usage: '' }) === null, '缺/空 last_usage ⇒ null（等价 last_usage IS NULL）')
    check(!!lastUsageOf && Number.isFinite(lastUsageOf({ last_usage: ago(3) })), '有值 ⇒ 可解析为 ms')
  }

  // ── T3：撤销 freshness 软降权（scoreMemory 只吃相关性） ────────────────────
  console.log('[T3] 撤销降权：scoreMemory 不再吃 freshness')
  {
    const sm = m.scoreMemory
    const withFresh = sm({}, { relevance: 0.4, freshness: 1 })
    const withoutFresh = sm({}, { relevance: 0.4, freshness: 0 })
    check(withFresh === 0.4 && withoutFresh === 0.4, `freshness 入参不影响分数（实测 ${withFresh} / ${withoutFresh}；改前=0.58/0.28 ⇒ 该断言在还原口树上必红）`)
    check(typeof m.freshnessWeight === 'function', 'freshnessWeight 仍导出（@deprecated，仅为不破坏既有 import）')
  }

  // ── T4/T5/T6：行为级（真实 recall） ──────────────────────────────────────
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

  await put('used-recent', { content: 'the proto rule is alpha', tags: ['proto'], updatedAt: ago(300), usage_count: 3, last_usage: ago(5) })
  await put('used-old', { content: 'the proto rule is beta', tags: ['proto'], updatedAt: ago(2), usage_count: 9, last_usage: ago(45) })
  await put('never-fresh', { content: 'the proto rule is gamma', tags: ['proto'], updatedAt: ago(2) })
  await put('never-stale', { content: 'the proto rule is delta', tags: ['proto'], updatedAt: ago(45) })

  console.log('[T4] 行为级：超过窗口的条目不再被召回（硬淘汰）')
  {
    const r = await tools.memory_recall.execute({ query: 'proto', limit: 20 })
    const ids = r.entries.map((e) => e.id)
    check(ids.includes('used-recent') && ids.includes('never-fresh'), `窗口内/来源新鲜的条目被召回（实测 ${JSON.stringify(ids)}）`)
    check(!ids.includes('used-old'), '**用过但 45 天未用 ⇒ 不失格才怪**：不再被召回（改前会被返回并仅降权 ⇒ 该断言在还原口树上必红）')
    check(!ids.includes('never-stale'), '从未用过且来源已旧 ⇒ 不再被召回（照 codex 的 `last_usage IS NULL` 分支）')
  }

  console.log('[T5] 行为级：排序首键 = usage_count DESC（不再是 freshness 加权）')
  {
    // 两条资格相同、相关性相同，只差 usage_count 与新鲜度：高使用但较旧 应排在 低使用但更新 之前。
    await put('low-use-fresh', { content: 'the order probe is one', tags: ['ord'], usage_count: 0, updatedAt: ago(1) })
    await put('high-use-older', { content: 'the order probe is two', tags: ['ord'], usage_count: 5, updatedAt: ago(10) })
    const r = await tools.memory_recall.execute({ query: 'ord', limit: 20 })
    const ids = r.entries.map((e) => e.id)
    const iHigh = ids.indexOf('high-use-older')
    const iLow = ids.indexOf('low-use-fresh')
    check(iHigh >= 0 && iLow >= 0 && iHigh < iLow, `usage_count 高的排在前（实测顺序 ${JSON.stringify(ids)}；改前按 freshness 加权会把更新的那条排前面 ⇒ 该断言在还原口树上必红）`)
  }

  console.log('[T6] 行为级：被召回的条目异步累加 usage_count / last_usage（+ 去抖）')
  {
    const before = entryOf('used-recent').usage_count || 0
    await tools.memory_recall.execute({ query: 'proto', limit: 20 })
    await sleep(400)
    const after = entryOf('used-recent')
    check((after.usage_count || 0) === before + 1, `usage_count 异步 +1（实测 ${before} → ${after.usage_count}）`)
    check(!!after.last_usage && Math.abs(Date.now() - new Date(after.last_usage).getTime()) < 120000, `last_usage 被刷新为当前时刻（实测 ${after.last_usage}）`)
    // 去抖：紧接着再召回一次，不应再 +1（同一 id 10 分钟内只计一次）。
    await tools.memory_recall.execute({ query: 'proto', limit: 20 })
    await sleep(250)
    check((entryOf('used-recent').usage_count || 0) === after.usage_count, `10 分钟内重复召回不再累加（去抖；实测 ${entryOf('used-recent').usage_count}）`)
  }

  console.log('[T7] 兼容：旧条目（无 usage_count / last_usage 字段）仍按"从未用过 + 更新时间新鲜"资格正常召回')
  {
    await put('legacy-entry', { content: 'the legacy proto note is epsilon', tags: ['proto'] })
    const raw = entryOf('legacy-entry')
    check(!!raw && !('usage_count' in raw) && !('last_usage' in raw), '旧记录**原样保留**、不被迁移/重写（缺字段就是缺字段，读路径才补默认）')
    const r = await tools.memory_recall.execute({ query: 'proto', limit: 20 })
    check(r.entries.some((e) => e.id === 'legacy-entry'), '旧条目仍被召回（向后兼容：缺字段 ⇒ 0 / null ⇒ 视为从未用过但新鲜）')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T195 CODEX-LIFECYCLE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
