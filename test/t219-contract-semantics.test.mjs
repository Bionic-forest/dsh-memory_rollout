// t219（R2 §3/§4/§7 · B 联合数据契约纠正）：把**可验证的那部分**契约钉住 ——
//   · 四类额度口径分开标注（`QUOTA_SEMANTICS`）
//   · 「entries 层检索资格策略」的**分层范围差异**（entries 失格 ≠ 文件搜索/注入里消失）
//   · 查询结果层的排序事实（`usage_count` 先于查询相关性 ⇒ 曝光代理/热门优先）
//   · manifest 如实标明 `selection_scope`（只登记本批输入，不是完整当前选择集合）
//   · `phase2_abandoned` = 可审计的隔离/人工待处理（不是记忆语义淘汰；停止重试 ≠ 恢复成功）
//   · 三层分离 / 「未启用的目标能力」在源码里**明文存在**（源码级锚点，单独标注）
//
// 与 t216 同款**缺导出包装**：在"改前树"上给**断言级红**（不 TypeError 崩溃）。
import assert from 'node:assert'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, setMeta } from './lib/helpers.mjs'

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t219-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const M = await import(PLUGIN)
const { apply, entryEligible, DEFAULT_MAX_UNUSED_DAYS } = M

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
// 每段一个独立护栏：改前树上**任一段**抛错都只记一条红，不影响其余段继续给出断言级红。
const section = async (label, fn) => {
  try { return await fn() } catch (err) {
    check(false, `${label} 在"改前树"上中断（**预期的断言级红**，不是崩溃）：${err && err.message ? err.message : err}`)
  }
}

const REQUIRED_EXPORTS = ['apply', 'entryEligible', 'QUOTA_SEMANTICS', 'DEFAULT_MAX_UNUSED_DAYS']
const missingExports = REQUIRED_EXPORTS.filter((n) => M[n] === undefined)
check(missingExports.length === 0,
  `本测试所需的导出/常量齐全（缺失 ${missingExports.length} 个${missingExports.length ? '：' + missingExports.join(', ') : ''}）`)

const root = () => path.join(HOME, 'memories')
const currentFile = () => path.join(root(), 'current.json')
const readCurrent = () => { try { return JSON.parse(fs.readFileSync(currentFile(), 'utf8')) } catch { return null } }
const verFile = (v, f) => { try { return fs.readFileSync(path.join(root(), 'versions', v, f), 'utf8') } catch { return '' } }
const sha256 = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex')
function writeCurrent(summary, registry) {
  const id = 'p2-t219-' + Math.random().toString(36).slice(2, 8)
  const vd = path.join(root(), 'versions', id)
  fs.mkdirSync(vd, { recursive: true })
  fs.writeFileSync(path.join(vd, 'memory_summary.md'), summary, 'utf8')
  fs.writeFileSync(path.join(vd, 'MEMORY.md'), registry, 'utf8')
  // manifest 必须带两份 sha256，否则 versionIsUsable 不认这个版本、读取会回退到根文件（根文件此处不存在）。
  fs.writeFileSync(path.join(vd, 'manifest.json'), JSON.stringify({
    version: id, summary_file: 'memory_summary.md', registry_file: 'MEMORY.md', manifest_file: 'manifest.json',
    summary_sha256: sha256(summary), registry_sha256: sha256(registry),
    phase2_authoritative: true, created_at: new Date().toISOString(),
  }, null, 2), 'utf8')
  fs.writeFileSync(currentFile(), JSON.stringify({ version: id }), 'utf8')
  return id
}
const clearQueue = async () => { const t = domain.table('phase2_jobs'); for (const k of [...t.keys()]) await t.delete(k) }

let llmResponse = { memory_summary: 'v1\n## 索引\n- 契约测试结论', registry: '# MEMORY.md\n- 契约测试结论' }
const llmMock = {
  stream: (opts) => {
    if (opts && String(opts.system).includes('memory-extraction')) {
      return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    }
    const payload = JSON.stringify(llmResponse)
    return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  },
}
const tools = {}
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  tools: { register: (t) => { if (t && t.name) tools[t.name] = t } },
})

