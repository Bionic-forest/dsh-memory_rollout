// t206（S1）：`last_used_at` 进 `recordSchema` —— 牙齿是「**经 valueSchema.parse 之后该字段仍在**」。
//
// 为什么需要这条测试（旧 F1 测试的漏洞）：
//   t198 的 F1 测试把「旧字段」记录**直接 put 进假域**（假域不跑任何 schema），因此它验证的是
//   「`lastUsageOf` 认不认 `last_used_at`」——**认**。但生产路径上，宿主存储域载入记录时会先
//   `valueSchema.parse(raw)`（zod 默认 strip 未声明键）⇒ 字段在到达插件之前就被剥掉了 ⇒
//   t198 的修复在生产路径是空转，而旧测试**看不到**这一点。
//   本文件的 T2–T6 因此**先过一遍插件交给宿主的那份 valueSchema**（用 `storageDomain.open` 捕获
//   规格，拿到的就是宿主真正会 parse 的那份），再走读/写/召回路径。
//
// 覆盖：
//   T1 捕获到的域规格里 entries.valueSchema 存在（否则后续一切无从谈起）
//   T2 【核心牙齿】带 `last_used_at` 的原始记录 parse 之后，**该字段与值仍在**
//   T3 该 parse 结果喂给读函数 `lastUsageOf` ⇒ 得到旧字段的时间戳
//   T4 缺字段 ⇒ parse 补空串、`lastUsageOf` ⇒ null（= 从未使用）
//   T5 【行为级牙齿】经 parse 落库的记录能被召回（`updatedAt` 过期但旧字段新鲜）
//   T6 写入面：召回交付后的回写**不覆盖**旧字段、只刷新 `last_usage`
//   T7 反回归护栏：未声明键仍被 strip（没有为了修本缺陷而关掉 strip）；`usage_count` 默认仍在
// 靶目录一律 os.tmpdir()；测试后清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const m = await import(PLUGIN)
const { apply } = m
// 安全包装：缺导出 ⇒ 断言红（不中途崩溃），与 t195/t198 同法。
const lastUsageOf = typeof m.lastUsageOf === 'function' ? m.lastUsageOf : null

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-t206-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DAY = 86400000
const ago = (days) => new Date(Date.now() - days * DAY).toISOString()
const LEGACY_TS = ago(5)

