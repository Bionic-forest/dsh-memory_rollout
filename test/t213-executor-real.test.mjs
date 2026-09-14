// t213：① 的**实质** —— 整合的模型调用**真在受限执行者会话里跑**（不是只建了一个空壳会话）。
//
// 依据（t211 独立复核）：t187 落的是**接口层** —— 会话被真建、策略真落，但 `sessionStats={turns:0,steps:0,…}`、
//   `blank=true` ⇒ **一次轮次都没跑**；`consolidateWithLlm(prompt)` 只吃 prompt ⇒ 模型调用仍在进程内。
// 本批：`agent.followup(消息)` 起一轮 → `await agent.whenIdle()` → 从**记忆根内的产物文件**（或会话日志）回读，
//   任何一步不成 ⇒ **显式回落**进程内单发，并把「走哪条路 / 会话 id / 是否 restricted / 原因 / 活动证据」
//   落到 **批记录**（`executor_*` 字段）——不依赖控制台。
//
// 覆盖：
//   T1 执行者可用 ⇒ 整合走受限会话（followup 被调、进程内 LLM **零调用**、发布内容来自会话、批记录带观测字段）
//   T2 会话派发抛错 ⇒ **显式回落**（记录 path='in-process-fallback' + 非空 reason），批仍照常发布
//   T3 agents 服务不可用 ⇒ 同样显式回落并记录原因（reason='agents-service-unavailable'）
//   T4 会话产出不可解析 ⇒ 显式回落（reason='executor-output-unparsable-or-empty'）
// 靶目录一律 os.tmpdir()；测试后清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedJob, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const m = await import(PLUGIN)
const { apply } = m
const buildExecutorUserMessage = typeof m.buildExecutorUserMessage === 'function' ? m.buildExecutorUserMessage : null

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-t213-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })
process.env.DSH_HOME = tmp

// ── 假「受限执行者」服务：create() 真调 setup（策略落点），返回带 followup/whenIdle/session 的 agent ──
function makeFakeAgents() {
  const state = {
    mode: 'ok',                 // 'ok' | 'followup-throws' | 'unparsable'
    enabled: true,              // agents 服务是否可用
    created: [],
    followups: [],
    restrictFilters: [],
    sessionEvents: [],
    turns: 0,
  }
  const create = async ({ sessionId, meta, setup }) => {
    const childTools = { restrict: (f) => { const K=['agent_teams_create_task','memory__recall','session_search','delete_to_recycle_bin','download_idm','unarchive_session']; const ns=[...(f.allow||[]),...(f.deny||[])]; const un=ns.filter((n)=>!K.includes(n)); if(un.length) throw new Error('tools.restrict() names unknown global tools '+un.map((n)=>'"'+n+'"').join(', ')+'; known global tools: '+K.slice().sort().join(', ')); state.restrictFilters.push(f) } }
    if (typeof setup === 'function') setup({ tools: childTools })
    const myEvents = []   // **每个会话自己一条日志**（共享会让上一批的 assistant 文本串到下一批）
    const session = { append: (...a) => { myEvents.push(a) }, events: () => myEvents }
    const agent = {
      id: sessionId,
      get status() { return { state: 'idle', turns: state.turns } },
      session,
      followup: (msg) => {
        if (state.mode === 'followup-throws') throw new Error('fake followup rejected')
        state.followups.push({ sessionId, msg })
        state.turns++
        const payload = state.mode === 'unparsable'
          ? 'this is not json at all'
          : JSON.stringify({ memory_summary: 'v1\n## by-executor-session', registry: '# MEMORY.md\nby-executor-session' })
        // 模拟「受限会话**按提示词指示**把自己的 cwd（= 记忆根）内产物文件写出来」：
        //   目标路径从派发消息里提取（= 插件真正要读的那个路径，证明"根内可写 + 按路径回读"这条路成立）。
        const text = String(msg && msg.content && msg.content[0] && msg.content[0].text || '')
        const mm = text.match(/([A-Za-z]:\\[^\n"]*?\.json|\/[^\n"]*?\.json)/)
        const outFile = mm ? mm[1] : path.join(String(meta && meta.cwd), '.consolidation-out', `${sessionId}.json`)
        try {
          fs.mkdirSync(path.dirname(outFile), { recursive: true })
          fs.writeFileSync(outFile, payload)
        } catch {}
        myEvents.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: payload }] } })
      },
      whenIdle: async () => { await new Promise((r) => setTimeout(r, 5)) },
    }
    state.created.push({ sessionId, meta })
    return { agent, dispose: async () => {} }
  }
  return { state, service: { create } }
}