// ─────────────────────────────────────────────────────────────────────────────
// C1. 四类额度口径分开标注
// ─────────────────────────────────────────────────────────────────────────────
await section('[C1]', async () => {
  console.log('\n[C1] 四类额度口径分开标注（R2 §7）')
  const Q = M.QUOTA_SEMANTICS
  check(!!Q && typeof Q === 'object', 'QUOTA_SEMANTICS 存在（同一份口径供代码/测试/报告引用）')
  const labels = ['每日 Stage1 尝试上限', '每趟处理上限', 'Phase 2 启动门（不是调用预算）', '真实 provider 限额']
  const got = [Q.stage1DailyAttempts, Q.stage1PerPassSources, Q.phase2CallBudget, Q.providerRateLimit].map((x) => x && x.label)
  check(JSON.stringify(got) === JSON.stringify(labels), `四项标签齐且分开：${got.join(' / ')}`)
  // F5 口径（评审 §五.3）：第三项的 label/note 必须把两件事**分开**说 ——
  //   ①「依 Stage 1 计数决定能否启动整合」（已实现）；②「实际限制整合调用次数/费用」（未实现）。
  check(String(Q.phase2CallBudget.note).includes('依 Stage 1 计数决定能否启动整合')
    && String(Q.phase2CallBudget.note).includes('未实现'),
    '第三项把「启动门」与「实际限制整合次数/费用」分开表述（后者明标未实现）')
  check(Q.stage1DailyAttempts.isProviderQuota === false && Q.stage1DailyAttempts.debitedBy.length === 1,
    '第一项：本地发明、只由 stage-1 提炼记账、非 provider 额度')
  check(Q.phase2CallBudget.debitedBy.length === 0 && Q.providerRateLimit.enforcedAt.length === 0,
    'Phase 2 调用**不进**本地计数；真实 provider 限额**未实现**（如实标注）')
  check(Q.sharedAccounting === false,
    'sharedAccounting=false ⇒ 该门**不得**被表述为服务商额度门（要共享就必须两阶段 + 回落都记账）')

  // ───────────────────────────────────────────────────────────────────────────
  // C2. 三层分离 / 「未启用的目标能力」在源码里明文存在（**源码级锚点**，不是行为断言）
  //     —— 单独标注：它们抓的是"本批写下的契约文本"，不是运行行为。
  // ───────────────────────────────────────────────────────────────────────────
})

await section('[C2]', async () => {
  console.log('\n[C2] 契约文本的源码级锚点（本批新增；标注为源码锚点，不作行为背书）')
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  check(src.includes('联合数据契约 —— 三层必须分开'), '源码含「三层必须分开」的契约块')
  check(src.includes('把同一算法放错层，比缺一个参数更严重'), '源码明写「放错层比缺参数更严重」')
  check(src.includes('不再新增"名为照 Codex、实则搬错层"的函数'), '源码明写「不再新增照 Codex 的错层函数」')
  check(src.includes('文件层退出（来源退出后清理失去支持的派生内容）') && src.includes('本批不实现'),
    '「文件层退出 = 未启用的目标能力（本批不实现）」明文在册')
  check(src.includes('entries 层检索资格策略'), '30 天机制已正名为「entries 层检索资格策略」')
  check(src.includes('一条 entries 失格，不保证'), '明写「entries 失格不保证同一事实从文件搜索/注入消失」')
  check(src.includes('可审计的隔离 / 人工待处理状态') && src.includes('停止重试 ≠ 恢复成功'),
    '`phase2_abandoned` 语义已正名（可审计隔离；停止重试 ≠ 恢复成功）')

  // ───────────────────────────────────────────────────────────────────────────
  // C3. entries 层资格 vs 文件搜索层（**分层范围差异** —— 行为断言；注意：两棵树都成立 ⇒ 牙齿里算假阳性）
  // ───────────────────────────────────────────────────────────────────────────
})

await section('[C3]', async () => {
  console.log('\n[C3] entries 失格 ≠ 同一事实从文件搜索/注入消失（分层范围差异）')
  await apply(ctx, { recallLimit: 10 })
  const NOW = Date.now()
  const OLD = new Date(NOW - 40 * 86400000).toISOString()
  const stale = { content: 'ZETA-ONLY-FACT: 三十天前的条目事实', tags: [], status: 'active', updatedAt: OLD, usage_count: 0, last_usage: '' }
  check(entryEligible(stale, NOW, DEFAULT_MAX_UNUSED_DAYS) === false,
    'entries 层：40 天未用且从未用过 ⇒ 失格（条目层资格策略生效）')
  await domain.table('entries').put('e-stale', { id: 'e-stale', ...stale, createdAt: OLD, source: 'ui' })
  // 同一事实**仍在权威总纲里**（文件层）
  writeCurrent('v1\n## 索引\n- ZETA-ONLY-FACT: 三十天前的条目事实 → memories/rollout_summaries/x.md', '# MEMORY.md\n- ZETA-ONLY-FACT')
  const r1 = await tools['memory_recall'].execute({ query: 'ZETA-ONLY-FACT', limit: 5 })
  check(r1.entries.length === 0, `entries 层把它挡掉（entries=${r1.entries.length}）`)
  check(r1.memories.length >= 1 && r1.memories.some((m) => String(m.content).includes('ZETA-ONLY-FACT')),
    `文件搜索层**仍**能返回它（memories=${r1.memories.length}）⇒ 分层范围差异成立，不是"整条管线已失格"`)

  // ───────────────────────────────────────────────────────────────────────────
  // C4. 查询结果层排序：usage_count 是首键（先于查询相关性）⇒ 曝光代理/热门优先
  //     注意：这是**既有行为**（本批只更正注释/口径）⇒ 牙齿里同样算假阳性
  // ───────────────────────────────────────────────────────────────────────────
})

