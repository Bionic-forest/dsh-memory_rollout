// t230：`tools.restrict()` 的**工具名契约**（真机 blocker t229 / F-N1 的最小验证集）
//
// 真机逐字报错（v0.1.15，C 的 t229 验收 §4）：
//   executor-restrictions-not-established: tool-restrict-not-established
//   (tools.restrict() names unknown global tools "read", "write", "edit", "glob", "grep", "subagent";
//    known global tools: agent_teams_*, memory__*, session_*, delete_*, download_idm, unarchive_session)
//
// 根因（**测试盲区**）：t224/t187/t213/t220 的假 `tools.restrict` **不校验名字** ⇒
//   `allow:['read','write','edit','glob','grep']` 这种**真机必失败**的过滤器在测试层一路绿灯。
//
// 本文件的立场：**把宿主契约搬进测试**（名单取自真机报错逐字的 31 个名字），让
//   「名字不在宿主可限制名单里」在**测试层**就失败；并验证实现改为**从宿主注册表派生**。
//
// 宿主契约（**实际加载副本**：`…\.pnpm\@deepseek-ai+dsh-tools@0.1._3c09556…\…\dsh-tools\lib\index.js`
//   SHA256 AABA52BF5D0149355407642B3965C06977D1E9143F5C61BC19429ABBE6A11C5D / 151,784 B）：
//   · `restrict(filter)` **L2790-2805**：只接受 `view(scope).restrictableNames`，否则在
//     `layers.effect(…restrictions.append…)`（L2804）**之前**抛错 ⇒ 探测调用无副作用；
//   · `view(scope)` **L2854-2880**：`restrictableNames` = 继承层（global + 祖先）注册的工具名，
//     **本层自有注册只进 `knownNames`/`visible`**（L2870-2873）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 宿主契约：真机报错里逐字回吐的 known global tools（**32** 个，已按宿主 L2803 排序）─────
const HOST_KNOWN_GLOBAL_TOOLS = [
  'agent_teams_add_member', 'agent_teams_approve', 'agent_teams_claim_task', 'agent_teams_create',
  'agent_teams_create_task', 'agent_teams_delete', 'agent_teams_edit_plan', 'agent_teams_reassign_task',
  'agent_teams_remove_member', 'agent_teams_resume', 'agent_teams_send_message', 'agent_teams_status',
  'agent_teams_update_task', 'delete_sessions', 'delete_to_recycle_bin', 'download_idm',
  'list_archived_sessions', 'memory__archive_vault', 'memory__phase2_integrate', 'memory__restore_vault',
  'memory__stage1_drain', 'memory_forget', 'memory_integrate', 'memory_note', 'memory_precompact',
  'memory_recall', 'memory_remember', 'session_event_search', 'session_read', 'session_search',
  'session_trace', 'unarchive_session',
]
/** 本批**想要**约束、但宿主真实名单里**没有**的 6 个名字（内建文件工具 5 + `subagent`）。 */
const DESIRED_BUT_ABSENT = ['read', 'write', 'edit', 'glob', 'grep', 'subagent']
/** 保留的 PTC 传输名 `run_code`（宿主 L2800 明文禁列）——真机报错的 known 名单里**不含**它
 *  （它是 `visible` 的兜底项，而 `restrictableNames` 只含注册名），故契约数组长度 = 32。 */
const RESERVED_NAME = 'run_code'

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-t230-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(tmp, { recursive: true })
process.env.DSH_HOME = tmp

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const M = await import(PLUGIN)
const { apply } = M

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
/** 改前树没有 t230 的导出 ⇒ 包装成断言红，而不是 import/调用中途崩溃。 */
const restrictableGlobalTools =
  typeof M.restrictableGlobalTools === 'function'
    ? M.restrictableGlobalTools
    : () => ({ names: [], source: 'restrictableGlobalTools-missing', unknownDesired: [], note: 'export-missing' })
const startExec =
  typeof M.startConsolidationExecutor === 'function'
    ? M.startConsolidationExecutor
    : async () => ({ ok: false, reason: 'startConsolidationExecutor-missing', spec: null, restricted: false, restrictObs: null })