try {
  // 捕获插件交给宿主的域规格（宿主就是拿它的 valueSchema 去 parse 的）
  let spec = null
  const { ctx, domain, tools } = makeCtx({
    storageDomain: { open: async (s) => { spec = s; return domain } },
    get: (k) => (k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
    tools: { register: (t) => { tools[t.name] = t } },
  })
  const home = path.join(tmp, 'h-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  await apply(ctx, { recallLimit: 20 })

  const schema = spec && spec.tables && spec.tables.entries ? spec.tables.entries.valueSchema : null
  const parse = (rec) => (schema ? schema.parse(rec) : rec)

  console.log('[T1] 捕获到的域规格里有 entries.valueSchema（宿主 parse 用的就是它）')
  {
    check(!!schema && typeof schema.parse === 'function', '（**假阳性/健全性**）entries.valueSchema 可用（否则后面的 parse 断言全部无意义）')
    check(!!spec && spec.name === 'dsh_rollout', `（**假阳性/健全性**）域规格 name=${spec && spec.name}（应为 dsh_rollout）`)
  }

  console.log('[T2] 【核心牙齿】原始记录 parse 之后 `last_used_at` 仍在（改前树：zod strip ⇒ 必红）')
  {
    const raw = { content: 'the schemaprobe rule is alpha', tags: ['schemaprobe'], createdAt: ago(50), updatedAt: ago(40), source: 'tool', last_used_at: LEGACY_TS }
    const parsed = parse(raw)
    check(parsed.last_used_at === LEGACY_TS,
      `parse 后字段与值原样保留（实测 ${JSON.stringify(parsed.last_used_at)}；改前树应为 undefined ⇒ 必红）`)
    check('last_used_at' in parsed, '（牙齿②：键存在性 —— 改前树该键不存在 ⇒ 也红）parse 结果里存在该键')
  }

  console.log('[T3] parse 结果喂给读函数 ⇒ 得到旧字段的时间戳（t198 的 F1 在生产路径才真正生效）')
  {
    const parsed = parse({ content: 'x', tags: [], createdAt: ago(50), updatedAt: ago(40), last_used_at: LEGACY_TS })
    const t = lastUsageOf ? lastUsageOf(parsed) : null
    check(Number.isFinite(t) && Math.abs(t - Date.parse(LEGACY_TS)) < 1000,
      `lastUsageOf(parsed) = ${t}（应 ≈ ${Date.parse(LEGACY_TS)}；改前树 parse 已剥字段 ⇒ null ⇒ 必红）`)
  }

  console.log('[T4] 缺字段 ⇒ parse **不新增该键**（t208 起）；读路径行为不变（投影得空串、读函数 ⇒ null）')
  {
    const parsed = parse({ content: 'y', tags: [], createdAt: ago(2), updatedAt: ago(2) })
    check(!('last_used_at' in parsed), `（牙齿④：键不被补齐 —— 改前树 .default('') 会补出 "" ⇒ 必红）缺该字段的记录 parse 后**不含该键**（实测 ${JSON.stringify(parsed.last_used_at)}）`)
    check(String(parsed.last_used_at || '') === '', "（**假阳性**：两树都过）投影口径 String(x || '') 仍得空串（读路径行为不变）")
    check(lastUsageOf && lastUsageOf(parsed) === null, '（**假阳性**）⇒ 读函数判 null（= 从未使用）')
  }

  console.log('[T5] 【行为级牙齿】经 parse 落库的记录能被召回（updatedAt 过期 + 旧字段新鲜）')
  {
    const table = domain.table('entries')
    // 与生产一致：先过 valueSchema.parse，再落库（假域本身不跑 schema）
    await table.put('schema-legacy-recent', parse({ content: 'the schemaprobe rule is alpha', tags: ['schemaprobe'], createdAt: ago(50), updatedAt: ago(40), source: 'tool', last_used_at: LEGACY_TS }))
    await table.put('schema-never-stale', parse({ content: 'the schemaprobe rule is beta', tags: ['schemaprobe'], createdAt: ago(50), updatedAt: ago(40), source: 'tool' }))
    const r = await tools.memory_recall.execute({ query: 'schemaprobe', limit: 20 })
    const ids = r.entries.map((e) => e.id)
    check(ids.includes('schema-legacy-recent'),
      `旧字段新鲜者被召回（实测 ${JSON.stringify(ids)}；改前树 parse 剥字段 ⇒ 该条退化成「从没用过 + updatedAt 过期」⇒ 不召回 ⇒ 必红）`)
    check(!ids.includes('schema-never-stale'),
      '（**假阳性**：两树都过）缺字段且 updatedAt 过期 ⇒ 仍不召回（兼容读不放宽窗口）')
  }

  console.log('[T6] 写入面：回写不覆盖旧字段、只刷新 `last_usage`')
  {
    await sleep(400) // 等 scheduleUsageBump 的异步写落盘
    const rec = domain.table('entries').get('schema-legacy-recent')
    check(!!rec && rec.last_used_at === LEGACY_TS,
      `回写后旧字段原样（实测 ${rec && rec.last_used_at}；改前树该字段在 parse 时已被剥 ⇒ undefined ⇒ 必红）`)
    check(!!rec && !!rec.last_usage && Math.abs(Date.now() - new Date(rec.last_usage).getTime()) < 120000,
      `（**连带牙齿**：T5 的后果 —— 改前树该条根本没被交付，故不会回写 ⇒ 也红）既有写路径仍只刷新 last_usage（实测 ${rec && rec.last_usage}）`)
  }

  console.log('[T7] 反回归护栏：未声明键仍被 strip（没有为修本缺陷关掉 strip）')
  {
    const parsed = parse({ content: 'z', tags: [], createdAt: ago(1), updatedAt: ago(1), bogus_legacy_key: 'should-not-survive' })
    check(!('bogus_legacy_key' in parsed), '（**假阳性**：两树都过）未声明键仍被剥掉（只放宽了这一个字段）')
    check(parsed.usage_count === 0 && parsed.status === 'active', '（**假阳性**）既有默认值仍在（usage_count=0 / status=active）')
  }
  console.log('[T8] 【t208 核心牙齿】原始记录**没有**该字段时，写回序列化结果**不含**该键')
  {
    // 单元级：逐字模拟 scheduleUsageBump 的 `table.put(id, { ...cur, usage_count, last_usage })`
    const parsedMissing = parse({ content: 'm', tags: [], createdAt: ago(3), updatedAt: ago(3) })
    const written = { ...parsedMissing, usage_count: 1, last_usage: new Date().toISOString() }
    const writtenJson = JSON.stringify(written)
    check(!('last_used_at' in written) && !writtenJson.includes('last_used_at'),
      `（改前树 .default('') ⇒ parse 补出 "" ⇒ 写回多出 "last_used_at":"" ⇒ 必红）写回对象不含该键（实测 ${writtenJson.slice(0, 110)}…）`)
    // 行为级：经真实回写路径（内存召回 → scheduleUsageBump）后再读同一条记录
    const table = domain.table('entries')
    await table.put('schema-missing-key', parse({ content: 'the schemaprobe note is delta', tags: ['schemaprobe'], createdAt: ago(3), updatedAt: ago(3), source: 'tool' }))
    await sleep(50)
    await tools.memory_recall.execute({ query: 'schemaprobe', limit: 20 })
    await sleep(400)
    const stored = table.get('schema-missing-key')
    check(!!stored && !('last_used_at' in stored),
      `（同一颗牙齿的行为级形态）回写后磁盘记录仍**不含**该键（实测 hasKey=${!!stored && ('last_used_at' in stored)}；改前树必红）`)
    const storedLegacy = table.get('schema-legacy-recent')
    check(!!storedLegacy && storedLegacy.last_used_at === LEGACY_TS, '（原 T6 的「真实旧值被保留」断言在此**再点名一次**，T6 本身未改动）')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T206 SCHEMA-LAST-USED-AT TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
