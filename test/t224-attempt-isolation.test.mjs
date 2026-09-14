// t224：真机验收（t223）四条发现的最小验证集
//   F1【高】会话 id 与尝试解耦 —— 真机实测同一批第 2 次尝试撞名（`session "p2-exec-<batch>" already exists`）
//           ⇒ 受限路径对**任何重试**永久不可用。本测试用"重名即抛"的假 agents 服务复现该主机行为。
//   F2【低】成功提交后清掉批级 `last_error`（转存 `last_error_history`），不再把上一轮的错串误读成本轮失败。
//   F3【中】基线里的 slug 短名在**重整合时被纠正为真实路径**（t216 的 alias 索引修复）。
//   F4【低】失败尝试留下的空 `attempt-*` 目录被清理。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, setMeta } from './lib/helpers.mjs'

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t224-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const M = await import(PLUGIN)
const { apply, buildReferenceMap, renderPhase2References } = M

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const REG = {}
const regTools = { register: (t) => { if (t && t.name) REG[t.name] = t } }
const root = () => path.join(HOME, 'memories')
const section = async (label, fn) => {
  try { return await fn() } catch (err) {
    check(false, `${label} 中断（改前树上属预期的断言级红）：${err && err.message ? err.message : err}`)
  }
}
const draftsDir = () => path.join(root(), 'rollout_summaries')
const writeDraft = (sid) => {
  fs.mkdirSync(draftsDir(), { recursive: true })
  fs.writeFileSync(path.join(draftsDir(), sid + '.md'), `session_id: ${sid}\ncwd: D:/x\n\n# 会话草稿\n- durable\n`, 'utf8')
}

/** 假 agents 服务：**重名即抛**（复现真机 `session "…" already exists`）。 */
function makeFakeAgents(opts = {}) {
  const state = { created: [], followups: [], cancelled: 0, disposed: 0, turns: 0 }
  const service = {
    create: async ({ sessionId, meta, setup }) => {
      if (opts.throwOnCreate) throw new Error(String(opts.throwOnCreate))
      // 真机行为：同一个 sessionId 建第二次 ⇒ 抛 "already exists"
      if (state.created.some((c) => c.sessionId === sessionId)) {
        throw new Error(`session "${sessionId}" already exists`)
      }
      state.created.push({ sessionId, meta })
      if (typeof setup === 'function') setup({ tools: { restrict: () => {} } })
      const evs = []
      const agent = {
        id: sessionId,
        status: { state: 'idle', turns: state.turns },
        session: { append: () => {}, events: () => evs },
        cancel: () => { state.cancelled++ },
        followup: (msg) => {
          state.followups.push({ sessionId, msg })
          state.turns++
          const text = String((msg && msg.content && msg.content[0] && msg.content[0].text) || '')
          const mm = text.match(/([A-Za-z]:\\[^\n"]*?\.json|\/[^\n"]*?\.json)/)
          if (mm) {
            // 第 1 次尝试故意给**不可解析/空**的产物（逼出一次失败重试），第 2 次给合法产物。
            const payload = state.turns === 1
              ? JSON.stringify({ memory_summary: '', registry: '' })
              : JSON.stringify({ memory_summary: 'v1\n## t224-retry-ok', registry: '# MEMORY.md\nt224-retry-ok' })
            try { fs.mkdirSync(path.dirname(mm[1]), { recursive: true }); fs.writeFileSync(mm[1], payload) } catch {}
            evs.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: payload }] } })
          }
        },
        whenIdle: async () => { await new Promise((r) => setTimeout(r, 5)) },
      }
      return { agent, dispose: async () => { state.disposed++ } }
    },
  }
  return { state, service }
}

const makeLlm = (counters, payloadFor) => ({
  stream: (o) => {
    if (o && String(o.system).includes('memory-extraction')) {
      return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    }
    counters.inProcess++
    const payload = JSON.stringify(payloadFor(counters.inProcess))
    return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  },
})
const mkCtx = (getFn) => makeCtx({ get: getFn, tools: regTools })
const jobsOf = (domain) => [...domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v }))
const readCurrent = () => { try { return JSON.parse(fs.readFileSync(path.join(root(), 'current.json'), 'utf8')) } catch { return null } }
const verFile = (v, f) => { try { return fs.readFileSync(path.join(root(), 'versions', v, f), 'utf8') } catch { return '' } }
const past = new Date(Date.now() - 120000).toISOString()
const putPhase2Job = (domain, id, over = {}) => domain.table('phase2_jobs').put(id, {
  id, status: 'pending', input_ids: [], change_ids: [], mode: 'normal', lease_owner: '', lease_expires_at: '',
  attempt_count: 0, max_attempts: 3, available_at: past, staging_version: '', last_error: '',
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
})
/** 把某批再次变成"可领取"（模拟退避到期）。 */
const makeRunnable = async (domain, id) => {
  await domain.table('phase2_jobs').update(id, (cur) => ({ ...cur, available_at: past }))
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
}

