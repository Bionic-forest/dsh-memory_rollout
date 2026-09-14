// t220（R2 §8）：受限执行者**三条边界**的最小验证集
//   ① 限制失败**不派发**受限轮次（§8-1）
//   ② 写范围**隔离**：可写根 = 记忆根内的隔离候选工作区；执行者动了权威面 ⇒ **该轮产物被拒收**（§8-2）
//   ③ 超时 ⇒ **停掉执行者**（cancel + dispose）；产物**新鲜度闸门** ⇒ 不复用上一次尝试的旧结果（§8-3）
//   （R2 §8 的第四项「一次真实受限轮次」是真机项 —— 需要重启后实测，本测试只能走隔离副本。）
//
// 说明：宿主沙箱（cwd 隔离 ⇒ 越界写被内核拒绝）在假 agents 服务里无法复现；本测试覆盖的是
//   **插件侧**的两层：spec/`meta.cwd` 的隔离（②a）+ 权威面快照比对（②b，沙箱没兜住时的兜底）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, setMeta } from './lib/helpers.mjs'

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t220-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const M = await import(PLUGIN)
const { apply, runConsolidationExecutorTurn, stopConsolidationExecutor, EXECUTOR_OUT_SUBDIR } = M

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
/** 工具注册表（`makeCtx` 的 `tools.register` 会把工具写进 `REG`，调用点用 `REG['memory__…']`）。 */
const REG = {}
const regTools = { register: (t) => { if (t && t.name) REG[t.name] = t } }
const isStrictSubdir = (parent, child) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}
const root = () => path.join(HOME, 'memories')
const section = async (label, fn) => {
  try { return await fn() } catch (err) {
    check(false, `${label} 中断（改前树上属预期的断言级红）：${err && err.message ? err.message : err}`)
  }
}

/** 假 agents 服务（可注入"限制不成立/策略不落成/越界写"三种故障）。 */
function makeFakeAgents(opts = {}) {
  const state = {
    created: [], followups: [], restrictFilters: [], policyEvents: [],
    cancelled: [], disposed: 0, inProcessTurns: 0,
  }
  const service = {
    create: async ({ sessionId, meta, setup }) => {
      state.created.push({ sessionId, meta })
      const childTools = opts.noRestrict ? {} : { restrict: (f) => state.restrictFilters.push(f) }
      if (typeof setup === 'function') setup({ tools: childTools })
      const myEvents = []
      const session = { append: (t, d) => state.policyEvents.push([t, d]), events: () => myEvents }
      const agent = {
        id: sessionId,
        get status() { return { state: 'idle', turns: state.inProcessTurns } },
        session,
        cancel: (arg) => state.cancelled.push(arg),
        followup: (msg) => {
          state.followups.push({ sessionId, msg })
          state.inProcessTurns++
          if (opts.onFollowup) opts.onFollowup({ msg, meta, state, myEvents })
        },
        whenIdle: async () => { await new Promise((r) => setTimeout(r, 5)) },
      }
      return { agent, dispose: async () => { state.disposed++ } }
    },
  }
  return { state, service }
}

const LLM_BY_INPROCESS = { memory_summary: 'v1\n## by-inprocess-llm', registry: '# MEMORY.md\nby-inprocess-llm' }
const makeLlm = (counters) => ({
  stream: (o) => {
    if (o && String(o.system).includes('memory-extraction')) {
      return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    }
    counters.inProcess++
    const payload = JSON.stringify(LLM_BY_INPROCESS)
    return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  },
})