await section('[C4]', async () => {
  console.log('\n[C4] 查询结果层排序事实：usage_count 先于相关性（更正注释所依据的实现）')
  const nowIso = new Date().toISOString()
  await domain.table('entries').put('e-hot', { id: 'e-hot', content: 'BETA 只出现一次', tags: [], status: 'active', createdAt: nowIso, updatedAt: nowIso, usage_count: 5, last_usage: nowIso, source: 'ui' })
  await domain.table('entries').put('e-rel', { id: 'e-rel', content: 'BETA BETA BETA 出现三次', tags: [], status: 'active', createdAt: nowIso, updatedAt: nowIso, usage_count: 0, last_usage: '', source: 'ui' })
  const r2 = await tools['memory_recall'].execute({ query: 'BETA', limit: 5 })
  const ids = r2.entries.map((e) => e.id)
  check(ids[0] === 'e-hot' && ids.includes('e-rel'),
    `usage_count DESC 是**首键**（相关性 1 次的 e-hot 排在 3 次的 e-rel 之前）：顺序=${ids.join(' > ')}`)
  check(ids.indexOf('e-hot') < ids.indexOf('e-rel'),
    '⇒ 这是 DSH 的曝光代理/热门优先排序，不是"仅在相关性打平时才影响排序"（旧注释已作废）')

  // ───────────────────────────────────────────────────────────────────────────
  // C5. manifest 如实标明 selection_scope（只登记本批输入，不是完整当前选择集合）
  // ───────────────────────────────────────────────────────────────────────────
})

await section('[C5]', async () => {
  console.log('\n[C5] manifest 标明 selection_scope（R2 §3.2）')
  await clearQueue()
  await seedOutput(domain, 'j-t219-a', { session_id: 's-219-a', source_watermark: 'wm-219-a', rollout_summary: '契约事实', generated_at: '2026-03-01T00:00:00.000Z' })
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  llmResponse = { memory_summary: 'v1\n## 索引\n- 契约测试：selection_scope', registry: '# MEMORY.md\n- 契约测试：selection_scope' }
  const before = readCurrent().version
  await tools['memory__phase2_integrate'].execute({})
  const after = readCurrent().version
  check(after !== before, `本批已发布新版本（${before} → ${after}）`)
  const manifest = (() => { try { return JSON.parse(verFile(after, 'manifest.json')) } catch { return null } })()
  check(!!manifest && manifest.selection_scope === 'batch-inputs',
    `manifest.selection_scope = ${manifest && manifest.selection_scope}（如实标明"本批消费输入"，**不**冒充完整当前选择集合）`)
  check(!!manifest && /NOT the full current selection set/i.test(String(manifest.selection_scope_note || '')),
    '并写明它与原生"完整当前选择集合"语义的差别')

  // ───────────────────────────────────────────────────────────────────────────
  // C6. phase2_abandoned = 可审计的隔离/人工待处理（不重选，但不抹掉痕迹）
  // ───────────────────────────────────────────────────────────────────────────
})

await section('[C6]', async () => {
  console.log('\n[C6] 被放弃的来源：隔离可见、不重选、痕迹保留（停止重试 ≠ 恢复成功）')
  await clearQueue()
  await seedOutput(domain, 'j-t219-abandoned', {
    session_id: 's-219-abandoned', source_watermark: 'wm-ab', rollout_summary: '曾被放弃的来源',
    generated_at: '2026-03-02T00:00:00.000Z', selected_for_phase2: false,
    phase2_abandoned: true, phase2_abandoned_reason: 'phase2 retries exhausted: released 3 time(s)',
  })
  await seedOutput(domain, 'j-t219-fresh', { session_id: 's-219-fresh', source_watermark: 'wm-fr', rollout_summary: '正常来源', generated_at: '2026-03-03T00:00:00.000Z' })
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  llmResponse = { memory_summary: 'v1\n## 索引\n- 契约测试：隔离', registry: '# MEMORY.md\n- 契约测试：隔离' }
  await tools['memory__phase2_integrate'].execute({})
  const ab = domain.table('stage1_outputs').get('j-t219-abandoned') || {}
  const fr = domain.table('stage1_outputs').get('j-t219-fresh') || {}
  check(ab.selected_for_phase2 !== true && !ab.phase2_batch_id,
    '被放弃的来源**不被重选**（未绑定批次、未标记消费）')
  check(String(ab.phase2_abandoned_reason).includes('retries exhausted'),
    `隔离原因**仍可查**（"${String(ab.phase2_abandoned_reason).slice(0, 48)}…"）⇒ 可审计，不是静默丢弃`)
  check(fr.selected_for_phase2 === true, '同批的正常来源照常被消费（隔离只针对那一条，不连坐）')
})

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n${failed === 0 ? 'ALL T219 CONTRACT-SEMANTICS TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
