// M2 生成资格与隐私闭环测试：
//   [2] 外部工具会话整段跳过自动生成（不调 llm、不产出 output，仅 skip reason）。
//   [3] 本地工具会话不被误杀（用户决定仍可生成）。
//   [1a] generateMemories=false 时 session/disposed 不入队。
//   [1b] generateMemories 与 useMemories 均可独立设置。
//   [5] compaction/start 不再自动入队（活跃会话不持久）；显式 memory_precompact 仍可用。
// 存储访问：dsh_rollout 的 stage1_jobs / stage1_outputs / stage1_meta 表。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobBySession, outputListOf, metaOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

// ── 合法 surface event 构造（Session.create/deriveMessages 接受的真实形状）──
// user/message、assistant/message、tool/result 都是 surface 事件，必须带 surfaceOp:'append'；
// assistant/message 的 message.source 需 role+kind(model)+provider+model；
// tool/result 的 message.content 是 [ToolResultBlock]：{type:'tool-result', toolCallId, content:[{type:'text',text}]}。
const ev = (type, seq, data, surfaceOp) => ({
  type, seq, time: Date.now(),
  ...(surfaceOp ? { surfaceOp } : {}),
  data,
})
const header = (id, cwd) => ({ version: 0, id, cwd, createdAt: 0 })
const readSessionOf = (eventsFor) => async (id) => ({
  session: header(id, 'C:/' + id),
  events: typeof eventsFor === 'function' ? eventsFor(id) : (eventsFor || []),
})

// 构造一个「本地工具 + 用户决定」的合法会话（user/assistant 文本足够长，避免 <60 截断）。
const localEvents = () => ([
  ev('user/message', 0, { role: 'user', id: 'm1', content: [{ type: 'text', text: '用户明确决定：以后所有生成的目标文件都以 report_ 前缀命名，并且优先使用本地 PowerShell 处理，不需要额外确认。这是一个应当被记住的真实操作偏好。' }], source: { kind: 'user' } }, 'append'),
  ev('tool/call', 1, { turn: 0, step: 0, callId: 'c1', name: 'pwsh', arguments: '{}' }),
  ev('tool/result', 2, { turn: 0, step: 0, message: { role: 'user', id: 'tr1', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] }], source: { kind: 'tool', callId: 'c1' } } }, 'append'),
  ev('assistant/message', 3, { turn: 0, step: 0, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: '好的，我已按你的决定把目标文件命名为 report_ 前缀，并继续使用本地 PowerShell。' }], source: { kind: 'model', provider: 'test', model: 'test-model' } } }, 'append'),
])
// 构造一个「外部 web_search 工具」的合法会话。
const externalEvents = () => ([
  ev('user/message', 0, { role: 'user', id: 'm1', content: [{ type: 'text', text: '请查一下今天的新闻，用 web_search 帮我看。' }], source: { kind: 'user' } }, 'append'),
  ev('tool/call', 1, { turn: 0, step: 0, callId: 'c1', name: 'web_search', arguments: '{"queries":["today"]}' }),
  ev('tool/result', 2, { turn: 0, step: 0, message: { role: 'user', id: 'tr1', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'Sources:\n- https://example.com/news' }] }], source: { kind: 'tool', callId: 'c1' } } }, 'append'),
  ev('assistant/message', 3, { turn: 0, step: 0, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: '以下是新闻摘要。' }], source: { kind: 'model', provider: 'test', model: 'test-model' } } }, 'append'),
])

