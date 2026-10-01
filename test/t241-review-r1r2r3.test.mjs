// t241（T30 · 独立评审 R1 / R1b / R2 / R3 收口）：把评审**亲自复现的三条实证问题**搬进测试层。
//
// 评审来源：`rollout-独立评审与路线裁决-2026-09-21.md`（R1 P1 删前判据未绑定本次来源版本、
//   R1b P2 调用返回 ≠ 删除成功、R2 P1 暂时读不到来源被永久记成扫描完成、R3 P1 目标阻断：
//   受限执行者被真实宿主服务访问规则挡住）。对应实现见 `lib/index.js` 的
//   `ingestIdleScan`（scanSeen 只在"确知已处理"时推进）/ `restrictableGlobalTools`
//   （不再读 `childCtx.agent`，作用域由宿主自身的校验错误派生）。
//
// ⚠️ **本批（C1：撤"记忆并删除"编排）的退役登记**：
//   原文件的 R1a / R1b+ / R1b− / R1c / R1d 五段测的是**删前门槛**——即 C 入口的路由
//   `/dsh-memory_rollout/ingest-and-delete`、它的 `stagesOf` 四层口径、以及按删除工具返回契约判定的
//   `judgeDeleteToolResult`。用户裁定「删除＝可选项」+ 契约 C1 把这**整条编排撤掉**（`lib/` 内
//   `ingest-and-delete` / `stagesOf` / `evidenceReasonText` / `judgeDeleteToolResult` **命中归零**）
//   ⇒ 被测对象本身已不存在，这五段**整段退役**（连同 `postRoute` 与 `judgeDeleteToolResult` 的桩）。
//   **R2（扫描故障恢复）与 R3（agent 访问门）与删除无关，原样保留、必须通过。**
//   退役不是"改断言让闸门变绿"：撤掉的断言与其被测代码**一一对应**，清单见交付报告。
//
// 本文件现覆盖：
//   · **扫描故障**：首次临时读失败**不推进**完成水位（且不烧模型）⇒ 恢复后同一 mtime 仍入队 ⇒ 去重仍成立。
//   · **服务接线**：`setup` 收到的 ctx 上 `agent` 是**访问门**（getter 抛 `without inject`）时，
//     限制仍能建立；旧写法（读 `childCtx.agent`）在该门上是**必抛**的（牙齿）。
//   · 全部走**真实入口**与合成夹具；**绝不删任何真实会话**，只在 tmp 里造合成文件。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, metaOf, seedJob, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const M = await import(PLUGIN)
const { apply } = M
/** 改前树没有这些导出 ⇒ 包装成断言红，而不是中途崩掉整份文件。 */
const restrictableGlobalTools = typeof M.restrictableGlobalTools === 'function'
  ? M.restrictableGlobalTools
  : () => ({ names: [], source: 'missing-export', unknownDesired: [], note: 'export-missing' })

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

