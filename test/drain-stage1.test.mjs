// 阶段 A · 接线②：drainStage1Jobs 消费持久 pending 作业（领取→提炼→提交）
// 验证：memory__stage1_drain 工具触发 drain，消费表里到期的 pending job；
// 无会话消息（raw 空）→ succeeded_no_output，作业被提交完成。不改变现有自动管线。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const tmp = path.join(os.tmpdir(), 'dsh-rollout-drain-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const readJobs = (domain) => jobListOf(domain)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  const { ctx, domain } = makeCtx({ get: () => undefined }) // no sessionQuery, no llm -> raw empty -> no_output
  await apply(ctx, {})
  assert.ok(ctx.tools['memory__stage1_drain'] && typeof ctx.tools['memory__stage1_drain'].execute === 'function', 'memory__stage1_drain tool registered')

  // Seed one due pending job (available now) into the stage1_jobs table.
  await seedJob(domain, 's1', 'wm-v1')

  const res = await ctx.tools['memory__stage1_drain'].execute({})
  console.log('  drain processed:', res.processed)
  const jobs = readJobs(domain)
  check(res.processed >= 1, 'drain processed at least one job')
  const job = jobs['s1::wm-v1']
  check(job && (job.status === 'succeeded_no_output' || job.completed_at), 'the drained job was submitted (no_output, no raw content)')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL DRAIN-STAGE1 TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