// llm spy：记录调用，返回 collectStreamText 可消费的 async iterable（不是 Promise）。
const mkLlmSpy = (state) => ({
  stream: (...args) => {
    state.streamCalled = (state.streamCalled || 0) + 1
    const json = JSON.stringify({
      rollout_summary: '用户决定：允许使用本地工具。',
      raw_memory: '允许使用本地工具',
      slug: 'm2-local-tool',
      keywords: 'local,tool',
      title: '本地工具决定',
    })
    return (async function* () {
      yield { type: 'text-delta', text: json }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
})
const mkDefaultModel = () => ({ currentSelection: () => ({ provider: 'test', model: 'test-model' }) })
const mkCtxGet = (eventsFor, llmState) => (k) => {
  if (k === 'sessionQuery') return { readSession: readSessionOf(eventsFor) }
  if (k === 'llm') return mkLlmSpy(llmState)
  if (k === 'agentDefaultModel') return mkDefaultModel()
  return undefined
}

const makeTmp = (tag) => {
  const tmp = path.join(os.tmpdir(), `dsh-memory_rollout-m2-${tag}-` + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
  process.env.DSH_HOME = tmp
  fs.mkdirSync(tmp, { recursive: true })
  return tmp
}
const cleanup = (tmp) => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }

// ─────────────────────────────────────────────────────────────────────────────
// [2] 外部工具会话（web_search）整段跳过自动生成
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log('\n[2] 外部工具会话（web_search）整段跳过自动生成')
  const tmp = makeTmp('ext')
  let llmState = {}
  const { ctx, domain } = makeCtx({ get: mkCtxGet(externalEvents, llmState), on: () => () => {} })
  try {
    await apply(ctx, { generateMemories: true })
    await seedJob(domain, 'ext1', 'wm-ext1')
    const res = await ctx.tools['memory__stage1_drain'].execute({})
    const job = jobBySession(domain, 'ext1')[0]
    check(job && job.status === 'succeeded_no_output', '外部会话以 succeeded_no_output 提交')
    check(String(job && job.last_skip_reason || '').includes('external_context'), '内部 skip reason 已记录（last_skip_reason 含 external_context）')
    check(llmState.streamCalled === undefined, '未调用 llm.stream（不烧配额）')
    check(Object.keys(outputListOf(domain)).length === 0, '未产出 stage1_outputs')
    check(metaOf(domain).modelAttemptsToday === 0, '未消耗模型预算')
    check(res.processed >= 1, 'drain 处理了该作业')
  } finally { cleanup(tmp) }
}

// ─────────────────────────────────────────────────────────────────────────────
// [3] 本地工具会话（仅本地工具 + 用户决定）不被误杀
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log('\n[3] 本地工具会话（仅本地工具 + 用户决定）仍可生成')
  const tmp = makeTmp('local')
  let llmState = {}
  const { ctx, domain } = makeCtx({ get: mkCtxGet(localEvents, llmState), on: () => () => {} })
  try {
    await apply(ctx, { generateMemories: true })
    await seedJob(domain, 'loc1', 'wm-loc1')
    await ctx.tools['memory__stage1_drain'].execute({})
    check(Object.keys(outputListOf(domain)).length >= 1, '本地工具会话产出了 stage1_outputs（未被外部名单误杀）')
    check(!!llmState.streamCalled, '调用了 llm.stream（生成了记忆）')
  } finally { cleanup(tmp) }
}

// ─────────────────────────────────────────────────────────────────────────────
// [1a] generateMemories=false 时 session/disposed 不入队
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log('\n[1a] generateMemories=false 时 session/disposed 不入队')
  const tmp = makeTmp('genoff')
  const eventHandlers = {}
  let llmState = {}
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'llm' ? mkLlmSpy(llmState) : undefined),
    on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
  })
  try {
    await apply(ctx, { generateMemories: false })
    assert.ok(eventHandlers['session/disposed'], 'session/disposed handler registered')
    const sess = { id: 's-off', header: { cwd: 'C:/' }, deriveMessages: () => [] }
    await eventHandlers['session/disposed'](sess)
    await new Promise((r) => setTimeout(r, 120))
    check(jobBySession(domain, 's-off').length === 0, '关生成不新增自动 job')
  } finally { cleanup(tmp) }
}

// ─────────────────────────────────────────────────────────────────────────────
// [1b] generateMemories / useMemories 独立设置
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log('\n[1b] generateMemories 与 useMemories 均可独立设置')
  const tmp = makeTmp('both')
  let llmState = {}
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'llm' ? mkLlmSpy(llmState) : undefined),
    on: () => () => {},
  })
  try {
    await apply(ctx, { generateMemories: true, useMemories: false })
    check(ctx.tools['memory_recall'] && typeof ctx.tools['memory_recall'].execute === 'function', 'recall 工具存在（useMemories=false 不影响生成开关存在）')
  } finally { cleanup(tmp) }
}

// ─────────────────────────────────────────────────────────────────────────────
// [5] compaction/start 不再自动入队；显式 memory_precompact 仍可用
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log('\n[5] compaction/start 不再自动入队（活跃会话不持久）')
  const tmp = makeTmp('comp')
  const eventHandlers = {}
  let llmState = {}
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'llm' ? mkLlmSpy(llmState) : undefined),
    on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
  })
  try {
    await apply(ctx, { generateMemories: true, precompactAuto: true })
    await eventHandlers['session/event']({ id: 'comp1', header: { cwd: 'C:/' }, deriveMessages: () => [] }, { type: 'compaction/start' })
    await new Promise((r) => setTimeout(r, 150))
    check(jobBySession(domain, 'comp1').length === 0, 'compaction/start 不自动入队 stage1_jobs')
    check(ctx.tools['memory_precompact'] && typeof ctx.tools['memory_precompact'].execute === 'function', '显式 memory_precompact 工具仍注册')
  } finally { cleanup(tmp) }
}

console.log(`\n${failed === 0 ? 'ALL M2 TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
