// 阶段 A · 验收：apply() 启动即恢复 + 排程消费（H1 修复）
// 此前 stage1Recover 只在测试里被直接调；apply() 启动只 integrate()，既不回收过期
// running，也不 setImmediate(drainStage1Jobs)。因此 DSH 在提炼中崩溃/重启后，磁盘
// 遗留的过期 running 作业永不被回收、永不消费 → 丢任务。
// 本测试：向 dsh_rollout 表预置一个「过期 running」的 job，然后通过 apply() 启动，
// 验证该 job 被自动回收为 pending 并被 drain 自动消费（最终不再 running）。
// 存储访问：读 dsh_rollout 的 stage1_jobs 表（jobListOf），预置用 seedJob。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply } = await import(PLUGIN)

const { ctx, domain } = makeCtx({ get: () => undefined }) // no sessionQuery/llm -> the expired running job reduces to no_output

const tmp = path.join(os.tmpdir(), 'dsh-rollout-startup-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const readJobs = (d) => jobListOf(d)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

// Pre-seed an EXPIRED running job (as if DSH crashed mid-distill) BEFORE startup,
// so apply()'s startup recovery + drain must handle it.
const now = Date.now()
const past = new Date(now - 5000).toISOString()
await seedJob(domain, 's1', 'wm1', { status: 'running', availableAt: past, leaseExpiresAt: past, leaseOwner: 'w1', createdAt: past })

await apply(ctx, {})

// Let the startup setImmediate(drainStage1Jobs) run and settle (drain is microtask-based,
// so a small real-time delay is deterministic and non-flaky).
await new Promise((r) => setTimeout(r, 100))

const jobs = readJobs(domain)
const job = jobs['s1::wm1']
check(!!job, 'seeded job survives apply() startup')
check(job && job.status !== 'running', 'apply() startup no longer leaves the expired job running')
check(job && job.status === 'succeeded_no_output', 'apply() startup drained the recovered job to completion')
check(job && !!job.completed_at, 'recovered job was consumed (completed_at set)')

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`\n${failed === 0 ? 'ALL STARTUP-RECOVER TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
