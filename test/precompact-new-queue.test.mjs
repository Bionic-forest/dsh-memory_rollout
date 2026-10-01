// 第三轮返工第 5 步（R7 / P1-3 / §11.4⑥）：迁移 compaction/precompact 到新持久管线并退役旧管线。
// M2 更新：compaction/start 是「活跃会话」的上下文压缩事件（非会话结束/闲置边界），
// 因此**不再作为自动持久记忆入口**（退役自动 Phase 1 入队，满足「活跃会话不持久」）。
// 显式 memory_precompact 工具仍入队（用户主动 checkpoint）。
// 验证（行为层）：
//   ① compaction/start → 不再自动入队 stage1_jobs；旧 .pipeline-state.json / .stage1-state.json 不写。
//   ② memory_precompact → 走新队列：stage1_jobs 入队，不再写无消费者的 stage1_meta.sessions；
//      旧 .pipeline-state.json / 旧 .stage1-state.json 均不存在。
//   ③ turn/end 不再做活动水位持久写；新队列以 session+content watermark 判断新活动。
//   ④ 旧管线函数不可达：lib/index.js 源码中不再出现 runPipeline/kickPipeline/pipelinePhase1/
//      pipelinePhase2/pendingPipeline/loadPipelineState/savePipelineState/.pipeline-state.json（仅注释可留）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, metaOf } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply, contentWatermark } = await import(PLUGIN)

const eventHandlers = {}
const { ctx, domain } = makeCtx({
  get: () => undefined, // 无 sessionQuery / 无 llm：drain 读到空 raw → no_output（不烧模型）。
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
})

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-precompact-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const root = () => path.join(tmp, 'memories')
const pipelineStateFile = () => path.join(root(), '.pipeline-state.json')
const stage1StateFile = () => path.join(root(), '.stage1-state.json')

