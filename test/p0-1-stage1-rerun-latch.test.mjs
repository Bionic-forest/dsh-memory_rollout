// P0 #1 反例：drain 收尾窗口入队，无新外部事件仍自动完成（Stage1 busy rerun latch）。
// 旧实现：drainStage1Jobs 在 stage1Busy 时直接 return（不记录补跑标记），
// 若作业恰好在「claim 循环已返回无作业、finally 未释放 busy」的窗口入队，且其触发被
// busy 拦截返回 0，则该作业永远不被消费。本反例验证 latch 修复后 B 自动完成。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const tmp = path.join(os.tmpdir(), 'dsh-p0-1-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })
process.env.DSH_HOME = tmp

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return false
}

let gateEntered = false
let releaseGate = null
const gate = () => new Promise((r) => { releaseGate = r })
const longMsg = (id) => 'this is a reasonably long message for session ' + id + ' that is long enough to trigger the model extraction step'
const msgEvent = (id) => ({ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: longMsg(id) }] } })
const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [msgEvent(id)] })
const EXTRACTION_A = { rollout_summary: 'summary of session a', raw_memory: 'raw-a', slug: 'a', keywords: 'a', title: 'A' }
const CONSOLIDATION = { memory_summary: 'v1\n## auto consolidated', registry: '# MEMORY.md\nauto registry' }
const llmMock = {
  stream: (opts) => {
    const isExtract = String(opts && opts.system).includes('memory-extraction')
    const payload = isExtract ? EXTRACTION_A : CONSOLIDATION
    return {
      async *[Symbol.asyncIterator]() {
        if (!isExtract) { gateEntered = true; await gate() }
        yield { type: 'text-delta', text: JSON.stringify(payload) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

try {
  const { ctx, domain } = makeCtx({
    get: (k) =>
      k === 'llm' ? llmMock
        : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : k === 'sessionQuery' ? { readSession } : undefined,
  })
  await apply(ctx, { maxModelAttemptsPerDay: 100, recallLimit: 20 })
  assert.ok(ctx.tools['memory__stage1_drain'], 'stage1_drain tool registered')

  await seedJob(domain, 'a', 'wm-a')
  // 第一次 drain：A 提炼成功 → 自动 phase2 → 阻塞在 consolidation 门（stage1Busy 仍 true）。
  const drainPromise = ctx.tools['memory__stage1_drain'].execute({})
  const entered = await waitUntil(() => gateEntered, 3000)
  check(entered, 'drain A reached the phase-2 consolidation gate (stage1 busy)')

  // 收尾窗口入队 B：此时 drain A 的 claim 循环已返回无作业、finally 未释放 busy。
  await seedJob(domain, 'b', 'wm-b')
  // 触发第二次 drain（模拟 B 入队时的 scheduleStage1Drain）——应被 busy 拦截并记录 rerun latch。
  const p2 = await ctx.tools['memory__stage1_drain'].execute({})
  check(p2 && p2.processed === 0, 'second drain while busy is swallowed (processed=0) but latched')

  releaseGate()
  await drainPromise
  const autoDone = await waitUntil(() => {
    const b = Object.values(jobListOf(domain)).find((x) => String(x.session_id) === 'b')
    return b && (b.status === 'succeeded_with_output' || b.status === 'succeeded_no_output' || b.status === 'failed_terminal')
  }, 4000)
  const bJob = Object.values(jobListOf(domain)).find((x) => String(x.session_id) === 'b')
  check(autoDone, 'B auto-completed without a new external drain event (rerun latch)')
  check(bJob && bJob.status === 'succeeded_with_output', 'B reached a terminal succeeded_with_output')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL P0-1 STAGE1 RERUN LATCH TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
