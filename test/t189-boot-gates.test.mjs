// t189：② 两道启动门槛（抄 codex）+ 启动顺序 + 「只对根会话生成」。
//
// 为什么这样测：
//   - 门槛一「一次启动最多 N 个来源」：**行为级**在真实启动路径上观察（启动前播种 3 条到期来源，
//     启动后统计"被处理过"的条数 ≤ N，且至少一条仍未被碰）；再用 `maxSourcesPerStartup: 3` 证明可配置。
//   - 门槛二「额度剩余 <25% 不启动新整合」：纯函数断言**边界**（恰好 25% 放行 / 低于 25% 拦），
//     再在真实启动路径上观察"额度耗尽 ⇒ 一次整合 LLM 都没跑、批仍 pending"，以及"额度够 ⇒ 正常整合"。
//   - 显式工具 `memory__phase2_integrate` **绕过**该门（只拦自动路径）。
//   - 「只对根会话生成」：捕获 `session/disposed` 处理器，分别投喂根会话与非根会话（带 parentSession）。
// 靶目录一律 `os.tmpdir()`（不指向真实记忆根）；测试后清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedJob, seedOutput, setMeta, jobBySession, jobListOf } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const m = await import(PLUGIN)
const { apply } = m
// 改前树上没有这些导出：用安全包装，让"缺导出"表现为**断言红**而不是中途崩溃（牙齿要红在断言上）。
const bootQuotaPlan = typeof m.bootQuotaPlan === 'function' ? m.bootQuotaPlan : null
const isRootSessionHeader = typeof m.isRootSessionHeader === 'function' ? m.isRootSessionHeader : null
const DEFAULT_MAX_SOURCES_PER_STARTUP = m.DEFAULT_MAX_SOURCES_PER_STARTUP

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-t189-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return false
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 本地日 key（与插件 `dayKey()` 同口径：本地 YYYY-MM-DD）。 */
const localDayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