const NOW = Date.now()
const SID = 'aa000000-0000-4000-8000-000000000241'
const snap = (id, idleHours = 12) => ({
  header: { version: 4, isSeeded: false, id, cwd: 'C:/t241', createdAt: 0 },
  revision: `1:2:3:${Math.round((NOW - idleHours * 3600000) * 1e6)}:4`,
  sizeBytes: 256,
})
const msgEvent = (id, text) => ({
  type: 'user/message', seq: 0, time: 0, surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const V1 = 'T241 v1：本次决定 = 删除一律走回收站。' + '细节A'.repeat(20)

/**
 * 起一个带**真实路由注册面**与合成持久化的宿主（本批只用到 A 面扫描入口与 R3 的执行者装配）。
 * @param opts.text            会话正文（默认 V1）
 * @param opts.readSession     (id, n) => Promise<session>；可抛错模拟读源失败
 * @param opts.withLlm         是否提供 llm 服务（计数模型调用）
 */
const boot = async (opts = {}) => {
  const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t241-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(HOME, { recursive: true })
  process.env.DSH_HOME = HOME
  const listCalls = { n: 0 }
  const readCalls = { n: 0 }
  const llmCalls = { n: 0 }
  const persistence = {
    list: async () => { listCalls.n += 1; return listCalls.n === 1 ? [] : [snap(opts.id || SID)] },
    locate: () => ({ path: 'Z:\\t241-not-exist\\log.jsonl' }),
  }
  const routes = new Map()
  const defaultRead = async (id) => ({
    session: { version: 4, isSeeded: false, id, cwd: 'C:/t241', createdAt: 0 },
    events: [msgEvent(id, opts.text || V1)],
  })
  const readSessionImpl = opts.readSession ? (id, n) => opts.readSession(id, n) : defaultRead
  const llm = {
    stream: () => {
      llmCalls.n += 1
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: JSON.stringify({ rollout_summary: 's', raw_memory: 'r', slug: 's', keywords: '', title: '' }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const { ctx, domain, tools } = makeCtx({
    get: (k) => {
      if (k === 'sessionQuery') {
        return { readSession: async (id) => { readCalls.n += 1; return readSessionImpl(id, readCalls.n) } }
      }
      if (k === 'sessionPersistence') return persistence
      if (k === 'webServer') return { register: (r) => { routes.set(r.path, r); return () => {} } }
      if (k === 'llm') return opts.withLlm ? llm : undefined
      if (k === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  })
  await apply(ctx, opts.cfg || {})
  return { HOME, domain, routes, tools, llmCalls, readCalls, defaultRead }
}

/** 用 A 面入队一次，拿到**本次来源水位**（键 = `<sid>::<wm>`）；这是测试里唯一"合法"的取水位方式。 */
const watermarkViaScan = async (tools, domain, sid) => {
  const r = await tools['memory__ingest_scan'].execute({})
  const keys = Object.keys(jobListOf(domain)).filter((k) => k.startsWith(sid + '::'))
  return { wm: keys.length === 1 ? keys[0].slice((sid + '::').length) : '', scan: r }
}
await section('[t241-R2] 扫描故障恢复：失败不推进水位、恢复后重入队、去重仍成立', async () => {
  console.log('\n[R2] 读源失败只记 deferred；同 mtime 恢复后再扫能入队；重复成功仍去重')
  let readFail = true
  const b = await boot({
    withLlm: true,
    readSession: async (id) => {
      if (readFail) throw new Error('synthetic temporary read failure')
      return { session: { version: 4, isSeeded: false, id, cwd: 'C:/t241', createdAt: 0 }, events: [msgEvent(id, V1)] }
    },
  })
  const scanTool = b.tools['memory__ingest_scan']
  const r1 = await scanTool.execute({})
  check(r1.candidates === 1 && r1.enqueued === 0, `首次（读源失败）⇒ 候选 1、入队 0（candidates=${r1.candidates} enqueued=${r1.enqueued}）`)
  check(r1.deferred === 1 && r1.done === 0, `记成"延后"而不是"完成"（deferred=${r1.deferred} done=${r1.done}）`)
  check(r1.sourceGone === 1, `临时读失败被识别为源不可用（sourceGone=${r1.sourceGone}）`)
  const seen1 = metaOf(b.domain).scanSeen || {}
  check(!Object.prototype.hasOwnProperty.call(seen1, SID), `**未**推进 scanSeen 完成水位（scanSeen 里有该会话？${Object.prototype.hasOwnProperty.call(seen1, SID)}）`)
  check(Object.keys(jobListOf(b.domain)).length === 0, '没有入队（因此这一趟不可能烧模型）')
  check(b.llmCalls.n === 0, `读失败的那一趟**没有模型调用**（llmCalls=${b.llmCalls.n}）`)
  check(!!(metaOf(b.domain).unrefined || {})[SID], 'D2 未提炼碑已记（异常与"完成"是**两种不同状态**）')

  readFail = false
  const r2 = await scanTool.execute({})
  check(r2.candidates === 1 && r2.enqueued === 1 && r2.deferred === 0,
    `恢复后**同一 mtime** 能入队（candidates=${r2.candidates} enqueued=${r2.enqueued} deferred=${r2.deferred}）`)
  const keys = Object.keys(jobListOf(b.domain))
  check(keys.length === 1, `恰好 1 条作业（实测 ${keys.length}）`)

  const r3 = await scanTool.execute({})
  check(r3.enqueued === 0 && r3.done === 1, `重复成功仍去重（enqueued=${r3.enqueued} done=${r3.done}）`)
  check(Object.keys(jobListOf(b.domain)).length === 1, `作业数仍是 1（实测 ${Object.keys(jobListOf(b.domain)).length}）`)
})

// ── R3：服务访问门（childCtx 上 agent 属性 getter 抛错）下限制仍能建立 ───────────
await section('[t241-R3] 落成受限执行者：agent 属性访问门 + 宿主形名字契约', async () => {
  console.log('\n[R3] `setup(childCtx)` 的 `agent` 是访问门（without inject）——限制仍必须建立')
  const startExec = typeof M.startConsolidationExecutor === 'function' ? M.startConsolidationExecutor : null
  if (!startExec) { check(false, 'startConsolidationExecutor 未导出'); return }
  // 宿主契约名单（真机报错逐字回吐的 32 个可限制全局工具，见 t230）。
  const KNOWN = [
    'agent_teams_add_member', 'agent_teams_approve', 'agent_teams_claim_task', 'agent_teams_create',
    'agent_teams_create_task', 'agent_teams_delete', 'agent_teams_edit_plan', 'agent_teams_reassign_task',
    'agent_teams_remove_member', 'agent_teams_resume', 'agent_teams_send_message', 'agent_teams_status',
    'agent_teams_update_task', 'delete_sessions', 'delete_to_recycle_bin', 'download_idm',
    'list_archived_sessions', 'memory__archive_vault', 'memory__phase2_integrate', 'memory__restore_vault',
    'memory__stage1_drain', 'memory_forget', 'memory_integrate', 'memory_note', 'memory_precompact',
    'memory_recall', 'memory_remember', 'session_event_search', 'session_read', 'session_search',
    'session_trace', 'unarchive_session',
  ]
  const sink = []
  const hostShapedRestrict = (filter) => {
    const names = [...(filter.allow || []), ...(filter.deny || [])]
    const unknown = names.filter((n) => !KNOWN.includes(n))
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map((n) => `"${n}"`).join(', ')}; known global tools: ${[...KNOWN].sort().join(', ')}`)
    }
    sink.push(filter)
    return () => {}
  }
  /** ⚠️ 这就是评审指出的服务访问门：读 `ctx.agent` 直接抛，**参数求值期**就抛。 */
  const child = { tools: { view: () => ({ restrictableNames: new Set(['memory_recall']) }), restrict: hostShapedRestrict } }
  Object.defineProperty(child, 'agent', { get() { throw new Error('cannot get property "agent" without inject') } })
  // 牙齿：旧写法（把 childCtx.agent 当参数）在**进入函数之前**就抛 ⇒ 真机记住假原因 + 永久回落。
  let teethMsg = ''
  try { void restrictableGlobalTools(child.tools, child.agent) } catch (err) { teethMsg = String((err && err.message) || err) }
  check(teethMsg.includes('without inject'), `旧写法（读 childCtx.agent）在访问门上必抛（${teethMsg}）`)

  const target = path.join(os.tmpdir(), 'dsh-memory_rollout-t241-exec-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(target, { recursive: true })
  const svc = {
    create: async (o) => {
      if (typeof o.setup === 'function') o.setup(child)   // 宿主形状：setup 收**上下文**，不是 Agent
      return { session: { append: () => {} }, agent: { id: o.sessionId }, dispose: async () => {} }
    },
  }
  const r = await startExec({ ctx: { get: (k) => (k === 'agents' ? svc : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined) }, memoryRoot: target, sessionId: 't241-gate' })
  check(r.ok === true && r.restricted === true, `限制**真建立**（ok=${r.ok} restricted=${r.restricted} reason=${r.reason || '-'}）`)
  check(!String(r.reason).includes('without inject'), '不再出现 agent 访问门导致的假原因')
  check(sink.length === 1 && sink[0].deny.length === KNOWN.length, `restrict 收到完整权威名单（${sink.length} 次调用 / ${sink[0] && sink[0].deny.length} 个名字）`)
  check(sink.length === 1 && sink[0].allow === undefined, '只传 deny（不靠 allow 表达内建工具）')
  check(sink[0].deny.includes('memory_recall') && sink[0].deny.includes('delete_sessions'), 'deny 覆盖真实插件工具（含删除入口）')
  check(!sink[0].deny.includes('read') && !sink[0].deny.includes('subagent'), '名单里不含宿主不认的 6 个名字（否则真机仍会抛）')
  check(r.restrictObs && r.restrictObs.names.length === KNOWN.length && r.restrictObs.unknownDesired.length === 6,
    `批记录可读：names=${r.restrictObs && r.restrictObs.names.length} / unknownDesired=${r.restrictObs && r.restrictObs.unknownDesired.length}`)
  // 负面对照：宿主**不**枚举名单时，绝不假装 restricted=true
  const blind = { tools: { view: () => ({ restrictableNames: new Set(['memory_recall']) }), restrict: () => { /* 不校验、不枚举 */ } } }
  Object.defineProperty(blind, 'agent', { get() { throw new Error('cannot get property "agent" without inject') } })
  const svc2 = {
    create: async (o) => {
      if (typeof o.setup === 'function') o.setup(blind)
      return { session: { append: () => {} }, agent: { id: o.sessionId }, dispose: async () => {} }
    },
  }
  const r2 = await startExec({ ctx: { get: (k) => (k === 'agents' ? svc2 : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined) }, memoryRoot: target, sessionId: 't241-blind' })
  check(r2.ok === false && String(r2.reason).includes('executor-restrictions-not-established'),
    `名单不可得 ⇒ 明确回落（不假装已限制）（reason=${String(r2.reason).slice(0, 80)}…）`)
  check(!String(r2.reason).includes('without inject'), '回落原因里也没有 agent 访问门（该缺陷已消失）')
})

console.log(`\n${failed === 0 ? 'ALL T241 REVIEW-R1R2R3 TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
