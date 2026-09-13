// t187：① 受限执行者（插件自建会话）+ 相位 2 作业租约 3600s。
//
// 为什么这样测：
//   - 「整合执行体 = 插件自建会话」的可观测点有两个：**传给 `ctx.agents.create` 的参数**
//     （`meta.cwd` = 记忆根 / `setup` 里的 `tools.restrict`）与**落到该会话上的策略事件**
//     （`sandbox/mode=workspace-write` / `approval/policy=never`）。两者都用假服务**逐字捕获**。
//   - 「租约 3600s」用**行为级**观察：让整合暂停在 LLM 里，读被领取作业的 `lease_expires_at`
//     （改前树为 60000ms ⇒ 该断言必红）。
//   - 「安全阀」：建会话抛错不得拖垮批（批仍应 committed）。
//   - 「宿主没有 agents 服务」（本仓库其它 64 个测试即此形态）⇒ 明确降级、行为不变。
// 全部使用临时目录作靶（**绝不指向真实记忆根**），测试后临时物由 finally 清理 + 跑完送回收站。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const m = await import(PLUGIN)
const { apply } = m
// 改前树上没有这个导出：用安全包装，让"缺导出"表现为**断言红**，而不是测试中途崩溃（牙齿要红在断言上）。
const startExec =
  typeof m.startConsolidationExecutor === 'function'
    ? m.startConsolidationExecutor
    : async () => ({ ok: false, reason: 'startConsolidationExecutor-missing', spec: null })

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-t187-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })
const TARGET = path.join(tmp, 'memory-root-target') // 靶 = 临时目录（不是真实记忆根）
fs.mkdirSync(TARGET, { recursive: true })

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

// ── 可暂停的 consolidation LLM mock（同 p0-9 款） ─────────────────────────────
let consolidationCalls = 0
let pauseConsolidation = false
let consolidationInFlight = false
let releaseConsolidation = () => {}
let llmResponse = { memory_summary: 'v1\n## t187 ok', registry: '# MEMORY.md\nt187 ok' }
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

