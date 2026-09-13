// t178：启动期「写锁竞争」不该把整次调度判死、更不该记成 error。
//
// 背景：`withWrite` **不是队列** —— `writeBusy` 为真时直接抛 `another write is in progress — retry shortly`。
// 启动块里同时起多条写路径（setImmediate 的 stage1 drain / 0ms 的 phase2 定时器 / 被 await 的
// reconcilePhase2Bindings）⇒ 落败者整次 pass 被丢掉。而**落败路径上没有重新武装**（catch 只 log）
// ⇒ 若没有别的触发（新会话事件等），该 pass 的工作会被**拖延**到下一次触发。
//
// 修法：把"抢锁失败"识别为**可重试**（短退避 + 有界），成功即清零；并把落败日志降为 warn。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedJob, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const mod = await import(PLUGIN)
const { apply, isWriteConflictError } = mod

let failed = 0
const check = (c, m) => { if (c) console.log('  ✓ ', m); else { failed++; console.error('  ✗ ', m) } }

// ── ① 冲突识别（纯函数） ──
console.log('\n[t178 ①] 写锁冲突的识别')
check(
  isWriteConflictError(new Error('[dsh-memory_rollout] another write is in progress — retry shortly')) === true,
  '精确消息 ⇒ 判为冲突（可重试）',
)
check(isWriteConflictError({ message: 'another write is in progress — retry shortly' }) === true, '对象形态（message 属性）也认')
check(isWriteConflictError(new Error('boom')) === false, '普通错误 ⇒ 不算冲突（仍按 error 记）')
check(isWriteConflictError(null) === false, 'null / undefined 不炸')

// ── ② 启动期多写路径竞争：不记 error + 工作仍被处理 ──
console.log('\n[t178 ②] 启动期竞争：不把落败记成 error，且工作不丢')
const HOME = path.join(os.tmpdir(), 't178-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(path.join(HOME, 'memories'), { recursive: true })
process.env.DSH_HOME = HOME

let llmCalls = 0
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm'
    ? {
        stream: () => {
          llmCalls++
          const payload = JSON.stringify({ memory_summary: 'v1\n## 索引\n- 结论 T178 → memories/x.md', registry: '# MEMORY.md\n- 结论 T178' })
          return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
        },
      }
    : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
})

// 制造"启动期多写路径几乎同时起"的局面：
//   · 一个**已到期**的 stage1 job ⇒ 启动时 scheduleStage1Wake 会武装、且 drain 会去领它；
//   · 未消费且未绑定的 outputs ⇒ armPhase2Wake 会立刻武装 phase2 定时器 + hasPendingPhase2Work 为真。
await seedJob(domain, 's178', 'wm178', { status: 'pending', availableAt: new Date(Date.now() - 5000).toISOString() })
for (let i = 1; i <= 3; i++) {
  await seedOutput(domain, 'o178-' + i, { session_id: 's178', source_watermark: 'wm178', rollout_summary: 'T178 ' + i, selected_for_phase2: false })
}

// ★ 关键：假域是**同步**的 ⇒ 锁一瞬即放，撞不上（实测：不加延迟时修前也 0 error）。
//   真实存储的写是**异步且慢**的，锁会跨越 macrotask ⇒ 启动期那几条被 setImmediate / 0ms 定时器
//   调度的写路径才会真正撞上"被 await 的启动 reconcile"。这里给每个写操作加 2ms 模拟该特性。
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
for (const name of ['entries', 'stage1_jobs', 'stage1_outputs', 'stage1_meta', 'stage1_seen', 'phase2_jobs', 'phase2_jobs_archive', 'publish_versions', 'memory_changes']) {
  const t = domain.table(name)
  for (const op of ['put', 'update', 'delete']) {
    const orig = t[op]
    t[op] = async (...args) => { await delay(2); return orig.apply(t, args) }
  }
}

const errs = []
const warns = []
const oldErr = console.error
const oldWarn = console.warn
console.error = (...a) => { errs.push(a.map(String).join(' ')) }
console.warn = (...a) => { warns.push(a.map(String).join(' ')) }
try {
  await apply(ctx, {})
  await new Promise((r) => setTimeout(r, 900)) // 让启动期的所有异步写路径跑完
} finally {
  console.error = oldErr
  console.warn = oldWarn
}