let seedN = 0
async function seedBatch(domain, sid) {
  seedN++
  await seedOutput(domain, 'j-t220-' + seedN, { session_id: sid, source_watermark: 'wm-' + seedN, rollout_summary: 'durable ' + seedN, generated_at: `2026-04-0${seedN}T00:00:00.000Z` })
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
}
const jobsOf = (domain) => [...domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v }))
const lastJob = (domain) => jobsOf(domain).pop() || {}
const verSummary = (v) => { try { return fs.readFileSync(path.join(root(), 'versions', v, 'memory_summary.md'), 'utf8') } catch { return '' } }
const readCurrent = () => { try { return JSON.parse(fs.readFileSync(path.join(root(), 'current.json'), 'utf8')) } catch { return null } }
/** 直接驱动 runConsolidationExecutorTurn 的假执行者（供 §8-3 的两个单元级场景）。 */
function makeFakeExecutor({ whenIdle, onFollowup }) {
  const captured = { msg: null, outFile: '' }
  const myEvents = []
  const executor = {
    ok: true, sessionId: 'p2-exec-unit', candidateDir: path.join(root(), EXECUTOR_OUT_SUBDIR, 'executor-workspace', 'attempt-unit'),
    handle: {
      agent: {
        id: 'p2-exec-unit',
        status: { state: 'idle', turns: 1 },
        session: { events: () => myEvents },
        cancel: () => { executor.cancelled = true },
        followup: (msg) => {
          captured.msg = msg
          const text = String((msg && msg.content && msg.content[0] && msg.content[0].text) || '')
          const mm = text.match(/([A-Za-z]:\\[^\n"]*?\.json|\/[^\n"]*?\.json)/)
          if (mm) captured.outFile = mm[1]
          if (onFollowup) onFollowup({ outFile: captured.outFile, myEvents })
        },
        whenIdle,
      },
      dispose: async () => { executor.disposed = true },
    },
  }
  return { executor, captured }
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 边界 1：限制失败 ⇒ 不派发
// ─────────────────────────────────────────────────────────────────────────────
await section('[S1]', async () => {
  console.log('\n[S1] 边界 1a：tools.restrict 缺失 ⇒ 不派发受限轮次')
  const counters = { inProcess: 0 }
  const fa = makeFakeAgents({ noRestrict: true })
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'agents' ? fa.service : k === 'llm' ? makeLlm(counters) : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
    tools: regTools,
  })
  await apply(ctx, {})
  await seedBatch(domain, 's-220-a')
  await REG['memory__phase2_integrate'].execute({})
  const job = lastJob(domain)
  check(fa.state.followups.length === 0, `限制未建立 ⇒ **一次受限轮次都没派发**（followup 调用 ${fa.state.followups.length} 次）`)
  check(String(job.executor_reason || '').includes('executor-restrictions-not-established'),
    `批记录写明原因（executor_reason="${String(job.executor_reason || '').slice(0, 72)}…"）`)
  check(job.executor_path === 'in-process-fallback', `显式回落（executor_path=${job.executor_path}）`)
  check(counters.inProcess >= 1, `进程内单发兜底照常完成（${counters.inProcess} 次）`)
  check(fa.state.cancelled.length >= 1 && fa.state.disposed >= 1,
    `刚建的会话被停掉（cancel=${fa.state.cancelled.length} dispose=${fa.state.disposed}）`)
})

await section('[S2]', async () => {
  console.log('\n[S2] 边界 1b：沙箱/审批未按预期落成 ⇒ 同样不派发')
  const counters = { inProcess: 0 }
  const fa = makeFakeAgents()
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'agents' ? fa.service
      : k === 'sandboxPolicy' ? { setMode: () => { throw new Error('sandbox service unavailable (simulated)') } }
        : k === 'llm' ? makeLlm(counters) : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
    tools: regTools,
  })
  await apply(ctx, {})
  await seedBatch(domain, 's-220-b')
  await REG['memory__phase2_integrate'].execute({})
  const job = lastJob(domain)
  check(fa.state.followups.length === 0, '沙箱没落成 ⇒ 不派发（工具限制成立也不够）')
  check(String(job.executor_reason || '').includes('policies-not-applied'),
    `原因写明"策略未落成"（"${String(job.executor_reason || '').slice(0, 80)}…"）`)
  check(job.executor_path === 'in-process-fallback' && counters.inProcess >= 1, '仍显式回落并完成整合')
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 边界 2：写范围隔离 + 越界写被拒
// ─────────────────────────────────────────────────────────────────────────────
await section('[S3]', async () => {
  console.log('\n[S3] 边界 2a：可写根 = 记忆根内的隔离候选工作区（≠ 记忆根）')
  const counters = { inProcess: 0 }
  const fa = makeFakeAgents({
    onFollowup: ({ msg, state, myEvents }) => {
      const text = String((msg && msg.content && msg.content[0] && msg.content[0].text) || '')
      const mm = text.match(/([A-Za-z]:\\[^\n"]*?\.json|\/[^\n"]*?\.json)/)
      if (mm) { fs.mkdirSync(path.dirname(mm[1]), { recursive: true }); fs.writeFileSync(mm[1], JSON.stringify({ memory_summary: 'v1\n## by-executor', registry: '# MEMORY.md\nby-executor' })) }
      myEvents.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } })
      void state
    },
  })
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'agents' ? fa.service : k === 'llm' ? makeLlm(counters) : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
    tools: regTools,
  })
  await apply(ctx, {})
  await seedBatch(domain, 's-220-c')
  await REG['memory__phase2_integrate'].execute({})
  const cwd = fa.state.created[0] && fa.state.created[0].meta && fa.state.created[0].meta.cwd
  check(!!cwd && isStrictSubdir(root(), cwd), `meta.cwd 严格位于记忆根内（实测 ${cwd}）`)
  check(!!cwd && path.resolve(cwd) !== path.resolve(root()), 'meta.cwd **不是**记忆根（执行者不拥有权威面写权限）')
  check(!!cwd && path.resolve(cwd).includes(EXECUTOR_OUT_SUBDIR), `meta.cwd 落在 ${EXECUTOR_OUT_SUBDIR} 下（隔离候选工作区）`)
  const job = lastJob(domain)
  check(String(job.executor_cwd || '') !== '', `批记录带 executor_cwd（实测 ${String(job.executor_cwd || '').slice(0, 60)}…）`)
  check(job.executor_path === 'restricted-session', `隔离成立 ⇒ 正常走受限会话（executor_path=${job.executor_path}）`)
})

