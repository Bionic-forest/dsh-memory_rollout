// t244（T35 / v0.1.26）：**后台承载（plugin-background）** 的定向测试。
//
// 口径（用户拍板）：**只能用一个直接的 API 请求来处理** —— 后台路径 = 插件进程内**一次** `ctx.llm` 调用，
//   * 不建任何会话（⇒ 不继承普通聊天预设、无会话残留、无自我摄取面）；
//   * **不带工具面**（不是"名册外拦不住"，而是**根本没有**）；
//   * **不注入任何指令**（没有会话就没有 agent-instructions 注入面）；
//   * 输入 = 与受限会话路径**同一份** `buildConsolidationPrompt` 产物，**不截断**（不许拿截断换便宜）；
//   * 校验/发布链完全复用；失败/耗时/调用次数/字符量自建可观测（批次 + 成本字段）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedJob, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const m = await import(PLUGIN)
const carrierOf = typeof m.consolidationCarrier === 'function' ? m.consolidationCarrier : () => 'export-missing'
const bgTurn = typeof m.runConsolidationBackgroundTurn === 'function' ? m.runConsolidationBackgroundTurn : async () => ({ ok: false, reason: 'export-missing', cost: {} })
const PLUGIN_CARRIER = typeof m.CONSOLIDATION_CARRIER_PLUGIN === 'string' ? m.CONSOLIDATION_CARRIER_PLUGIN : ''
const EXPERIMENT_CARRIER = typeof m.CONSOLIDATION_CARRIER_RESTRICTED === 'string' ? m.CONSOLIDATION_CARRIER_RESTRICTED : ''

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

// ── ① 承载归一化：默认后台；旧布尔向后兼容 ────────────────────────────────────
await section('[t244-1] 承载归一化（默认后台 + 旧布尔兼容）', async () => {
  console.log('\n[T244-1] `consolidationCarrier`：默认/未设 ⇒ plugin-background')
  check(PLUGIN_CARRIER === 'plugin-background', `常量 plugin-background（${PLUGIN_CARRIER}）`)
  check(EXPERIMENT_CARRIER === 'restricted-session-experiment', `常量 experiment（${EXPERIMENT_CARRIER}）`)
  check(carrierOf({}) === 'plugin-background', `未设 ⇒ 后台（${carrierOf({})}）`)
  check(carrierOf({ consolidationExecutor: 'plugin-background' }) === 'plugin-background', '显式后台 ⇒ 后台')
  check(carrierOf({ consolidationExecutor: 'restricted-session-experiment' }) === 'restricted-session-experiment', '显式实验 ⇒ 实验')
  check(carrierOf({ consolidationExecutor: true }) === 'restricted-session-experiment', '旧 true ⇒ 实验（旧"开"就是试受限执行者）')
  check(carrierOf({ consolidationExecutor: false }) === 'plugin-background', '旧 false ⇒ 后台（旧"关"就是走进程内）')
})

