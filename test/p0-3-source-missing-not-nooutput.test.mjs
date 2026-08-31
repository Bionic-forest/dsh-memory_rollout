// P0 #3 反例：session source 缺失时不得 succeeded_no_output，须有明确错误/终态原因。
// 旧实现：读源抛错/损坏返回空 raw → extractWithOutcome('') → succeeded_no_output（无原因），
// 导致「源真的没了」也伪装成成功 no-op。本次把 source_missing/source_unavailable 与 no-output 分离。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const tmp = path.join(os.tmpdir(), 'dsh-p0-3-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })
process.env.DSH_HOME = tmp

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  // readSession 抛错（会话已删/服务不可用），模拟持久源缺失。
  const readSession = async () => { throw new Error('session service unavailable') }
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'sessionQuery' ? { readSession } : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  })
  await apply(ctx, { maxModelAttemptsPerDay: 100, recallLimit: 20 })
  await seedJob(domain, 's1', 'wm-missing')
  const res = await ctx.tools['memory__stage1_drain'].execute({})
  check(res.processed >= 1, 'drain processed the job')
  const job = Object.values(jobListOf(domain)).find((x) => String(x.session_id) === 's1')
  check(job && job.status !== 'succeeded_no_output', 'source-missing session is NOT reported as succeeded_no_output')
  check(job && (job.status === 'failed_retryable' || job.status === 'failed_terminal'), 'source-missing session has an explicit error/terminal status: ' + (job && job.status))
  check(job && /source unavailable/.test(String(job.last_error)), 'job records a source_unavailable error reason')
  check(job && !job.completed_at, 'source-unavailable job is retryable (not completed)')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL P0-3 SOURCE-MISSING TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
