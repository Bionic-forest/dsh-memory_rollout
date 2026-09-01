// P0-R2-4 验收：用「真实 lib/index.js + 真实 @deepseek-ai/dsh-storage-domain(DomainFacility) +
// 真实文件后端」驱动 stage1→phase2 闭环，覆盖验收文档《六 下一轮任务单》第 4 条要求、以及
// 第四节「仍未得到真实证明的项目」中缺口。每场景独立 temp home，彼此不污染。
//
// 与已有测试的分工：
//   - p0-r2-1 / p0-r2-2 / p0-r2-3 用 **fake domain** 单测覆盖了逻辑边界；
//   - 本脚本改走 **真实 DomainFacility + 真实证据文件**，验证「同一套 lib/index.js 在
//     真实存储前端下仍然成立」，专补文档标注的「尚未真实证明」：
//     ① idle memory_remember 不手动 integrate、无 stage1 事件也自主进入 current；
//     ② 仅 forget / note / UI delete 也自主进入 current（复核 p0-r2-1，但走真实前端）；
//     ③ readSession 抛错 → failed_retryable 可重试（attempt 递增、max 后 terminal，不烧配额）；
//     ④ 空源 / 短内容 / model 空摘要三种 no-output 原因（empty_source / short_content / model_empty）；
//     ⑤ 同 session 第二 watermark 后两个 source_ref 同时可在真实证据文件上验证（复核 p0-5）；
//     ⑥ 召回引用不出现「同关键词、不同事实」的错配——entry 只与同 session 证据共享一个词，
//        真实 memoryCitationEntries 必须回退（不进 stage1 证据行、不伪造已核验）。
//
// 用法：cd plugins/dsh-rollout && node test/p0-r2-4-real-e2e-verify.test.mjs
// 安全：全部使用 os.tmpdir() 下的独立临时 home，绝不触碰真实 DSH 的 storages/memories。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply, validateSourceRef } = await import(PLUGIN)

// ── 真实文件后端 + 真实 DomainFacility（m3-e2e 已验证模式）────────────────────
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
function newFacility(tempHome) {
  const backend = { kv: { open: async () => makeUnit(path.join(tempHome, 'storages', 'dsh_rollout.json')) } }
  return new DomainFacility(
    { storage: { backend: { get: (n) => (n === 'real' ? backend : null) } }, emit: () => {}, logger: { warn() {}, info() {}, error() {} } },
    { backend: 'real', routes: {} },
  )
}

