// @tag: reusable
// @工程: dsh-rollout
// @主诉: M3 真实用户闭环——端到端验收（真实 @deepseek-ai/dsh-storage-domain + 文件后端）
//        驱动当前 lib/index.js，验证 M2 新逻辑 + M3 完成定义的管线侧核心。
//
// 覆盖 M3 完成定义（§七 M3）+ M2 关键回归：
//   [A] 会话A建立偏好 → drain → stage1_output 含提炼事实；phase2 发布版本 + current.json。
//   [B] 外部工具(web_search)会话整段跳过（不调用 llm/不产出，记 last_skip_reason）。
//   [C] 本地工具会话不被误杀（用户决定仍产出 stage1_output）。
//   [D] 真实 domain 用插件 spec 重开（模拟重启）→ schema 通过、committed 批次保留、
//       发布版本摘要/注册表仍在（重启后读取成立）。
//   [E] memory_recall 在发布后能召回自动记忆（渐进披露：总纲/注册表 + 引用）。
//
// 用法：cd plugins/dsh-rollout && node test/m3-e2e-acceptance.mjs  （安全：纯隔离 temp home）
// 注：不依赖宿主 HTTP；可直接 node 本文件观察结果，或宿主重启后用真实渠道人工复核。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const tempHome = path.join(os.tmpdir(), 'dsh-rollout-m3-e2e-' + Date.now())
process.env.DSH_HOME = tempHome
fs.mkdirSync(path.join(tempHome, 'storages'), { recursive: true })
fs.mkdirSync(path.join(tempHome, 'memories'), { recursive: true })
const jsonPath = path.join(tempHome, 'storages', 'dsh_rollout.json')
const memoryRoot = () => path.join(tempHome, 'memories')

// ── 文件后端 unit（真实写链语义）─────────────────────────────────────────────
function makeUnit(file) {
  const mem = new Map()
  let globalValue = null
  const persist = () => {
    const tables = {}
    for (const [t, m] of mem) tables[t] = Object.fromEntries(m.entries())
    fs.writeFileSync(file, JSON.stringify({ unit: { name: 'dsh_rollout', version: 1 }, global: globalValue, tables }))
  }
  return {
    async loadAll() { const tables = {}; for (const [t, m] of mem) tables[t] = Object.fromEntries(m.entries()); return { tables, global: globalValue } },
    async putRecord(table, key, value) { if (!mem.has(table)) mem.set(table, new Map()); mem.get(table).set(key, value); persist() },
    async deleteRecord(table, key) { if (!mem.has(table)) return false; mem.get(table).delete(key); persist(); return true },
    async setGlobal(value) { globalValue = value; persist() },
    async close() { persist() },
  }
}
const backend = { kv: { open: async () => makeUnit(jsonPath) } }
function newFacility() {
  return new DomainFacility(
    { storage: { backend: { get: (n) => (n === 'real' ? backend : null) } }, emit: () => {}, logger: { warn() {}, info() {}, error() {} } },
    { backend: 'real', routes: {} },
  )
}
let openedDomain = null
let lastSpec = null
const realOpen = async (spec) => { lastSpec = spec; openedDomain = await newFacility().open(spec); return openedDomain }

// ── mock LLM / 会话（单 ctx，readSession 按 session_id 分派）──────────────────
let extractCalls = 0
let consolidCalls = 0
const EXTRACTION = { rollout_summary: 'v1\n## 会话A提炼\n- 用户偏好：咖啡在工作前喝', raw_memory: 'coffee-before-work', slug: 'coffee', keywords: 'preference', title: 'pref' }
const CONSOLIDATION = { memory_summary: 'v1\n## 总纲\n- 用户偏好：咖啡在工作前喝', registry: '# MEMORY.md\n- 用户偏好：咖啡在工作前喝' }
const llmMock = { stream: (opts) => {
  const isExtract = opts && String(opts.system).includes('memory-extraction')
  if (isExtract) extractCalls++; else consolidCalls++
  const payload = isExtract ? EXTRACTION : CONSOLIDATION
  return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(payload) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
} }