let consolidationCalls = 0
const llmMock = {
  stream: (opts) => {
    const isExtract = opts && String(opts.system).includes('memory-extraction')
    if (isExtract) return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    consolidationCalls++
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: JSON.stringify({ memory_summary: 'v1\n## t189 ok', registry: '# MEMORY.md\nt189 ok' }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

const newCtx = ({ handlers } = {}) => {
  const tools = {}
  const { ctx, domain } = makeCtx({
    get: (k) =>
      k === 'llm'
        ? llmMock
        : k === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : undefined,
    tools: { register: (t) => { tools[t.name] = t } },
    ...(handlers ? { on: (ev, cb) => { handlers[ev] = cb; return () => {} } } : {}),
  })
  const home = path.join(tmp, 'h-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  return { ctx, domain, tools, root: () => path.join(home, 'memories') }
}
const putPhase2Job = (domain, id, over = {}) =>
  domain.table('phase2_jobs').put(id, {
    id, status: 'pending', input_ids: [], change_ids: [], lease_owner: '', lease_expires_at: '',
    attempt_count: 0, max_attempts: 3, available_at: new Date().toISOString(), staging_version: '',
    last_error: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
  })
const past = new Date(Date.now() - 120000).toISOString()
/** "被处理过"的来源：离开 pending，或至少被领取过一次。 */
const touchedCount = (domain) =>
  Object.values(jobListOf(domain)).filter((j) => j && (j.status !== 'pending' || (j.attempt_count || 0) > 0)).length

try {
  // ── T1：额度门纯函数边界（抄 codex：已用% ≤ 100−阈值 ⇒ 放行） ─────────────
  console.log('[T1] bootQuotaPlan：恰好 25% 放行 / 低于 25% 拦 / 阈值可配')
  {
    const ok = bootQuotaPlan ? bootQuotaPlan({ attemptsToday: 18, maxAttemptsPerDay: 24, minRemainingPercent: 25 }) : null
    check(ok && ok.allowed === true, `恰好 25% 剩余 ⇒ 放行（实测 ${ok && ok.allowed}，remaining=${ok && ok.remainingPercent}）`)
    const low = bootQuotaPlan ? bootQuotaPlan({ attemptsToday: 19, maxAttemptsPerDay: 24, minRemainingPercent: 25 }) : null
    check(low && low.allowed === false && low.reason === 'quota-below-threshold',
      `低于 25%（20.8% 剩余）⇒ 拦，原因 quota-below-threshold（实测 ${low && low.reason}）`)
    const zero = bootQuotaPlan ? bootQuotaPlan({ attemptsToday: 24, maxAttemptsPerDay: 24, minRemainingPercent: 0 }) : null
    check(zero && zero.allowed === true, `阈值配成 0 ⇒ 额度用尽也放行（实测 ${zero && zero.allowed}）`)
    const full = bootQuotaPlan ? bootQuotaPlan({ attemptsToday: 1, maxAttemptsPerDay: 24, minRemainingPercent: 100 }) : null
    check(full && full.allowed === false, `阈值配成 100 ⇒ 只要用过额度就拦（实测 ${full && full.allowed}）`)
    check(m.DEFAULT_MAX_SOURCES_PER_STARTUP === 2, `默认每启动来源上限 N=2（抄 codex；实测 ${m.DEFAULT_MAX_SOURCES_PER_STARTUP}）`)
  }

  // ── T2：「只对根会话生成」判据 ─────────────────────────────────────────────
  console.log('[T2] isRootSessionHeader：非根会话识别 + 未知血缘保守放行')
  {
    const f = isRootSessionHeader
    check(f && f({}) === true, '空头 ⇒ 视为根会话（放行）')
    check(f && f(null) === true, '无头 ⇒ 视为根会话（保守：不因读不到血缘停掉生成）')
    check(f && f({ parentSession: 'p1' }) === false, 'parentSession ⇒ 非根（跳过）')
    check(f && f({ origin: 'subagent' }) === false, 'origin=subagent ⇒ 非根（跳过）')
    check(f && f({ delegationDepth: 2 }) === false, 'delegationDepth>0 ⇒ 非根（跳过）')
    check(f && f({ delegationDepth: 0 }) === true, 'delegationDepth=0 ⇒ 根会话')
  }

  // ── T3：门槛一 · 启动来源上限（行为级，含可配置） ─────────────────────────
  console.log('[T3] 启动一趟最多处理 N=2 个来源（第 3 个留给后续趟次）')
  {
    const { ctx, domain } = newCtx()
    for (const sid of ['s-a', 's-b', 's-c']) await seedJob(domain, sid, 'wm-' + sid, { availableAt: past })
    await apply(ctx, {})
    await sleep(500)
    const touched = touchedCount(domain)
    check(touched <= DEFAULT_MAX_SOURCES_PER_STARTUP,
      `启动这一趟处理的来源数 ${touched} ≤ N=${DEFAULT_MAX_SOURCES_PER_STARTUP}（改前会 3 条全处理 ⇒ 该断言在还原口树上必红）`)
    check(touched >= 1, `确实处理了东西（实测 ${touched}）`)
    check(Object.values(jobListOf(domain)).length - touched >= 1, `仍有来源留在队列里等后续趟次（未丢）`)
  }
  {
    const { ctx, domain } = newCtx()
    for (const sid of ['s-x', 's-y', 's-z']) await seedJob(domain, sid, 'wm-' + sid, { availableAt: past })
    await apply(ctx, { maxSourcesPerStartup: 3 })
    await sleep(500)
    check(touchedCount(domain) === 3, `上限配成 3 ⇒ 一趟处理完 3 条（实测 ${touchedCount(domain)}；证明可配置）`)
  }

  // ── T4：门槛二 · 额度门（行为级） ──────────────────────────────────────────
  console.log('[T4] 额度耗尽 ⇒ 不启动新整合（0 次整合 LLM）；额度够 ⇒ 正常整合')
  {
    const { ctx, domain, root } = newCtx()
    await apply(ctx, {})
    await seedOutput(domain, 'o-gate', { source_watermark: 'wm-gate', session_id: 's-gate', rollout_summary: 'g', phase2_batch_id: 'B-gate', selected_for_phase2: false, generated_at: past })
    await putPhase2Job(domain, 'B-gate', { status: 'pending', input_ids: ['o-gate'], available_at: past })
    await setMeta(domain, { runDay: localDayKey(), modelAttemptsToday: 24, lastSuccessWatermark: '', lastPhase2At: '', phase2_last_error: '' })
    consolidationCalls = 0
    // t189 启动顺序证据：把"死数据"（退役的 .pipeline-state.json）放进记忆根 ⇒ 启动应当**先 prune 掉它**，
    //   而同一趟里额度门仍然拦住整合 —— 一个 pass 同时证明"清理先发生"与"门在清理之后判"。
    fs.mkdirSync(root(), { recursive: true })
    const legacy = path.join(root(), '.pipeline-state.json')
    fs.writeFileSync(legacy, '{"legacy":true}')
    await apply(ctx, {})
    await sleep(700)
    check(!fs.existsSync(legacy), '启动顺序：遗留状态文件已先被 prune（清理先于门）')
    check(fs.readdirSync(root()).some((f) => f.startsWith('.pipeline-state.json.bak-pstate-')), 'prune 是"归档"而非删除（归档文件在）')
    check(consolidationCalls === 0, `额度耗尽 ⇒ 一次整合 LLM 都没跑（实测 ${consolidationCalls}）`)
    const job = domain.table('phase2_jobs').get('B-gate')
    check(!!job && job.status === 'pending', `批仍停在队列里等额度恢复（status=${job && job.status}）`)
  }
  {
    const { ctx, domain } = newCtx()
    await apply(ctx, {})
    await seedOutput(domain, 'o-gate2', { source_watermark: 'wm-gate2', session_id: 's-gate2', rollout_summary: 'g2', phase2_batch_id: 'B-gate2', selected_for_phase2: false, generated_at: past })
    await putPhase2Job(domain, 'B-gate2', { status: 'pending', input_ids: ['o-gate2'], available_at: past })
    await setMeta(domain, { runDay: localDayKey(), modelAttemptsToday: 17, lastSuccessWatermark: '', lastPhase2At: '', phase2_last_error: '' }) // 剩余 29.2% ≥ 25%
    consolidationCalls = 0
    await apply(ctx, {})
    const done = await waitUntil(() => {
      const j = domain.table('phase2_jobs').get('B-gate2')
      return j && j.status === 'committed'
    }, 2500)
    check(done === true, `剩余 29.2% ≥ 阈值 ⇒ 自动整合照跑并提交（实测 ${done}）`)
  }

  // ── T5：显式工具绕过额度门（只拦自动路径） ────────────────────────────────
  console.log('[T5] 显式 memory__phase2_integrate 不受额度门限制')
  {
    const { ctx, domain, tools } = newCtx()
    await apply(ctx, {})
    await seedOutput(domain, 'o-man', { source_watermark: 'wm-man', session_id: 's-man', rollout_summary: 'm', phase2_batch_id: 'B-man', selected_for_phase2: false, generated_at: past })
    await putPhase2Job(domain, 'B-man', { status: 'pending', input_ids: ['o-man'], available_at: past })
    await setMeta(domain, { runDay: localDayKey(), modelAttemptsToday: 24, lastSuccessWatermark: '', lastPhase2At: '', phase2_last_error: '' })
    consolidationCalls = 0
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r && r.ran === true, `显式整合仍被放行（ran=${r && r.ran} reason=${r && r.reason}）`)
  }

  // ── T6：「只对根会话生成」（行为级：真实 session/disposed 处理器） ─────────
  console.log('[T6] session/disposed：根会话入队、非根会话不入队')
  {
    const handlers = {}
    const { ctx, domain } = newCtx({ handlers })
    await apply(ctx, {})
    const live = (id, extra = {}) => ({
      id,
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 't189 probe ' + 'x'.repeat(80) }] }],
      ...extra,
    })
    const onDisposed = handlers['session/disposed']
    check(typeof onDisposed === 'function', '捕获到 session/disposed 处理器')
    if (typeof onDisposed === 'function') {
      await onDisposed(live('s-root-189'))
      check(jobBySession(domain, 's-root-189').length >= 1, '根会话 ⇒ 入队为提炼来源')
      await onDisposed(live('s-sub-189', { header: { parentSession: 'p-189' } }))
      check(jobBySession(domain, 's-sub-189').length === 0, '非根会话（parentSession）⇒ 不入队（对齐 codex 只对根会话生成）')
      await onDisposed(live('s-sub-depth', { header: { delegationDepth: 1 } }))
      check(jobBySession(domain, 's-sub-depth').length === 0, '非根会话（delegationDepth=1）⇒ 不入队')
    }
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T189 BOOT-GATE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
