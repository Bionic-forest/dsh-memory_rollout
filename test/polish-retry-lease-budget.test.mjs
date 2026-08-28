// 返工复核反例固化（P0-1 / P0-4 / P0-5）：用「真实 drain」而非纯函数验证三个反例。
//   - P0-1：`failed_retryable` 到期（available_at<=now）被 drain 再次领取并消费；
//           未到期（available_at 未来）的 pending 不被提前领取（保持 pending）。
//   - P0-4：外部 owner 未过期但非当前 boot（lease_owner 含非当前 boot_id）的 `running`
//           在启动/drain 时被回收为 pending 并立即消费（无 60s 卡死窗口）；
//           「租约过期」同样被回收。
//   - P0-5：stage1_meta 的 modelAttemptsToday 在跨日（runDay 变化）时归零并恢复领取
//           （此前只测了当日 cap 上界）。
// 存储访问：dsh_rollout 的 stage1_jobs / stage1_meta 表（helpers 的 seedJob / setMeta / metaOf）。
// 注意：dsHome() 在模块加载时一次性捕获 process.env.DSH_HOME，因此必须在 import 前设置单一
// 隔离 home（OS tmp），三个 scope 共享该 home（fake domain 表彼此独立，内存文件幂等）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedJob, setMeta, metaOf } from './lib/helpers.mjs'

const HOME = path.join(os.tmpdir(), 'dsh-rollout-polish-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply } = await import(PLUGIN)

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10)
let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── P0-1：到期 failed_retryable 被真实再次领取；未到期不被提前领取 ─────────────
console.log('\n[P0-1] failed_retryable 到期再次领取 / 未到期不提前领取')
{
  const { ctx, domain } = makeCtx({ get: () => undefined }) // no sessionQuery/llm -> raw empty -> no_output
  await apply(ctx, {})
  assert.ok(ctx.tools['memory__stage1_drain'] && typeof ctx.tools['memory__stage1_drain'].execute === 'function', 'drain tool registered')

  const past = new Date(Date.now() - 5000).toISOString()
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  // A：到期 failed_retryable（可再次领取）；B：未到期 pending（available_at 在未来）。
  await seedJob(domain, 'retryDue', 'wm-retry', { status: 'failed_retryable', availableAt: past, attemptCount: 1 })
  await seedJob(domain, 'pendingFuture', 'wm-future', { status: 'pending', availableAt: future })

  const res = await ctx.tools['memory__stage1_drain'].execute({})
  const jobs = jobListOf(domain)
  console.log('  drain processed:', res.processed)
  const retryJob = jobs['retryDue::wm-retry']
  const futureJob = jobs['pendingFuture::wm-future']
  check(res.processed >= 1, 'drain processed at least one job')
  check(retryJob && retryJob.status !== 'pending' && retryJob.status !== 'failed_retryable' && !!retryJob.completed_at, 'due failed_retryable RE-claimed and consumed (completed_at set, not left retryable)')
  check(futureJob && futureJob.status === 'pending', 'not-yet-due pending job NOT claimed early (stays pending)')
}

// ── P0-4：外部 owner 未过期（非当前 boot）的 running 被立即回收消费；「租约过期」同 ─
console.log('\n[P0-4] 外部 owner 未过期 + 租约过期 都在启动/drain 被回收为 pending 并消费')
{
  const { ctx, domain } = makeCtx({ get: () => undefined })
  const now = Date.now()
  const past = new Date(now - 5000).toISOString()
  const future = new Date(now + 5 * 60 * 1000).toISOString() // 未来，5 分钟后才过期 —— 若不被回收，会卡 60s
  // F：外部 owner 未过期（lease_owner 非当前 boot_id）→ 靠 foreign 判定立即回收。
  await seedJob(domain, 'foreignNotExpired', 'wm-f', { status: 'running', availableAt: now, leaseOwner: 'boot-foreign', leaseExpiresAt: future, createdAt: past })
  // E：租约过期（任何 owner）→ 靠 expired 判定回收。
  await seedJob(domain, 'leaseExpired', 'wm-e', { status: 'running', availableAt: past, leaseOwner: 'w0', leaseExpiresAt: past, createdAt: past })

  // 预置在 apply 之前 → 启动恢复+排程 drain 必须处理它们（模拟 DSH 崩溃重启）。
  await apply(ctx, {})
  await sleep(100)

  const jobs = jobListOf(domain)
  const f = jobs['foreignNotExpired::wm-f']
  const e = jobs['leaseExpired::wm-e']
  console.log('  foreign:', f && f.status, '| expired:', e && e.status)
  check(f && f.status !== 'running', 'foreign-owner-not-expired running job reclaimed (no longer running)')
  check(f && f.status === 'succeeded_no_output' && !!f.completed_at, 'foreign-owner-not-expired job consumed immediately (no 60s deadlock window)')
  check(e && e.status !== 'running', 'lease-expired running job reclaimed (no longer running)')
  check(e && e.status === 'succeeded_no_output' && !!e.completed_at, 'lease-expired job consumed')
}

// ── P0-5：跨日 modelAttemptsToday 归零并恢复领取（此前只测当日 cap）─────────────
console.log('\n[P0-5] stage1_meta.modelAttemptsToday 跨日（runDay 变化）归零并恢复领取')
{
  const { ctx, domain } = makeCtx({ get: () => undefined })
  await apply(ctx, {})
  assert.ok(ctx.tools['memory__stage1_drain'], 'drain tool registered')

  // 预置「旧的一天 + 当日额度已打满」：若不做跨日归零，budget 会卡住（>= cap）不领取。
  await setMeta(domain, { runDay: '2000-01-01', modelAttemptsToday: 999, lastSuccessWatermark: '', lastPhase2At: '', phase2_last_error: '' })
  await seedJob(domain, 'crossDay', 'wm-cross', { status: 'pending', availableAt: new Date().toISOString() })

  const res = await ctx.tools['memory__stage1_drain'].execute({})
  const m = metaOf(domain)
  const jobs = jobListOf(domain)
  const job = jobs['crossDay::wm-cross']
  console.log('  drain processed:', res.processed, '| runDay:', m.runDay, '| modelAttemptsToday:', m.modelAttemptsToday)
  check(res.processed >= 1, 'drain resumed claiming despite stale full budget (cross-day reset)')
  check(m.runDay === dayKey(), 'meta.runDay updated to today after cross-day reset')
  check(m.modelAttemptsToday === 0, 'modelAttemptsToday reset to 0 (was 999) — no stale cap carried over')
  check(job && job.status !== 'pending' && !!job.completed_at, 'cross-day job consumed by the resumed drain')
}

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n${failed === 0 ? 'ALL POLISH RETRY/LEASE/BUDGET TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
