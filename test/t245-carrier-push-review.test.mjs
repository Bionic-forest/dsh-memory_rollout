// t245（T36 / v0.1.27）：GPT《推送前独立审核》F1 / F2 / F3 的**完整插件入口**验收。
//
//   F1（吞错）：后台调用边界必须有**结构化失败类别 + 脱敏原因**，并且**四类在批记录里真的不同**、
//               **都不发布**。旧实现（`consolidateWithLlmRaw` 一律 null）在真实入口下四类不可分。
//   F2（一次请求是硬约束）：**移除**"推理强度不支持 ⇒ 去掉参数再调一次"的内部重试；
//               计数在**实际 stream 调用边界**，保证 `cost_model_calls === actualStreamCalls`。
//   F3（升级边界）：5 种配置的**最终载体**；实验载体不是安全回退（落告警字段）。
//
// 本文件一律走 `apply(ctx, cfg)` + `memory__phase2_integrate`（**完整入口**，不是假件直调）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedJob, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const m = await import(PLUGIN)

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
const TERMINAL_FAIL = new Set(['retry_wait', 'failed_terminal'])

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory_rollout-t245-'))

/**
 * 起一个假宿主。`llmMode` 决定**实际模型调用边界**的行为：
 *   'ok' | 'absent'（没有 llm 服务）| 'noRoute'（有服务但无 provider/model 路由）
 *   | 'throws'（一般异常）| 'empty'（正常空返回）| 'reasoningEffort'（宿主拒绝推理强度）
 */