await section('[S4]', async () => {
  console.log('\n[S4] 边界 2b：执行者动了权威面 ⇒ 该轮产物被**拒收**')
  const counters = { inProcess: 0 }
  const fa = makeFakeAgents({
    onFollowup: ({ msg, state }) => {
      // 模拟"沙箱没兜住"：执行者直接写记忆根里的权威文件，同时把一份**带标记**的产物写进候选工作区。
      try { fs.writeFileSync(path.join(root(), 'MEMORY.md'), '# MEMORY.md\nTAMPERED-BY-EXECUTOR') } catch {}
      const text = String((msg && msg.content && msg.content[0] && msg.content[0].text) || '')
      const mm = text.match(/([A-Za-z]:\\[^\n"]*?\.json|\/[^\n"]*?\.json)/)
      if (mm) { fs.mkdirSync(path.dirname(mm[1]), { recursive: true }); fs.writeFileSync(mm[1], JSON.stringify({ memory_summary: 'v1\n## by-tampered-executor', registry: '# MEMORY.md\nby-tampered-executor' })) }
      void state
    },
  })
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'agents' ? fa.service : k === 'llm' ? makeLlm(counters) : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
    tools: regTools,
  })
  await apply(ctx, {})
  await seedBatch(domain, 's-220-d')
  await REG['memory__phase2_integrate'].execute({})
  const job = lastJob(domain)
  const cur = readCurrent()
  const published = cur ? verSummary(cur.version) : ''
  check(String(job.executor_boundary_violation || '').includes('MEMORY.md'),
    `批记录登记越界证据（executor_boundary_violation="${String(job.executor_boundary_violation || '').slice(0, 60)}"）`)
  check(job.executor_path === 'in-process-fallback', `该轮产物被拒收并显式回落（executor_path=${job.executor_path}）`)
  check(!published.includes('by-tampered-executor'), '被污染的那一轮**没有**被采纳进权威版本')
  check(published.includes('by-inprocess-llm'), '权威版本来自外层自己的（进程内）结果')
  check(fa.state.cancelled.length >= 1, '越界后该执行者会话也被停掉')
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 边界 3：超时停止 + 旧输出不复用（单元级，直接驱动 runConsolidationExecutorTurn）
// ─────────────────────────────────────────────────────────────────────────────
await section('[S5]', async () => {
  console.log('\n[S5] 边界 3a：超时 ⇒ 停掉执行者（cancel + dispose）且候选目录被清理')
  const { executor } = makeFakeExecutor({ whenIdle: () => new Promise(() => {}) })
  const workDir = executor.candidateDir
  const r = await runConsolidationExecutorTurn({
    executor, prompt: 'p', systemPrompt: 's', memoryRoot: root(), batchId: 'b-unit', attemptTag: '3-deadbe', timeoutMs: 150,
  })
  check(r.ok === false && String(r.reason).includes('executor-turn-failed'),
    `超时 ⇒ 明确失败（reason="${String(r.reason).slice(0, 60)}…"）`)
  check(!!r.stopped && r.stopped.cancelled === true, `超时后**取消**了原执行者（cancelled=${!!r.stopped && r.stopped.cancelled}）`)
  check(!!r.stopped && r.stopped.disposed === true, `超时后**释放**了会话（disposed=${!!r.stopped && r.stopped.disposed}）`)
  check(executor.stopped === true, '执行者对象被标记 stopped（后续调用方据此不再复用）')
  check(!fs.existsSync(path.join(workDir, 'attempt-3-deadbe')), '该次尝试的候选目录已清理（迟到写没有"共享路径"可被下一次读走）')
})