// ─────────────────────────────────────────────────────────────────────────────
// F1 + F2：同一批两次尝试 —— 会话 id 不同、第二次不再 already exists；成功后清 last_error
// ─────────────────────────────────────────────────────────────────────────────
await section('[F1/F2]', async () => {
  console.log('\n[F1] 同一批两次尝试：会话 id 与尝试解耦（真机撞名不得再现）')
  const SID = '9c0c360d-3aad-4886-a876-4597f688be81'
  writeDraft(SID)
  const counters = { inProcess: 0 }
  const fa = makeFakeAgents()
  const { ctx, domain } = mkCtx((k) => (k === 'agents' ? fa.service
    // 进程内回落**也要**在第 1 次失败（否则批第一次就提交了，逼不出"同一批第二次尝试"）
    : k === 'llm' ? makeLlm(counters, (n) => (n === 1
      ? { memory_summary: '', registry: '' }
      : { memory_summary: 'v1\n## t224-inprocess', registry: '# MEMORY.md\nt224-inprocess' }))
      : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined))
  await apply(ctx, {})
  await seedOutput(domain, 'o-t224', { session_id: SID, source_watermark: 'wm-t224', rollout_summary: 't224 fact', generated_at: past })
  await putPhase2Job(domain, 'B224', { input_ids: ['o-t224'] })
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })

  // ── 尝试 1：受限会话起了一轮，但产物不合法 ⇒ 批失败（retry_wait），并留下批级 last_error ──
  await REG['memory__phase2_integrate'].execute({})
  const j1 = jobsOf(domain).find((j) => j.id === 'B224') || {}
  check(fa.state.created.length === 1, `尝试 1 建了 1 个会话（实测 ${fa.state.created.length}）`)
  check(j1.status === 'retry_wait' && Number(j1.attempt_count) === 1, `尝试 1 后批进 retry_wait 且 attempt_count=1（实测 ${j1.status}/${j1.attempt_count}）`)
  check(String(j1.last_error || '').includes('memory_summary'), `尝试 1 留下批级 last_error（"${String(j1.last_error || '').slice(0, 60)}…"）`)
  const sid1 = String((fa.state.followups[0] || {}).sessionId || '')

  // ── 尝试 2：退避到期后重跑**同一个批** ──
  await makeRunnable(domain, 'B224')
  await REG['memory__phase2_integrate'].execute({})
  const j2 = jobsOf(domain).find((j) => j.id === 'B224') || {}
  const sid2 = String((fa.state.followups[1] || {}).sessionId || '')
  check(fa.state.created.length === 2, `尝试 2 又建了 1 个会话（未被"已存在"挡住；实测 created=${fa.state.created.length}）`)
  check(sid1 !== '' && sid2 !== '' && sid1 !== sid2, `两次尝试的 sessionId 不同（"${sid1}" ≠ "${sid2}"）`)
  check(sid1.startsWith('p2-exec-B224-') && sid2.startsWith('p2-exec-B224-'),
    '两个会话 id 都带同一批前缀 + 各自的尝试标记')
  check(!String(j2.executor_reason || '').includes('already exists'),
    `尝试 2 **不再**出现 already exists（executor_reason="${String(j2.executor_reason || '').slice(0, 70)}"）`)
  check(j2.executor_path === 'restricted-session', `尝试 2 真的走了受限路径（executor_path=${j2.executor_path}）`)
  check(String(j2.executor_session_id) === sid2, `批记录记的是本次尝试的会话（record=${String(j2.executor_session_id).slice(0, 40)}…）`)

  // ── 产物路径与"尝试"对应（与 t220「每次尝试独立产物路径」自洽） ──
  const outOf = (m) => { const t = String((m && m.content && m.content[0] && m.content[0].text) || ''); const x = t.match(/([A-Za-z]:\\[^\n"]*?\.json)/); return x ? x[1] : '' }
  const p1 = outOf((fa.state.followups[0] || {}).msg)
  const p2 = outOf((fa.state.followups[1] || {}).msg)
  check(p1 !== '' && p2 !== '' && p1 !== p2, '两次尝试的产物路径不同（attempt 标记隔离）')
  check(/attempt-\d+-[0-9a-f]{6}/.test(p1) && /attempt-\d+-[0-9a-f]{6}/.test(p2), '产物路径里带各自 attempt 标记')

  console.log('\n[F2] 成功提交后：批级 last_error 清空、历史转存')
  check(j2.status === 'committed', `尝试 2 已提交（status=${j2.status}）`)
  check(String(j2.last_error || '') === '', `提交后批级 last_error 已清空（实测 "${String(j2.last_error || '')}"）`)
  check(String(j2.last_error_history || '').includes('memory_summary'), `被清的值转存 last_error_history（"${String(j2.last_error_history || '').slice(0, 60)}…"）`)
  check(!fs.existsSync(path.join(root(), '.consolidation-out')), '[F4] 候选工作区已随批收尾清理（`.consolidation-out` 不复存在）')
})

// ─────────────────────────────────────────────────────────────────────────────
// F3：基线里的 slug 短名在重整合时被纠正为真实路径
// ─────────────────────────────────────────────────────────────────────────────
await section('[F3-unit]', async () => {
  console.log('\n[F3] slug 短名 → 真实路径（单元级：别名必须接回条目）')
  const S = '244024df-5fbf-4ea9-8671-c8d9183fed20'
  writeDraft(S)
  const sources = [
    { session_id: S, rollout_slug: 'slug-a' },      // 本批输入的 slug
    { session_id: S, rollout_slug: 'legacy-slug' }, // 基线里出现的**另一个** slug（同一会话）
  ]
  const map = buildReferenceMap({
    memoryRoot: root(),
    inputs: [{ session_id: S, source_watermark: 'wm', rollout_slug: 'slug-a' }],
    sources,
    baselineTexts: ['v1\n- 旧结论 → memories/rollout_summaries/legacy-slug.md'],
  })
  check(map.entries.length === 1, `同一会话只产生一个条目（实测 ${map.entries.length}）`)
  check(!!map.byAlias.get('slug-a'), '本批输入的 slug 可解析')
  check(!!map.byAlias.get('legacy-slug'), '**基线里的旧 slug 也接回了条目**（F3 的修法点）')
  const r = renderPhase2References('v1\n- 旧结论 → memories/rollout_summaries/legacy-slug.md', map)
  check(r.text === `v1\n- 旧结论 → memories/rollout_summaries/${S}.md`, `渲染为真实路径（实测 ${r.text.split('→ ')[1]}）`)
  check(r.unverified.length === 0, `不再落成 unverified（实测 ${r.unverified.length}）`)
})

await section('[F3-e2e]', async () => {
  console.log('\n[F3-e2e] 端到端：注册表里的 slug 短名在发布时被纠正')
  const S = '244024df-5fbf-4ea9-8671-c8d9183fed20'
  writeDraft(S)
  const counters = { inProcess: 0 }
  const fa = makeFakeAgents()
  // 假会话把"模型输出"原样写进产物文件：含一条**基线里才有的** slug 指针
  const origFollowup = fa.service.create
  void origFollowup
  const { ctx, domain } = mkCtx((k) => (k === 'agents'
    ? { create: async (o) => {
        const h = await fa.service.create(o)
        const inner = h.agent.followup
        h.agent.followup = (msg) => {
          const text = String((msg && msg.content && msg.content[0] && msg.content[0].text) || '')
          const mm = text.match(/([A-Za-z]:\\[^\n"]*?\.json)/)
          // 关键：产物里带的是**旧 slug**（不是真实会话号）
          const payload = JSON.stringify({ memory_summary: 'v1\n## 索引\n- 旧结论 → memories/rollout_summaries/legacy-slug.md', registry: '# MEMORY.md\n- 旧结论 → memories/rollout_summaries/legacy-slug.md' })
          if (mm) { try { fs.mkdirSync(path.dirname(mm[1]), { recursive: true }); fs.writeFileSync(mm[1], payload) } catch {} }
          fa.state.followups.push({ sessionId: o.sessionId, msg })
          fa.state.turns++
          h.agent.session.events() // no-op
        }
        return h
      } }
    : k === 'llm' ? makeLlm(counters, () => ({ memory_summary: 'v1\n## t224-inprocess', registry: '# MEMORY.md\nt224-inprocess' }))
      : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined))
  await apply(ctx, {})
  // 先放一份"含旧 slug 指针"的当前权威版本（= 基线）
  const vd = path.join(root(), 'versions', 'p2-base-t224')
  fs.mkdirSync(vd, { recursive: true })
  fs.writeFileSync(path.join(vd, 'memory_summary.md'), 'v1\n- 旧结论 → memories/rollout_summaries/legacy-slug.md', 'utf8')
  fs.writeFileSync(path.join(vd, 'MEMORY.md'), '# MEMORY.md\n- 旧结论 → memories/rollout_summaries/legacy-slug.md', 'utf8')
  fs.writeFileSync(path.join(vd, 'manifest.json'), JSON.stringify({ version: 'p2-base-t224', summary_sha256: '', registry_sha256: '' }), 'utf8')
  fs.writeFileSync(path.join(root(), 'current.json'), JSON.stringify({ version: 'p2-base-t224' }), 'utf8')
  // 记录：让 legacy-slug 能由**插件记录**解析到 S（唯一）
  await seedOutput(domain, 'o-base-slug', { session_id: S, source_watermark: 'wm-base', rollout_slug: 'legacy-slug', rollout_summary: 'base', selected_for_phase2: true, generated_at: past })
  await seedOutput(domain, 'o-new', { session_id: S, source_watermark: 'wm-new', rollout_slug: 'slug-a', rollout_summary: 'new', generated_at: past })
  await putPhase2Job(domain, 'B224b', { input_ids: ['o-new'] })
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  await REG['memory__phase2_integrate'].execute({})
  const cur = readCurrent()
  const reg = cur ? verFile(cur.version, 'MEMORY.md') : ''
  const sum = cur ? verFile(cur.version, 'memory_summary.md') : ''
  check(cur && cur.version !== 'p2-base-t224', `本批已发布新版本（${cur && cur.version}）`)
  check(reg.includes(`memories/rollout_summaries/${S}.md`), '发布的注册表里旧 slug 已被**纠正为真实路径**')
  check(!reg.includes('legacy-slug') && !reg.includes('未验证引用'), '注册表里**没有**残留 slug 短名、也没有「未验证引用」标记')
  check(sum.includes(`memories/rollout_summaries/${S}.md`), '发布的总结里同样是真实路径')
})

// ─────────────────────────────────────────────────────────────────────────────
// F4：执行者建不起来（会话创建抛错）⇒ 不留下空 attempt 目录
// ─────────────────────────────────────────────────────────────────────────────
await section('[F4]', async () => {
  console.log('\n[F4] 失败尝试不留空 attempt 目录')
  const S = '9c0c360d-3aad-4886-a876-4597f688be81'
  writeDraft(S)
  const counters = { inProcess: 0 }
  const fa = makeFakeAgents({ throwOnCreate: 'boom (simulated host rejection)' })
  const { ctx, domain } = mkCtx((k) => (k === 'agents' ? fa.service
    : k === 'llm' ? makeLlm(counters, () => ({ memory_summary: 'v1\n## t224-inprocess', registry: '# MEMORY.md\nt224-inprocess' }))
      : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined))
  await apply(ctx, {})
  await seedOutput(domain, 'o-t224c', { session_id: S, source_watermark: 'wm-c', rollout_summary: 'c', generated_at: past })
  await putPhase2Job(domain, 'B224c', { input_ids: ['o-t224c'] })
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  await REG['memory__phase2_integrate'].execute({})
  const j = jobsOf(domain).find((x) => x.id === 'B224c') || {}
  check(String(j.executor_reason || '').includes('executor-start-failed'), `会话建不起来 ⇒ 记录明确原因（"${String(j.executor_reason || '').slice(0, 60)}…"）`)
  const ws = path.join(root(), '.consolidation-out')
  const leftovers = fs.existsSync(ws) ? fs.readdirSync(ws, { recursive: true }).length : 0
  check(leftovers === 0, `失败尝试**没有**留下任何候选目录（实测残项 ${leftovers}）`)
})

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n${failed === 0 ? 'ALL T224 ATTEMPT-ISOLATION TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