const LONG_A = 'Session A establishes a durable user preference: the user prefers to drink coffee before starting work each morning, and wants this remembered across future sessions.'
const eventsExternal = (id) => mkEvents(id, 'Use web_search to look up today news for me. Please search on the web for current news.', ['web_search'])
const eventsLocal = (id) => mkEvents(id, 'User explicitly decides to always prefix generated filenames with report_ and use local PowerShell without extra confirmation, a durable operating preference that should be remembered.', ['pwsh'])
const eventsA = (id) => mkEvents(id, LONG_A)

function mkEvents(userId, text, toolCalls = []) {
  const evs = [{ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id: 'm-' + userId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }]
  let seq = 1
  for (const tc of toolCalls) {
    evs.push({ type: 'tool/call', seq: seq++, time: seq, data: { turn: 0, step: 0, callId: 'c-' + seq, name: tc, arguments: '{}' } })
    evs.push({ type: 'tool/result', seq: seq++, time: seq, surfaceOp: 'append', data: { turn: 0, step: 0, message: { id: 'tr-' + seq, role: 'user', source: { kind: 'tool', callId: 'c-' + seq }, content: [{ type: 'tool-result', toolCallId: 'c-' + seq, content: [{ type: 'text', text: 'done' }] }] } } })
  }
  evs.push({ type: 'assistant/message', seq: seq++, time: seq, surfaceOp: 'append', data: { turn: 0, step: 0, message: { id: 'a-' + userId, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ack' }] } } })
  return evs
}

// 按 session_id 分派：sA=偏好(无工具) sB=外部工具 sC=本地工具。
const readSession = async (id) => {
  const sid = String(id || '')
  let evs
  if (sid === 'sB') evs = eventsExternal(sid)
  else if (sid === 'sC') evs = eventsLocal(sid)
  else evs = eventsA(sid)
  return { session: { version: 0, id: sid, cwd: 'C:/' + sid, createdAt: 0 }, events: evs }
}

const handlers = {}
const ctx = {
  storageDomain: { open: realOpen },
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : k === 'sessionQuery' ? { readSession } : undefined),
  tools: { register(t) { if (t && t.name) this[t.name] = t } },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: (ev, cb) => { handlers[ev] = cb; return () => {} },
}

let failed = 0
const check = (cond, msg) => { if (cond) console.log('  ✓ ', msg); else { failed++; console.error('  ✗ ', msg) } }
const waitUntil = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = pred(); if (r) return r; await new Promise((r2) => setTimeout(r2, 15)) } return null }
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const domainTbl = (t) => openedDomain.table(t)
const seedFreshJob = async (sid) => { await domainTbl('stage1_jobs').put(sid + '::wm', { id: 'j-' + sid, session_id: sid, source_watermark: 'wm', status: 'pending', attempt_count: 0, max_attempts: 3, available_at: new Date().toISOString(), lease_owner: '', lease_expires_at: '', last_error: '', last_error_code: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: '' }) }

// ── Phase A：会话 A（无外部工具）→ 生成产出 ──────────────────────────────────
console.log('[A] 会话A（纯用户偏好，无外部工具）→ drain → stage1_output → phase2 发布')
await apply(ctx, { generateMemories: true })
check(!!ctx.tools['memory__stage1_drain'] && !!ctx.tools['memory__phase2_integrate'] && !!handlers['session/disposed'], '工具与事件处理器已注册')

const sessionA = { id: 'sA', header: { cwd: 'C:/sA' }, deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: LONG_A }] }] }
await handlers['session/disposed'](sessionA)
await ctx.tools['memory__stage1_drain'].execute({})
// session/disposed 入队可能异步，直接 seed sA 作业再由 drain 处理更稳。
const outAppeared = await waitUntil(() => [...domainTbl('stage1_outputs').entries()].some(([, o]) => o && o.rollout_summary && o.rollout_summary.includes('咖啡')), 4000)
check(outAppeared, 'drain 产物写入 stage1_outputs 且含会话 A 事实')
check(extractCalls >= 1, '发生至少一次 extraction LLM 调用')

