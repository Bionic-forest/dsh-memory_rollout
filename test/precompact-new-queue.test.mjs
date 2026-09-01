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
  assert.ok(eventHandlers['session/event'], 'session/event handler registered')
  assert.ok(ctx.tools['memory_precompact'], 'memory_precompact tool registered')

  console.log('[1] compaction/start → M2：不再自动入队（活跃会话不持久）；旧管线文件不写')
  {
    const sess = { id: 'c1', header: { cwd: 'C:/c1' }, deriveMessages: () => [] }
    await eventHandlers['session/event'](sess, { type: 'compaction/start' })
    const jobs = jobListOf(domain)
    const c1Jobs = Object.values(jobs).filter((x) => x && String(x.session_id) === 'c1')
    check(c1Jobs.length === 0, 'compaction/start does NOT auto-enqueue a stage-1 job (active-session, not persisted)')
    check(!fs.existsSync(pipelineStateFile()), '.pipeline-state.json is NOT written by compaction/start')
    check(!fs.existsSync(stage1StateFile()), '.stage1-state.json is NOT written by compaction/start')
  }

  console.log('[2] memory_precompact → 新队列：stage1_jobs 入队，不写废弃 sessions 水位')
  {
    const body = 'precompact key points'
    const r = await ctx.tools.memory_precompact.execute(
      { content: body },
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

  console.log('[3] turn/end → 不写废弃会话水位')
  {
    await eventHandlers['session/event']({ id: 't1', header: { cwd: 'C:/t1' } }, { type: 'turn/end' })
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
