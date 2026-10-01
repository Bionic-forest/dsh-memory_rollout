// t243（T33 / v0.1.24）：**短期正确性收口**的定向测试。
//
// 三件事，按外部裁决 §九 的顺序：
//   ① **内部执行来源隔离**（最优先）：内部执行者会话**永不作记忆来源** —— 新入队要挡、**队列里已存在的
//      内部作业**也要过资格检查；身份用**可信创建记录**（会话头 `delegationDepth>0` / 我们的创建台账），
//      名字前缀只作**辅助**（覆盖改动之前创建的旧执行者会话）。
//   ② **消息契约**：`buildExecutorUserMessage` 按加载副本 `dsh-session` 的 `assertMessageEventShape`
//      补非空 `id`（`user/message` 的 data 必须有 id），否则会话日志被判 `SESSION_QUERY_CORRUPT_SESSION`。
//   ③ **D-1**：成功分支保留最小必要的 `executor_restrict_source` / `executor_restrict_unknown`。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, metaOf, seedJob, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const m = await import(PLUGIN)
const { apply } = m
const internalReason = typeof m.internalExecutionReason === 'function' ? m.internalExecutionReason : () => 'export-missing'
const isInternal = typeof m.isInternalExecutionSession === 'function' ? m.isInternalExecutionSession : () => false
const buildMsg = typeof m.buildExecutorUserMessage === 'function' ? m.buildExecutorUserMessage : () => ({})
const startExec = typeof m.startConsolidationExecutor === 'function' ? m.startConsolidationExecutor : async () => ({ ok: false, reason: 'export-missing' })
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory_rollout-t243-'))
process.env.DSH_HOME = TMP
const MODEL = { currentSelection: () => ({ provider: 'tp', model: 'tm' }) }
/** 宿主形 `restrict`（按真实名单校验名字；不带 known 名单的假件会让权威探测拿不到名单）。 */
const hostShapedRestrict = (names, sink) => (f) => {
  const asked = [...(f.allow || []), ...(f.deny || [])]
  const unknown = asked.filter((n) => !names.includes(n))
  if (unknown.length > 0) {
    throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map((n) => `"${n}"`).join(', ')}; known global tools: ${[...names].sort().join(', ')}`)
  }
  if (sink) sink.push(f)
  return () => {}
}
const HOUR = 3600000
const snap = (id, idleHours, header = {}) => ({
  header: { version: 4, isSeeded: false, id, cwd: 'C:/t243', createdAt: 0, ...header },
  revision: `1:2:3:${Math.round((Date.now() - idleHours * HOUR) * 1e6)}:4`,
  sizeBytes: 128,
})
const msgEvent = (id, text) => ({ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })

// ── ① 身份判定：可信创建记录优先、前缀辅助；`delegationDepth` **不算**内部身份 ──
await section('[t243-1] 身份判定（台账 > 前缀；不含 delegationDepth）', async () => {
  console.log('\n[T243-1] `internalExecutionReason`：台账 > 前缀；普通子代理会话**不得**被误标')
  check(internalReason({ header: {}, sessionId: 'x', ledger: { x: { batchId: 'B' } } }) === 'internal-executor-ledger',
    '创建台账命中 ⇒ 认作内部（可信记录）')
  check(internalReason({ header: {}, sessionId: 'p2-exec-whatever' }) === 'internal-executor-name',
    '执行者 id 前缀 ⇒ 认作内部（**辅助**：覆盖台账缺失 / 旧执行者会话）')
  check(internalReason({ header: {}, sessionId: 'p2-exec-whatever', ledger: { 'p2-exec-whatever': {} } }) === 'internal-executor-ledger',
    '台账优先于前缀（可信记录优先）')
  // t250（T34 真机复核的更正）：普通子代理会话也带 delegationDepth>0 ⇒ 单凭它会把 77 条误标成内部执行者
  check(internalReason({ header: { delegationDepth: 1 }, sessionId: '92eab145-dd40-4652-ba88-981dad13ae2d' }) === '',
    '普通子代理会话（UUID id + delegationDepth>0）⇒ **不**标成内部执行者（真机曾误标 77 条）')
  check(internalReason({ header: { delegationDepth: 1 }, sessionId: 'x' }) === '', '只有 delegationDepth ⇒ 不算内部身份')
  check(internalReason({ header: {}, sessionId: 'session-abc' }) === '', '普通根会话 ⇒ 不是内部')
  check(isInternal({ header: {}, sessionId: 'p2-exec-a' }) === true && isInternal({ header: {}, sessionId: 'session-a' }) === false, '布尔简写一致')
})

// ── ② 创建时写入可信记录 + 记账台账 ───────────────────────────────────────────
await section('[t243-2] 创建执行者会话写入可信记录（meta.delegationDepth + 台账）', async () => {
  console.log('\n[T243-2] `agents.create` 收到的 meta 含 delegationDepth；台账落 stage1_meta')
  const calls = []
  const ctx = {
    get: (k) => (k === 'agents' ? { create: async (o) => { calls.push(o); await o.setup({ on: () => () => {}, tools: { view: () => ({ restrictableNames: new Set(['memory_recall']) }), restrict: hostShapedRestrict(['memory_recall'], null) } }); return { session: { append: () => {} }, agent: { id: o.sessionId } } } }
      : k === 'agentDefaultModel' ? MODEL : undefined),
  }
  const r = await startExec({ ctx, memoryRoot: path.join(TMP, 'm1'), sessionId: 'p2-exec-B-0-abc' })
  check(r.ok === true, `装配成功（ok=${r.ok}）`)
  check(calls.length === 1 && calls[0].meta && Number(calls[0].meta.delegationDepth) > 0,
    `meta 带 delegationDepth（实测 ${JSON.stringify(calls[0] && calls[0].meta)}）⇒ 身份跨重启可读、不靠名字`)
  check(!(calls[0].meta.origin === 'subagent'),
    '不用 `origin:"subagent"`（那会落到宿主的 subagent 归属路由，干扰后续官方读取取证）')

  // 台账：跑一趟真实整合（成功路径），看 stage1_meta.executorSessions 是否记上
  const home = path.join(TMP, 'm2'); fs.mkdirSync(home, { recursive: true }); process.env.DSH_HOME = home
  const tools = {}
  const specW = specOf(path.join(home, 'memories'))
  const agentsSvc = {
    create: async (o) => {
      await o.setup({ on: () => () => {}, tools: { view: () => ({ restrictableNames: new Set(['memory_recall']) }), restrict: hostShapedRestrict(['memory_recall'], null) } })
      const agent = {
        id: o.sessionId,
        session: { id: o.sessionId, ownEvents: () => [], snapshotEvents: () => [], append: () => {} },
        get status() { return 'idle' },
        followup: () => {},
        cancel: () => {},
        whenIdle: async () => {},
      }
      return { session: agent.session, agent, dispose: async () => {} }
    },
  }
  const { ctx: c2, domain } = makeCtx({
    get: (k) => (k === 'agents' ? agentsSvc : k === 'agentDefaultModel' ? MODEL
      : k === 'llm' ? { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify({ memory_summary: 's\n## x', registry: '# MEMORY.md\nx' }) }; yield { type: 'finish', reason: { kind: 'stop' } } } }) }
        : undefined),
    tools: { register: (t) => { if (t && t.name) tools[t.name] = t } },
  })
  await apply(c2, { consolidationExecutor: 'restricted-session-experiment' })
  await seedOutput(domain, 'o1', { session_id: 's1', source_watermark: 'w1', rollout_summary: 'content ' + 'x'.repeat(60) })
  await seedJob(domain, 's1', 'w1', { status: 'succeeded_with_output' })
  domain.table('phase2_jobs').put('B', {
    id: 'B', status: 'pending', input_ids: ['o1'], change_ids: [], lease_owner: '', lease_expires_at: '',
    attempt_count: 0, max_attempts: 3, available_at: new Date(Date.now() - 120000).toISOString(), staging_version: '',
    last_error: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  await tools['memory__phase2_integrate'].execute({})
  const ledger = metaOf(domain).executorSessions || {}
  const ids = Object.keys(ledger)
  check(ids.length === 1 && /^p2-exec-B-/.test(ids[0]),
    `创建台账记下执行者会话（实测 ${JSON.stringify(ids)}）⇒ 队列侧也能用它判身份`)
  check(String(ledger[ids[0]] && ledger[ids[0]].batchId) === 'B', `台账条目带批次 id（${ledger[ids[0]] && ledger[ids[0]].batchId}）`)
  process.env.DSH_HOME = TMP
})

// ── ③ 扫描：不再把内部会话当候选 ─────────────────────────────────────────────
await section('[t243-3] 静置扫描不再消费内部执行者会话（新式标记 / 旧式前缀）', async () => {
  console.log('\n[T243-3] 扫描把内部会话单独计数，且**不读源、不入队**')
  const runScan = async (snapshots, cfg = {}) => {
    const home = path.join(TMP, 'h-' + Math.random().toString(36).slice(2, 7))
    fs.mkdirSync(home, { recursive: true })
    process.env.DSH_HOME = home
    let listCalls = 0
    let reads = 0
    const readIds = []
    const persistence = {
      list: async () => { listCalls += 1; return listCalls === 1 ? [] : snapshots },
      locate: () => ({ path: 'Z:\\t243-nope\\log.jsonl' }),
    }
    const { ctx, domain } = makeCtx({
      get: (k) => (k === 'sessionPersistence' ? persistence
        : k === 'sessionQuery' ? { readSession: async (id) => { reads += 1; readIds.push(String(id)); return { session: { version: 4, isSeeded: false, id, cwd: 'C:/t243', createdAt: 0 }, events: [msgEvent(id, 'x'.repeat(200))] } } }
          : k === 'llm' ? { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }) } : undefined),
    })
    await apply(ctx, cfg)
    const r = await ctx.tools['memory__ingest_scan'].execute({})
    if (process.env.T243_DEBUG) console.log('   [debug] scan =', JSON.stringify(r), 'jobs =', JSON.stringify(Object.keys(jobListOf(domain))))
    return { r, domain, reads: () => reads, readIds: () => readIds, meta: () => metaOf(domain) }
  }
  {
    const a = await runScan([snap('p2-exec-B-0-new', 12, { delegationDepth: 1 }), snap('session-real-1', 12)], { minRolloutIdleHours: 6, maxRolloutAgeDays: 10 })
    check(a.r.internal === 1 && a.r.nonRoot === 0, `内部执行者会话被单独计数（internal=${a.r.internal} nonRoot=${a.r.nonRoot}）`)
    check(a.r.enqueued === 1, `同趟的**普通**会话照常入队（enqueued=${a.r.enqueued}）`)
    const keys = Object.keys(jobListOf(a.domain))
    check(!keys.some((k) => k.startsWith('p2-exec-')), `内部会话没有入队（jobs=${JSON.stringify(keys)}）`)
    const seen = a.meta().scanSeen || {}
    check(String((seen['p2-exec-B-0-new'] || {}).reason || '').startsWith('internal-executor-session'),
      `内部会话的水位被推进并标注理由（${(seen['p2-exec-B-0-new'] || {}).reason}）⇒ 不每周期重查`)
    check(a.reads() <= 1, `只为普通会话读过一次源（reads=${a.reads()}）⇒ 内部会话**不读源**`)
  }
  {
    // t250（D-3 回归）：**普通子代理会话**（UUID id + delegationDepth>0）⇒ 走既有的"非根"计数，
    //   不占 `internal`、也不写 scanSeen（真机曾把 77 条这类会话误标成内部执行者）。
    const c = await runScan([snap('92eab145-dd40-4652-ba88-981dad13ae2d', 12, { delegationDepth: 1 })], { minRolloutIdleHours: 6, maxRolloutAgeDays: 10 })
    check(c.r.internal === 0 && c.r.nonRoot === 1,
      `普通子代理会话被算作**非根**而不是内部执行者（internal=${c.r.internal} nonRoot=${c.r.nonRoot}）`)
    const seen2 = c.meta().scanSeen || {}
    check(!(seen2['92eab145-dd40-4652-ba88-981dad13ae2d']), '并且**不写** scanSeen（回归改前 v0.1.23 的行为）')
  }
  {
    // 旧式（改动之前创建）：头里没有标记，只有名字前缀
    const b = await runScan([snap('p2-exec-B-0-legacy', 12)], { minRolloutIdleHours: 6, maxRolloutAgeDays: 10 })
    check(b.r.internal === 1 && b.r.enqueued === 0 && b.r.candidates === 0,
      `旧式残留（仅名字前缀）同样被挡（internal=${b.r.internal} enqueued=${b.r.enqueued} candidates=${b.r.candidates}）`)
  }
})

// ── ④ 显式入口也不放行 ───────────────────────────────────────────────────────
await section('[t243-4] 三个触发面共用同一判定：显式入口也不得把它变成来源', async () => {
  console.log('\n[T243-4] `memory_ingest_session` 点名内部会话 ⇒ 明确拒绝、不入队')
  const home = path.join(TMP, 'h-explicit'); fs.mkdirSync(home, { recursive: true }); process.env.DSH_HOME = home
  const tools = {}
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'sessionQuery' ? { readSession: async (id) => ({ session: { version: 4, isSeeded: false, id, cwd: 'C:/t243', delegationDepth: 1 }, events: [msgEvent(id, 'y'.repeat(200))] }) } : undefined),
    tools: { register: (t) => { if (t && t.name) tools[t.name] = t } },
  })
  await apply(ctx, {})
  const r = await tools['memory_ingest_session'].execute({ sessionId: 'p2-exec-Z-0-x', awaitDraft: false })
  check(r.queued === false && r.reason === 'internal-executor-session', `显式入口拒绝（queued=${r.queued} reason=${r.reason}）`)
  check(Object.keys(jobListOf(domain)).length === 0, '没有产生任何作业')
  check(!fs.existsSync(path.join(home, 'memories', 'rollout_summaries', 'p2-exec-Z-0-x.md')), '没有产生草稿/证据')
  process.env.DSH_HOME = TMP
})

// ── ⑤ 队列里已存在的内部作业：资格检查收掉，且不读源 ─────────────────────────
await section('[t243-5] 队列中已有的内部作业被资格检查收掉（不读源、不重试）', async () => {
  console.log('\n[T243-5] 已入队的 `pending` 内部作业 ⇒ `succeeded_no_output` + 明确 skip 理由')
  const home = path.join(TMP, 'h-queue'); fs.mkdirSync(home, { recursive: true }); process.env.DSH_HOME = home
  let reads = 0
  const readIds = []
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'sessionQuery' ? { readSession: async (id) => { reads += 1; readIds.push(String(id)); return { session: { version: 4, isSeeded: false, id, cwd: 'C:/t243', createdAt: 0 }, events: [msgEvent(id, 'z'.repeat(300))] } } }
      : k === 'llm' ? { stream: () => { throw new Error('内部作业**不该**走到模型调用'); } } : undefined),
  })
  await apply(ctx, {})
  // 两条：① 名字前缀（旧式）② 台账式（用 delegationDepth 头认不出——故先造台账不现实，这里用前缀 + 断言字段）
  await seedJob(domain, 'p2-exec-Q-0-old', 'wm-old', { status: 'pending' })
  await seedJob(domain, 'p2-exec-Q-0-retry', 'wm-retry', { status: 'failed_retryable', attemptCount: 1 })
  await seedJob(domain, 'session-keep', 'wm-keep', { status: 'pending' })
  const res = await ctx.tools['memory__stage1_drain'].execute({})
  check(!!res, `drain 跑过（${JSON.stringify(res && res.ran)}）`)
  const jobs = jobListOf(domain)
  const j1 = jobs['p2-exec-Q-0-old::wm-old']
  const j2 = jobs['p2-exec-Q-0-retry::wm-retry']
  check(j1 && j1.status === 'succeeded_no_output', `旧式内部作业被判 no-output（status=${j1 && j1.status}）`)
  check(j1 && String(j1.last_skip_reason || '').includes('internal_executor_session'),
    `并落明确理由（last_skip_reason=${j1 && j1.last_skip_reason}）`)
  check(j2 && j2.status === 'succeeded_no_output', `**失败可重试**的内部作业也一并收掉（status=${j2 && j2.status}）⇒ 不再反复重试`)
  check(Object.keys(jobListOf(domain)).every((k) => k.startsWith('p2-exec-') || k === 'session-keep::wm-keep'),
    '内部作业没有产生任何 output 条目（只留作业记录）')
  const outs = [...domain.table('stage1_outputs').entries()]
  check(outs.length === 0, `没有产出（outputs=${outs.length}）`)
  const internalReads = readIds.filter((id) => id.startsWith('p2-exec-'))
  check(internalReads.length === 0, `内部作业**一次源都没读**（内部读取=${JSON.stringify(internalReads)}；本趟合法作业读取=${JSON.stringify(readIds)}）⇒ 不走"读失败→重试"那条路`)
  process.env.DSH_HOME = TMP
})

// ── ⑥ 消息契约：非空 id ──────────────────────────────────────────────────────
await section('[t243-6] 执行者消息按宿主消息契约补 id', async () => {
  console.log('\n[T243-6] `buildExecutorUserMessage` 生成非空 id；派发时用稳定 id')
  const a = buildMsg('hello')
  check(typeof a.id === 'string' && a.id !== '', `默认生成非空 id（${a.id}）`)
  check(a.role === 'user' && Array.isArray(a.content) && a.content[0] && a.content[0].type === 'text', 'role/content 形状不变')
  check(a.source && a.source.kind === 'plugin', `source.kind 保留（${a.source && a.source.kind}）`)
  const b = buildMsg('hello', { id: 'exec-B-0-t' })
  check(b.id === 'exec-B-0-t', `显式 id 生效（${b.id}）`)
  check(buildMsg('x').id !== buildMsg('x').id, '缺省时两次生成不同 id（不撞号）')
  // 派发路径：假 agent 记录收到的消息
  const seen = []
  const ctx = {
    get: (k) => (k === 'agents' ? { create: async (o) => {
      await o.setup({ on: () => () => {}, tools: { view: () => ({ restrictableNames: new Set(['memory_recall']) }), restrict: hostShapedRestrict(['memory_recall'], null) } })
      const events = []
      const agent = {
        id: o.sessionId,
        session: { id: o.sessionId, ownEvents: () => events, snapshotEvents: () => events, append: (t, d) => events.push([t, d]) },
        get status() { return 'idle' },
        followup: (msg) => { seen.push(msg); events.push(['turn/start', {}]) },
        cancel: () => {},
        whenIdle: async () => {},
      }
      return { session: agent.session, agent, dispose: async () => {} }
    } } : k === 'agentDefaultModel' ? MODEL : undefined),
  }
  const root = path.join(TMP, 'm-msg'); fs.mkdirSync(root, { recursive: true })
  const exec = await startExec({ ctx, memoryRoot: root, sessionId: 'p2-exec-MSG-0-t' })
  const spec = specOf(root)
  fs.mkdirSync(spec.cwd, { recursive: true })
  await m.runConsolidationExecutorTurn({ executor: exec, prompt: 'p', systemPrompt: 's', memoryRoot: root, batchId: 'MSG', candidateDir: spec.cwd, attemptTag: '0-t' })
  check(seen.length === 1 && typeof seen[0].id === 'string' && seen[0].id !== '', `真正派发出的消息带 id（${seen[0] && seen[0].id}）`)
  check(seen[0] && seen[0].id === 'exec-MSG-0-t', `id 稳定可复查（batchId+attemptTag）`)
})

// ── ⑦ D-1：成功路径保留限制观测（最小必要） ─────────────────────────────────
await section('[t243-7] 成功路径保留 `executor_restrict_source` / `_unknown`（D-1）', async () => {
  console.log('\n[T243-7] 受限轮次**成功**时，批记录仍带限制来源与缺失名单')
  const home = path.join(TMP, 'h-d1'); fs.mkdirSync(home, { recursive: true }); process.env.DSH_HOME = home
  const tools = {}
  const known = ['memory_recall']   // 宿主"可限制名单"（假件按它校验名字）
  const attemptTagDir = () => {
    const ws = path.join(home, 'memories', '.consolidation-out', 'executor-workspace')
    try { return path.join(ws, fs.readdirSync(ws).find((n) => n.startsWith('attempt-')) || '') } catch { return '' }
  }
  const agentsSvc = {
    create: async (o) => {
      await o.setup({ on: () => () => {}, tools: { view: () => ({ restrictableNames: new Set(known) }), restrict: hostShapedRestrict(known, null) } })
      const events = []
      const agent = {
        id: o.sessionId,
        // 真宿主 `ownEvents()` 返回**事件对象**（带 `type`）⇒ 假件也照此，才能验证"助手输出"计数。
        session: { id: o.sessionId, ownEvents: () => events, snapshotEvents: () => events, append: (t, d) => events.push({ type: t, data: d }) },
        get status() { return 'idle' },
        followup: () => {
          // 真宿主一轮：先 append `turn/start`，再产出助手消息；产物由执行者自己写进候选工作区。
          events.push({ type: 'turn/start', data: {} })
          events.push({ type: 'step/start', data: {} })
          events.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'ok' }] } })
          const dir = attemptTagDir()
          if (dir) fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ memory_summary: 'v-next\n## t243', registry: '# MEMORY.md\nt243' }))
        },
        cancel: () => {},
        whenIdle: async () => {},
      }
      return { session: agent.session, agent, dispose: async () => {} }
    },
  }
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'agents' ? agentsSvc : k === 'agentDefaultModel' ? MODEL
      : k === 'llm' ? { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify({ memory_summary: 'fb\n## x', registry: '# MEMORY.md\nfb' }) }; yield { type: 'finish', reason: { kind: 'stop' } } } }) }
        : undefined),
    tools: { register: (t) => { if (t && t.name) tools[t.name] = t } },
  })
  await apply(ctx, { consolidationExecutor: 'restricted-session-experiment' })
  await seedOutput(domain, 'o-d1', { session_id: 's-d1', source_watermark: 'w-d1', rollout_summary: 'content ' + 'y'.repeat(60) })
  await seedJob(domain, 's-d1', 'w-d1', { status: 'succeeded_with_output' })
  domain.table('phase2_jobs').put('D1', {
    id: 'D1', status: 'pending', input_ids: ['o-d1'], change_ids: [], lease_owner: '', lease_expires_at: '',
    attempt_count: 0, max_attempts: 3, available_at: new Date(Date.now() - 120000).toISOString(), staging_version: '',
    last_error: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  await tools['memory__phase2_integrate'].execute({})
  const job = [...domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v })).pop() || {}
  check(job.executor_path === 'restricted-session' && job.executor_reason === '',
    `受限路径成功（path=${job.executor_path} reason="${job.executor_reason}"）`)
  check(job.executor_source === 'executor-out-file', `产物取自执行者写的文件（${job.executor_source}）`)
  check(String(job.executor_restrict_source) !== '', `**限制来源不再丢**（executor_restrict_source=${job.executor_restrict_source}）`)
  check(String(job.executor_restrict_unknown).split(',').filter(Boolean).length > 0,
    `**缺失名单不再丢**（executor_restrict_unknown=${job.executor_restrict_unknown}）`)
  check(String(job.executor_assistant_events) !== '' && Number(job.executor_assistant_events) >= 1,
    `助手输出计数落记录（${job.executor_assistant_events}）`)
  check(job.executor_activity_gate === 'passed', `活动门通过（${job.executor_activity_gate}）`)
  process.env.DSH_HOME = TMP
})

// ── ⑧ D-5：唤醒时刻必须并进"扫描到期"（否则扫描周期被 drain 收尾清掉） ────────
await section('[t243-8] `nextWakeAtWithScan`：扫描到期不被队列排程覆盖（D-5）', async () => {
  console.log('\n[T243-8] 唤醒合并规则（真机实测 40 分钟无 wake 扫描 ⇒ 修）')
  const merge = typeof m.nextWakeAtWithScan === 'function' ? m.nextWakeAtWithScan : () => null
  const iv = 30 * 60 * 1000
  const now = Date.UTC(2026, 8, 21, 14, 42, 0)
  const scanAt = new Date(Date.UTC(2026, 8, 21, 14, 2, 56)).toISOString()
  const scanDue = Date.UTC(2026, 8, 21, 14, 32, 56)
  check(merge({ wakeAt: null, scanLastAtIso: scanAt, now, intervalMs: iv }) === scanDue,
    '队列无到期（wakeAt=null）⇒ 仍按"上次扫描 + 周期"排唤醒（改前会被清成无定时器）')
  const later = scanDue + 3600000
  check(merge({ wakeAt: later, scanLastAtIso: scanAt, now, intervalMs: iv }) === scanDue,
    '队列到期更晚 ⇒ 取更早的扫描到期')
  const earlier = scanDue - 600000
  check(merge({ wakeAt: earlier, scanLastAtIso: scanAt, now, intervalMs: iv }) === earlier,
    '队列到期更早 ⇒ 保留队列到期（不推迟）')
  check(merge({ wakeAt: null, scanLastAtIso: '', now, intervalMs: iv }) === now + iv,
    '没有扫描记账 ⇒ 以 now 起算一个周期（不返回 null）')
})
console.log(`\n${failed === 0 ? 'ALL T243 INTERNAL-SOURCE-ISOLATION TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
