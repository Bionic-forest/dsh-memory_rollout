// t121：每日预算「日界」= **本机时区**（本地 00:00 换日），不再是 UTC 日。
//
// 手法（可判别、不依赖跑测试时的真实时钟）：
//   1) 先把 `process.env.TZ` 固定为 `Asia/Shanghai`（UTC+8）——必须在任何 Date 使用 / import 之前；
//      Node 会即时生效（本文件开头断言 offset === -480，前提不成立就直接失败，避免"看起来通过"）。
//   2) 再把**全局 Date 冻结**在一个「UTC 日 ≠ 本地日」的时刻：
//      `2026-09-12T17:30:00Z` → 本地 = 2026-09-13 01:30。
//      旧实现 `toISOString().slice(0,10)` 会写 **2026-09-12**；新实现必须写 **2026-09-13**。
//   3) 用**真实 drain**（`memory__stage1_drain`）观察 `stage1_meta.runDay` 落在哪一天，
//      并覆盖「跨日 → modelAttemptsToday 归零 / 恢复领取」与「本地 00:00 边界」。
//
// 存储访问：dsh_rollout 的 stage1_jobs / stage1_meta（helpers 的 seedJob / setMeta / metaOf）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TZ = 'Asia/Shanghai' // ⚠ 必须在 import / 任何 Date 之前

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-daykey-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

// ── 冻结时钟：只冻结「现在」，其余 Date 行为原样（可改 NOW 以跨过本地午夜）──────
const RealDate = Date
const localMidnightPlus8 = (isoLocal) => RealDate.parse(isoLocal + '+08:00') // 便于写"本地时刻"
let NOW = RealDate.parse('2026-09-12T17:30:00Z') // 本地 2026-09-13 01:30
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(NOW)
    else super(...args)
  }
  static now() {
    return NOW
  }
}
globalThis.Date = FrozenDate