await section('[S6]', async () => {
  console.log('\n[S6] 边界 3b：产物新鲜度闸门 ⇒ 不复用旧结果')
  // 旧结果：派发瞬间就把文件写成"1 小时前"，模拟"上一次尝试留下的产物"
  const stale = makeFakeExecutor({
    whenIdle: async () => { await new Promise((r) => setTimeout(r, 5)) },
    onFollowup: ({ outFile }) => {
      if (!outFile) return
      fs.mkdirSync(path.dirname(outFile), { recursive: true })
      fs.writeFileSync(outFile, JSON.stringify({ memory_summary: 'v1\n## STALE-FROM-PREVIOUS-ATTEMPT', registry: '# MEMORY.md\nstale' }))
      const old = new Date(Date.now() - 3600000)
      fs.utimesSync(outFile, old, old)
    },
  })
  const rOld = await runConsolidationExecutorTurn({
    executor: stale.executor, prompt: 'p', systemPrompt: 's', memoryRoot: root(), batchId: 'b-unit', attemptTag: '1-aa11bb', timeoutMs: 2000,
  })
  check(rOld.ok === false && String(rOld.reason).includes('executor-stale-output'),
    `旧产物被拒（reason="${String(rOld.reason).slice(0, 70)}…"）⇒ 不会把上次尝试的结果当本轮结果`)
  // 新鲜产物：同一位置、同一路径形状，但写入时间晚于派发 ⇒ 采纳
  const fresh = makeFakeExecutor({
    whenIdle: async () => { await new Promise((r) => setTimeout(r, 5)) },
    onFollowup: ({ outFile }) => {
      if (!outFile) return
      fs.mkdirSync(path.dirname(outFile), { recursive: true })
      fs.writeFileSync(outFile, JSON.stringify({ memory_summary: 'v1\n## FRESH', registry: '# MEMORY.md\nfresh' }))
    },
  })
  const rNew = await runConsolidationExecutorTurn({
    executor: fresh.executor, prompt: 'p', systemPrompt: 's', memoryRoot: root(), batchId: 'b-unit', attemptTag: '2-cc22dd', timeoutMs: 2000,
  })
  check(rNew.ok === true && rNew.source === 'executor-out-file', '（**假阳性**：两棵树都过）新鲜产物被正常采纳（正向控制）')
  // 两次尝试的产物路径**不同** ⇒ 重试天然不共用输出路径
  check(!!stale.captured.outFile && !!fresh.captured.outFile && stale.captured.outFile !== fresh.captured.outFile,
    '两次尝试的产物路径不同（attemptTag 隔离 ⇒ 重试不共用输出路径）')
  check(stale.captured.outFile.includes('attempt-1-aa11bb') && fresh.captured.outFile.includes('attempt-2-cc22dd'),
    '产物路径里带各自的尝试标记（候选输出与"尝试"对应）')
})

await section('[S7]', async () => {
  console.log('\n[S7] 边界 2/3 的纯函数副作用：不可写根 = 根外/根本身 ⇒ 拒跑')
  const { executor } = makeFakeExecutor({ whenIdle: async () => {} })
  const outside = await runConsolidationExecutorTurn({
    executor, prompt: 'p', systemPrompt: 's', memoryRoot: root(), batchId: 'b', candidateDir: path.dirname(root()), timeoutMs: 500,
  })
  check(outside.ok === false && String(outside.reason).includes('executor-candidate-workspace-required'),
    '候选工作区在记忆根外 ⇒ 拒跑（不把写边界放到根外/根上）')
})

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n${failed === 0 ? 'ALL T220 EXECUTOR-BOUNDARY TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