// ── ② 后台一轮（单元）：成功/失败都可诊断 + 成本字段 ─────────────────────────
await section('[t244-2] `runConsolidationBackgroundTurn`：一次调用 + 成本字段 + 失败可诊断', async () => {
  console.log('\n[T244-2] 单次调用；失败原因各自可辨')
  {
    const seen = []
    // t254（T36 · F1/F2）：注入**结构化**调用（含 stream_calls）：计数取自实际调用处。
    const r = await bgTurn({ prompt: 'PROMPT-BODY', batchId: 'B1', call: async (p) => { seen.push(p); return { ok: true, text: '{"memory_summary":"ms","registry":"rg"}', category: '', detail: '', stream_calls: 1 } } })
    check(r.ok === true && r.text.includes('memory_summary'), `成功返回原始文本（ok=${r.ok}）`)
    check(seen.length === 1 && seen[0] === 'PROMPT-BODY', `**恰好一次**调用，且原样传同一份提示词（calls=${seen.length}）`)
    const c = r.cost || {}
    check(c.model_calls === 1, `cost.model_calls=${c.model_calls}`)
    check(c.input_chars === 'PROMPT-BODY'.length, `cost.input_chars=${c.input_chars}（= 提示词长度）`)
    check(c.output_chars === r.text.length, `cost.output_chars=${c.output_chars}`)
    check(c.extra_session_artifacts === 0, `cost.extra_session_artifacts=${c.extra_session_artifacts}（不建会话）`)
    check(c.source_bytes_read === 0, `cost.source_bytes_read=${c.source_bytes_read}（后台包装本身不外读，输入已在提示词里）`)
    check(typeof c.wall_clock_ms === 'number' && c.wall_clock_ms >= 0, `cost.wall_clock_ms=${c.wall_clock_ms}`)
    check(String(c.failure_visibility).includes('no session log'), `cost.failure_visibility=${c.failure_visibility}`)
    check(String(c.failure_category) === '', `成功 ⇒ failure_category 为空（"${c.failure_category}"）`)
  }
  // t254（T36 · F1）：四类失败**类别各不相同**（旧版这里只有"一个 background-* 串"）
  const cases = [
    ['没有 llm 调用器', { prompt: 'p' }, 'llm-call-not-wired', 'background-llm-call-not-wired'],
    ['空提示词', { prompt: '   ', call: async () => ({ ok: true, text: 'x', stream_calls: 1 }) }, 'llm-empty-prompt', 'background-llm-empty-prompt'],
    ['调用抛错', { prompt: 'p', call: async () => { throw new Error('boom-llm') } }, 'llm-stream-error', 'background-llm-stream-error'],
    ['返回空', { prompt: 'p', call: async () => null }, 'llm-empty-output', 'background-llm-empty-output'],
    ['服务缺失', { prompt: 'p', call: async () => ({ ok: false, text: '', category: 'llm-service-unavailable', detail: 'x', stream_calls: 0 }) }, 'llm-service-unavailable', 'background-llm-service-unavailable'],
    ['推理强度不支持', { prompt: 'p', call: async () => ({ ok: false, text: '', category: 'llm-reasoning-effort-unsupported', detail: 'high', stream_calls: 1 }) }, 'llm-reasoning-effort-unsupported', 'background-llm-reasoning-effort-unsupported'],
  ]
  const cats = []
  for (const [label, opts, expectCat, expectReason] of cases) {
    const r = await bgTurn(opts)
    cats.push(String(r.cost && r.cost.failure_category))
    check(r.ok === false && String(r.reason).startsWith(expectReason), `${label} ⇒ 原因可辨（${String(r.reason).slice(0, 56)}）`)
    check(String(r.cost && r.cost.failure_category) === expectCat, `${label} ⇒ failure_category=${r.cost && r.cost.failure_category}`)
    check(!!(r.cost && r.cost.failure_visibility), `${label} ⇒ 成本字段带失败可见性（${r.cost && r.cost.failure_visibility}）`)
  }
  check(new Set(cats).size === cases.length, `六类失败类别两两不同（${cats.join(' / ')}）`)
  // 调用次数**取自实际调用边界**（call 返回的 stream_calls），本层不自行 +1
  {
    const r = await bgTurn({ prompt: 'p', call: async () => ({ ok: true, text: 'x', stream_calls: 7 }) })
    check(r.cost.model_calls === 7, `model_calls 照抄实际调用次数（实测 ${r.cost.model_calls}，期望 7）`)
  }
})

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory_rollout-t244-'))
process.env.DSH_HOME = TMP
const EVIDENCE_TAIL = 'TAIL-EVIDENCE-MARK-9f2b（输入完整性哨兵）'

/** 起一个假宿主：llm 捕获请求；agents/presets 计数（后台路径**不该**被调用）。 */
const boot = async (carrierCfg, opts = {}) => {
  const home = path.join(TMP, 'h-' + Math.random().toString(36).slice(2, 7))
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const counters = { agentCreates: 0, presetResolve: 0, presetMount: 0, llmStreams: 0, restrictCalls: 0 }
  const llmRequests = []
  const tools = {}
  const agents = {
    create: async (o) => {
      counters.agentCreates += 1
      if (typeof o.setup === 'function') {
        await o.setup({
          on: () => () => {},
          tools: { view: () => ({ restrictableNames: new Set(['memory_recall']) }), restrict: () => { counters.restrictCalls += 1 } },
        })
      }
      return { session: { append: () => {} }, agent: { id: o.sessionId } }
    },
  }
  const presets = { resolve: async (id) => { counters.presetResolve += 1; return { id: id || 'preset-default' } }, mount: async () => { counters.presetMount += 1 } }
  const llm = {
    stream: (req) => {
      counters.llmStreams += 1
      llmRequests.push(req)
      if (opts.llmThrows) throw new Error('llm-down')
      if (opts.llmEmpty) return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: JSON.stringify({ memory_summary: 'v1\n## t244', registry: '# MEMORY.md\nt244' }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'llm' ? llm
      : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : k === 'agents' ? agents
          : k === 'agentPresets' ? presets
            : undefined),
    tools: { register: (t) => { if (t && t.name) tools[t.name] = t } },
  })
  await m.apply(ctx, carrierCfg)
  // 同一批输入：证据正文尾部带哨兵 ⇒ 用来验"不许截断"
  await seedOutput(domain, 'o-t244', { session_id: 's-t244', source_watermark: 'w-t244', rollout_summary: 'HEAD ' + 'x'.repeat(200) + ' ' + EVIDENCE_TAIL })
  await seedJob(domain, 's-t244', 'w-t244', { status: 'succeeded_with_output' })
  domain.table('phase2_jobs').put('T244', {
    id: 'T244', status: 'pending', input_ids: ['o-t244'], change_ids: [], lease_owner: '', lease_expires_at: '',
    attempt_count: 0, max_attempts: 3, available_at: new Date(Date.now() - 120000).toISOString(), staging_version: '',
    last_error: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  return { ctx, domain, tools, counters, llmRequests, home }
}

const runBatch = async (b) => {
  await b.tools['memory__phase2_integrate'].execute({})
  return [...b.domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v })).pop() || {}
}