let inProcessConsolidationCalls = 0
const fake = makeFakeAgents()
const CONSOLIDATION_BY_INPROCESS = { memory_summary: 'v1\n## by-inprocess-llm', registry: '# MEMORY.md\nby-inprocess-llm' }
const llmMock = {
  stream: (opts) => {
    const isExtraction = !!(opts && String(opts.system).includes('memory-extraction'))
    if (!isExtraction) inProcessConsolidationCalls++
    const payload = isExtraction
      ? { rollout_summary: 'sum', raw_memory: 'raw', slug: 'note', keywords: '', title: '' }
      : CONSOLIDATION_BY_INPROCESS
    return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(payload) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  },
}

const tools = {}
const { ctx, domain } = makeCtx({
  get: (k) => {
    if (k === 'agents') return fake.state.enabled ? fake.service : undefined
    if (k === 'llm') return llmMock
    if (k === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    return undefined
  },
  tools: { register: (t) => { tools[t.name] = t } },
})

const jobsOf = () => [...domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v }))
const summaryFile = () => path.join(tmp, 'memories', 'memory_summary.md')
const seedOneBatch = async (tag) => {
  await seedJob(domain, 's-' + tag, 'w-' + tag, { status: 'succeeded_with_output' })
  await seedOutput(domain, 'j-' + tag, { session_id: 's-' + tag, source_watermark: 'w-' + tag, rollout_summary: 'batch content ' + tag, raw_memory: 'raw ' + tag, selected_for_phase2: false })
}

