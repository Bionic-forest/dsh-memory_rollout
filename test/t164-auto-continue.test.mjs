// t164（R1 §5.2）：**自动续跑** —— 21 条来源，只触发一次整合，此后不调工具、不建会话、不重启，
// 剩余来源必须**自动**处理完；且续跑**有界**（区分「立即可处理」与「未来退避」，不忙循环）。
//
// 这一条补的正是 S0-1 的验收缺口：旧 `nextPhase2WakeAt` 只扫**已创建作业**，看不到"尚未绑定"的
// 残余来源 ⇒ 第一批跑完后第 21 条没有任何唤醒入口（t147 的验证报告里是我**手动**又调了一次
// `memory__phase2_integrate` 才跑完的）。
//
// 观测口径：
//   - 工具只调用 **1 次**（之后完全不再调工具）；
//   - 不建会话（本测试不接触 sessions）；
//   - 不重启（同进程内）；
//   - 只等真实定时器（`schedulePhase2Wake` 的 0ms 唤醒）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const HOME = path.join(os.tmpdir(), 't164-autocont-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

let failed = 0
const check = (c, m) => { if (c) console.log('  ✓ ', m); else { failed++; console.error('  ✗ ', m) } }

const N = 21
const markerOf = (i) => `T164AUTO-${String(i).padStart(2, '0')}`

let llmCalls = 0
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm'
    ? {
        stream: () => {
          llmCalls++
          const payload = JSON.stringify({
            memory_summary: 'v1\n## 索引\n- 结论 T164A → memories/x.md',
            registry: '# MEMORY.md\n- 结论 T164A',
          })
          return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
        },
      }
    : k === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      : undefined),
})

for (let i = 1; i <= N; i++) {
  await seedOutput(domain, 't164a-' + String(i).padStart(2, '0'), { rollout_summary: markerOf(i), selected_for_phase2: false })
}
await apply(ctx, {})

console.log(`\n[t164 自动续跑] 预置 ${N} 条来源，**只触发一次**整合，然后不再调工具`)
const first = await ctx.tools['memory__phase2_integrate'].execute({})
console.log('  第一次（也是唯一一次）工具调用结果:', JSON.stringify({ ran: first.ran, ok: first.ok, batchId: first.batchId, wake: first.wake }))

const consumedAfterFirst = [...domain.table('stage1_outputs').entries()].filter(([, o]) => o && o.selected_for_phase2 === true).length
console.log(`  第一次调用后已消费 = ${consumedAfterFirst}（期望 ≤ 20 —— 剩下的靠自动续跑）`)
const callsAfterFirst = llmCalls

// 只等定时器：不调任何工具、不建会话、不重启
const BOUND_MS = 4000
const t0 = Date.now()
let waited = 0
while (Date.now() - t0 < BOUND_MS) {
  await new Promise((r) => setTimeout(r, 25))
  waited += 25
  const done = [...domain.table('stage1_outputs').entries()].filter(([, o]) => o && o.selected_for_phase2 === true).length
  if (done === N) break
}
const elapsed = Date.now() - t0

const outs = [...domain.table('stage1_outputs').entries()]
const consumed = outs.filter(([, o]) => o && o.selected_for_phase2 === true).length
const stillUnbound = outs.filter(([, o]) => o && o.selected_for_phase2 !== true && !o.phase2_batch_id).length
const jobs = [...domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v }))
console.log(`  自动续跑：${elapsed}ms 内已消费 ${consumed}/${N}；批次数 = ${jobs.length}；llmCalls = ${llmCalls}（首次调用时 = ${callsAfterFirst}）`)
console.log(`  批次状态: ${JSON.stringify(jobs.map((j) => ({ id: j.id, status: j.status, n: (j.input_ids || []).length })))}`)

check(consumedAfterFirst <= 20, `第一次调用只消费 ≤ 20 条（实测 ${consumedAfterFirst}）`)
check(consumed === N, `**自动**把 ${N} 条全部处理完（实测 ${consumed}/${N}，只等定时器 ${elapsed}ms）`)
check(stillUnbound === 0, `没有留下的未绑定残余（实测 ${stillUnbound}）`)
check(llmCalls > callsAfterFirst, `续跑确实又跑了真实批次（llmCalls ${callsAfterFirst} → ${llmCalls}），而不是靠工具调用`)
// 有界性：每次续跑都消费 ≥1 条 ⇒ 批次数 ≤ N（远小于忙循环的量级）
check(jobs.length <= N, `批次数有上界（实测 ${jobs.length} ≤ ${N}）⇒ 不是忙循环`)
check(jobs.every((j) => j.status === 'committed'), `每个批都归终态 committed（退出条件成立）：${JSON.stringify(jobs.map((j) => j.status))}`)

// 退出条件：全部消费完之后，再等一会儿不应再产生新批（不忙循环）
const jobsBefore = jobs.length
await new Promise((r) => setTimeout(r, 300))
const jobsAfter = [...domain.table('phase2_jobs').entries()].length
check(jobsAfter === jobsBefore, `残余清零后不再新开批（${jobsBefore} → ${jobsAfter}）⇒ 退出条件生效`)
check(llmCalls === jobsBefore, `模型调用次数 == 批次数（每批恰一次，无空转重试）：${llmCalls} vs ${jobsBefore}`)

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n${failed === 0 ? 'ALL T164 AUTO-CONTINUE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
