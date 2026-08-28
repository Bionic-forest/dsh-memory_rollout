// 阶段 A 验收：重启后作业不丢、可继续消费（总纲 §15 完成标志）
// 组合 apply() 启动恢复（回收过期 running→pending）+ drainStage1Jobs（继续消费）。
// 存储访问：读 dsh_rollout 的 stage1_jobs 表（jobListOf），预置用 seedJob。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const { ctx, domain } = makeCtx({ get: () => undefined }) // no sessionQuery/llm -> drained job reduces to no_output

const tmp = path.join(os.tmpdir(), 'dsh-rollout-restart-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const readJobs = (d) => jobListOf(d)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  // Pre-restart state: one running job whose lease expired + one pending job.
  // Seed BEFORE apply() so apply()'s startup recovery (recoverStage1Jobs) reclaims the
  // expired running job, and the scheduled setImmediate(drainStage1Jobs) consumes both.
  const now = Date.now()
  const past = new Date(now - 5000).toISOString()
  await seedJob(domain, 's1', 'wm1', { status: 'running', availableAt: past, leaseExpiresAt: past, leaseOwner: 'w1', createdAt: past })
  await seedJob(domain, 's2', 'wm2', { status: 'pending' })

  await apply(ctx, {})

  // apply() startup recovery ran synchronously (before the scheduled setImmediate drain),
  // so right after apply the expired running job is back to pending and the pending job is untouched.
  const after = readJobs(domain)
  check(after['s1::wm1'].status === 'pending', 'expired running job -> pending after restart')
  check(after['s2::wm2'].status === 'pending', 'pending job survives restart untouched')

  // Let the scheduled startup setImmediate(drainStage1Jobs) run and settle.
  await new Promise((r) => setTimeout(r, 100))
  const final = readJobs(domain)
  check(final['s1::wm1'].completed_at || final['s1::wm1'].status !== 'pending', 'recovered job was submitted')
  check(final['s2::wm2'].completed_at, 'pending job was submitted')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PIPELINE-RESTART-STYLE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