const boot = async ({ cfg = {}, llmMode = 'ok', errMsg = 'llm-down' } = {}) => {
  const home = path.join(TMP, 'h-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const counters = { agentCreates: 0, presetResolve: 0, presetMount: 0, restrictCalls: 0, streamCalls: 0, streamCallsWithEffort: 0 }
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
      return { session: { append: () => {}, events: () => [] }, agent: { id: o.sessionId }, dispose: async () => {} }
    },
  }
  const presets = { resolve: async (id) => { counters.presetResolve += 1; return { id: id || 'preset-default' } }, mount: async () => { counters.presetMount += 1 } }
  const llm = {
    stream: (req) => {
      // **实际调用**在这里计数（与插件内部的自计数做对比）
      counters.streamCalls += 1
      if (req && req.reasoningEffort) counters.streamCallsWithEffort += 1
      llmRequests.push(req)
      if (llmMode === 'throws') throw new Error(errMsg)
      if (llmMode === 'reasoningEffort') throw new Error(`reasoning effort "${req && req.reasoningEffort}" is not supported by this model (UNSUPPORTED_REASONING_EFFORT)`)
      if (llmMode === 'empty') {
        return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: JSON.stringify({ memory_summary: 'v1\n## t245', registry: '# MEMORY.md\nt245' }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const { ctx, domain } = makeCtx({
    get: (k) => {
      if (k === 'llm') return llmMode === 'absent' ? undefined : llm
      if (k === 'agentDefaultModel') return llmMode === 'noRoute' ? undefined : { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (k === 'agents') return agents
      if (k === 'agentPresets') return presets
      return undefined
    },
    tools: { register: (t) => { if (t && t.name) tools[t.name] = t } },
  })
  await m.apply(ctx, cfg)
  await seedOutput(domain, 'o-t245', { session_id: 's-t245', source_watermark: 'w-t245', rollout_summary: 'HEAD-body-t245' })
  await seedJob(domain, 's-t245', 'w-t245', { status: 'succeeded_with_output' })
  domain.table('phase2_jobs').put('T245', {
    id: 'T245', status: 'pending', input_ids: ['o-t245'], change_ids: [], lease_owner: '', lease_expires_at: '',
    attempt_count: 0, max_attempts: 3, available_at: new Date(Date.now() - 120000).toISOString(), staging_version: '',
    last_error: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  return {
    ctx, domain, tools, counters, llmRequests, home,
    job: () => ({ id: 'T245', ...(domain.table('phase2_jobs').get('T245') || {}) }),
    memoryRoot: () => path.join(home, 'memories'),
    currentFile: () => path.join(home, 'memories', 'current.json'),
    run: async () => { await tools['memory__phase2_integrate'].execute({}); return { id: 'T245', ...(domain.table('phase2_jobs').get('T245') || {}) } },
    makeRunnable: async () => { await domain.table('phase2_jobs').update('T245', (cur) => ({ ...cur, available_at: new Date(Date.now() - 60000).toISOString() })) },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// F1：四类失败在**批记录**里真的不同，且都不发布
// ─────────────────────────────────────────────────────────────────────────────
await section('[t245-F1] 四类模型失败：类别不同 + 都不发布', async () => {
  console.log('\n[T245-F1] 服务缺失 / 路由缺失 / 一般异常 / 正常空返回')
  const cases = [
    ['服务缺失', { llmMode: 'absent' }, 'llm-service-unavailable'],
    ['路由缺失', { llmMode: 'noRoute' }, 'llm-route-unavailable'],
    ['一般异常', { llmMode: 'throws', errMsg: 'gateway-500-boom' }, 'llm-stream-error'],
    ['正常空返回', { llmMode: 'empty' }, 'llm-empty-output'],
  ]
  const seenCategories = []
  for (const [label, opts, expectCat] of cases) {
    const b = await boot(opts)
    const job = await b.run()
    const cat = String(job.cost_failure_category || '')
    seenCategories.push(cat)
    check(TERMINAL_FAIL.has(String(job.status)), `${label} ⇒ 不发布（status=${job.status}）`)
    check(!fs.existsSync(b.currentFile()), `${label} ⇒ current.json 未生成（无发布）`)
    check(cat === expectCat, `${label} ⇒ cost_failure_category=${cat}（期望 ${expectCat}）`)
    check(String(job.executor_reason || '').startsWith('background-' + expectCat), `${label} ⇒ executor_reason=${String(job.executor_reason).slice(0, 60)}`)
    check(String(job.last_error || '').includes(expectCat), `${label} ⇒ last_error 含真实类别（${String(job.last_error).slice(0, 60)}）`)
    check(String(job.cost_failure_visibility || '').length > 0, `${label} ⇒ failure_visibility=${job.cost_failure_visibility}`)
    check(b.counters.agentCreates === 0, `${label} ⇒ 仍不建会话（agentCreates=${b.counters.agentCreates}）`)
  }
  check(new Set(seenCategories).size === 4, `四类类别**两两不同**（${seenCategories.join(' / ')}）`)
  // 一般异常的原因必须带**脱敏后的真实错误串**（不是泛泛 'llm-unavailable'）
  const bThrows = await boot({ llmMode: 'throws', errMsg: 'gateway-500-boom' })
  const j = await bThrows.run()
  check(String(j.executor_reason).includes('gateway-500-boom'), `一般异常保留真实原因（${String(j.executor_reason).slice(0, 70)}）`)
  check(String(j.last_error).includes('gateway-500-boom'), `last_error 也带真实原因（${String(j.last_error).slice(0, 70)}）`)
})

// ─────────────────────────────────────────────────────────────────────────────
// F2：一次请求是硬约束（推理强度不支持 ⇒ **不重试**）；计数在实际调用边界
// ─────────────────────────────────────────────────────────────────────────────
await section('[t245-F2] 推理强度不支持：不重试 + 计数相等 + 失败可见', async () => {
  console.log('\n[T245-F2] reasoningEffort 被宿主拒绝')
  const b = await boot({ cfg: { consolidationReasoningEffort: 'high' }, llmMode: 'reasoningEffort' })
  const job = await b.run()
  check(b.counters.streamCalls === 1, `**实际 stream 调用恰好 1 次**（实测 ${b.counters.streamCalls}）⇒ 没有"去掉参数再调一次"`)
  check(b.counters.streamCallsWithEffort === 1, `那一次确实带了 reasoningEffort（${b.counters.streamCallsWithEffort}）`)
  check(Number(job.cost_model_calls) === b.counters.streamCalls, `recordedModelCalls(${job.cost_model_calls}) === actualStreamCalls(${b.counters.streamCalls})`)
  check(String(job.cost_failure_category) === 'llm-reasoning-effort-unsupported', `类别=${job.cost_failure_category}`)
  check(TERMINAL_FAIL.has(String(job.status)), `不发布（status=${job.status}）`)
  check(!fs.existsSync(b.currentFile()), 'current.json 未生成（无发布）')
  check(String(job.executor_reason).includes('reasoning-effort-unsupported'), `原因可辨（${String(job.executor_reason).slice(0, 80)}）`)
  // 重试批次仍**单独可见**：再跑一次 ⇒ attempt_count 递增、仍是同一批
  await b.makeRunnable()
  const job2 = await b.run()
  check(job2.id === job.id && Number(job2.attempt_count) === 2, `重试可见：同一批 attempt_count 1→${job2.attempt_count}`)
  check(b.counters.streamCalls === 2, `重试是真的**新一轮**调用（累计实际调用=${b.counters.streamCalls}），不是同轮内部重试`)
})

await section('[t245-F2b] 成功路径：1 次调用 1 次记录', async () => {
  console.log('\n[T245-F2b] 成功路径计数闭合')
  const b = await boot({})
  const job = await b.run()
  check(job.status === 'committed', `已提交（status=${job.status}）`)
  check(b.counters.streamCalls === 1 && Number(job.cost_model_calls) === 1, `actual=${b.counters.streamCalls} recorded=${job.cost_model_calls}`)
  check(String(job.cost_failure_category) === '', `成功 ⇒ 失败类别为空（"${job.cost_failure_category}"）`)
  check(!!fs.existsSync(b.currentFile()), 'current.json 已生成（发布发生）')
})

// ─────────────────────────────────────────────────────────────────────────────
// F3：5 种配置的**最终载体**
// ─────────────────────────────────────────────────────────────────────────────
await section('[t245-F3] 5 种配置 → 最终载体（完整入口）', async () => {
  console.log('\n[T245-F3] 未配置 / 旧 true / 旧 false / 显式后台 / 显式实验')
  const pluginCases = [
    ['未配置', {}, 'plugin-background'],
    ['旧 false', { consolidationExecutor: false }, 'plugin-background'],
    ['显式后台', { consolidationExecutor: 'plugin-background' }, 'plugin-background'],
  ]
  for (const [label, cfg, expect] of pluginCases) {
    const b = await boot({ cfg })
    const job = await b.run()
    check(String(job.executor_carrier) === expect, `${label} ⇒ executor_carrier=${job.executor_carrier}`)
    check(String(job.executor_path) === 'plugin-background', `${label} ⇒ executor_path=${job.executor_path}`)
    check(b.counters.agentCreates === 0 && !job.executor_session_id, `${label} ⇒ 不建会话（agentCreates=${b.counters.agentCreates}, sid="${job.executor_session_id}"）`)
    check(String(job.executor_carrier_note || '') === '', `${label} ⇒ 无实验告警字段（"${job.executor_carrier_note}"）`)
  }
  const expCases = [
    ['旧 true', { consolidationExecutor: true }],
    ['显式实验', { consolidationExecutor: 'restricted-session-experiment' }],
  ]
  for (const [label, cfg] of expCases) {
    const b = await boot({ cfg })
    const job = await b.run()
    check(String(job.executor_carrier) === 'restricted-session-experiment', `${label} ⇒ executor_carrier=${job.executor_carrier}（**留在实验载体**）`)
    check(['restricted-session', 'in-process-fallback'].includes(String(job.executor_path)), `${label} ⇒ executor_path=${job.executor_path}`)
    check(String(job.executor_carrier_note || '').includes('not-a-safe-fallback'), `${label} ⇒ 落告警字段（${String(job.executor_carrier_note).slice(0, 60)}…）`)
  }
})

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`\n${failed === 0 ? 'ALL T245 CARRIER-PUSH-REVIEW TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
