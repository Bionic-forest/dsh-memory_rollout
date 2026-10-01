// t242（T31 / v0.1.23）：**跑完整个流程**所需的四条收口 + 两条并入的小项，逐条做可复现断言。
//
// 覆盖：
//   ① 失败/提前 return **全部**收口到 stop/dispose（旧实现漏 `executor-no-output` / `executor-stale-output`
//      ⇒ 执行者会话留在宿主会话列表里，真机累积 10 个）；
//   ② 活动口径换成本宿主**真有的** API（`ownEvents()`/`snapshotEvents()`；`AgentStatus` 是字符串），
//      批次字段不再写无意义的 `-1`；
//   ③ 执行者装配照宿主正规配方补齐（`meta.agentPreset` + `agentOptions{provider,model}` + `presets.mount`），
//      缺模型路由 / 挂预设失败都 **fail-closed**（不吞错、不假装 restricted=true）；
//   ④ "受限轮次真发生"变成门：事件数必须**增长**（宿主 loop 开轮第一件事就是 append `turn/start`）；
//   ⑤ 空壳（我们自己的 id + 零事件 + 已停）才顺手清，且有内容/别人的 id/配置关闭 都不碰；
//   ⑥ 会话目录被外部清掉 ⇒ 读/停/清**都不抛不挂**，且**不改批的状态与理由**。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const m = await import(PLUGIN)
const { apply } = m
/** 改前树（v0.1.22）没有这些导出 ⇒ 包装成断言红，而不是中途崩掉。 */
const startExec = typeof m.startConsolidationExecutor === 'function' ? m.startConsolidationExecutor : async () => ({ ok: false, reason: 'export-missing', restricted: false, restrictObs: null, assembly: null })
const runTurn = typeof m.runConsolidationExecutorTurn === 'function' ? m.runConsolidationExecutorTurn : async () => ({ ok: false, reason: 'export-missing' })
const stopExec = typeof m.stopConsolidationExecutor === 'function' ? m.stopConsolidationExecutor : async () => ({ notImplemented: true })
const cleanupEmpty = typeof m.cleanupEmptyExecutorSession === 'function' ? m.cleanupEmptyExecutorSession : async () => ({ attempted: false, outcome: 'export-missing', text: '', deleted: false, id: '' })
const sessionGone = typeof m.executorSessionGone === 'function' ? m.executorSessionGone : async () => undefined
const specOf = typeof m.consolidationExecutorSpec === 'function' ? m.consolidationExecutorSpec : () => ({ cwd: '' })

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const section = async (label, fn) => {
  try { return await fn() } catch (err) {
    check(false, `${label} 中断（改前树上属预期的断言级红）：${err && err.message ? err.message : err}`)
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory_rollout-t242-'))
const ROOT = path.join(TMP, 'memories')
fs.mkdirSync(ROOT, { recursive: true })
// 权威面文件要存在：越界检查按 SHA 比对（缺失也算一种"状态"，但这里造一个真实的起点）。
fs.writeFileSync(path.join(ROOT, 'MEMORY.md'), '# MEMORY.md\nbaseline\n')
fs.writeFileSync(path.join(ROOT, 'memory_summary.md'), 'baseline summary\n')
fs.writeFileSync(path.join(ROOT, 'current.json'), '{"version":"base"}\n')
process.env.DSH_HOME = TMP
const MODEL = { currentSelection: () => ({ provider: 'test-p', model: 'test-m' }) }
/**
 * 宿主形的 `restrict`（**按真实名单校验名字**，抛点/文案与 dsh-tools 一致）：
 * 不带上 `; known global tools: …` 的假件会让"权威探测"拿不到名单 —— 那是**假件的契约缺失**，
 * 不是实现的退路（t230 已记录该测试盲区）。
 */
const hostShapedRestrict = (names, sink) => (f) => {
  const asked = [...(f.allow || []), ...(f.deny || [])]
  const unknown = asked.filter((n) => !names.includes(n))
  if (unknown.length > 0) {
    throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map((n) => `"${n}"`).join(', ')}; known global tools: ${[...names].sort().join(', ')}`)
  }
  if (sink) sink.push(f)
  return () => {}
}

/** 假受限执行者：会话事件可自己长，cancel/dispose 计数。 */
const makeAgent = (opts = {}) => {
  const events = []
  const st = { cancelled: 0, disposed: 0, followups: 0, idle: 0 }
  if (opts.seedEvents) for (let i = 0; i < opts.seedEvents; i++) events.push(['seed/' + i, {}])
  const session = {
    id: opts.id || 'p2-exec-b-1',
    ownEvents: () => events,
    snapshotEvents: () => events,
    append: (t, d) => {
      events.push([t, d])
      // 真宿主的执行者会把产物写进候选工作区（用 `write` 工具）；这里让"跑成功"的一轮也这么做。
      if (opts.onAppend) opts.onAppend(t, d)
    },
  }
  const agent = {
    id: opts.id || 'p2-exec-b-1',
    session,
    get status() { return 'idle' },
    followup: () => {
      st.followups += 1
      // 真宿主的一轮：先 append `turn/start`（`dsh-agent-loop` L926），再跑步。
      if (opts.appendOnFollowup !== 0) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        if (opts.appendOnFollowup > 2) session.append('user/message', { content: [{ type: 'text', text: 'x' }] })
        if (opts.assistantReply) session.append('assistant/message', { content: [{ type: 'text', text: 'ok' }] })
      }
      if (typeof opts.duringTurn === 'function') opts.duringTurn()
    },
    cancel: () => { st.cancelled += 1 },
    whenIdle: async () => { st.idle += 1; if (opts.throwOnIdle) throw new Error(opts.throwOnIdle) },
  }
  const handle = { agent, dispose: async () => { st.disposed += 1 } }
  return { agent, handle, events, st }
}

const runOf = async (agent, handle, opts = {}) => {
  const spec = specOf(ROOT, { candidateDir: opts.candidateDir })
  fs.mkdirSync(spec.cwd, { recursive: true })
  return runTurn({
    executor: { ok: true, handle, candidateDir: spec.cwd, spec, assembly: opts.assembly || { agentErrors: opts.agentErrors || [] } },
    prompt: 'p', systemPrompt: 's', memoryRoot: ROOT, batchId: 'b', candidateDir: spec.cwd, attemptTag: '0-t', timeoutMs: opts.timeoutMs,
  })
}

// ── ① 失败路径全部收口 ────────────────────────────────────────────────────────
await section('[t242-1] 所有失败/提前 return 都 stop/dispose', async () => {
  console.log('\n[T242-1] 失败路径收口（旧实现漏 no-output / stale-output 两条）')
  // (a) 派发后正常收敛，但**没有** result.json 也没有 assistant 文本 ⇒ executor-no-output
  {
    const a = makeAgent({ appendOnFollowup: 3 })
    const r = await runOf(a.agent, a.handle)
    check(r.ok === false && r.reason === 'executor-no-output', `no-output 路径如实报（reason=${r.reason}）`)
    check(a.st.cancelled === 1 && a.st.disposed === 1, `no-output ⇒ cancel×${a.st.cancelled} / dispose×${a.st.disposed}（旧实现都是 0）`)
    check(!!r.stopped && r.stopped.disposed === true, '返回值带 stopped 证据')
    check(/^events=\d+->\d+\(\w+\) turns=idle$/.test(String(r.activity)), `活动串是真实计数（${r.activity}）`)
  }
  // (b) whenIdle 超时/抛错
  {
    const a = makeAgent({ appendOnFollowup: 0, throwOnIdle: 'timeout after 150ms' })
    const r = await runOf(a.agent, a.handle, { timeoutMs: 150 })
    check(r.ok === false && String(r.reason).includes('executor-turn-failed'), `whenIdle 抛错 ⇒ 明确失败（${r.reason}）`)
    check(a.st.cancelled === 1 && a.st.disposed === 1, `超时路径也停会话（cancel×${a.st.cancelled} / dispose×${a.st.disposed}）`)
  }
  // (c) 事件一点没长 ⇒ 活动门拦下（不假装跑过）
  {
    const a = makeAgent({ appendOnFollowup: 0 })
    const r = await runOf(a.agent, a.handle)
    check(r.ok === false && String(r.reason).includes('executor-no-activity'), `零活动 ⇒ 拒收（${r.reason}）`)
    check(r.activityGate === 'failed', `活动门标 failed（${r.activityGate}）`)
    check(a.st.cancelled === 1 && a.st.disposed === 1, '零活动路径也停会话')
  }
  // (d) 陈旧产物（上一轮的 result.json 早于本轮派发）⇒ 停会话 + 明确理由
  {
    const a = makeAgent({ appendOnFollowup: 3 })
    const spec = specOf(ROOT, { candidateDir: path.join(ROOT, '.consolidation-out', 'ws-stale') })
    fs.mkdirSync(path.join(spec.cwd, 'attempt-0-t'), { recursive: true })
    fs.writeFileSync(path.join(spec.cwd, 'attempt-0-t', 'result.json'), '{"memory_summary":"old","registry":"old"}')
    const old = Date.now() - 60000
    fs.utimesSync(path.join(spec.cwd, 'attempt-0-t', 'result.json'), old / 1000, old / 1000)
    const r = await runTurn({
      executor: { ok: true, handle: a.handle, candidateDir: spec.cwd, spec, assembly: { agentErrors: [] } },
      prompt: 'p', systemPrompt: 's', memoryRoot: ROOT, batchId: 'b', candidateDir: spec.cwd, attemptTag: '0-t',
    })
    check(String(r.reason).startsWith('executor-stale-output'), `陈旧产物被拒（${String(r.reason).slice(0, 40)}…）`)
    check(a.st.cancelled === 1 && a.st.disposed === 1, `stale-output 路径也停会话（旧实现漏的就是它）`)
  }
  // (e) 成功路径同样停会话（释放活体；会话日志/证据不受影响）
  {
    const a = makeAgent({ appendOnFollowup: 3 })
    const spec = specOf(ROOT, { candidateDir: path.join(ROOT, '.consolidation-out', 'ws-ok') })
    fs.mkdirSync(path.join(spec.cwd, 'attempt-0-t'), { recursive: true })
    fs.writeFileSync(path.join(spec.cwd, 'attempt-0-t', 'result.json'), '{"memory_summary":"ms","registry":"rg"}')
    const r = await runTurn({
      executor: { ok: true, handle: a.handle, candidateDir: spec.cwd, spec, assembly: { agentErrors: [] } },
      prompt: 'p', systemPrompt: 's', memoryRoot: ROOT, batchId: 'b', candidateDir: spec.cwd, attemptTag: '0-t',
    })
    check(r.ok === true && r.source === 'executor-out-file', `成功路径可读产物（source=${r.source}）`)
    check(a.st.cancelled === 1 && a.st.disposed === 1, '成功路径也停会话（防活体泄漏）')
    check(r.activityGate === 'passed', `活动门 passed（事件真的长了：${r.activity}）`)
  }
  // (f) 边界越界（执行者动了权威面）⇒ 停会话 + 拒收。越界必须发生在**轮内**（快照前后）。
  {
    const spec = specOf(ROOT, { candidateDir: path.join(ROOT, '.consolidation-out', 'ws-viol') })
    fs.mkdirSync(path.join(spec.cwd, 'attempt-0-t'), { recursive: true })
    fs.writeFileSync(path.join(spec.cwd, 'attempt-0-t', 'result.json'), '{"memory_summary":"ms","registry":"rg"}')
    const a = makeAgent({ appendOnFollowup: 3, duringTurn: () => fs.appendFileSync(path.join(ROOT, 'MEMORY.md'), 'rogue\n') })
    const r = await runTurn({
      executor: { ok: true, handle: a.handle, candidateDir: spec.cwd, spec, assembly: { agentErrors: [] } },
      prompt: 'p', systemPrompt: 's', memoryRoot: ROOT, batchId: 'b', candidateDir: spec.cwd, attemptTag: '0-t',
    })
    fs.writeFileSync(path.join(ROOT, 'MEMORY.md'), '# MEMORY.md\nbaseline\n')
    check(r.ok === false && r.boundaryViolation === true, `越界 ⇒ 拒收（boundaryViolation=${r.boundaryViolation}）`)
    check(a.st.cancelled === 1 && a.st.disposed === 1, '越界路径也停会话')
  }
})

// ── ② 活动口径：不再有 -1 ─────────────────────────────────────────────────────
await section('[t242-2] 活动口径用本宿主真有的 API', async () => {
  console.log('\n[T242-2] `sessionEventStats` 分层取数 + 串里不出现 -1')
  const stats = typeof m.sessionEventStats === 'function' ? m.sessionEventStats : () => ({ count: null, basis: 'export-missing' })
  check(stats({ ownEvents: () => [1, 2, 3] }).count === 3 && stats({ ownEvents: () => [1, 2, 3] }).basis === 'ownEvents',
    'ownEvents 优先（加载副本 dsh-session L192）')
  check(stats({ snapshotEvents: () => [1] }).basis === 'snapshotEvents', '退到 snapshotEvents（L187）')
  check(stats({ events: [1, 2] }).basis === 'events-array', '老副本的 get events 也认（跨版本兼容）')
  const unreadable = stats({})
  check(unreadable.count === null && unreadable.basis === 'unreadable', '读不到 ⇒ basis=unreadable（不再伪造 -1）')
  {
    const a = makeAgent({ appendOnFollowup: 3 })
    const r = await runOf(a.agent, a.handle)
    check(!String(r.activity).includes('-1'), `活动串里**没有** -1（${r.activity}）`)
    check(r.activity.includes('turns=idle'), 'turns 用真实 AgentStatus 字符串（本宿主 AgentStatus="idle"|"running"）')
  }
})

// ── ③ 执行者装配 ──────────────────────────────────────────────────────────────
await section('[t242-3] 按宿主正规配方装配（preset + 模型 + mount 顺序 + fail-closed）', async () => {
  console.log('\n[T242-3] `agents.create` 收到 preset/model；挂预设先于 restrict；缺路由/挂失败都拒派发')
  const known = ['memory_recall', 'preset_provided_tool', 'delete_sessions']
  const mkPresets = (order, opts = {}) => ({
    resolve: async (id) => { order.push('resolve:' + String(id)); if (opts.resolveThrows) throw new Error('preset broken'); return { id: id || 'preset-default' } },
    mount: async () => { order.push('mount'); if (opts.mountThrows) throw new Error('mount refused') },
  })
  const mkChild = (order, names) => ({
    on: () => () => {},
    tools: {
      view: () => ({ restrictableNames: new Set(names) }),
      // 只有**通过校验**的那次才算一次真 restrict；注定失败的探测（权威名单探路）会在 push 之前抛。
      restrict: (f) => { hostShapedRestrict(names, null)(f); order.push('restrict') },
    },
  })
  // (a) 默认预设 + 模型路由：创建参数齐、mount 先于 restrict
  {
    const order = []
    const calls = []
    const ctx = {
      get: (k) => (k === 'agents' ? { create: async (o) => { calls.push(o); await o.setup(mkChild(order, known)); return { session: { append: () => {} }, agent: { id: o.sessionId } } } }
        : k === 'agentDefaultModel' ? MODEL
          : k === 'agentPresets' ? mkPresets(order) : undefined),
    }
    const r = await startExec({ ctx, memoryRoot: ROOT, sessionId: 'p2-exec-a-1' })
    check(r.ok === true && r.restricted === true, `装配成功（ok=${r.ok} restricted=${r.restricted}）`)
    check(calls.length === 1 && calls[0].agentOptions && calls[0].agentOptions.provider === 'test-p' && calls[0].agentOptions.model === 'test-m',
      `agents.create 收到模型路由（${JSON.stringify(calls[0] && calls[0].agentOptions)}）`)
    check(calls[0].meta.agentPreset === 'preset-default', `meta.agentPreset = 默认预设（${calls[0] && calls[0].meta.agentPreset}）`)
    check(order.join('>') === 'resolve:undefined>mount>restrict', `顺序 = resolve>mount>restrict（实测 ${order.join('>')}）⇒ 预设工具进祖先层、可被 deny 覆盖`)
    check(r.assembly && r.assembly.mounted === true && r.assembly.model === 'test-m',
      `装配证据落返回值（presetId=${r.assembly && r.assembly.presetId} mounted=${r.assembly && r.assembly.mounted}）`)
  }
  // (b) 配置显式点名 preset
  {
    const order = []
    const calls = []
    const ctx = {
      get: (k) => (k === 'agents' ? { create: async (o) => { calls.push(o); await o.setup(mkChild(order, known)); return { session: { append: () => {} } } } }
        : k === 'agentDefaultModel' ? MODEL
          : k === 'agentPresets' ? mkPresets(order) : undefined),
    }
    const r = await startExec({ ctx, memoryRoot: ROOT, sessionId: 'p2-exec-a-2', agentPreset: 'preset-x' })
    check(r.ok === true && calls[0].meta.agentPreset === 'preset-x', `executorAgentPreset 覆盖生效（${calls[0] && calls[0].meta.agentPreset}）`)
    check(order[0] === 'resolve:preset-x', `resolve 收到显式 id（${order[0]}）`)
  }
  // (c) 没有模型路由 ⇒ fail-closed，**不建会话**（照宿主 loop L1149 的硬要求，提前报出来）
  {
    let created = 0
    const ctx = { get: (k) => (k === 'agents' ? { create: async () => { created += 1 } } : undefined) }
    const r = await startExec({ ctx, memoryRoot: ROOT, sessionId: 'p2-exec-a-3' })
    check(r.ok === false && String(r.reason).includes('executor-model-route-missing'), `缺模型路由 ⇒ 明确拒派发（${String(r.reason).slice(0, 60)}）`)
    check(created === 0, '拒派发时**没有**建会话（不留残留）')
    check(r.restricted === false, '不假装 restricted=true')
  }
  // (d) 预设挂失败 ⇒ fail-closed + 停掉刚建的会话
  {
    const order = []
    const st = { disposed: 0 }
    const ctx = {
      get: (k) => (k === 'agents' ? { create: async (o) => { await o.setup(mkChild(order, known)); return { session: { append: () => {} }, agent: { id: o.sessionId }, dispose: async () => { st.disposed += 1 } } } }
        : k === 'agentDefaultModel' ? MODEL
          : k === 'agentPresets' ? mkPresets(order, { mountThrows: true }) : undefined),
    }
    const r = await startExec({ ctx, memoryRoot: ROOT, sessionId: 'p2-exec-a-4' })
    check(r.ok === false && String(r.reason).includes('preset-not-mounted'), `挂预设失败 ⇒ 拒派发（${String(r.reason).slice(0, 80)}）`)
    check(st.disposed === 1, `并停掉刚建的会话（dispose×${st.disposed}）`)
  }
  // (e) 预设带来的工具名**在** deny 名单里（证明"挂预设"不等于"放宽限制"）
  {
    const order = []
    const denySink = []
    const ctx = {
      get: (k) => (k === 'agents' ? { create: async (o) => {
        await o.setup({ on: () => () => {}, tools: { view: () => ({ restrictableNames: new Set(known) }), restrict: hostShapedRestrict(known, denySink) } })
        return { session: { append: () => {} } }
      } } : k === 'agentDefaultModel' ? MODEL : k === 'agentPresets' ? mkPresets(order) : undefined),
    }
    await startExec({ ctx, memoryRoot: ROOT, sessionId: 'p2-exec-a-5' })
    const deny = denySink.length ? denySink[0].deny : null
    check(Array.isArray(deny) && deny.includes('preset_provided_tool') && deny.includes('memory_recall'),
      `deny 覆盖预设带来的工具名（${JSON.stringify(deny)}）`)
  }
})

// ── ⑤ 空壳执行者会话：只识别、不删除（本批 C2「只停不删」牙齿翻转）─────────────
// 翻转依据：用户裁定「归档＝宿主标准配置、**删除＝可选项**」+ Codex R5「移除删除编排时应保留真正的
//   取消/释放路径」⇒ 插件侧不再驱动任何会话删除。**原断言是"空壳被清（attempted=true / 调用一次）"**，
//   现改为"识别到空壳但 `delete_sessions` 调用计数恒为 0、结果如实报未删"。安全不变式原样保留：
//   只认自己的会话 id、有模型输出绝不碰、配置关闭不记。
await section('[t242-5] 空壳会话：识别到但不删除（本批牙齿翻转）', async () => {
  console.log('\n[T242-5] `cleanupEmptyExecutorSession` 的四道谓词 + **不驱动删除** + 结果如实')
  const mkCtxWithDelete = (calls, result) => ({ tools: { get: (n) => (n === 'delete_sessions' ? { execute: async (a) => { calls.push(a); return result } } : undefined) } })
  // (a) 正例（**牙齿翻转**）：我们的 id + 0 事件 ⇒ 识别为空壳，但**绝不调用删除工具**
  {
    const calls = []
    const ctx = mkCtxWithDelete(calls, { dryRun: false, targets: 1, deleted: 1, skippedLive: 0, skippedBackup: 0, backupDir: 'B:/x', details: [{ sessionId: 'p2-exec-b-1-0-t', action: 'deleted', backupPath: 'B:/x/p2-exec-b-1-0-t' }] })
    const r = await cleanupEmpty({ ctx, config: {}, batchId: 'b-1', sessionId: 'p2-exec-b-1-0-t', assistantEvents: 0 })
    check(r.emptyShell === true && r.deleted === false && r.outcome === 'no-delete-by-design',
      `空壳被**识别**（emptyShell=${r.emptyShell} outcome=${r.outcome}）`)
    check(r.attempted === false, `不发起删除尝试（attempted=${r.attempted}）`)
    check(calls.length === 0, `删除工具**调用 0 次**（实测 ${calls.length}；本批前此处为 1 —— 插件侧不再驱动删除）`)
  }
  // (b) 有内容（事件>0）⇒ 绝不碰（那是本轮证据）—— 安全不变式，原样保留
  {
    const calls = []
    const r = await cleanupEmpty({ ctx: mkCtxWithDelete(calls, {}), config: {}, batchId: 'b-1', sessionId: 'p2-exec-b-1-0-t', assistantEvents: 7 })
    check(r.attempted === false && r.emptyShell === false && String(r.text).includes('has-assistant-output') && calls.length === 0, `有模型输出 ⇒ 不碰（那是本轮证据；${r.text}）`)
  }
  // (c) 不是我们的会话 id ⇒ 绝不碰（只认自己的）—— 安全不变式，原样保留
  {
    const calls = []
    const r = await cleanupEmpty({ ctx: mkCtxWithDelete(calls, {}), config: {}, batchId: 'b-1', sessionId: 'session-user-real', assistantEvents: 0 })
    check(r.attempted === false && r.emptyShell === false && r.text === 'not-our-executor-session' && calls.length === 0, '别人的会话 id ⇒ 不碰（只认自己的）')
  }
  // (d) 配置键 `executorEmptySessionCleanup:false`（旧配置）⇒ 连识别记录都不落（读取兼容，不是"停止"开关）
  {
    const calls = []
    const r = await cleanupEmpty({ ctx: mkCtxWithDelete(calls, {}), config: { executorEmptySessionCleanup: false }, batchId: 'b-1', sessionId: 'p2-exec-b-1-0-t', assistantEvents: 0 })
    check(r.attempted === false && r.emptyShell === false && r.text === 'disabled-by-config' && calls.length === 0, '旧配置键 false ⇒ 不记识别（且**不驱动删除**）')
  }
  // (e) **口径翻转**：旧断言"缺删除工具 ⇒ delete-tool-unavailable"作废 —— 现在**根本不去取删除工具**，
  //     因此"工具不可用"不再是一个可达结果；同一入参应报"空壳已识别、不删除"。
  {
    const r = await cleanupEmpty({ ctx: { tools: { get: () => null } }, config: {}, batchId: 'b-1', sessionId: 'p2-exec-b-1-0-t', assistantEvents: 0 })
    check(r.emptyShell === true && r.outcome === 'no-delete-by-design' && r.deleted === false,
      `删除工具不存在也照样只识别（outcome=${r.outcome}；旧断言的 delete-tool-unavailable 已不可达）`)
  }
  // (f) 入参缺失 ⇒ 如实跳过，不抛
  {
    const r = await cleanupEmpty({ config: {}, batchId: 'b-1', sessionId: '', assistantEvents: 0 })
    check(r.attempted === false && r.text === 'missing-id-or-batch', `缺 id ⇒ 如实跳过（${r.text}）`)
  }
})

// ── ⑥ 会话目录消失的容错 ──────────────────────────────────────────────────────
await section('[t242-6] 会话已消失：读/停/识别都不抛不挂，且不改批状态（本批不删）', async () => {
  console.log('\n[T242-6] 悬空引用的容错（用户 GUI 清掉执行者会话目录）')
  // (a) stop 对"会话没了"的 executor 不抛、不挂
  {
    const t0 = Date.now()
    const r = await stopExec({ handle: { agent: null, dispose: async () => { throw new Error('handle already gone') } } }, 'executor-session-missing')
    check(typeof r === 'object' && Date.now() - t0 < 3000, `stop 对残缺 handle 不抛不挂（notes=${(r.notes || []).join('|') || '-'}）`)
  }
  // (b) executorSessionGone：活体注册表没有 + 持久化里也没有 ⇒ true；持久化不可用 ⇒ undefined（不敢下结论）
  {
    const gone = await sessionGone({ get: (k) => (k === 'sessionPersistence' ? { list: async () => [{ header: { id: 'other' } }] } : undefined) }, 'p2-exec-b-1-0-t')
    check(gone === true, `存储里找不到 ⇒ gone=true（实测 ${gone}）`)
    const alive = await sessionGone({ get: (k) => (k === 'sessionPersistence' ? { list: async () => [{ header: { id: 'p2-exec-b-1-0-t' } }] } : undefined) }, 'p2-exec-b-1-0-t')
    check(alive === false, `还在存储里 ⇒ gone=false（实测 ${alive}）`)
    const unknown = await sessionGone({ get: () => undefined }, 'p2-exec-b-1-0-t')
    check(unknown === undefined, `判不出来 ⇒ undefined（**不据此改任何状态**，实测 ${unknown}）`)
    const liveReg = await sessionGone({ get: (k) => (k === 'agents' ? { get: () => ({ id: 'x' }) } : undefined) }, 'p2-exec-b-1-0-t')
    check(liveReg === false, '活体注册表里还在 ⇒ 立即 false（不查存储）')
  }
  // (c) 集成：同一场景跑两遍 —— **会话还在** vs **会话目录已被外部清掉**；批次的判定必须一致。
  {
    const runBatch = async (tag, includeOwnSession) => {
      const home = path.join(TMP, 'h6-' + tag)
      fs.mkdirSync(home, { recursive: true })
      process.env.DSH_HOME = home
      const { seedJob, seedOutput, makeCtx: mk } = await import('./lib/helpers.mjs')
      const tools = {}
      const a = makeAgent({ appendOnFollowup: 0 })   // 零活动 ⇒ 走到 no-activity 失败 + 停 + 清理
      const deleteCalls = []
      const st = { disposed: 0 }
      const own = { id: '' }
      // 会话"还在不在存储里"要按**真实生成的 id** 判定：create 时抓下来，`list()` 再据此回答。
      const persistenceList = () => (includeOwnSession
        ? [{ header: { id: own.id } }, { header: { id: 'other-session' } }]
        : [{ header: { id: 'other-session' } }])
      const agentsSvc = {
        create: async (o) => {
          own.id = String(o.sessionId || '')
          // 真宿主保证 `agent.id === agent.session.id`（dsh-agent 的 `enter` 会断言）⇒ 假件也照此对齐。
          a.agent.id = own.id
          a.agent.session.id = own.id
          await o.setup({ on: () => () => {}, tools: { view: () => ({ restrictableNames: new Set(['memory_recall']) }), restrict: hostShapedRestrict(['memory_recall'], null) } })
          return { session: a.agent.session, agent: a.agent, dispose: async () => { st.disposed += 1 } }
        },
      }
      const { ctx, domain } = mk({
        get: (k) => (k === 'agents' ? agentsSvc
          : k === 'agentDefaultModel' ? MODEL
            : k === 'llm' ? { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify({ memory_summary: 'v2\n## ' + tag, registry: '# MEMORY.md\n' + tag }) }; yield { type: 'finish', reason: { kind: 'stop' } } } }) }
              : k === 'sessionPersistence' ? { list: async () => persistenceList() }
                : undefined),
        tools: { register: (t) => { if (t && t.name) tools[t.name] = t } },
      })
      ctx.tools.get = (n) => (n === 'delete_sessions' ? { execute: async (args) => { deleteCalls.push(args); return { dryRun: false, targets: 1, deleted: 0, skippedLive: 0, skippedBackup: 0, backupDir: 'B:/x', details: [{ sessionId: args.sessionIds[0], action: 'skipped-missing' }] } } } : undefined)
      await apply(ctx, { consolidationExecutor: 'restricted-session-experiment' })
      await seedOutput(domain, 'o-' + tag, { session_id: 's-' + tag, source_watermark: 'wm-' + tag, rollout_summary: 'durable content for ' + tag + ' ' + 'x'.repeat(40) })
      await seedJob(domain, 's-' + tag, 'wm-' + tag, { status: 'succeeded_with_output' })
      domain.table('phase2_jobs').put('B', {
        id: 'B', status: 'pending', input_ids: ['o-' + tag], change_ids: [], lease_owner: '', lease_expires_at: '',
        attempt_count: 0, max_attempts: 3, available_at: new Date(Date.now() - 120000).toISOString(), staging_version: '',
        last_error: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      })
      let err = null
      try { await tools['memory__phase2_integrate'].execute({}) } catch (e) { err = e }
      const job = [...domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v })).pop() || {}
      return { err, job, deleteCalls, disposed: st.disposed }
    }
    const withSession = await runBatch('alive', true)
    // 会话目录"已被清掉"：存储里**还有别的会话**，但没有执行者那一条（这正是用户 GUI 清完后的形态）
    const goneSession = await runBatch('gone', false)
    process.env.DSH_HOME = TMP
    check(withSession.err === null && goneSession.err === null,
      `两种情形都**不报错**（alive=${withSession.err && withSession.err.message} / gone=${goneSession.err && goneSession.err.message}）`)
    check(withSession.job.status === goneSession.job.status,
      `批次状态**不因会话消失而改判**（alive=${withSession.job.status} / gone=${goneSession.job.status}）`)
    check(String(withSession.job.executor_reason) === String(goneSession.job.executor_reason),
      `批次理由也不改判（${goneSession.job.executor_reason}）`)
    check(withSession.disposed === 1 && goneSession.disposed === 1, `两种情形执行者会话都被停（${withSession.disposed}/${goneSession.disposed}）`)
    check(String(goneSession.job.executor_activity || '').includes('events=') && !String(goneSession.job.executor_activity).includes('-1'),
      `批记录带真实活动串（${goneSession.job.executor_activity}）`)
    check(goneSession.job.executor_model === 'test-m', `批记录带装配证据（model=${goneSession.job.executor_model}）`)
    check(String(goneSession.job.executor_reason).includes('executor-no-activity'), `失败理由如实（${goneSession.job.executor_reason}）`)
    check(goneSession.deleteCalls.length === 0,
      `**不驱动删除**：本批不会对"空壳 + 我们自己的 id"发起任何删除调用（实测 ${goneSession.deleteCalls.length} 次；翻转前此处为 1）`)
    check(String(goneSession.job.executor_cleanup || '').includes('no-delete-by-design'),
      `识别结果如实落记录（executor_cleanup=${goneSession.job.executor_cleanup}）`)
    check(String(withSession.job.executor_session_missing_at || '') === '' && String(goneSession.job.executor_session_missing_at || '') !== '',
      `只有"会话真的没了"那一路落缺失标记（alive='${withSession.job.executor_session_missing_at || ''}' / gone='${goneSession.job.executor_session_missing_at || ''}'）`)
  }
})

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`\n${failed === 0 ? 'ALL T242 EXECUTOR-FULL-FLOW TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