// ── ③ 默认承载 = 后台：**全程不建会话**、不带工具面、不注入指令 ──────────────
await section('[t244-3] 默认 = 后台：不建会话 / 无工具面 / 无注入 / 同输入不截断', async () => {
  console.log('\n[T244-3] 默认承载（plugin-background）')
  const b = await boot({})
  const job = await runBatch(b)
  if (process.env.T244_DEBUG) console.log('   [debug job]', JSON.stringify({ status: job.status, path: job.executor_path, reason: job.executor_reason, last_error: job.last_error, cost: { calls: job.cost_model_calls, in: job.cost_input_chars } }))
  check(job.status === 'committed', `批次提交（status=${job.status}${job.last_error ? ' / ' + String(job.last_error).slice(0, 80) : ''}）`)
  check(job.executor_path === 'plugin-background', `executor_path=plugin-background（${job.executor_path}）`)
  check(job.executor_carrier === 'plugin-background', `executor_carrier=plugin-background（${job.executor_carrier}）`)
  check(job.executor_source === 'plugin-background-llm', `executor_source=${job.executor_source}`)
  check(!job.executor_session_id, `**没有会话 id**（executor_session_id="${job.executor_session_id}"）`)
  check(b.counters.agentCreates === 0, `**agents.create 调用 0 次**（实测 ${b.counters.agentCreates}）⇒ 不建会话、无残留、无自我摄取面`)
  check(b.counters.presetResolve === 0 && b.counters.presetMount === 0, `不解析/不挂预设（resolve=${b.counters.presetResolve} mount=${b.counters.presetMount}）⇒ 不继承普通聊天预设`)
  check(b.counters.restrictCalls === 0, `**没有工具面**：从不调 tools.restrict（${b.counters.restrictCalls}）⇒ 不存在"名册外拦不住"的缺口`)
  check(b.counters.llmStreams === 1, `**恰好一次**模型调用（${b.counters.llmStreams}）`)
  check(Number(job.cost_model_calls) === b.counters.llmStreams, `记录次数=实际次数（recorded=${job.cost_model_calls} actual=${b.counters.llmStreams}）`)
  check(String(job.executor_carrier_note || '') === '', `后台载体无实验告警字段（"${job.executor_carrier_note}"）`)
  check(!job.executor_restrict_unknown, `executor_restrict_unknown 为空（"缺哪些名字"这个缺口在后台路径不存在：${job.executor_restrict_unknown}）`)
  check(!job.executor_restrict_source, `executor_restrict_source 为空（没有名册可谈）`)
  check(!job.executor_assembly_error && !job.executor_agent_errors, `无装配错误/无宿主 agent/error（${job.executor_assembly_error}|${job.executor_agent_errors}）`)
  // 成本字段
  check(Number(job.cost_model_calls) === 1, `cost_model_calls=${job.cost_model_calls}`)
  check(Number(job.cost_input_chars) > 0, `cost_input_chars=${job.cost_input_chars}`)
  check(Number(job.cost_output_chars) > 0, `cost_output_chars=${job.cost_output_chars}`)
  check(Number(job.cost_extra_session_artifacts) === 0, `cost_extra_session_artifacts=${job.cost_extra_session_artifacts}`)
  check(Number(job.cost_source_bytes_read) === 0, `cost_source_bytes_read=${job.cost_source_bytes_read}`)
  check(String(job.cost_failure_visibility).length > 0, `cost_failure_visibility 非空（${job.cost_failure_visibility}）`)
  check(Number(job.cost_wall_clock_ms) >= 0, `cost_wall_clock_ms=${job.cost_wall_clock_ms}`)
  // 同输入 / 不截断：送进模型的消息里必须含证据正文的**尾部哨兵**
  const req = b.llmRequests[0] || {}
  const msgText = ((req.messages || [])[0] && (req.messages[0].content || [])[0] && req.messages[0].content[0].text) || ''
  check(b.llmRequests.length === 1 && msgText.length > 0, `捕获到请求体（${msgText.length} 字符）`)
  check(msgText.includes(EVIDENCE_TAIL), `提示词里含证据正文**尾部哨兵** ⇒ 后台路径没有新增截断（"不许拿截断换便宜"）`)
  check(!!(req.system && String(req.system).length > 0), 'system 提示词照旧（未改动）')
})