let failed = 0
const check = (cond, msg) => { if (cond) console.log('  ✓ ', msg); else { failed++; console.error('  ✗ ', msg) } }
const waitUntil = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await new Promise((r2) => setTimeout(r2, 15)) } return null }
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const currentSummary = (root) => {
  try { const v = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8')).version; return fs.readFileSync(path.join(root, 'versions', v, 'memory_summary.md'), 'utf8') }
  catch { try { return fs.readFileSync(path.join(root, 'memory_summary.md'), 'utf8') } catch { return '' } }
}
const currentRegistry = (root) => {
  try { const v = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8')).version; return fs.readFileSync(path.join(root, 'versions', v, 'MEMORY.md'), 'utf8') }
  catch { try { return fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8') } catch { return '' } }
}
const changesOf = (domain, kind) => { const out = []; for (const [, c] of domain.table('memory_changes').entries()) if (c && c.kind === kind) out.push(c); return out }
const anyConsumed = (list) => list.some((c) => c.status === 'consumed')

// 每场景独立 temp home + facility + 独立 apply。`llmMock`/`readSessionOverride` 按需注入。
async function runScenario(name, opts = {}) {
  const tmp = path.join(os.tmpdir(), `dsh-p0-r2-4-${name}-` + Date.now())
  fs.mkdirSync(path.join(tmp, 'storages'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'memories'), { recursive: true })
  process.env.DSH_HOME = tmp

  // 默认 LLM mock：extraction 无输出（不产 stage1 事件），consolidation 回显可配置。
  // 调用方可传 opts.llmMock 覆盖（如带 extract 调用计数器的 version）。
  let llmResponse = opts.llmResponse || { memory_summary: 'v1\n## consolidated', registry: '# MEMORY.md' }
  const extractShape = opts.extractShape // 若提供：extraction 产出的 JSON 对象（用于 model_empty / with_output）
  const llmMock = opts.llmMock || {
    stream: (o) => {
      const isExtract = String(o && o.system).includes('memory-extraction')
      if (isExtract) {
        // model_empty 依赖 parseExtractionJson 成功但 rollout_summary 为空；provided via extractShape.
        if (extractShape !== undefined) {
          return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(extractShape) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
        }
        // default extraction：什么都不 yield（等价 LLM 返回 null/empty → failed）。
        return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
      }
      return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(llmResponse) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
    },
  }

  const registeredRoutes = []
  const webServer = { register: (r) => { registeredRoutes.push(r); return () => {} } }
  const tools = {}
  // 单例 facility：apply 内的 storageDomain.open 与查询工具共用同一实例，保证内存表一致。
  let opened = null
  const ctx = {
    storageDomain: { open: async (spec) => { opened = await newFacility(tmp).open(spec); return opened } },
    get: (k) =>
      k === 'llm' ? llmMock
        : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : k === 'webServer' ? webServer
            : k === 'sessionQuery' ? { readSession: opts.readSession || (async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [] })) }
              : undefined,
    tools: { register: (t) => { tools[t.name] = t } },
    systemPrompt: { section: () => {} },
    effect: (fn) => fn(),
    on: () => () => {},
  }
  await apply(ctx, { recallLimit: 20, maxModelAttemptsPerDay: opts.maxModelAttemptsPerDay || 100 })
  return { tmp, ctx, tools, domain: opened, root: () => path.join(tmp, 'memories'), routes: registeredRoutes }
}

// ── 辅助（作用于真实 domain）───────────────────────────────────────────────
function dumpScenario(s) { try { fs.rmSync(s.tmp, { recursive: true, force: true }) } catch {} }
async function seedRealJob(domain, sessionId, watermark, opts = {}) {
  const now = opts.createdAt ? new Date(opts.createdAt) : new Date()
  const key = `${String(sessionId)}::${String(watermark)}`
  const job = {
    id: opts.id || 'j-real-' + Math.random().toString(36).slice(2, 8),
    session_id: String(sessionId),
    source_watermark: String(watermark),
    status: opts.status || 'pending',
    attempt_count: opts.attemptCount ?? 0,
    max_attempts: opts.maxAttempts ?? 3,
    available_at: opts.availableAt ?? now.toISOString(),
    lease_owner: opts.leaseOwner || '',
    lease_expires_at: opts.leaseExpiresAt || '',
    last_error: opts.lastError || '',
    last_error_code: opts.lastErrorCode || '',
    last_error_message: opts.lastErrorMessage || '',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    completed_at: opts.completedAt || '',
    ...(opts.extra || {}),
  }
  await domain.table('stage1_jobs').put(key, job)
  return job
}
function jobBySession(domain, sid) { const out = []; for (const [, v] of domain.table('stage1_jobs').entries()) if (v && String(v.session_id) === String(sid)) out.push(v); return out }
function outputBySession(domain, sid) { const out = []; for (const [, v] of domain.table('stage1_outputs').entries()) if (v && String(v.session_id) === String(sid)) out.push(v); return out }

// 构造一个可被 Session.create/deriveMessages 正确解析的完整事件序列（user + assistant 配对）。
// 参考 m3-e2e 的 mkEvents：deriveMessages 需要 user/assistant 成对的 surfaceOp=append 消息。
const mkEvents = (userId, text, toolCalls = []) => {
  const evs = [{ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id: 'm-' + userId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }]
  let seq = 1
  for (const tc of toolCalls) {
    evs.push({ type: 'tool/call', seq: seq++, time: seq, data: { turn: 0, step: 0, callId: 'c-' + seq, name: tc, arguments: '{}' } })
    evs.push({ type: 'tool/result', seq: seq++, time: seq, surfaceOp: 'append', data: { turn: 0, step: 0, message: { id: 'tr-' + seq, role: 'user', source: { kind: 'tool', callId: 'c-' + seq }, content: [{ type: 'tool-result', toolCallId: 'c-' + seq, content: [{ type: 'text', text: 'done' }] }] } } })
  }
  evs.push({ type: 'assistant/message', seq: seq++, time: seq, surfaceOp: 'append', data: { turn: 0, step: 0, message: { id: 'a-' + userId, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ack' }] } } })
  return evs
}

// ═══════════════════════════════════════════════════════════════════════════
// 场景① idle memory_remember 自主进入 current（无手动 integrate、无 stage1 事件）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[1] idle memory_remember → 自主进入 current（真实前端）')
{
  const s = await runScenario('idle-remember', {
    llmResponse: { memory_summary: 'v1\n## consolidated\nuser prefers coffee before work', registry: '# MEMORY.md\n- user prefers coffee before work' },
  })
  try {
    const before = changesOf(s.domain, 'remember').length
    const r = await s.tools.memory_remember.execute({ content: 'user prefers coffee before work', tags: ['pref'] }, { agent: { session: { id: 'idle-r' } } })
    check(!!r && !!r.id, 'remember 返回 id=' + (r && r.id))
    check(changesOf(s.domain, 'remember').length === before + 1, '一条 kind=remember pending change 进入变更流')
    // 不手动 integrate、不产生 stage1 事件 —— 靠 writeChangeRecord 里的 requestPhase2Integrate 自动唤醒。
    const consumed = await waitUntil(() => anyConsumed(changesOf(s.domain, 'remember').slice(before)), 4000)
    check(consumed, 'remember change 被自动消费（无需手动 integrate / 无 stage1 事件）')
    const cur = await waitUntil(() => readJson(path.join(s.root(), 'current.json')), 4000)
    check(!!cur && !!cur.version, 'current.json 已发布：' + (cur && cur.version))
    check(currentSummary(s.root()).includes('coffee before work'), '发布版本 memory_summary.md 含记住的事实')
  } finally { dumpScenario(s) }
}

// ═══════════════════════════════════════════════════════════════════════════
// 场景② 仅 forget / note 自主进入 current（真实前端复核 p0-r2-1）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[2] 仅 note / forget 自主进入 current（真实前端，无手动 integrate、无 stage1 事件）')
{
  // ②-a note（独立场景，llmResponse = note 内容）
  {
    const s = await runScenario('idle-note', {
      llmResponse: { memory_summary: 'v1\n## consolidated\nuser prefers concise answers with tables', registry: '# MEMORY.md\n- user prefers concise answers with tables' },
    })
    try {
      const noteBefore = changesOf(s.domain, 'note').length
      const rn = await s.tools.memory_note.execute({ slug: 'concise-pref', content: 'user prefers concise answers with tables' })
      check(!!rn && !!rn.file, 'note 写入了文件：' + (rn && rn.file))
      check(changesOf(s.domain, 'note').length === noteBefore + 1, '一条 kind=note pending change 进入变更流')
      const noteConsumed = await waitUntil(() => anyConsumed(changesOf(s.domain, 'note').slice(noteBefore)), 4000)
      check(noteConsumed, 'note change 被自动消费（真实前端，无需手动 integrate）')
      check(currentSummary(s.root()).includes('concise answers with tables'), 'current 反映 note 内容')
    } finally { dumpScenario(s) }
  }
  // ②-b forget（独立场景，llmResponse = obsidian 基线；forget 后 exclusions 剥离它）
  {
    const forgetBase = 'the obsidian vault is sealed'
    const s = await runScenario('idle-forget', {
      llmResponse: { memory_summary: 'v1\n## consolidated\n' + forgetBase, registry: '# MEMORY.md\n- ' + forgetBase },
    })
    try {
      const rRemember = await s.tools.memory_remember.execute({ content: forgetBase }, { agent: { session: { id: 'n-fg' } } })
      await waitUntil(() => anyConsumed(changesOf(s.domain, 'remember')), 4000)
      check(currentSummary(s.root()).includes(forgetBase), '基线 current 含 forget 前内容')
      const forgetBefore = changesOf(s.domain, 'forget').length
      const rf = await s.tools.memory_forget.execute({ id: rRemember.id })
      check(rf.deleted === 1, 'forget 返回 deleted=1')
      check(changesOf(s.domain, 'forget').length === forgetBefore + 1, '一条 kind=forget pending change 进入变更流')
      const forgetConsumed = await waitUntil(() => anyConsumed(changesOf(s.domain, 'forget').slice(forgetBefore)), 4000)
      check(forgetConsumed, 'forget change 被自动消费（真实前端，无需手动 integrate）')
      check(!currentSummary(s.root()).includes(forgetBase), 'current 不再含被遗忘内容（forget exclusion 生效）')
    } finally { dumpScenario(s) }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 场景③ readSession 抛错 → failed_retryable 可重试（attempt 递增、max 后降级、不烧配额）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[3] source_unavailable：failed_retryable 可重试（真实前端）')
{
  // readSession 抛错模拟「源被删/服务不可用」。用计数器记录 extraction LLM 调用次数。
  let extractCalls = 0
  const okShape = { rollout_summary: 'v1\n## x', raw_memory: 'x', slug: 'x', keywords: 'x', title: 'x' }
  const llmMock = {
    stream: (o) => {
      const isExtract = String(o && o.system).includes('memory-extraction')
      if (isExtract) extractCalls++
      if (isExtract) return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(okShape) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
      return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    },
  }
  const readSession = async (id) => { throw new Error('session not found: ' + id) }
  const s = await runScenario('unavailable', { readSession, llmMock })
  try {
    // ① 第一次 drain：源不可用 → failed_retryable，不烧配额。
    await seedRealJob(s.domain, 'src-x', 'wm1', { maxAttempts: 3 })
    const d1 = await s.tools.memory__stage1_drain.execute({})
    check(d1.processed >= 1, '第一次 drain 处理了作业')
    const j1 = jobBySession(s.domain, 'src-x')[0]
    check(j1.status === 'failed_retryable', '源不可用 → failed_retryable（绝不伪装 succeeded_no_output）')
    // failed_retryable 把来源错因写入 last_error_message（no-output 才用 last_skip_reason）。
    check(String(j1.last_error_message || '').includes('source unavailable') || String(j1.last_error || '').includes('source unavailable'),
      'last_error_message 记录 source unavailable（实际：' + String(j1.last_error_message || '') + '）')
    check(j1.attempt_count >= 1, 'attempt_count 已递增：' + j1.attempt_count)
    check(extractCalls === 0, '源不可用不调用 extraction LLM（不烧配额）')
    const av1 = new Date(j1.available_at).getTime()
    check(av1 > Date.now(), 'available_at 已退避到未来（retry_wait 生效）')

    // ② 模拟退避到期后再次 drain：仍 failed_retryable，attempt 继续递增，仍不烧配额。
    await domain_update(s.domain, 'stage1_jobs', `${'src-x'}::wm1`, (cur) => ({ ...cur, available_at: new Date(Date.now() - 1000).toISOString() }))
    const d2 = await s.tools.memory__stage1_drain.execute({})
    const j2 = jobBySession(s.domain, 'src-x')[0]
    check(j2.attempt_count >= 2, '退避到期后重试，attempt 递增到 ' + j2.attempt_count)
    check(j2.status === 'failed_retryable', '仍 failed_retryable（源仍不可用）')
    check(extractCalls === 0, '重试仍不烧配额')

    // ③ 耗尽 max_attempts → 降级 failed_terminal（不再无限重试）。
    await domain_update(s.domain, 'stage1_jobs', `${'src-x'}::wm1`, (cur) => ({ ...cur, attempt_count: 2, available_at: new Date(Date.now() - 1000).toISOString() }))
    const d3 = await s.tools.memory__stage1_drain.execute({})
    const j3 = jobBySession(s.domain, 'src-x')[0]
    check(j3.status === 'failed_terminal', '达到 max_attempts → 降级 failed_terminal（不再无限重试）')
    check(!!j3.completed_at, 'failed_terminal 记录 completed_at')
  } finally { dumpScenario(s) }
}

// 对真实 domain 的某表某 key 做原子 update（代理 storage-domain 的 table.update）。
async function domain_update(domain, table, key, fn) {
  const cur = domain.table(table).get(key)
  const next = fn(JSON.parse(JSON.stringify(cur)))
  await domain.table(table).put(key, next)
  return next
}

// ═══════════════════════════════════════════════════════════════════════════
// 场景④ 三种 no-output 原因：empty_source / short_content / model_empty（真实前端）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[4] 三种 no-output 原因分型（真实前端）')
{
  // 按 session_id 分派完整事件序列：empty → 无消息；short → <60 字符；modelempty → >=60 字符但 LLM 摘要为空。
  const readSession = async (id) => {
    if (id === 'src-empty') return { session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [] }
    if (id === 'src-short') return { session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: mkEvents(id, 'short note') }
    return { session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: mkEvents(id, 'This is a long enough transcript that reaches the model extraction threshold for a durable fact that should be remembered.') }
  }
  // model_empty：extraction 返回解析成功但 rollout_summary 为空。
  const extractShape = { rollout_summary: '', raw_memory: '', slug: 'x', keywords: '', title: '' }
  const s = await runScenario('reasons', { readSession, extractShape })
  try {
    await seedRealJob(s.domain, 'src-empty', 'wm1')
    await seedRealJob(s.domain, 'src-short', 'wm1')
    await seedRealJob(s.domain, 'src-modelempty', 'wm1')
    await s.tools.memory__stage1_drain.execute({})
    const bySid = (sid) => jobBySession(s.domain, sid)[0]
    const jE = bySid('src-empty'), jS = bySid('src-short'), jM = bySid('src-modelempty')
    check(jE && jE.status === 'succeeded_no_output' && String(jE.last_skip_reason || '').includes('empty_source'),
      '真空源 → succeeded_no_output + last_skip_reason=empty_source:*（实际：' + (jE && jE.last_skip_reason) + '）')
    check(jS && jS.status === 'succeeded_no_output' && String(jS.last_skip_reason || '').includes('short_content'),
      '短内容(<60字符) → last_skip_reason=short_content:*（实际：' + (jS && jS.last_skip_reason) + '）')
    check(jM && jM.status === 'succeeded_no_output' && String(jM.last_skip_reason || '').includes('model_empty'),
      'LLM 空摘要 → last_skip_reason=model_empty:*（实际：' + (jM && jM.last_skip_reason) + '）')
    // 三者都不该产生 stage1_output（无真实记忆被写入）。
    check(outputBySession(s.domain, 'src-empty').length === 0, 'empty 源未产出 stage1_output')
    check(outputBySession(s.domain, 'src-short').length === 0, 'short 源未产出 stage1_output')
    check(outputBySession(s.domain, 'src-modelempty').length === 0, 'model_empty 源未产出 stage1_output')
  } finally { dumpScenario(s) }
}

// ═══════════════════════════════════════════════════════════════════════════
// 场景⑤ 同 session 第二 watermark 后两个 source_ref 同时有效（真实前端复核 p0-5）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[5] 同 session 双 watermark：两个 source_ref 都在真实证据文件上可验证（真实前端）')
{
  let payload = { rollout_summary: 'first watermark summary alpha', raw_memory: 'raw-a', slug: 'a', keywords: 'a', title: 'A' }
  const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: mkEvents(id, 'this is a long enough message for session ' + id + ' that reaches the model extraction of a durable fact') })
  const llmMock = { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(payload) }; yield { type: 'finish', reason: { kind: 'stop' } } } }) }
  const s = await runScenario('appendonly', { readSession, llmMock })
  try {
    await seedRealJob(s.domain, 'ev-sess', 'wm1')
    await s.tools.memory__stage1_drain.execute({})
    const firstOut = await waitUntil(() => outputBySession(s.domain, 'ev-sess').find((o) => String(o.source_watermark) === 'wm1'), 3000)
    check(!!firstOut && firstOut.source_ref, '第一 watermark 产出 output + source_ref')
    const firstRef = firstOut.source_ref
    const evPath = path.join(s.root(), 'rollout_summaries', 'ev-sess.md')
    check(fs.existsSync(evPath), '证据文件已写出（rollout_summaries/ev-sess.md）')
    check(validateSourceRef(firstRef, s.root()).ok === true, '第一个 source_ref 验证通过（追加前）')

    // 第二 watermark：append-only 追加新块，不改旧行。
    payload = { rollout_summary: 'second watermark summary beta', raw_memory: 'raw-b', slug: 'b', keywords: 'b', title: 'B' }
    await seedRealJob(s.domain, 'ev-sess', 'wm2')
    await s.tools.memory__stage1_drain.execute({})
    const secondOut = await waitUntil(() => outputBySession(s.domain, 'ev-sess').find((o) => String(o.source_watermark) === 'wm2'), 3000)
    check(!!secondOut && secondOut.source_ref, '第二 watermark 产出自己的 output + source_ref')
    check(validateSourceRef(secondOut.source_ref, s.root()).ok === true, '第二个 source_ref 验证通过')
    check(validateSourceRef(firstRef, s.root()).ok === true, '第一个 source_ref 在追加后仍验证通过（旧行未动）')
    const evTxt = fs.readFileSync(evPath, 'utf8')
    check(evTxt.includes('first watermark summary alpha'), '第一摘要仍在（未覆盖）')
    check(evTxt.includes('second watermark summary beta'), '第二摘要已追加')
  } finally { dumpScenario(s) }
}

// ═══════════════════════════════════════════════════════════════════════════
// 场景⑥ 召回引用不出现「同关键词、不同事实」错配（真实 memoryCitationEntries 链路）
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[6] 召回引用：同关键词不同事实 → 不误用 stage1 证据行段（真实前端）')
{
  // 会话 src-pnpm 用长文本（会触发 extraction 产出带 keywords=pnpm 的 output + 证据文件）。
  // 证据文件某行含「pnpm build failed because lockfile was stale」（Evidence 块）。
  // entry 内容为「user prefers pnpm over npm」—— 只与证据共享关键词 pnpm，但事实关系不同。
  const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: mkEvents(id, 'the pnpm build failed because the lockfile was stale during the continuous integration pipeline run.') })
  const extractShape = { rollout_summary: 'v1\n## 证据\n- pnpm build failed because lockfile was stale', raw_memory: 'pnpm-build-failure', slug: 'pnpm', keywords: 'pnpm,build', title: 'pnpm-build' }
  const s = await runScenario('recall-mismatch', { readSession, extractShape, llmResponse: { memory_summary: 'v1\n## consolidated', registry: '# MEMORY.md' } })
  try {
    await seedRealJob(s.domain, 'src-pnpm', 'wm1')
    await s.tools.memory__stage1_drain.execute({})
    const out = await waitUntil(() => outputBySession(s.domain, 'src-pnpm').find((o) => String(o.source_watermark) === 'wm1'), 3000)
    check(!!out && out.source_ref, 'src-pnpm 产出 output + source_ref（证据文件行段）')
    const evPath = path.join(s.root(), 'rollout_summaries', 'src-pnpm.md')
    check(fs.existsSync(evPath), '证据文件存在：src-pnpm.md')

    // 现在用 **手动注入** 一条「同 session、同关键词、不同事实」的 entry（不走 remember 会去重，故直接写表）。
    // 通过 memory_remember 在 src-pnpm 会话下手动记一条 content 与证据只共享 pnpm 的 entry。
    const r = await s.tools.memory_remember.execute({ content: 'user prefers pnpm over npm', tags: ['pref'] }, { agent: { session: { id: 'src-pnpm' } } })
    check(!!r.id, '记住同 session 同关键词不同事实的 entry：' + r.id)
    // recall 该 entry，检查引用形态。
    const rec = await s.tools.memory_recall.execute({ query: 'pnpm', limit: 10 })
    const cit = String(rec && rec.citation || '')
    // P0-R2-2（R2.1 修正）：同关键词、不同事实的 entry（"user prefers pnpm over npm"）绝不能凭
    // 一个共享词 `pnpm` 获得任何**内容证据式**引用——无论精确 Stage1 行段（startLine>1）还是
    // 整份草稿（1-N，此前的单 token 放行）。草稿只证明"该会话的记录"，不证明"草稿支持这个事实"；
    // 一旦引用 src-pnpm.md，来源元数据（provenance）就伪装成了内容证据（evidence）。
    // 因此断言：**mismatch entry（content=user prefers pnpm over npm）的引用**不得落在 src-pnpm.md
    // 的任何行段；它只能命中 MEMORY.md 中确含其完整内容的行，或回落为诚实的 unverified。
    const mismatchEntry = (Array.isArray(rec && rec.entries) ? rec.entries : []).find((en) => en && en.content && en.content.includes('user prefers pnpm over npm'))
    check(!!mismatchEntry, 'recall 返回了 mismatch entry（content=user prefers pnpm over npm）')
    // ① 结果引用文本里不得出现 src-pnpm.md 的行段引用（精确证据 N/A、草稿 1-N 也拒绝）。
    check(!/src-pnpm\.md:/.test(cit), 'mismatch entry 不引用 src-pnpm.md 的任何行段（精确证据 N/A、草稿 1-N 也拒绝）')
    // ② 它应回落为诚实 unverified（或命中确含完整内容的 MEMORY.md 行）。
    check(/unverified:0-0/.test(cit), 'mismatch entry 回退为未核验（unverified:0-0，宁缺毋滥）')
    // ③ 双保险（代码侧直测）：精确证据行段与整份草稿对该内容都以完整子串判 unrelated。
    const v = validateSourceRef({ path: 'rollout_summaries/src-pnpm.md', startLine: 2, endLine: 6, citeSpan: '', sessionId: 'src-pnpm' }, s.root(), { content: 'user prefers pnpm over npm' })
    check(v.ok === false, '同关键词不同事实的内容对证据行段（startLine>1）校验必为 unrelated（不当作已核验证据）')
    const vDraft = validateSourceRef({ path: 'rollout_summaries/src-pnpm.md', startLine: 1, endLine: 0, citeSpan: '', sessionId: 'src-pnpm' }, s.root(), { content: 'user prefers pnpm over npm' })
    check(vDraft.ok === false, '同关键词不同事实的内容对整份草稿（1-N）以完整子串校验也必为 unrelated（不再单 token 放行）')
  } finally { dumpScenario(s) }
}

// ── 收尾 ───────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? 'ALL P0-R2-4 REAL-E2E VERIFY TESTS PASSED' : failed + ' CHECKS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)