const conflictErrs = errs.filter((x) => /another write is in progress/.test(x))
const conflictWarns = warns.filter((x) => /write lock busy — retry/.test(x))
const consumed = [...domain.table('stage1_outputs').entries()].filter(([, o]) => o && o.selected_for_phase2 === true).length
console.log('  stderr(error) 里与写锁冲突相关的:', conflictErrs.length, '条')
console.log('  降噪后的 warn（write lock busy — retry）:', conflictWarns.length, '条')
console.log('  启动后已消费 outputs:', consumed, '/ 3   llmCalls =', llmCalls)
if (conflictErrs.length) console.log('  冲突 error 原文:', JSON.stringify(conflictErrs[0].slice(0, 160)))

check(conflictErrs.length === 0, `写锁竞争**不再被记成 error**（实测 ${conflictErrs.length} 条）`)
check(!errs.some((x) => /stage-1 drain error|phase-2 wake drain error|phase-2 auto integrate error/.test(x) && /another write/.test(x)), '三个已知的启动期调度报错都不再出现')
check(consumed === 3, `工作仍被处理（3/3 消费，实测 ${consumed}）⇒ 竞争**不再让一次 pass 丢掉工作**`)
check(llmCalls >= 1, `确实跑过整合（llmCalls=${llmCalls}）`)

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

// ── ③ 不冲突时**不重试**（确定性；t180 补） ──
console.log('\n[t178 ③] 不冲突时不得产生重试（否则就是把"正常"当"冲突"）')
{
  const H2 = path.join(os.tmpdir(), 't178b-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(path.join(H2, 'memories'), { recursive: true })
  process.env.DSH_HOME = H2
  const { ctx: ctx2, domain: dom2 } = makeCtx({
    get: (k) => (k === 'llm'
      ? { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify({ memory_summary: 'v1\n## 索引\n- 结论 T178b', registry: '# MEMORY.md\n- 结论 T178b' }) }; yield { type: 'finish', reason: { kind: 'stop' } } } }) }
      : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  })
  // 同 ② 的种子（含一个已到期 stage1 job ⇒ 启动会武装 scheduleStage1Wake 的 0ms 定时器），但**不加写延迟**
  await seedJob(dom2, 's178b', 'wm178b', { status: 'pending', availableAt: new Date(Date.now() - 5000).toISOString() })
  for (let i = 1; i <= 3; i++) {
    await seedOutput(dom2, 'o178b-' + i, { session_id: 's178b', source_watermark: 'wm178b', rollout_summary: 'T178b ' + i, selected_for_phase2: false })
  }
  const w2 = []
  const oe = console.error
  const ow = console.warn
  console.error = (...a) => w2.push('ERR ' + a.map(String).join(' '))
  console.warn = (...a) => w2.push('WARN ' + a.map(String).join(' '))
  try {
    await apply(ctx2, {})
    await new Promise((r) => setTimeout(r, 700))
  } finally {
    console.error = oe
    console.warn = ow
  }
  const retries = w2.filter((x) => /write lock busy — retry/.test(x))
  const consumed2 = [...dom2.table('stage1_outputs').entries()].filter(([, o]) => o && o.selected_for_phase2 === true).length
  console.log('  重试 warn 数 =', retries.length, ' 已消费 =', consumed2, '/ 3')
  check(retries.length === 0, `无竞争时**零重试**（实测 ${retries.length} 条）`)
  check(consumed2 === 3, `工作照常完成（3/3，实测 ${consumed2}）`)
  try { fs.rmSync(H2, { recursive: true, force: true }) } catch {}
}

// ── ④ 可复跑锚点：L2518 的接线（t182 补；**在 pre 树上必须失败**） ──
// 为什么要有这一组：t180 把 `scheduleStage1Wake` 的定时器体改走 `runScheduledPass`（L2518），
// 但那一处**零测试覆盖**（行为型断言很难把竞争压到这条入口上——两个入口共用单飞的 drainStage1Jobs）。
// 于是改成**源码级锚点**：直接把"接线形态"钉死，改回去就红。
console.log('\n[t182 ④] 锚点：scheduleStage1Wake 定时器体必须经 runScheduledPass(… stage1-wake …)')
{
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  check(
    /runScheduledPass\('stage-1 wake drain error',\s*'stage1-wake'/.test(src),
    "源码里存在 runScheduledPass('stage-1 wake drain error', 'stage1-wake', …)",
  )
  check(
    !/drainStage1Jobs\(\)\s*\.catch\(/.test(src),
    '源码里**不存在**旧形态 `drainStage1Jobs().catch(只 log)`（修前形态缺席）',
  )
}

console.log(`\n${failed === 0 ? 'ALL T178 WRITE-LOCK-CONFLICT TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