// ── ④ 实验路径：显式开关下仍然可用（真建会话） ──────────────────────────────
await section('[t244-4] 显式实验开关下，受限会话路径仍可用', async () => {
  console.log('\n[T244-4] `restricted-session-experiment`（显式）')
  const b = await boot({ consolidationExecutor: 'restricted-session-experiment' })
  const job = await runBatch(b)
  check(b.counters.agentCreates === 1, `建了 1 次会话（${b.counters.agentCreates}）⇒ 实验路径保留可用`)
  check(job.executor_carrier === 'restricted-session-experiment', `executor_carrier=${job.executor_carrier}`)
  check(['restricted-session', 'in-process-fallback'].includes(String(job.executor_path)), `executor_path=${job.executor_path}（成功或显式回落）`)
  // 旧布尔 true 等价于实验
  const b2 = await boot({ consolidationExecutor: true })
  const job2 = await runBatch(b2)
  check(b2.counters.agentCreates === 1, `旧 true ⇒ 也走实验（agentCreates=${b2.counters.agentCreates}）`)
  check(job2.executor_carrier === 'restricted-session-experiment', `executor_carrier=${job2.executor_carrier}`)
  check(String(job2.executor_carrier_note || '').includes('not-a-safe-fallback'),
    `旧 true ⇒ 落"实验载体不是安全回退"告警（${String(job2.executor_carrier_note).slice(0, 60)}…）`)
})

// ── ⑤ 失败可诊断：llm 不可用/抛错/无输出时批次原因明确且成本字段落盘 ─────────
await section('[t244-5] 后台失败也可诊断（原因 + 成本字段）', async () => {
  console.log('\n[T244-5] 无会话可查 ⇒ 失败一律落批记录')
  const b = await boot({}, { llmThrows: true })
  const job = await runBatch(b)
  check(job.status !== 'committed', `llm 抛错 ⇒ 本批不发布（status=${job.status}）`)
  check(String(job.last_error || '').length > 0, `批记录有明确 last_error（${String(job.last_error).slice(0, 60)}）`)
  check(String(job.executor_reason || '').length > 0, `executor_reason 非空（${String(job.executor_reason).slice(0, 60)}）`)
  check(String(job.cost_failure_category) === 'llm-stream-error', `类别可辨：${job.cost_failure_category}`)
  check(Number(job.cost_model_calls) >= 1 && String(job.cost_failure_visibility || '').length > 0,
    `成本字段仍落盘（calls=${job.cost_model_calls} visibility=${job.cost_failure_visibility}）`)
  const b2 = await boot({}, { llmEmpty: true })
  const job2 = await runBatch(b2)
  check(job2.status !== 'committed', `llm 无输出 ⇒ 不发布（status=${job2.status}）`)
  check(String(job2.executor_reason || job2.last_error || '').length > 0, `原因可辨（${String(job2.executor_reason || job2.last_error).slice(0, 60)}）`)
  check(String(job2.cost_failure_category) === 'llm-empty-output', `类别可辨：${job2.cost_failure_category}`)
  check(String(job.cost_failure_category) !== String(job2.cost_failure_category),
    `两类失败在批记录里**不同**（${job.cost_failure_category} ≠ ${job2.cost_failure_category}）`)
})

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`\n${failed === 0 ? 'ALL T244 BACKGROUND-CARRIER TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