try {
  await apply(ctx, { consolidationExecutor: true, maxModelAttemptsPerDay: 24, minRemainingQuotaPercent: 25 })

  console.log('[T1] 执行者可用 ⇒ 整合**真在受限会话里跑**（本批核心）')
  {
    await seedOneBatch('ok')
    const r = await tools['memory__phase2_integrate'].execute({})
    const followups = fake.state.followups
    check(followups.length >= 1,
      `**受限会话里真起了一轮**：agent.followup 被调 ${followups.length} 次（改前树 0 次 ⇒ 必红）`)
    check(buildExecutorUserMessage && !!followups[0],
      '（**假阳性/健全性**）导出 buildExecutorUserMessage 且确有派发消息')
    const msg = followups[0] && followups[0].msg
    check(!!msg && msg.role === 'user' && msg.source && msg.source.kind === 'plugin' && Array.isArray(msg.content) && msg.content[0] && msg.content[0].type === 'text',
      `派发消息是合法 UserMessage 形状（role=${msg && msg.role} / source.kind=${msg && msg.source && msg.source.kind} / content[0].type=${msg && msg.content && msg.content[0] && msg.content[0].type}）`)
    check(!!msg && msg.content[0].text.includes('## INCREMENTAL MERGE'),
      '派发文本含整合提示词契约标记（`## INCREMENTAL MERGE` —— 我们那份整合契约随轮次进入会话）')
    const rf = fake.state.restrictFilters[0]
    check(!!rf && Array.isArray(rf.deny) && rf.deny.length > 0 && rf.allow === undefined,
      `（**假阳性**：改前树也过 —— t187 接口层已有）setup 内 restrict 白名单/deny 正确（${JSON.stringify(rf)}）`)
    check(fake.state.turns > 0,
      `会话活动证据：turns=${fake.state.turns}（>0 = 轮次真跑了；t211 实测改前是 turns:0）`)
    check(inProcessConsolidationCalls === 0,
      `**进程内 LLM 零调用**（实测 ${inProcessConsolidationCalls} 次；改前树 1 次 ⇒ 必红）`)
    // t224（F1）：会话 id 现在是 `p2-exec-<batchId>-<attemptTag>`（会话与尝试解耦）⇒ 取批记录改为
    //   按"走过受限路径"找，并**另行断言**会话 id 以 `p2-exec-<batchId>` 开头（新契约）。
    const rec = jobsOf().find((j) => String(j.executor_path) === 'restricted-session')
    const batchId = String((rec && rec.id) || '')
    const sid0 = String((followups[0] && followups[0].sessionId) || '')
    check(!!rec && batchId !== '' && sid0.startsWith(`p2-exec-${batchId}`),
      `会话 id 带批次前缀且与尝试解耦（sessionId="${sid0}" / batchId=${batchId}）`)
    check(!!rec && rec.executor_path === 'restricted-session',
      `批记录带**不依赖控制台**的观测：executor_path=${rec && rec.executor_path}（改前树无该字段 ⇒ 必红）`)
    check(!!rec && String(rec.executor_session_id).startsWith(`p2-exec-${batchId}`) && rec.executor_restricted === true && rec.executor_reason === '',
      `会话 id / restricted / 空原因三项齐（实测 ${rec && rec.executor_session_id} / ${rec && rec.executor_restricted} / "${rec && rec.executor_reason}"）`)
    check(!!rec && /turns=|events=/.test(String(rec.executor_activity || '')),
      `会话活动证据落记录：executor_activity="${rec && rec.executor_activity}"`)
    check(!!rec && rec.executor_source === 'executor-out-file',
      `结果**从受限会话写在记忆根内的产物文件回读**（executor_source=${rec && rec.executor_source}；= "根内可写 + 按路径回读"这条路真跑通）`)
    const published = fs.existsSync(summaryFile()) ? fs.readFileSync(summaryFile(), 'utf8') : ''
    check(published.includes('by-executor-session') && !published.includes('by-inprocess-llm'),
      '**发布的总纲内容来自受限会话**（而不是进程内单发；改前树只能是 by-inprocess-llm ⇒ 必红）')
    void r
  }

  console.log('[T2] 会话派发抛错 ⇒ **显式回落**（不得静默降级）')
  {
    fake.state.mode = 'followup-throws'
    inProcessConsolidationCalls = 0
    await seedOneBatch('throw')
    await tools['memory__phase2_integrate'].execute({})
    const rec = jobsOf().filter((j) => String(j.executor_path) === 'in-process-fallback').pop()
    check(!!rec, `批记录标明走了回落路径（executor_path=${rec && rec.executor_path}）`)
    check(!!rec && /executor-dispatch-threw/.test(String(rec.executor_reason || '')),
      `回落原因非空且可读：executor_reason="${rec && rec.executor_reason}"`)
    check(inProcessConsolidationCalls >= 1, `回落后用进程内单发兜底（实测调用 ${inProcessConsolidationCalls} 次）`)
    const published = fs.existsSync(summaryFile()) ? fs.readFileSync(summaryFile(), 'utf8') : ''
    check(published.includes('by-inprocess-llm'), '（**假阳性**：改前树也过）批仍照常发布（回落不改批的成败）')
    fake.state.mode = 'ok'
  }

  console.log('[T3] agents 服务不可用 ⇒ 显式回落并记原因')
  {
    fake.state.enabled = false
    inProcessConsolidationCalls = 0
    await seedOneBatch('noagents')
    await tools['memory__phase2_integrate'].execute({})
    const rec = jobsOf().filter((j) => String(j.executor_reason || '').includes('agents-service-unavailable')).pop()
    check(!!rec && rec.executor_path === 'in-process-fallback',
      `服务缺失 ⇒ executor_path=${rec && rec.executor_path} / reason="${rec && rec.executor_reason}"`)
    check(inProcessConsolidationCalls >= 1, `（**假阳性**：改前树也走进程内）仍用进程内单发完成整合（${inProcessConsolidationCalls} 次）`)
    fake.state.enabled = true
  }

  console.log('[T4] 会话产出不可解析 ⇒ 显式回落')
  {
    fake.state.mode = 'unparsable'
    inProcessConsolidationCalls = 0
    await seedOneBatch('unparsable')
    await tools['memory__phase2_integrate'].execute({})
    const rec = jobsOf().filter((j) => String(j.executor_reason || '').includes('executor-output-unparsable')).pop()
    if (process.env.T213_DEBUG) {
      console.log('    [debug] inProcessCalls=' + inProcessConsolidationCalls + ' batches=' + JSON.stringify(jobsOf().map((j) => ({ id: j.id, status: j.status, path: j.executor_path, reason: j.executor_reason, src: j.executor_source, err: String(j.last_error || '').slice(0, 80) }))))
    }
    check(!!rec && rec.executor_path === 'in-process-fallback',
      `产出不可解析 ⇒ 回落并记原因（实测 reason="${rec && rec.executor_reason}"）`)
    check(inProcessConsolidationCalls >= 1, '（**假阳性**）回落兜底照常完成')
    fake.state.mode = 'ok'
  }

  console.log('[T5] 契约不变量：**每一次**整合的批记录都带 `executor_path`（永不静默）')
  {
    const all = jobsOf()
    const missing = all.filter((j) => !String(j.executor_path || ''))
    check(missing.length === 0,
      `全部 ${all.length} 条批记录都带 executor_path（缺失 ${missing.length} 条；改前树全部缺失 ⇒ 必红）`)
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T213 EXECUTOR-REAL TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