const { makeCtx, seedJob, setMeta, metaOf, jobListOf } = await import('./lib/helpers.mjs')
const { apply } = await import('../lib/index.js')

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const pad = (n) => String(n).padStart(2, '0')
/** 独立的「本地日」参考实现（与被测实现同口径，但由测试自己算，避免自证） */
const localDayOf = (ms) => { const d = new RealDate(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const utcDayOf = (ms) => new RealDate(ms).toISOString().slice(0, 10)

// ── [A] 前提：TZ 生效（否则本测试无法判别，直接失败）────────────────────────
console.log('\n[A] TZ 前提')
{
  const d = new RealDate(NOW)
  const off = d.getTimezoneOffset()
  check(off === -480, `process.env.TZ=Asia/Shanghai 已生效（offset=${off}，期望 -480）`)
  check(localDayOf(NOW) === '2026-09-13', `固定时刻的本地日 = ${localDayOf(NOW)}（期望 2026-09-13）`)
  check(utcDayOf(NOW) === '2026-09-12', `同一时刻的 UTC 日 = ${utcDayOf(NOW)}（期望 2026-09-12 → 两者可判别）`)
  check(localDayOf(NOW) !== utcDayOf(NOW), '本地日 ≠ UTC 日（判别力成立）')
}

// ── [B] 日界归本机：旧 runDay（UTC 日）→ 新 runDay（本地日）并归零、恢复领取 ────
console.log('\n[B] 日界改本机：runDay 由 UTC 日迁到本地日 + modelAttemptsToday 归零 + 恢复领取')
{
  const { ctx, domain } = makeCtx({ get: () => undefined }) // 无 llm/sessionQuery → 不烧配额
  await apply(ctx, {})
  assert.ok(ctx.tools['memory__stage1_drain'], 'drain tool registered')

  // 预置：runDay 恰是「同一时刻的 UTC 日」且当日额度已满 —— 这正是旧口径会写下的值。
  await setMeta(domain, { runDay: utcDayOf(NOW), modelAttemptsToday: 999, lastSuccessWatermark: '', lastPhase2At: '', phase2_last_error: '' })
  await seedJob(domain, 'daykeyLocal', 'wm-daykey-local', { status: 'pending', availableAt: new RealDate(NOW).toISOString() })

  const res = await ctx.tools['memory__stage1_drain'].execute({})
  const m = metaOf(domain)
  const job = jobListOf(domain)['daykeyLocal::wm-daykey-local']
  console.log('  drain processed:', res.processed, '| runDay:', m.runDay, '| modelAttemptsToday:', m.modelAttemptsToday)

  check(/^\d{4}-\d{2}-\d{2}$/.test(String(m.runDay)), `runDay 仍是 YYYY-MM-DD 形状（${m.runDay}）`)
  check(m.runDay === '2026-09-13', 'runDay = 本地日 2026-09-13（**本机时区口径**）')
  check(m.runDay !== '2026-09-12', 'runDay ≠ 同一时刻的 UTC 日 2026-09-12（**已不再是 UTC 口径**）')
  check(m.modelAttemptsToday === 0, 'modelAttemptsToday 归零（旧 runDay 不等 → 跨日重置）')
  check(res.processed >= 1, '重置后恢复领取（未被旧日期的满额卡住）')
  check(job && job.status !== 'pending' && !!job.completed_at, '该作业被本轮 drain 消费')
}

// ── [C] 同日不重置：runDay 已是本地日 → 不归零 ────────────────────────────────
console.log('\n[C] 同一本地日内不重置（只在跨日时归零）')
{
  const { ctx, domain } = makeCtx({ get: () => undefined })
  await apply(ctx, {})
  await setMeta(domain, { runDay: localDayOf(NOW), modelAttemptsToday: 5, lastSuccessWatermark: '', lastPhase2At: '', phase2_last_error: '' })
  await seedJob(domain, 'daykeySameDay', 'wm-daykey-same', { status: 'pending', availableAt: new RealDate(NOW).toISOString() })

  const res = await ctx.tools['memory__stage1_drain'].execute({})
  const m = metaOf(domain)
  console.log('  drain processed:', res.processed, '| runDay:', m.runDay, '| modelAttemptsToday:', m.modelAttemptsToday)

  check(m.runDay === localDayOf(NOW), 'runDay 保持为本地日（未发生跨日）')
  check(m.modelAttemptsToday >= 5, `modelAttemptsToday 未被重置（=${m.modelAttemptsToday}，期望 ≥5）`)
}

// ── [D] 本地 00:00 边界：跨过本地午夜即换日（而不是 UTC 午夜）────────────────
console.log('\n[D] 本地 00:00 边界：本地 23:59:59 → 次日 00:00:01 即换日')
{
  const { ctx, domain } = makeCtx({ get: () => undefined })
  await apply(ctx, {})

  // 本地 2026-09-13 23:59:59（+08）
  NOW = localMidnightPlus8('2026-09-13T23:59:59')
  const beforeDay = localDayOf(NOW)
  await setMeta(domain, { runDay: beforeDay, modelAttemptsToday: 7, lastSuccessWatermark: '', lastPhase2At: '', phase2_last_error: '' })
  await seedJob(domain, 'daykeyBeforeMidnight', 'wm-before-mid', { status: 'pending', availableAt: new RealDate(NOW).toISOString() })
  await ctx.tools['memory__stage1_drain'].execute({})
  const m1 = metaOf(domain)
  check(m1.runDay === beforeDay, `本地 23:59:59 时 runDay 仍是 ${beforeDay}`)
  check(m1.modelAttemptsToday >= 7, `本地 23:59:59 时不重置（=${m1.modelAttemptsToday}）`)

  // 本地 2026-09-14 00:00:01（+08）→ 只过了 2 秒，但已跨本地日
  NOW = localMidnightPlus8('2026-09-14T00:00:01')
  const afterDay = localDayOf(NOW)
  await seedJob(domain, 'daykeyAfterMidnight', 'wm-after-mid', { status: 'pending', availableAt: new RealDate(NOW).toISOString() })
  const res = await ctx.tools['memory__stage1_drain'].execute({})
  const m2 = metaOf(domain)
  console.log('  before:', beforeDay, '→ after:', m2.runDay, '| modelAttemptsToday:', m2.modelAttemptsToday)
  check(beforeDay === '2026-09-13' && afterDay === '2026-09-14', '两个时刻跨过的是**本地**午夜（09-13 → 09-14）')
  check(m2.runDay === afterDay, `跨本地午夜后 runDay = ${afterDay}（本地日界）`)
  check(m2.modelAttemptsToday === 0, 'modelAttemptsToday 在本地 00:00 处归零')
  check(res.processed >= 1, '跨日重置后恢复领取')
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n${failed === 0 ? 'ALL DAYKEY LOCAL-TIMEZONE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
