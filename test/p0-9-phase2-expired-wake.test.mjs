// P0-9：Phase 2 过期作业「延迟重试失醒」回归测试（定时器级，非只直接调用函数）。
//
// 缺陷：`nextPhase2WakeAt()` 只把「未来的 available_at/租约」当作唤醒时间；一旦作业已到期
//   （av <= nowMs 或 le <= nowMs），它反而不再返回任何时间。而 `schedulePhase2Wake()` 每次都
//   先清旧计时器。于是到期附近若发生一次额外调度（busy / no-change / 恢复早退），过期的
//   retry_wait/pending 批会从时间调度视野中消失；无新事件时可以无限停住（不重启、无新 Stage 1
//   输出也不重试）。
//
// 修复：`nextPhase2WakeAt()` 对已到期的非终态批返回「立即」（nowMs），由 phase2Integrate 的
//   单飞吸收，且已被领取批的退避总是未来 available_at（>=30s），不形成忙循环。
//
// 测试均为黑盒：通过真实 schedulePhase2Wake → setTimeout → phase2Integrate 链（apply 启动 /
//   memory__phase2_integrate 工具）驱动，不直接调用内部函数。每个场景用独立 storage domain +
//   独立 DSH_HOME，且「先 apply（空表）再播种」以避免启动 requestPhase2Integrate 掩盖计时器路径；
//   T3 例外（测试启动路径，先播种再启动，属启动冒烟；启动 requestPhase2Integrate 与 wake 都覆盖它）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

// ── 可控 LLM mock（consolidation 专用；本文件不触发 extraction）─────────────
let consolidationCalls = 0
let pauseConsolidation = false
let consolidationInFlight = false
let releaseConsolidation = () => {}
let llmResponse = { memory_summary: 'v1\n## ok', registry: '# MEMORY.md\nok' }
const llmMock = {
  stream: (opts) => {
    const isExtract = opts && String(opts.system).includes('memory-extraction')
    if (isExtract) return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    consolidationCalls++
    const payload = JSON.stringify(llmResponse)
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: payload }
        if (pauseConsolidation) {
          consolidationInFlight = true
          await new Promise((r) => { releaseConsolidation = r })
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-p09-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })

// 每个场景独立 { ctx, domain, tools }（独立 storage domain）+ 独立 DSH_HOME，避免表数据与版本目录互相污染。
const newCtx = () => {
  const tools = {}
  const { ctx, domain } = makeCtx({
    get: (k) =>
      k === 'llm'
        ? llmMock
        : k === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : undefined,
    tools: { register: (t) => { tools[t.name] = t } },
  })
  const home = path.join(tmp, 'h-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const root = () => path.join(home, 'memories')
  return { ctx, domain, tools, root, home }
}

const putPhase2Job = (domain, id, over = {}) =>
  domain.table('phase2_jobs').put(id, {
    id,
    status: 'pending',
    input_ids: [],
    change_ids: [],
    lease_owner: '',
    lease_expires_at: '',
    attempt_count: 0,
    max_attempts: 3,
    available_at: new Date().toISOString(),
    staging_version: '',
    last_error: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  })
const past = new Date(Date.now() - 120000).toISOString() // 已到期（过去）
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return false
}

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  // ── T1：恢复早退（published→commit）后重新武装唤醒，过期 retry_wait 不失醒 ──
  // 场景：B(published) 提交后 phase2Integrate 在 committedIds 分支早退（L3044），早退处
  //       schedulePhase2Wake(nextPhase2WakeAt(now)) 必须仍把过期的 A 排上，否则 A 永久失醒。
  console.log('[T1] 恢复早退（published→commit）后重新武装唤醒 → 过期 retry_wait 仍被自动处理')
  {
    const { ctx, domain, tools, root } = newCtx()
    await apply(ctx, {})
    await seedOutput(domain, 'o-B', { source_watermark: 'wm-B', session_id: 'sB', rollout_summary: 'B', phase2_batch_id: 'B', selected_for_phase2: false, generated_at: past })
    await seedOutput(domain, 'o-A', { source_watermark: 'wm-A', session_id: 'sA', rollout_summary: 'A', phase2_batch_id: 'A', selected_for_phase2: false, generated_at: past })
    await putPhase2Job(domain, 'B', { status: 'published', input_ids: ['o-B'], lease_expires_at: past })
    await putPhase2Job(domain, 'A', { status: 'retry_wait', input_ids: ['o-A'], available_at: past, attempt_count: 1, max_attempts: 3 })
    consolidationCalls = 0
    llmResponse = { memory_summary: 'v1\n## A ok', registry: '# MEMORY.md\nA ok' }
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === true, 'recovery early-return round commits the published batch (B)')
    const aDone = await waitUntil(() => {
      const j = domain.table('phase2_jobs').get('A')
      return j && j.status === 'committed'
    }, 2500)
    check(aDone === true, 'expired retry_wait A auto-claimed & committed via re-armed wake (NOT lost)')
    check(fs.readFileSync(path.join(root(), 'memory_summary.md'), 'utf8') === 'v1\n## A ok', 'A produced the consolidated memory_summary (processed, not stuck)')
  }

  // ── T2：单飞吸收（busy）后由运行中纤维在返回点重排，过期批不丢 ──
  // 场景：B(pending,due) 被领取并暂停在 LLM（phase2Busy=true）；此时 A(过期 retry_wait) 的时间
  //       唤醒到达 → phase2Integrate L3030 被单飞吸收（不重排）；B 完成后其返回点 L3059
  //       schedulePhase2Wake(nextPhase2WakeAt(now)) 必须把仍过期的 A 排上（修复），否则 A 永久失醒。
  console.log('[T2] busy 单飞吸收后运行纤维在返回点重排 → 过期 retry_wait 不丢')
  {
    const { ctx, domain, tools, root } = newCtx()
    await apply(ctx, {})
    await seedOutput(domain, 'o-B', { source_watermark: 'wm-B2', session_id: 'sB2', rollout_summary: 'B', phase2_batch_id: 'B', selected_for_phase2: false, generated_at: past })
    await seedOutput(domain, 'o-A', { source_watermark: 'wm-A2', session_id: 'sA2', rollout_summary: 'A', phase2_batch_id: 'A', selected_for_phase2: false, generated_at: past })
    // 播种顺序：B 先入表（claim 先取 B），A 后入表（过期，稍后被 A 的唤醒再领）。
    await putPhase2Job(domain, 'B', { status: 'pending', input_ids: ['o-B'], available_at: past })
    await putPhase2Job(domain, 'A', { status: 'retry_wait', input_ids: ['o-A'], available_at: past, attempt_count: 1, max_attempts: 3 })
    consolidationCalls = 0
    llmResponse = { memory_summary: 'v1\n## B ok', registry: '# MEMORY.md\nB ok' }
    pauseConsolidation = true
    consolidationInFlight = false
    const p1 = tools['memory__phase2_integrate'].execute({}) // 领取 B 并暂停（phase2Busy=true）
    const entered = await waitUntil(() => consolidationInFlight, 2000)
    check(entered === true, 'B consolidation in flight (phase2Busy true)')
    const r2 = await tools['memory__phase2_integrate'].execute({}) // 模拟过期的 A 唤醒被单飞吸收
    check(r2.ran === false && r2.reason === 'busy', 'expired-A wake absorbed by single-flight (busy, no re-arm here)')
    // 释放 B → B 完成 → 其返回点 L3059 重新武装唤醒；过期的 A 必须仍被排上。
    pauseConsolidation = false
    llmResponse = { memory_summary: 'v1\n## A ok', registry: '# MEMORY.md\nA ok' }
    releaseConsolidation()
    const r1 = await p1
    check(r1.ran === true && r1.ok === true, 'B committed after pause release')
    const aDone = await waitUntil(() => {
      const j = domain.table('phase2_jobs').get('A')
      return j && j.status === 'committed'
    }, 2500)
    check(aDone === true, 'expired retry_wait A auto-claimed & committed from the re-armed wake (NOT lost)')
    check(fs.readFileSync(path.join(root(), 'memory_summary.md'), 'utf8') === 'v1\n## A ok', 'A produced the consolidated memory_summary (not stuck)')
  }

  // ── T3：启动时已过期批次自动处理（启动调度不静默丢掉）──
  console.log('[T3] 启动时已过期批次被自动处理（启动调度不静默丢掉）')
  {
    const { ctx, domain, root } = newCtx()
    await seedOutput(domain, 'o-A3', { source_watermark: 'wm-A3', session_id: 'sA3', rollout_summary: 'A3', phase2_batch_id: 'A3', selected_for_phase2: false, generated_at: past })
    await putPhase2Job(domain, 'A3', { status: 'retry_wait', input_ids: ['o-A3'], available_at: past, attempt_count: 1, max_attempts: 3 })
    consolidationCalls = 0
    llmResponse = { memory_summary: 'v1\n## A3 ok', registry: '# MEMORY.md\nA3 ok' }
    await apply(ctx, {}) // 播种后启动：启动调度（L4175 wake + L4185 requestPhase2Integrate）处理过期批
    const aDone = await waitUntil(() => {
      const j = domain.table('phase2_jobs').get('A3')
      return j && j.status === 'committed'
    }, 2500)
    check(aDone === true, 'startup processes the already-expired retry_wait batch (not stuck)')
    check(fs.readFileSync(path.join(root(), 'memory_summary.md'), 'utf8') === 'v1\n## A3 ok', 'startup produced the consolidated memory_summary')
  }

  // ── T4：安全校验持续失败 → 按 max_attempts 进终态；不泄露；t170 起未消费输入**有界释放**（不再永久卡死）──
  console.log('[T4] 安全校验持续失败 → max_attempts 终态，未泄露，未消费输入有界释放（t170 契约改向）')
  {
    const { ctx, domain, tools, root } = newCtx()
    await apply(ctx, {})
    await seedOutput(domain, 'o-A4', { source_watermark: 'wm-A4', session_id: 'sA4', rollout_summary: 'A4', phase2_batch_id: 'A4', selected_for_phase2: false, generated_at: past })
    await putPhase2Job(domain, 'A4', { status: 'retry_wait', input_ids: ['o-A4'], available_at: past, attempt_count: 2, max_attempts: 3 })
    consolidationCalls = 0
    llmResponse = { memory_summary: 'v1\ncontains sk-abcDEF123456abcdef', registry: '# MEMORY.md\nok' } // 未脱敏秘密
    const r1 = await tools['memory__phase2_integrate'].execute({})
    check(r1.ran === true && r1.ok === false, 'secret output → ok:false (validation rejected)')
    const j1 = domain.table('phase2_jobs').get('A4')
    check(!!j1 && j1.status === 'failed_terminal', 'attempt 3 reaches max_attempts → failed_terminal (not retry_wait)')
    check(!!j1 && j1.attempt_count === 3, 'attempt_count capped at max_attempts (3), no infinite growth')
    // 秘密校验失败关闭：不把未脱敏内容写进权威 summary（允许存在空/默认文件，但绝不含秘密）。
    const leakedSum = fs.existsSync(path.join(root(), 'memory_summary.md')) ? fs.readFileSync(path.join(root(), 'memory_summary.md'), 'utf8') : ''
    check(!leakedSum.includes('sk-abcDEF123456abcdef'), 'memory_summary NOT published with the secret (no leak)')
    // t170 契约改向：终态批的**未消费**输入会被**释放**，所以下一轮**会**再跑一次（这是有界的：
    // 每次释放 +1 计数，达 MAX_PHASE2_RELEASES 后显式 abandoned 并彻底停下）。
    // 旧断言（no-change / 0 次 LLM）编码的是修复前的"永久保持绑定"行为——代价是来源**永久卡死且无人登记**。
    consolidationCalls = 0
    const r2 = await tools['memory__phase2_integrate'].execute({})
    check(r2.ran === true && r2.ok === false, 'after terminal, released input gets ONE bounded retry (not stuck forever)')
    check(consolidationCalls === 1, `exactly one further LLM call for the released input (实测 ${consolidationCalls})，不是忙循环`)
    const oA4 = domain.table('stage1_outputs').get('o-A4')
    check(oA4 && oA4.phase2_release_count === 1, `释放计数 = ${oA4 && oA4.phase2_release_count}（有界：上界 3）`)
    check(oA4 && oA4.phase2_abandoned !== true, '未达上界 ⇒ 仍可被正常处理（不静默丢）')
    check(j1 && j1.status === 'failed_terminal', 'batch stays failed_terminal (idempotent, no re-batch for same inputs)')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL P0-9 EXPIRED-WAKE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