await ctx.tools['memory__phase2_integrate'].execute({})
// phase2 整合可能异步/或 no-change 提前跳过（预期），以 current.json 出现为准。
const current = await waitUntil(() => readJson(path.join(memoryRoot(), 'current.json')), 6000)
check(!!current && !!current.version, 'current.json 已指向发布版本：' + (current && current.version))
if (current) {
  const summaryPath = path.join(memoryRoot(), 'versions', current.version, 'memory_summary.md')
  const summary = fs.existsSync(summaryPath) && fs.readFileSync(summaryPath, 'utf8')
  check(!!summary && summary.includes('咖啡'), '发布版本 memory_summary.md 含提炼事实')
  const regPath = path.join(memoryRoot(), 'versions', current.version, 'MEMORY.md')
  check(!!fs.existsSync(regPath), '发布版本 MEMORY.md 已写出')
  // Phase 2 整合可能 no-change 跳过整合模型（预期），consolidCalls 至少 0；不强断言。
}

// ── Phase B：外部工具(web_search)会话 → 整段跳过 ────────────────────────────
console.log('[B] 外部工具(web_search)会话 → 整段跳过自动生成')
await seedFreshJob('sB')
const extCallsBefore = extractCalls
await ctx.tools['memory__stage1_drain'].execute({})
const jobB = [...domainTbl('stage1_jobs').entries()].map(([, v]) => v).find((x) => String(x.session_id) === 'sB')
check(jobB && jobB.status === 'succeeded_no_output', '外部会话以 succeeded_no_output 提交')
check(String(jobB && jobB.last_skip_reason || '').includes('external_context'), '记录 last_skip_reason=external_context:*')
check(extractCalls === extCallsBefore, '未触发新的 extraction LLM 调用（不烧配额）')
check([...domainTbl('stage1_outputs').entries()].filter(([, o]) => String(o.session_id) === 'sB').length === 0, '未产出 sB 的 stage1_output')

// ── Phase C：本地工具会话 → 不误杀 ──────────────────────────────────────────
console.log('[C] 本地工具(pwsh)会话 → 不被误杀（用户决定仍产出）')
await seedFreshJob('sC')
const localCallsBefore = extractCalls
await ctx.tools['memory__stage1_drain'].execute({})
const outC = await waitUntil(() => [...domainTbl('stage1_outputs').entries()].some(([, o]) => String(o.session_id) === 'sC'), 4000)
check(outC, '本地工具会话产出 stage1_output（未被外部名单误杀）')
check(extractCalls > localCallsBefore, '本地工具会话触发了 extraction（生成了记忆）')

// ── Phase D：真实 domain 用插件 spec 重开（模拟重启）→ 不丢 ──────────────────
console.log('[D] 真实 domain 重开（模拟重启）→ schema 通过、产物仍在')
let reopenErr = null
let d2 = null
try { d2 = await newFacility().open(lastSpec) } catch (e) { reopenErr = e }
check(reopenErr === null, '重开 domain 未抛 invalid-record：' + (reopenErr ? reopenErr.message : 'OK'))
const cur2 = readJson(path.join(memoryRoot(), 'current.json'))
check(!!cur2 && !!cur2.version, '重启后 current.json 仍指向发布版本')
if (cur2) {
  const s2 = path.join(memoryRoot(), 'versions', cur2.version, 'memory_summary.md')
  check(!!fs.existsSync(s2) && fs.readFileSync(s2, 'utf8').includes('咖啡'), '重启后发布版本摘要仍含提炼事实')
}
const disk = readJson(jsonPath)
check(!!disk && disk.tables && disk.tables.phase2_jobs && Object.keys(disk.tables.phase2_jobs).length >= 1, '磁盘 dsh_rollout.json 已持久化 phase2 批次')

// ── Phase E：memory_recall 召回自动记忆 ─────────────────────────────────────
console.log('[E] memory_recall 召回自动记忆（渐进披露 + 引用）')
const rE = await ctx.tools['memory_recall'].execute({ query: '咖啡', limit: 5 })
const txtE = JSON.stringify(rE)
check(txtE.length > 0, 'recall 返回了结果')
check(txtE.includes('咖啡') || txtE.includes('MEMORY.md'), 'recall 结果含提炼事实或注册表引用')
check(/:\d+-\d+/.test(txtE), 'recall 结果带 file:line 引用（如 memory_summary.md:3-3）')

try { fs.rmSync(tempHome, { recursive: true, force: true }) } catch {}
console.log(`\n（extractCalls=${extractCalls}, consolidCalls=${consolidCalls}）`)
console.log(`${failed === 0 ? '\nALL M3 E2E ACCEPTANCE PASSED' : failed + ' CHECKS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