const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return false
}

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, { autoTrigger: 'sessionEnd', precompactAuto: true })
  // C4（本批授权改写）：契约 §C4 ④ 把**空监听** `session/event` 删了 ⇒ 原断言"handler registered"翻为
  //   "**未**注册"。原意（compaction/start 不自动入队 / 活跃会话不持久）在新语义下**更强地成立**：
  //   监听器根本不存在。下方用 `dispatchSessionEvent()` 做**两棵树都能跑**的派发（改前树有监听、改后树没有），
  //   行为断言（不产生 job、不写旧管线文件）**一字未改**。
  assert.ok(!eventHandlers['session/event'], 'session/event handler NOT registered (C4 删空监听后)')
  assert.ok(ctx.tools['memory_precompact'], 'memory_precompact tool registered')
  let sessionEventSeen = false
  /** 派发一次 session/event；返回是否真的存在监听器（改前树 true、改后树 false）。 */
  const dispatchSessionEvent = async (sess, ev) => {
    if (typeof eventHandlers['session/event'] !== 'function') return false
    sessionEventSeen = true
    await eventHandlers['session/event'](sess, ev)
    return true
  }

  console.log('[1] compaction/start → M2：不再自动入队（活跃会话不持久）；旧管线文件不写')
  {
    const sess = { id: 'c1', header: { cwd: 'C:/c1' }, deriveMessages: () => [] }
    const hadHandler = await dispatchSessionEvent(sess, { type: 'compaction/start' })
    check(!hadHandler, `session/event 无监听器 ⇒ compaction/start 根本没人接（改前树此处为 true）`)
    const jobs = jobListOf(domain)
    const c1Jobs = Object.values(jobs).filter((x) => x && String(x.session_id) === 'c1')
    check(c1Jobs.length === 0, 'compaction/start does NOT auto-enqueue a stage-1 job (active-session, not persisted)')
    check(!fs.existsSync(pipelineStateFile()), '.pipeline-state.json is NOT written by compaction/start')
    check(!fs.existsSync(stage1StateFile()), '.stage1-state.json is NOT written by compaction/start')
  }

  console.log('[2] memory_precompact → 新队列：stage1_jobs 入队，不写废弃 sessions 水位')
  {
    const body = 'precompact key points'
    // ⚠️ 语义变更（队长裁定 2026-10-01 · 评估 §五）：`memory_precompact` 的**提炼作业走正常 6h 静置资格**，
    //   只有 `force=true`（用户明确要求）才即时入队。本段要验的仍是"入队走新队列、不写废弃水位"，
    //   故显式带上 force；"默认不入队"的新契约由紧随其后的 [2b] 段与 t252-F 断言。
    const r = await ctx.tools.memory_precompact.execute(
      { content: body, force: true },
      { agent: { session: { id: 'p1', header: { cwd: 'C:/p1' } } } },
    )
    check(!!r.file && r.file.includes('p1'), `precompact wrote a draft (file=${r.file})`)
    check(r.sessionId === 'p1', 'precompact reports sessionId p1')
    // 会话对象无 deriveMessages → raw 退化为 body → watermark 由 body 计算。
    const key = `p1::${contentWatermark(body)}`
    const job = jobListOf(domain)[key]
    check(!!job, `memory_precompact enqueued a stage-1 job (key=${key})`)
    const meta = metaOf(domain)
    check(!meta.sessions, 'memory_precompact does not create retired stage1_meta.sessions')
    check(!fs.existsSync(pipelineStateFile()), '.pipeline-state.json is NOT written by memory_precompact')
    check(!fs.existsSync(stage1StateFile()), '.stage1-state.json is NOT written by memory_precompact')
  }

  console.log('[2b] memory_precompact 默认（模型自行调用）⇒ 草稿落、**不入队**，只留复查请求')
  {
    const r2 = await ctx.tools.memory_precompact.execute(
      { content: 'default call key points' },
      { agent: { session: { id: 'p2', header: { cwd: 'C:/p2' } } } },
    )
    check(!!r2.file && r2.file.includes('p2'), `默认调用仍**立即落草稿**（file=${r2.file}）`)
    check(Object.keys(jobListOf(domain)).filter((k) => k.startsWith('p2::')).length === 0,
      `默认调用**不入队**（改前树此处为 1 ⇒ 必红）`)
    const m2 = metaOf(domain)
    check(!!m2.idleRecheck && String(m2.idleRecheck.source || '').includes('precompact-not-qualified'),
      `只留一条复查请求（source=${m2.idleRecheck && m2.idleRecheck.source}）`)
  }

  console.log('[3] turn/end → 不写废弃会话水位')
  {
    await dispatchSessionEvent({ id: 't1', header: { cwd: 'C:/t1' } }, { type: 'turn/end' })
    const meta = metaOf(domain)
    check(!meta.sessions, 'turn/end does not create retired stage1_meta.sessions')
    check(!fs.existsSync(pipelineStateFile()), '.pipeline-state.json is NOT written by turn/end')
  }

  console.log('[4] 旧管线函数不可达（源码不再定义/调用；.pipeline-state.json 仅允许作为一次性迁移路径）')
  {
    const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    // 去掉块/行注释后，这些旧函数名不应再残留（定义或调用都不可达）。
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const banned = [
      'function runPipeline', 'async function runPipeline',
      'function kickPipeline', 'function pipelinePhase1', 'function pipelinePhase2',
      'let pendingPipeline', 'function loadPipelineState', 'function savePipelineState',
    ]
    for (const b of banned) {
      check(!noComments.includes(b), `old symbol "${b}" is absent from lib/index.js (unreachable)`)
    }
    // 旧管线读写函数名不应再以既有的调用形式出现（仅一次性迁移内读取路径可留）。
    check(!noComments.includes('loadPipelineState()'), 'no loadPipelineState() call sites remain')
    check(!noComments.includes('savePipelineState('), 'no savePipelineState() call sites remain')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PRECOMPACT-NEW-QUEUE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
