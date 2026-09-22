// t241（T30 · 独立评审 R1 / R1b / R2 / R3 收口）：把评审**亲自复现的三条实证问题**搬进测试层。
//
// 评审来源：`rollout-独立评审与路线裁决-2026-09-21.md`（R1 P1 删前判据未绑定本次来源版本、
//   R1b P2 调用返回 ≠ 删除成功、R2 P1 暂时读不到来源被永久记成扫描完成、R3 P1 目标阻断：
//   受限执行者被真实宿主服务访问规则挡住）。对应实现见 `lib/index.js` 的
//   `draftEvidenceOf` / `judgeDeleteToolResult` / `ingestIdleScan`（scanSeen 只在"确知已处理"时推进）
//   / `restrictableGlobalTools`（不再读 `childCtx.agent`，作用域由宿主自身的校验错误派生）。
//
// 本文件的立场（与评审 §六 的验收口径对齐）：
//   · **删前门槛**：旧草稿 + 新水位 pending ⇒ 不删；本次水位成功且证据可读 ⇒ 才调用删除；
//     等待期间来源又更新 ⇒ 不误删；空文件 / 提炼失败 ⇒ 不放行；删除服务说没删掉 ⇒ 如实报 deleted:false。
//   · **扫描故障**：首次临时读失败**不推进**完成水位（且不烧模型）⇒ 恢复后同一 mtime 仍入队 ⇒ 去重仍成立。
//   · **服务接线**：`setup` 收到的 ctx 上 `agent` 是**访问门**（getter 抛 `without inject`）时，
//     限制仍能建立；旧写法（读 `childCtx.agent`）在该门上是**必抛**的（牙齿）。
//   · 全部走**真实路由 handler** 与计数型模拟删除服务；**绝不删任何真实会话**，只在 tmp 里造合成文件。
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
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
const judgeDeleteToolResult = typeof M.judgeDeleteToolResult === 'function'
  ? M.judgeDeleteToolResult
  : () => ({ deleted: false, outcome: 'missing-export', detail: null, backupPath: '', text: 'export-missing' })

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
  header: { version: 0, id, cwd: 'C:/t241', createdAt: 0 },
  revision: `1:2:3:${Math.round((NOW - idleHours * 3600000) * 1e6)}:4`,
  sizeBytes: 256,
})
const msgEvent = (id, text) => ({
  type: 'user/message', seq: 0, time: 0, surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const V1 = 'T241 v1：本次决定 = 删除一律走回收站。' + '细节A'.repeat(20)
const V2 = 'T241 v2：后来改主意 = 删除前必须先有可读草稿。' + '细节B'.repeat(20)

/**
 * 起一个带路由与计数型删除服务的合成宿主。
 * @param opts.text            会话正文（默认 V1）
 * @param opts.readSession     (id, n) => Promise<session>；可抛错模拟读源失败
 * @param opts.deleteResult    delete_sessions 返回体（默认：报告"没删掉"）
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
  const deleteState = { calls: [] }
  const defaultRead = async (id) => ({
    session: { version: 0, id, cwd: 'C:/t241', createdAt: 0 },
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
  const deleteTool = {
    execute: async (args, exec) => {
      deleteState.calls.push({ args, exec })
      if (typeof opts.deleteResult === 'function') return opts.deleteResult(args, exec)
      return opts.deleteResult
    },
  }
  tools.get = (n) => (n === 'delete_sessions' ? deleteTool : undefined)
  await apply(ctx, opts.cfg || {})
  return { HOME, domain, routes, tools, deleteState, llmCalls, readCalls, defaultRead }
}

/** 打通真实路由 handler（POST JSON）；返回响应体对象。 */
const postRoute = async (routes, body) => {
  const route = routes.get('/dsh-memory_rollout/ingest-and-delete')
  if (!route || typeof route.handler !== 'function') throw new Error('ingest-and-delete 路由未注册')
  const req = new EventEmitter()
  req.method = 'POST'
  let answer = null
  const res = { setHeader() {}, end: (s) => { answer = JSON.parse(s) } }
  const pending = route.handler(req, res)
  queueMicrotask(() => { req.emit('data', JSON.stringify(body)); req.emit('end') })
  await pending
  return answer
}

const draftPathOf = (HOME, sid) => path.join(HOME, 'memories', 'rollout_summaries', `${sid}.md`)
const writeDraft = (HOME, sid, body) => {
  fs.mkdirSync(path.dirname(draftPathOf(HOME, sid)), { recursive: true })
  fs.writeFileSync(draftPathOf(HOME, sid), body)
}
/** 用 A 面入队一次，拿到**本次来源水位**（键 = `<sid>::<wm>`）；这是测试里唯一"合法"的取水位方式。 */
const watermarkViaScan = async (tools, domain, sid) => {
  const r = await tools['memory__ingest_scan'].execute({})
  const keys = Object.keys(jobListOf(domain)).filter((k) => k.startsWith(sid + '::'))
  check(keys.length === 1, `A 面入队得到 1 个键（实测 ${keys.length}：${keys.join(',')}）`)
  return { wm: keys.length === 1 ? keys[0].slice((sid + '::').length) : '', scan: r }
}
/** 造"本次水位已提炼且证据可读"：job 终态 + output 记录（带可核验 source_ref）+ 非空草稿。 */
const seedReadableEvidence = async (domain, HOME, sid, wm, cite = 'T241-CITE') => {
  const jobId = 'j-t241-' + wm.slice(0, 6)
  await seedJob(domain, sid, wm, { id: jobId, status: 'succeeded_with_output' })
  writeDraft(HOME, sid, cite + '\nsecond line\n')
  await seedOutput(domain, jobId, {
    session_id: sid,
    source_watermark: wm,
    rollout_summary: cite,
    source_ref: { path: `rollout_summaries/${sid}.md`, startLine: 1, endLine: 2, citeSpan: cite, sessionId: sid },
  })
  return jobId
}

const OK_DELETE = (sid) => ({
  dryRun: false, targets: 1, deleted: 1, skippedLive: 0, skippedBackup: 0,
  backupDir: 'B:/t241-backup', details: [{ sessionId: sid, action: 'deleted', backupPath: `B:/t241-backup/${sid}` }],
  note: 'synthetic: nothing real was read or deleted',
})

// ── R1 ①：旧草稿 + 新版本还没有本次水位的证据 ⇒ **不删** ─────────────────────────
await section('[t241-R1a] 旧草稿存在、本次水位拿不到证据 ⇒ 不删', async () => {
  console.log('\n[R1a] 删前门槛绑定**本次来源水位**（评审：旧代码约 3 ms 就放行）')
  const b = await boot({ deleteResult: OK_DELETE(SID) })
  // 磁盘上先放一份**旧草稿**（这正是旧判据 `existsSync` 会据以放行的东西）
  writeDraft(b.HOME, SID, '# OLD draft\nOld decision only\n')
  // 让读源失败 ⇒ 新水位进不了队列（最坏情形），但旧草稿在
  const ans = await postRoute(b.routes, { sessionId: SID, timeoutMs: 1200 })
  check(ans && ans.ok === true, `路由正常响应（ok=${ans && ans.ok}）`)
  check(ans.ingested === false && ans.deleted === false, `旧草稿**不**放行（ingested=${ans.ingested} deleted=${ans.deleted}）`)
  check(b.deleteState.calls.length === 0, `删除服务**调用 0 次**（实测 ${b.deleteState.calls.length}；旧代码此处为 1）`)
  check(/^(stage1-job-|no-stage1-job-for-watermark|missing-session-id-or-watermark|source-unavailable|ingest-error)/.test(String(ans.reason)),
    `理由指向"本次水位没准备好"（reason=${ans.reason}）`)
  check(fs.readFileSync(draftPathOf(b.HOME, SID), 'utf8').includes('Old decision only'), '旧草稿原样未动')
  check(ans.stages && ans.stages.draft_evidence_readable === false && ans.stages.published_authoritative_version === 'unjudged',
    `四层口径分开报（draft_evidence_readable=${ans.stages && ans.stages.draft_evidence_readable} / published=${ans.stages && ans.stages.published_authoritative_version}）`)
})

// ── R1 ②：本次水位成功且证据可读 ⇒ 才调用删除；并按返回契约判定（R1b 正例）──────
await section('[t241-R1b/R1b+] 本次水位可读证据 + 删除服务真删成功 ⇒ deleted:true', async () => {
  console.log('\n[R1b] 本次水位成功且证据可读 ⇒ 调用删除；按真实返回契约判定')
  const b = await boot({ deleteResult: OK_DELETE(SID), text: V1 })
  const { wm } = await watermarkViaScan(b.tools, b.domain, SID)
  check(!!wm, `取到本次来源水位（${wm}）`)
  await seedReadableEvidence(b.domain, b.HOME, SID, wm)
  const ans = await postRoute(b.routes, { sessionId: SID, timeoutMs: 3000 })
  check(ans.ingested === true, `本次水位证据可读 ⇒ ingested:true（watermark=${ans.watermark}）`)
  check(ans.watermark === wm, `放行的是**本次**水位（${ans.watermark} === ${wm}）`)
  check(b.deleteState.calls.length === 1, `删除服务恰好调用 1 次（实测 ${b.deleteState.calls.length}）`)
  check(b.deleteState.calls[0].args.sessionIds.join(',') === SID && b.deleteState.calls[0].args.dry_run === false,
    `入参形状符合真实契约（sessionIds=[sid] + dry_run:false）：${JSON.stringify(b.deleteState.calls[0].args)}`)
  check(ans.deleted === true && ans.deleteOutcome === 'deleted', `deleted:true + outcome=deleted（实测 ${ans.deleted}/${ans.deleteOutcome}）`)
  check(String(ans.message).includes('不表示已发布进权威记忆'), '文案**不**合成"已记忆"（明确未判定发布/复用）')
})

// ── R1b 牙齿：返回体说"没删掉" ⇒ 必须如实报 false（评审的复现正是此处假绿）────────
await section('[t241-R1b-] 删除服务返回拒绝 / 跳过 ⇒ deleted 必须为 false', async () => {
  console.log('\n[R1b] 返回体判定：拒绝、skipped-live、dry-run、以及无法判定')
  const cases = [
    ['评审复现体（无 details 的拒绝）', { deleted: 0, errors: ['synthetic refusal; nothing deleted'] }, 'undecidable'],
    ['会话仍活跃被护栏跳过', { dryRun: false, targets: 1, deleted: 0, skippedLive: 1, skippedBackup: 0, backupDir: 'B:/x', details: [{ sessionId: SID, action: 'skipped-live' }] }, 'skipped-live'],
    ['找不到会话目录', { dryRun: false, targets: 1, deleted: 0, skippedLive: 0, skippedBackup: 0, backupDir: 'B:/x', details: [{ sessionId: SID, action: 'skipped-missing' }] }, 'skipped-missing'],
    ['备份失败跳过', { dryRun: false, targets: 1, deleted: 0, skippedLive: 0, skippedBackup: 1, backupDir: 'B:/x', details: [{ sessionId: SID, action: 'skipped-backup' }] }, 'skipped-backup'],
    ['dry-run 体', { dryRun: true, targets: 1, deleted: 1, skippedLive: 0, skippedBackup: 0, backupDir: '', details: [{ sessionId: SID, action: 'deleted' }] }, 'dry-run'],
    ['返回体不认识', { whatever: true }, 'undecidable'],
    ['null 返回体', null, 'undecidable'],
  ]
  for (const [label, body, expect] of cases) {
    const j = judgeDeleteToolResult(body, SID)
    check(j.deleted === false && j.outcome === expect, `${label} ⇒ deleted=false + outcome=${expect}（实测 ${j.deleted}/${j.outcome}）`)
  }
  // 端到端：证据可读 + 删除服务返回"拒绝体" ⇒ 路由必须 deleted:false（旧代码此处为 true）
  const b = await boot({ deleteResult: { deleted: 0, errors: ['synthetic refusal; nothing deleted'] }, text: V1 })
  const { wm } = await watermarkViaScan(b.tools, b.domain, SID)
  await seedReadableEvidence(b.domain, b.HOME, SID, wm)
  const ans = await postRoute(b.routes, { sessionId: SID, timeoutMs: 3000 })
  check(ans.ingested === true && ans.deleted === false, `路由如实报"没删掉"（ingested=${ans.ingested} deleted=${ans.deleted}）`)
  check(String(ans.message).includes('没有删掉'), `文案明确"没删掉"（${String(ans.message).slice(0, 60)}…）`)
  // 端到端：删除工具抛错 ⇒ 同样不假装成功
  const b2 = await boot({ deleteResult: () => { throw new Error('synthetic tool failure') }, text: V1 })
  const s2 = await watermarkViaScan(b2.tools, b2.domain, SID)
  await seedReadableEvidence(b2.domain, b2.HOME, SID, s2.wm)
  const ans2 = await postRoute(b2.routes, { sessionId: SID, timeoutMs: 3000 })
  check(ans2.deleted === false && String(ans2.deleteError).startsWith('delete-failed'), `删除工具抛错 ⇒ deleted:false + deleteError 带出（${ans2.deleteError}）`)
})

// ── R1 ③：等待期间来源又更新 ⇒ 不误删 ──────────────────────────────────────────
await section('[t241-R1c] 等待期间新增内容 ⇒ 不误删', async () => {
  console.log('\n[R1c] 放行前复查来源水位：变了就不删（并为新内容入队）')
  // read #1 = A 面扫描（V1 → wm1）；read #2 = 路由首次 ingest（仍 V1）；read #3 = 放行前复查（V2）
  const b = await boot({
    deleteResult: OK_DELETE(SID),
    readSession: async (id, n) => ({
      session: { version: 0, id, cwd: 'C:/t241', createdAt: 0 },
      events: [msgEvent(id, n >= 3 ? V2 : V1)],
    }),
  })
  const { wm } = await watermarkViaScan(b.tools, b.domain, SID)
  await seedReadableEvidence(b.domain, b.HOME, SID, wm)
  const ans = await postRoute(b.routes, { sessionId: SID, timeoutMs: 3000 })
  check(ans.ingested === true, `wm1 的证据确实可读（ingested=${ans.ingested}）`)
  check(ans.reason === 'source-changed-since-enqueue', `复查发现新水位：（reason=${ans.reason}）`)
  check(ans.deleted === false && b.deleteState.calls.length === 0,
    `**没有误删**（deleted=${ans.deleted} 删除调用=${b.deleteState.calls.length}）`)
  const keys = Object.keys(jobListOf(b.domain)).filter((k) => k.startsWith(SID + '::'))
  check(keys.length === 2, `新内容已入队（job 键 ${keys.length} 个 ⇒ 新水位没丢）`)
})

// ── R1 ④：只有空文件 / 提炼失败 ⇒ 不放行 ───────────────────────────────────────
await section('[t241-R1d] 空文件与提炼失败都不放行', async () => {
  console.log('\n[R1d] `succeeded_no_output`（空/过短/无产出）与 `failed_terminal` 都不是"已提炼"')
  for (const [label, status] of [['无产出', 'succeeded_no_output'], ['终态失败', 'failed_terminal']]) {
    const b = await boot({ deleteResult: OK_DELETE(SID), text: V1 })
    const { wm } = await watermarkViaScan(b.tools, b.domain, SID)
    // **草稿文件存在且非空**（旧判据在这里会放行），但本次水位没有成功产物
    await seedJob(b.domain, SID, wm, { id: 'j-t241-' + status, status })
    writeDraft(b.HOME, SID, '# 别的历史内容\nhistory\n')
    const ans = await postRoute(b.routes, { sessionId: SID, timeoutMs: 1200 })
    check(ans.ingested === false && ans.deleted === false && b.deleteState.calls.length === 0,
      `${label}（${status}）⇒ 不放行（ingested=${ans.ingested} deleted=${ans.deleted} 删除调用=${b.deleteState.calls.length}）`)
    // 理由必须落在 stage-1 状态家族里（不是笼统的 timeout）。注意：种下的 `failed_terminal` 会被
    // **既有入队语义**重置回 `pending` 重新尝试（`enqueueStage1JobIntoTable` 的 P0-2 行为），
    // 所以这里观察到的新状态是**新一轮尝试**的结果——正确，不是撒谎。
    check(/^stage1-job-/.test(String(ans.reason)), `理由逐字指向 stage-1 状态（reason=${ans.reason}）`)
    const cur = Object.values(jobListOf(b.domain)).find((j) => j && String(j.session_id) === SID)
    if (status === 'failed_terminal') {
      check(cur && cur.status !== 'failed_terminal',
        `终态失败在**新一次点击**里被重置重试（现状 status=${cur && cur.status}）⇒ 不放行但材料不丢`)
    }
  }
  // 空草稿（0 字节）+ 成功产物（source_ref 覆盖到文件末、无 citeSpan）⇒ 命中 `draft-empty` 分支
  {
    const b = await boot({ deleteResult: OK_DELETE(SID), text: V1 })
    const { wm } = await watermarkViaScan(b.tools, b.domain, SID)
    const jobId = await seedReadableEvidence(b.domain, b.HOME, SID, wm)
    fs.writeFileSync(draftPathOf(b.HOME, SID), '')
    await b.domain.table('stage1_outputs').update(jobId, (cur) => ({
      ...cur, source_ref: { path: `rollout_summaries/${SID}.md`, startLine: 1, endLine: 0, sessionId: SID },
    }))
    const ans = await postRoute(b.routes, { sessionId: SID, timeoutMs: 1200 })
    check(ans.ingested === false && b.deleteState.calls.length === 0,
      `空草稿 ⇒ 不放行（ingested=${ans.ingested} 删除调用=${b.deleteState.calls.length}）`)
    check(ans.reason === 'draft-file-missing-or-empty', `理由指出空草稿（reason=${ans.reason}）`)
  }
  // 空草稿 + 期待 citeSpan ⇒ 在证据核验那一关就被拦（另一种同等诚实的拒绝理由）
  {
    const b = await boot({ deleteResult: OK_DELETE(SID), text: V1 })
    const { wm } = await watermarkViaScan(b.tools, b.domain, SID)
    await seedReadableEvidence(b.domain, b.HOME, SID, wm)
    fs.writeFileSync(draftPathOf(b.HOME, SID), '')
    const ans = await postRoute(b.routes, { sessionId: SID, timeoutMs: 1200 })
    check(ans.ingested === false && b.deleteState.calls.length === 0 && String(ans.reason).startsWith('evidence-unreadable'),
      `空草稿 + 期待证据段 ⇒ 仍然不放行（reason=${ans.reason}）`)
  }
  // 证据段读不出来（行号越界）⇒ 也不放行
  const b2 = await boot({ deleteResult: OK_DELETE(SID), text: V1 })
  const s2 = await watermarkViaScan(b2.tools, b2.domain, SID)
  const jobId2 = await seedReadableEvidence(b2.domain, b2.HOME, SID, s2.wm)
  writeDraft(b2.HOME, SID, 'only one line\n')
  await b2.domain.table('stage1_outputs').update(jobId2, (cur) => ({
    ...cur, source_ref: { path: `rollout_summaries/${SID}.md`, startLine: 9, endLine: 10, citeSpan: 'T241-CITE', sessionId: SID },
  }))
  const ans2 = await postRoute(b2.routes, { sessionId: SID, timeoutMs: 1200 })
  check(ans2.ingested === false && String(ans2.reason).startsWith('evidence-unreadable'), `证据段读不出来 ⇒ 不放行（reason=${ans2.reason}）`)
})

// ── R2：临时读不到来源 ⇒ 不推进完成水位 ⇒ 恢复后同一 mtime 仍入队 ────────────────
await section('[t241-R2] 扫描故障恢复：失败不推进水位、恢复后重入队、去重仍成立', async () => {
  console.log('\n[R2] 读源失败只记 deferred；同 mtime 恢复后再扫能入队；重复成功仍去重')
  let readFail = true
  const b = await boot({
    withLlm: true,
    readSession: async (id) => {
      if (readFail) throw new Error('synthetic temporary read failure')
      return { session: { version: 0, id, cwd: 'C:/t241', createdAt: 0 }, events: [msgEvent(id, V1)] }
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
