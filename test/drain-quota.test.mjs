// 阶段 A：drain 每日模型尝试上限（GPT §14.2：实际尝试数 ≤ N）
// 与 old pipelinePhase1 的单会话额度不同，这里验证 drain 消费时就地限额：
// cap=1 且有两个可提炼(≥60字符)的 job 时，drain 只消化 1 个（第 2 个仍 pending）。
// 存储访问：读 dsh_rollout 的 stage1_jobs 表（jobListOf），预置用 seedJob。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

let llmCalls = 0
let extractionCalls = 0
let consolidationCalls = 0
const msgEvent = (id, text) => ({ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [msgEvent(id, 'this is a long enough message for session ' + id + ' that definitely reaches the model extraction step now')] })
const EXTRACTION = { rollout_summary: 'sum', raw_memory: 'raw', slug: 'note', keywords: '', title: '' }
const CONSOLIDATION = { memory_summary: 'v1\n## consolidated', registry: '# MEMORY.md\nok' }
const llmMock = { stream: (opts) => {
  llmCalls++
  // 区分提炼(extraction)与整合(consolidation)：H3 自动触发会在产出后跑一次真 Phase 2
  if (opts && String(opts.system).includes('memory-extraction')) extractionCalls++
  else consolidationCalls++
  const payload = (opts && String(opts.system).includes('memory-extraction')) ? EXTRACTION : CONSOLIDATION
  return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(payload) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
} }
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : k === 'sessionQuery' ? { readSession } : undefined),
})

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-quota-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const readJobs = (d) => jobListOf(d)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, { maxModelAttemptsPerDay: 1 })
  assert.ok(ctx.tools['memory__stage1_drain'], 'drain tool registered')

  await seedJob(domain, 's1', 'w1')
  await seedJob(domain, 's2', 'w2')

  const res = await ctx.tools['memory__stage1_drain'].execute({})
  const jobs = readJobs(domain)
  check(res.processed === 1, 'only 1 job consumed because daily attempt cap = 1')
  check(extractionCalls === 1, 'only 1 extraction LLM attempt made (cap enforced)')
  // H3: drain 产出后自动触发真 Phase 2 整合（一次额外 consolidation 调用）
  check(consolidationCalls === 1, 'auto-triggered exactly 1 consolidation call after output')
  check(jobs['s1::w1'] && jobs['s1::w1'].status === 'succeeded_with_output', 's1 was distilled (consumed the single attempt)')
  check(jobs['s2::w2'] && jobs['s2::w2'].status === 'pending', 's2 stays pending — quota reached, not over-consumed')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL DRAIN-QUOTA TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