const isStrictSubdir = (parent, child) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 宿主形状的 `restrict`（**按真实名单校验名字**，抛点/文案与 dsh-tools L2803 一致）。 */
const hostShapedRestrict = (known, sink) => (filter) => {
  const names = [...(filter.allow || []), ...(filter.deny || [])]
  if (names.includes(RESERVED_NAME)) {
    throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RESERVED_NAME}"; restrict end-capability tools instead`)
  }
  const unknown = names.filter((n) => !known.includes(n))
  if (unknown.length > 0) {
    throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map((n) => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`)
  }
  if (sink) sink.push(filter)
  return () => {}
}

// ── T1：契约层——补丁/派生的名字必须**全部**在宿主可限制名单内 ────────────────────
await section('[T1]', async () => {
  console.log('\n[T1] 契约层：宿主视图路径派生 + 想要但缺失的名字显式上报')
  const seen = []
  const viewTools = { view: () => ({ restrictableNames: new Set([...HOST_KNOWN_GLOBAL_TOOLS, RESERVED_NAME]) }), restrict: hostShapedRestrict(HOST_KNOWN_GLOBAL_TOOLS, seen) }
  const d = restrictableGlobalTools(viewTools, { id: 'agent-1' })
  check(d.names.length === HOST_KNOWN_GLOBAL_TOOLS.length && HOST_KNOWN_GLOBAL_TOOLS.every((n) => d.names.includes(n)),
    `派生名单 = 宿主 view().restrictableNames（${d.names.length} 个）`)
  check(!d.names.includes(RESERVED_NAME), `保留名 ${RESERVED_NAME} 被剔除（宿主 L2800 明文禁列）`)
  check(d.source === 'view.restrictableNames', `来源可辨（source=${d.source}）`)
  check(d.unknownDesired.join(',') === DESIRED_BUT_ABSENT.join(','),
    `unknownDesired 恰好含那 6 个"想要但宿主没有"的名字（实测 ${JSON.stringify(d.unknownDesired)}）`)
  const stripped = d.names.filter((n) => !HOST_KNOWN_GLOBAL_TOOLS.includes(n))
  check(stripped.length === 0, `派生名单里**没有一个**名字超出宿主契约（多余 ${JSON.stringify(stripped)}）`)
})

// ── T2：探路退路——宿主不给 view 时，从报错回吐的 known 名单解析 ──────────────────
await section('[T2]', async () => {
  console.log('\n[T2] 契约层：退路探测（注定失败的 restrict ⇒ 解析 known global tools）')
  const probeOnly = { restrict: hostShapedRestrict(HOST_KNOWN_GLOBAL_TOOLS, []) }
  const d = restrictableGlobalTools(probeOnly, undefined)
  check(d.names.length === HOST_KNOWN_GLOBAL_TOOLS.length, `退路也把宿主名单全枚举出来（实测 ${d.names.length}/${HOST_KNOWN_GLOBAL_TOOLS.length}）`)
  check(d.source === 'restrict-error-known-list', `来源标为退路（source=${d.source}）`)
  check(d.unknownDesired.join(',') === DESIRED_BUT_ABSENT.join(','), '退路同样显式上报那 6 个缺失名')
  // 反面对照：宿主名单为空 ⇒ 不得静默通过，必须给出"名单不可得"的注记
  const noKnown = { restrict: () => { throw new Error('tools.restrict() names unknown global tool "x"; known global tools: (none)') } }
  const d2 = restrictableGlobalTools(noKnown, undefined)
  check(d2.names.length === 0 && d2.note === 'restrictable-name-set-unavailable',
    `名单不可得 ⇒ 显式注记（note=${d2.note}），不静默放行`)
})

// ── T3：牙齿——旧实现的过滤器（allow 5 内建名 + deny subagent）在**契约层**必然抛错 ──
await section('[T3]', async () => {
  console.log('\n[T3] 牙齿：真机报错的过滤器在宿主形假服务上复现（还原口树上必红）')
  let msg = ''
  try {
    hostShapedRestrict(HOST_KNOWN_GLOBAL_TOOLS, [])({ allow: ['read', 'write', 'edit', 'glob', 'grep'], deny: ['subagent'] })
  } catch (err) { msg = String((err && err.message) || err) }
  check(msg.includes('names unknown global tools') && msg.includes('"read"') && msg.includes('"subagent"'),
    `旧过滤器被宿主形服务**逐字复现**拒绝（${msg.slice(0, 96)}…）`)
  let msg2 = ''
  try { hostShapedRestrict(HOST_KNOWN_GLOBAL_TOOLS, [])({ deny: [RESERVED_NAME] }) } catch (err) { msg2 = String((err && err.message) || err) }
  check(msg2.includes('reserved'), `保留名也被拒（${msg2.slice(0, 72)}…）`)
})

// ── T4：行为层——受限执行者在本契约下**真建起来**（改前树：restricted=false）────────
await section('[T4]', async () => {
  console.log('\n[T4] 行为层：startConsolidationExecutor 在真实名单下 restricted=true')
  const sink = []
  const target = path.join(tmp, 'memories-t4')
  fs.mkdirSync(target, { recursive: true })
  const state = { creates: [] }
  const svc = {
    create: async (o) => {
      state.creates.push(o)
      if (typeof o.setup === 'function') {
        o.setup({ tools: { view: () => ({ restrictableNames: new Set([...HOST_KNOWN_GLOBAL_TOOLS, RESERVED_NAME]) }), restrict: hostShapedRestrict(HOST_KNOWN_GLOBAL_TOOLS, sink) } })
      }
      return { session: { append: () => {} }, agent: { id: o.sessionId } }
    },
  }
  const res = await startExec({ ctx: { get: (k) => (k === 'agents' ? svc : undefined) }, memoryRoot: target, sessionId: 'p2-exec-t230-t4' })
  check(res.restricted === true && res.ok === true,
    `限制**真建立**（restricted=${res.restricted} ok=${res.ok}；改前树因名字不匹配 ⇒ restricted=false）`)
  check(sink.length === 1 && Array.isArray(sink[0].deny) && sink[0].deny.length > 0 && sink[0].allow === undefined,
    `restrict 只传 deny（实测 ${JSON.stringify(sink[0])}）`)
  check(sink.length === 1 && sink[0].deny.includes('memory_recall') && sink[0].deny.includes('agent_teams_create_task'),
    'deny 覆盖的是**真实可委派/可写记忆的插件工具**（如 memory_recall / agent_teams_create_task）')
  const obs = res.restrictObs || {}
  check(obs.source === 'view.restrictableNames', `派生来源落观测（executor_restrict_source=${obs.source}）`)
  check(Array.isArray(obs.unknownDesired) && obs.unknownDesired.join(',') === DESIRED_BUT_ABSENT.join(','),
    `"想要但没有"落观测（executor_restrict_unknown=${(obs.unknownDesired || []).join(',')}）`)
  check(!sink[0].deny.includes('read') && !sink[0].deny.includes('subagent'),
    '派生名单里**不含**那 6 个不存在的名字（否则真机仍会抛）')
})

// ── T5：失败面可见——宿主形状的拒绝要能进 executor_reason（边界 1 不静默）────────
await section('[T5]', async () => {
  console.log('\n[T5] 失败面：名字仍不匹配时，原因进 executor_reason 且不派发')
  const target = path.join(tmp, 'memories-t5')
  fs.mkdirSync(target, { recursive: true })
  const svc = {
    create: async (o) => {
      if (typeof o.setup === 'function') {
        o.setup({ tools: { restrict: hostShapedRestrict(HOST_KNOWN_GLOBAL_TOOLS, []), view: undefined } })
      }
      return { session: { append: () => {} }, agent: { id: o.sessionId } }
    },
  }
  // 用一个只接受旧名字的假视角模拟"宿主完全不认可派生结果"的极端面
  const badSvc = {
    create: async (o) => {
      if (typeof o.setup === 'function') {
        o.setup({
          tools: {
            view: undefined,
            restrict: () => { throw new Error('tools.restrict() names unknown global tool "read"; known global tools: memory_recall, session_search') },
          },
        })
      }
      return { session: { append: () => {} }, agent: { id: o.sessionId } }
    },
  }
  const ok = await startExec({ ctx: { get: (k) => (k === 'agents' ? svc : undefined) }, memoryRoot: target, sessionId: 'p2-exec-t230-t5' })
  check(ok.restricted === true, '契约内派生 ⇒ 正常建立（对照组）')
  const bad = await startExec({ ctx: { get: (k) => (k === 'agents' ? badSvc : undefined) }, memoryRoot: target, sessionId: 'p2-exec-t230-t5b' })
  check(bad.ok === false && String(bad.reason).includes('executor-restrictions-not-established'),
    `宿主拒绝时**回落且写明**（reason=${String(bad.reason).slice(0, 88)}…）`)
  check(String(bad.reason).includes('unknown global tool'),
    '宿主报错**逐字带出**（失败面不吞错）')
  const obs = bad.restrictObs || {}
  check(Array.isArray(obs.unknownDesired) && obs.unknownDesired.length > 0,
    `批记录可读处也能看出"名字不匹配"这一类的缺失名单（unknownDesired=${(obs.unknownDesired || []).length} 个）`)
})

// ── T6：端到端——真跑一批，批记录里同时有 source/unknown（不只日志）─────────────
await section('[T6]', async () => {
  console.log('\n[T6] 端到端：批记录字段 executor_restrict_source / executor_restrict_unknown')
  const { makeCtx, seedOutput, setMeta } = await import('./lib/helpers.mjs')
  const home = path.join(tmp, 'h-t6')
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const sink = []
  const svc = {
    create: async (o) => {
      if (typeof o.setup === 'function') {
        o.setup({ tools: { view: () => ({ restrictableNames: new Set([...HOST_KNOWN_GLOBAL_TOOLS, RESERVED_NAME]) }), restrict: hostShapedRestrict(HOST_KNOWN_GLOBAL_TOOLS, sink) } })
      }
      const evs = []
      const agent = {
        id: o.sessionId,
        get status() { return { state: 'idle', turns: 1 } },
        session: { append: () => {}, events: () => evs },
        cancel: () => {}, followup: () => {}, whenIdle: async () => {},
      }
      return { agent, dispose: async () => {} }
    },
  }
  const counters = { inProcess: 0 }
  const llm = {
    stream: (o) => {
      if (o && String(o.system).includes('memory-extraction')) return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
      counters.inProcess++
      return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify({ memory_summary: 'v1\n## t230', registry: '# MEMORY.md\nt230' }) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
    },
  }
  const REG = {}
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'agents' ? svc : k === 'llm' ? llm : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
    tools: { register: (t) => { if (t && t.name) REG[t.name] = t } },
  })
  await apply(ctx, {})
  await seedOutput(domain, 'o-t230', { session_id: 's-t230', source_watermark: 'wm-t230', rollout_summary: 'durable t230', generated_at: new Date(Date.now() - 120000).toISOString() })
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  domain.table('phase2_jobs').put('B230', {
    id: 'B230', status: 'pending', input_ids: ['o-t230'], change_ids: [], lease_owner: '', lease_expires_at: '',
    attempt_count: 0, max_attempts: 3, available_at: new Date(Date.now() - 120000).toISOString(), staging_version: '',
    last_error: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  check(typeof REG['memory__phase2_integrate']?.execute === 'function', '插件工具已注册（memory__phase2_integrate）')
  await REG['memory__phase2_integrate'].execute({})
  const job = [...domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v })).pop() || {}
  check(job.executor_restrict_source === 'view.restrictableNames',
    `批记录带出派生来源（executor_restrict_source=${job.executor_restrict_source}）`)
  check(String(job.executor_restrict_unknown || '').split(',').filter(Boolean).join(',') === DESIRED_BUT_ABSENT.join(','),
    `批记录带出缺失名单（executor_restrict_unknown=${job.executor_restrict_unknown}）`)
  check(sink.length >= 1, `真实整合批里 restrict 至少被调用一次（${sink.length}）`)
})

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`\n${failed === 0 ? 'ALL T230 TOOLNAME-CONTRACT TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