const newCtx = ({ agents, sandboxPolicy, approval } = {}) => {
  const tools = {}
  const { ctx, domain } = makeCtx({
    get: (k) =>
      k === 'llm'
        ? llmMock
        : k === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : k === 'agents'
            ? agents
            : k === 'sandboxPolicy'
              ? sandboxPolicy
              : k === 'approval'
                ? approval
                : undefined,
    tools: { register: (t) => { tools[t.name] = t } },
  })
  const home = path.join(tmp, 'h-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  return { ctx, domain, tools, root: () => path.join(home, 'memories'), home }
}

const putPhase2Job = (domain, id, over = {}) =>
  domain.table('phase2_jobs').put(id, {
    id, status: 'pending', input_ids: [], change_ids: [], lease_owner: '', lease_expires_at: '',
    attempt_count: 0, max_attempts: 3, available_at: new Date().toISOString(), staging_version: '',
    last_error: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
  })
const past = new Date(Date.now() - 120000).toISOString()

/** 假 agents 服务：捕获 create 参数；按宿主的做法调用 setup（这样 restrict 才真的被走到）。 */
const fakeAgents = (opts = {}) => {
  const state = { calls: [], restrictCalls: [], events: [], childCtx: { tools: { restrict: (f) => state.restrictCalls.push(f) } } }
  state.svc = {
    create: async (o) => {
      state.calls.push(o)
      if (opts.throwOnCreate) throw new Error('host rejected sessionId/meta.cwd (simulated)')
      if (typeof o.setup === 'function') o.setup(state.childCtx)
      return opts.handle === undefined ? { session: { append: (t, d) => state.events.push([t, d]) } } : opts.handle
    },
  }
  return state
}

try {
  // ── T1：规格与常量（纯函数层） ─────────────────────────────────────────────
  console.log('[T1] 受限执行者规格 + 租约常量')
  check(typeof m.consolidationExecutorSpec === 'function', '导出 consolidationExecutorSpec（本批新增接口）')
  check(m.PHASE2_LEASE_MS === 3600000, `PHASE2_LEASE_MS = 3600000（实测 ${m.PHASE2_LEASE_MS}；改前 60000）`)
  check(m.HEARTBEAT_INTERVAL_MS === 20000, `HEARTBEAT_INTERVAL_MS = 20000（实测 ${m.HEARTBEAT_INTERVAL_MS}，心跳不变）`)
  const spec = typeof m.consolidationExecutorSpec === 'function' ? m.consolidationExecutorSpec(TARGET) : null
  check(!!spec && spec.cwd === path.resolve(TARGET), `cwd = 记忆根绝对路径（实测 ${spec && spec.cwd}）`)
  check(!!spec && spec.sandboxMode === 'workspace-write', `会话沙箱 = workspace-write（实测 ${spec && spec.sandboxMode}）`)
  check(!!spec && spec.approvalPolicy === 'never', `审批 = never（实测 ${spec && spec.approvalPolicy}）`)
  check(!!spec && spec.toolFilter.deny.includes('subagent'), `deny 含 subagent ⇒ 禁递归委派（实测 ${spec && JSON.stringify(spec.toolFilter.deny)}）`)
  const allow = (spec && spec.toolFilter.allow) || []
  check(
    allow.length > 0 && !allow.includes('pwsh') && !allow.includes('subagent') && !allow.includes('web_fetch') && !allow.includes('web_search'),
    `最小工具集不含 shell/网络/委派类工具（实测 ${JSON.stringify(allow)}）`,
  )
  check(typeof m.CONSOLIDATION_NETWORK_RESIDUAL === 'string' && m.CONSOLIDATION_NETWORK_RESIDUAL.includes('not a kernel boundary'),
    '无网残余面被显式登记（沙箱无网络维度 ⇒ 只能靠工具白名单，不是硬边界）')
  let threw = false
  try { m.consolidationExecutorSpec('') } catch { threw = true }
  check(threw === true, '记忆根为空 ⇒ 抛错（不拿 process.cwd() 兜底，避免写边界被悄悄挪走）')

  // ── T2：建会话参数与落到会话上的策略（假服务逐字捕获） ────────────────────
  console.log('[T2] ctx.agents.create 的参数 + 会话策略事件')
  {
    const fa = fakeAgents()
    const ctx = { get: (k) => (k === 'agents' ? fa.svc : undefined) }
    const res = await startExec({ ctx, memoryRoot: TARGET, sessionId: 'p2-exec-t2' })
    check(res.ok === true, `建会话成功（ok=${res.ok}）`)
    check(fa.calls.length === 1 && fa.calls[0].meta && fa.calls[0].meta.cwd === path.resolve(TARGET),
      `agents.create 收到 meta.cwd = 记忆根（实测 ${fa.calls[0] && JSON.stringify(fa.calls[0].meta)}）`)
    check(typeof fa.calls[0].setup === 'function', 'create 带上 setup（创建窗口内做 restrict）')
    check(fa.restrictCalls.length === 1 && fa.restrictCalls[0].deny.includes('subagent') && fa.restrictCalls[0].allow.length > 0,
      `setup 里调用 tools.restrict 且 deny 含 subagent（实测 ${JSON.stringify(fa.restrictCalls[0])}）`)
    check(res.restricted === true, 'restricted 标记 = true（说明 restrict 真的执行了，不是只传参）')
    check(fa.events.some(([t, d]) => t === 'sandbox/mode' && d.mode === 'workspace-write'),
      `会话被写入 sandbox/mode=workspace-write（实测 ${JSON.stringify(fa.events)}）`)
    check(fa.events.some(([t, d]) => t === 'approval/policy' && d.policy === 'never'), '会话被写入 approval/policy=never')
  }

  // ── T2b：有服务时优先走服务写入路径（不是直接 append） ────────────────────
  console.log('[T2b] 服务可用时优先 sandboxPolicy.setMode / approval.setPolicy')
  {
    const fa = fakeAgents({ handle: { session: { append: () => { throw new Error('should not append when services exist') } }, agent: { id: 'a' } } })
    const seen = { setMode: [], setPolicy: [] }
    const ctx = {
      get: (k) =>
        k === 'agents' ? fa.svc : k === 'sandboxPolicy' ? { setMode: (s, mode) => seen.setMode.push(mode) } : k === 'approval' ? { setPolicy: (a, p) => seen.setPolicy.push(p) } : undefined,
    }
    const res = await startExec({ ctx, memoryRoot: TARGET, sessionId: 'p2-exec-t2b' })
    check(res.ok === true && seen.setMode[0] === 'workspace-write' && seen.setPolicy[0] === 'never',
      `服务路径被使用（setMode=${JSON.stringify(seen.setMode)} setPolicy=${JSON.stringify(seen.setPolicy)}）`)
    check((res.applied.routes || []).join(',').includes('sandboxPolicy.setMode'), `routes 记录服务路径（${JSON.stringify(res.applied.routes)}）`)
  }

  // ── T3：宿主没有 agents 服务 ⇒ 明确降级（本仓库其余测试即此形态） ──────────
  console.log('[T3] 无 agents 服务 ⇒ ok:false + 明确原因 + 仍返回 spec')
  {
    const r3 = await startExec({ ctx: { get: () => undefined }, memoryRoot: TARGET, sessionId: 'x' })
    check(r3.ok === false && r3.reason === 'agents-service-unavailable',
      `降级原因明确（ok=${r3.ok} reason=${r3.reason}）`)
    check(!!r3.spec && r3.spec.cwd === path.resolve(TARGET), '降级时仍返回 spec（便于日志/排查）')
  }

  // ── T4：真实整合批 —— 建了受限执行者 + 作业租约 ≈3600s（行为级，改前树必红） ─
  console.log('[T4] 整合批：模型调用前已建受限执行者 + 租约 ≈3600s')
  {
    const fa = fakeAgents()
    const { ctx, domain, tools, root } = newCtx({ agents: fa.svc })
    await apply(ctx, {})
    await seedOutput(domain, 'o-t187', { source_watermark: 'wm-t187', session_id: 's-t187', rollout_summary: 't187', phase2_batch_id: 'B187', selected_for_phase2: false, generated_at: past })
    await putPhase2Job(domain, 'B187', { status: 'pending', input_ids: ['o-t187'], available_at: past })
    consolidationCalls = 0
    pauseConsolidation = true
    consolidationInFlight = false
    const p = tools['memory__phase2_integrate'].execute({})
    const entered = await waitUntil(() => consolidationInFlight, 2000)
    check(entered === true, '整合已在 LLM 内（可观察领取后的作业行）')
    const job = domain.table('phase2_jobs').get('B187')
    const leaseMs = job && job.lease_expires_at ? new Date(job.lease_expires_at).getTime() - Date.now() : -1
    check(leaseMs > 3500000 && leaseMs <= 3601000,
      `作业租约 ≈ 3600s（实测 ${Math.round(leaseMs / 1000)}s；改前为 60s ⇒ 该断言在改前树上必红）`)
    check(fa.calls.length === 1 && fa.calls[0].meta.cwd === path.resolve(root()),
      `整合批在模型调用前建了受限执行者，且 cwd = 本会话记忆根（实测 ${fa.calls[0] && JSON.stringify(fa.calls[0].meta)}）`)
    check(fa.restrictCalls.length === 1, `该批 restrict 调用 1 次（实测 ${fa.restrictCalls.length}）`)
    pauseConsolidation = false
    releaseConsolidation()
    const r = await p
    check(r.ran === true && r.ok === true, `暂停释放后本批正常完成（ran=${r.ran} ok=${r.ok}）`)
    check(fs.readFileSync(path.join(root(), 'memory_summary.md'), 'utf8') === 'v1\n## t187 ok', '总纲由本批正常发布（执行者门禁不影响发布路径）')
  }

  // ── T5：安全阀 —— 建会话抛错不得拖垮批 ───────────────────────────────────
  console.log('[T5] 建会话抛错 ⇒ 只 warn，批照旧完成（安全阀）')
  {
    const fa = fakeAgents({ throwOnCreate: true })
    const { ctx, domain, tools, root } = newCtx({ agents: fa.svc })
    await apply(ctx, {})
    await seedOutput(domain, 'o-t187b', { source_watermark: 'wm-t187b', session_id: 's-t187b', rollout_summary: 't187b', phase2_batch_id: 'B187b', selected_for_phase2: false, generated_at: past })
    await putPhase2Job(domain, 'B187b', { status: 'pending', input_ids: ['o-t187b'], available_at: past })
    consolidationCalls = 0
    pauseConsolidation = false
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === true, `建会话失败仍不影响批（ran=${r.ran} ok=${r.ok}）`)
    check(consolidationCalls === 1, `LLM 仍被调用 1 次（实测 ${consolidationCalls}）`)
    const job = domain.table('phase2_jobs').get('B187b')
    check(!!job && job.status === 'committed', `批已提交（status=${job && job.status}）`)
    check(fs.readFileSync(path.join(root(), 'memory_summary.md'), 'utf8') === 'v1\n## t187 ok', '总纲仍被发布')
  }

  // ── T6：配置关掉 ⇒ 完全不建执行者（逃生阀） ───────────────────────────────
  console.log('[T6] consolidationExecutor=false ⇒ 不建执行者')
  {
    const fa = fakeAgents()
    const { ctx, domain, tools } = newCtx({ agents: fa.svc })
    await apply(ctx, { consolidationExecutor: false })
    await seedOutput(domain, 'o-t187c', { source_watermark: 'wm-t187c', session_id: 's-t187c', rollout_summary: 't187c', phase2_batch_id: 'B187c', selected_for_phase2: false, generated_at: past })
    await putPhase2Job(domain, 'B187c', { status: 'pending', input_ids: ['o-t187c'], available_at: past })
    consolidationCalls = 0
    pauseConsolidation = false
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === true, '关掉执行者后批仍正常完成')
    check(fa.calls.length === 0, `未建任何执行者会话（实测 create 调用 ${fa.calls.length} 次）`)
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T187 RESTRICTED-EXECUTOR TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
