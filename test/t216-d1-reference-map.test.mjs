// t216（D1 修复 · 按 GPT R2 §5.2「窄范围 B + 轻量 D」）：
//   **可信引用映射 + 由代码渲染真实引用** —— 让合法来源路径不再被秘密闸门遮掉、虚构引用不再可发布、
//   真形式凭据继续被拦。判据按 R2 §5.2/§5.3 分成两条互不串用的链：正文 → 秘密规则；引用 → 映射/存在性/
//   归属/版本检查。
//
// 三段：
//   A. 纯函数层：映射只能由插件记录生成 / 精确匹配才算引用 / 凭据字段内不豁免 / 遗留引用标未验证
//   B. 三类材料验收（**隔离副本**，不碰真实 storages/memories）：合法来源路径可引用 / 虚构路径不发布 /
//      真形式凭据仍被拦
//   C. 结构判据：行段越界、越界路径、不在允许来源里的引用
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, setMeta } from './lib/helpers.mjs'

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t216-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const M = await import(PLUGIN)
const {
  apply, buildReferenceMap, referenceCatalogText, extractReferences, protectReferences,
  renderPhase2References, renderReferencePath, normalizeRefRelPath, verifyReferenceTarget, validatePhase2Output,
} = M

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

const root = () => path.join(HOME, 'memories')
const draftsDir = () => path.join(root(), 'rollout_summaries')
const SID = '9c0c360d-3aad-4886-a876-4597f688be81'   // 与真实数据同形（UUID）
const FOREIGN = 'deadbeef-1111-2222-3333-444455556666' // 从不出现在插件记录里的"看起来很像"的名字

fs.mkdirSync(draftsDir(), { recursive: true })
const writeDraft = (sid, extraLines = 1) => {
  const body = ['session_id: ' + sid, 'cwd: D:/x', '', '# 会话草稿', ...Array.from({ length: extraLines }, (_, i) => `- 结论 ${i + 1}（${sid}）`)].join('\n') + '\n'
  fs.writeFileSync(path.join(draftsDir(), sid + '.md'), body, 'utf8')
}
writeDraft(SID, 3)
writeDraft(FOREIGN, 1)

// ─────────────────────────────────────────────────────────────────────────────
// A. 纯函数层
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[A1] 映射只能由**插件既有记录**产生')
{
  const inputs = [{ session_id: SID, source_watermark: 'wm-1', rollout_slug: 'alpha-slug', cwd: 'D:/x' }]
  const map = buildReferenceMap({ memoryRoot: root(), inputs, sources: inputs, baselineTexts: [] })
  check(map.entries.length === 1 && map.entries[0].code === 'REF1', `只有本批输入进映射（entries=${map.entries.length}）`)
  check(map.entries[0].publicPath === `memories/rollout_summaries/${SID}.md`, `渲染路径=${map.entries[0].publicPath}（记忆根内真实文件）`)
  check(map.entries[0].sessionId === SID && map.entries[0].sourceVersion === 'wm-1', '来源身份=session_id / 源版本=source_watermark')
  check(map.entries[0].citableRegion === '1-7', `可引用区间=${map.entries[0].citableRegion}（行数实测，含末尾换行口径与插件一致）`)
  // 模型/网页声明不了条目：一个"磁盘上有、但不在记录里"的名字不进映射
  const map2 = buildReferenceMap({ memoryRoot: root(), inputs: [], sources: [], baselineTexts: [`v1\n- x → memories/rollout_summaries/${FOREIGN}.md`] })
  check(map2.entries.length === 0 && map2.unverified.length === 1, '记录里没有的来源 ⇒ 不进目录（磁盘上有同名文件也不算）')
  check(map2.unverified[0].reason === 'unresolvable-name', `标未验证（reason=${map2.unverified[0].reason}）而不是被当成可信`)
}

console.log('\n[A2] 目录只给代号 + 可读摘要')
{
  const inputs = [{ session_id: SID, source_watermark: 'wm-1', rollout_slug: 'alpha-slug', cwd: 'D:/x' }]
  const map = buildReferenceMap({ memoryRoot: root(), inputs, sources: inputs, baselineTexts: [] })
  const cat = referenceCatalogText(map)
  check(cat.includes('[[REF1]]') && cat.includes(`memories/rollout_summaries/${SID}.md`), '目录含代号与可读摘要')
  check(!/write the bare id|short id ALONE/i.test(cat), '目录里没有"写裸 id/短 id"这类逃生口')
  check(cat.split('\n').filter((l) => l.startsWith('- [[REF')).length === 1, '目录条数 = 映射条目数（模型加不进条目）')
}

console.log('\n[A3] 路径规范化/渲染（发布与读取共用同一约定）')
{
  check(normalizeRefRelPath('rollout_summaries/x.md') === 'rollout_summaries/x.md', '普通相对路径通过')
  check(normalizeRefRelPath('./rollout_summaries/x.md') === 'rollout_summaries/x.md', '`./` 前缀被剥掉')
  check(normalizeRefRelPath('rollout_summaries/../../etc/passwd.md') === '', '上越界（..）判非法')
  check(normalizeRefRelPath('/abs/rollout_summaries/x.md') === '', '绝对路径判非法')
  check(normalizeRefRelPath('C:\\x\\rollout_summaries\\y.md') === '', '盘符路径判非法')
  check(renderReferencePath('rollout_summaries/x.md') === 'memories/rollout_summaries/x.md', '渲染加 `memories/` 前缀')
  check(renderReferencePath('memories/rollout_summaries/x.md') === 'memories/rollout_summaries/x.md', '已带前缀不重复加')
}

console.log('\n[A4] 代号 → 真实路径（发布器渲染）；虚构引用不放过')
{
  const inputs = [{ session_id: SID, source_watermark: 'wm-1' }]
  const map = buildReferenceMap({ memoryRoot: root(), inputs, sources: inputs, baselineTexts: [] })
  const r1 = renderPhase2References('v1\n- 结论 → [[REF1]]', map)
  check(r1.text === `v1\n- 结论 → memories/rollout_summaries/${SID}.md`, `代号渲染为真实路径（${r1.text.split('→ ')[1]}）`)
  check(r1.used.length === 1 && r1.used[0] === 'REF1', '记录用到的代号（可观测）')
  const r2 = renderPhase2References(`v1\n- 结论 → rollout_summaries/${SID}.md`, map)
  check(r2.text === `v1\n- 结论 → memories/rollout_summaries/${SID}.md`, '精确匹配映射的**裸路径形态**也被渲染为统一约定')
  const r3 = renderPhase2References(`v1\n- 结论 → memories/rollout_summaries/${FOREIGN}.md`, map)
  check(r3.unmapped.length === 1 && r3.text.includes(FOREIGN), '映射外的路径 ⇒ 报 unmapped（调用方据此拒发）')
  const r4 = renderPhase2References('v1\n- 结论 → [[REF999]]', map)
  check(r4.unmapped.length === 1 && r4.unmapped[0].reason === 'unknown-reference-code', '未知代号 ⇒ 报 unmapped')
  const r5 = renderPhase2References('v1\n- 结论 → [[REF1:1-2]]', map)
  check(r5.text === `v1\n- 结论 → memories/rollout_summaries/${SID}.md:1-2`, '代号可带行段，渲染时保留')
}

console.log('\n[A5] 凭据字段里**不**享结构豁免（不存在 session_id 全局白名单）')
{
  const inputs = [{ session_id: SID, source_watermark: 'wm-1' }]
  const map = buildReferenceMap({ memoryRoot: root(), inputs, sources: inputs, baselineTexts: [] })
  const cred = `v1\n- session_id=memories/rollout_summaries/${SID}.md`
  const ex = extractReferences(cred, map)
  check(ex.tokens.length === 1 && ex.tokens[0].inCredentialField === true, '引用片段落在 `session_id=` 的值位置 ⇒ 标记为凭据字段内')
  check(protectReferences(cred, ex.tokens).protectedCount === 0, '凭据字段内的引用片段**不**被占位保护')
  const v = validatePhase2Output({ memory_summary: cred, registry: '# ok' }, { references: map })
  check(v.ok === false && v.errors.some((e) => e.includes('unredacted secret')), '⇒ 仍被秘密闸门拦下（不得借结构豁免绕过）')
  const okRef = `v1\n- 结论 → [[REF1]]`
  const ex2 = extractReferences(okRef, map)
  check(ex2.tokens.length === 1 && ex2.tokens[0].inCredentialField === false, '普通正文里的引用片段不算凭据字段')
  check(protectReferences(okRef, ex2.tokens).protectedCount === 1, '普通正文里的可信引用被占位保护（不会再被长串规则遮掉）')
  const v2 = validatePhase2Output({ memory_summary: okRef, registry: '# ok' }, { references: map })
  check(v2.ok === true, `带可信代号的总纲通过全部门（errors=${JSON.stringify(v2.errors)}）`)
}

console.log('\n[A6] 遗留引用：能用插件记录找回就找回，找不回就标未验证（不猜、不造文件）')
{
  const sources = [{ session_id: SID, rollout_slug: 'dsh-skill-inventory' }]
  const baseline = ['v1\n- x → memories/rollout_summaries/dsh-skill-inventory.md']
  const map = buildReferenceMap({ memoryRoot: root(), inputs: [], sources, baselineTexts: baseline })
  check(map.entries.length === 1 && map.entries[0].kind === 'baseline-slug' && map.entries[0].sessionId === SID,
    '短名经**插件记录的 rollout_slug** 找回真实来源（不猜测）')
  const r = renderPhase2References(baseline[0], map)
  check(r.text.includes(`memories/rollout_summaries/${SID}.md`), '渲染为找回后的真实路径')
  // 歧义：同一 slug 指向多个 session ⇒ 不猜
  const amb = buildReferenceMap({
    memoryRoot: root(), inputs: [],
    sources: [{ session_id: SID, rollout_slug: 'same-slug' }, { session_id: 'other-session', rollout_slug: 'same-slug' }],
    baselineTexts: ['v1\n- x → memories/rollout_summaries/same-slug.md'],
  })
  check(amb.entries.length === 0 && amb.unverified[0] && amb.unverified[0].reason === 'ambiguous-slug',
    '同 slug 指向多个会话 ⇒ 标歧义（未验证），不猜')
  const r2 = renderPhase2References('v1\n- x → memories/rollout_summaries/same-slug.md', amb)
  check(r2.text.includes('（未验证引用：same-slug.md）') && r2.unmapped.length === 0,
    '遗留未验证引用被**标记**（不阻断、不猜测、不静默丢弃）')
  check(!fs.existsSync(path.join(draftsDir(), 'same-slug.md')), '没有为它造空文件')
}

console.log('\n[A7] 结构判据：允许根 / 存在性 / 归属 / 行段')
{
  const inputs = [{ session_id: SID, source_watermark: 'wm-1' }]
  const map = buildReferenceMap({ memoryRoot: root(), inputs, sources: inputs, baselineTexts: [] })
  const e = map.entries[0]
  check(verifyReferenceTarget(e, { memoryRoot: root() }).ok === true, '存在 + 在允许根内 + 行段可核 ⇒ 通过')
  check(verifyReferenceTarget({ relPath: '../evil.md', sessionId: SID }, { memoryRoot: root() }).ok === false, '越界路径 ⇒ 不通过')
  check(verifyReferenceTarget({ relPath: 'rollout_summaries/nope.md', sessionId: SID }, { memoryRoot: root() }).ok === false, '目标不存在 ⇒ 不通过')
  check(verifyReferenceTarget(e, { memoryRoot: root(), lineRange: { start: 9, end: 99 } }).ok === false, '行段越界 ⇒ 不通过')
  check(verifyReferenceTarget(e, { memoryRoot: root(), allowedSessions: ['someone-else'] }).ok === false, '不属于本批允许来源 ⇒ 不通过')
  const v = validatePhase2Output({ memory_summary: `v1\n- x → [[REF1:1-99]]`, registry: '# ok' }, { references: map })
  check(v.ok === false && v.errors.some((x) => x.includes('line range out of bounds')), '渲染后的结构字段按结构判据验证（行段越界 → 不发布）')
}

// ─────────────────────────────────────────────────────────────────────────────
// B. 三类材料验收（隔离副本：只写 $DSH_HOME 临时目录）
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[B] 三类材料验收（隔离副本）')
let llmResponse = { memory_summary: 'v1\n## 索引\n- x → [[REF1]]', registry: '# MEMORY.md\n- x' }
let lastPrompt = ''
const llmMock = {
  stream: (opts) => {
    if (opts && String(opts.system).includes('memory-extraction')) {
      return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    }
    lastPrompt = (opts && opts.messages && opts.messages[0] && opts.messages[0].content && opts.messages[0].content[0] &&
      opts.messages[0].content[0].text) || ''
    const payload = JSON.stringify(llmResponse)
    return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  },
}
const tools = {}
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  tools: { register: (t) => { tools[t.name] = t } },
})
const currentFile = () => path.join(root(), 'current.json')
const readCurrent = () => { try { return JSON.parse(fs.readFileSync(currentFile(), 'utf8')) } catch { return null } }
const verSummary = (v) => { try { return fs.readFileSync(path.join(root(), 'versions', v, 'memory_summary.md'), 'utf8') } catch { return '' } }
function writeCurrent(summary, registry) {
  const id = 'p2-t216-' + Math.random().toString(36).slice(2, 8)
  const vd = path.join(root(), 'versions', id)
  fs.mkdirSync(vd, { recursive: true })
  fs.writeFileSync(path.join(vd, 'memory_summary.md'), summary, 'utf8')
  fs.writeFileSync(path.join(vd, 'MEMORY.md'), registry, 'utf8')
  fs.writeFileSync(currentFile(), JSON.stringify({ version: id }), 'utf8')
  return id
}
const clearQueue = async () => { const t = domain.table('phase2_jobs'); for (const k of [...t.keys()]) await t.delete(k) }
const lastJob = () => {
  const rows = [...domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v }))
  return rows[rows.length - 1] || {}
}
let seedN = 0
const seedOne = async (sid) => {
  writeDraft(sid, 3)
  seedN++
  await seedOutput(domain, 'j-t216-' + seedN, { session_id: sid, source_watermark: 'wm-' + seedN, rollout_summary: 'durable fact ' + seedN, generated_at: `2026-02-${String(seedN).padStart(2, '0')}T00:00:00.000Z` })
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
}

try {
  await apply(ctx, {})
  writeCurrent('v1\n## 旧总纲', '# MEMORY.md\n旧')

  // ① 合法来源路径**能被引用**（不再被遮）
  await clearQueue()
  const S1 = '11111111-2222-3333-4444-555555555555'
  await seedOne(S1)
  llmResponse = { memory_summary: 'v1\n## 索引\n- 结论一 → [[REF1]]', registry: '# MEMORY.md\n- 结论一' }
  await tools['memory__phase2_integrate'].execute({})
  const c1 = readCurrent()
  const s1 = verSummary(c1 && c1.version)
  check(!!c1 && s1.includes(`memories/rollout_summaries/${S1}.md`), `材料①：合法来源可引用，发布文本含真实路径（${s1.split('\n').pop().slice(0, 60)}）`)
  check(!s1.includes('[[') && !s1.includes('[REDACTED]'), '材料①：发布文本无残留代号、路径**没有**被重新遮掉')
  check(!!lastPrompt.match(/SOURCE REFERENCE CATALOG/) && lastPrompt.includes('[[REF1]]'), '材料①：提示词里给了代号目录（模型只拿代号）')

  // ①b 精确匹配映射的裸路径形态（保留完整路径时的豁免边界）
  await clearQueue()
  const S2 = '22222222-3333-4444-5555-666666666666'
  await seedOne(S2)
  llmResponse = { memory_summary: `v1\n## 索引\n- 结论二 → rollout_summaries/${S2}.md`, registry: '# MEMORY.md\n- 结论二' }
  await tools['memory__phase2_integrate'].execute({})
  const c2 = readCurrent()
  check(!!c2 && c2.version !== (c1 && c1.version) && verSummary(c2.version).includes(`memories/rollout_summaries/${S2}.md`), '材料①b：精确匹配映射的裸路径也被渲染为统一约定并发布')

  // ② 虚构路径**不发布**
  await clearQueue()
  const S3 = '33333333-4444-5555-6666-777777777777'
  await seedOne(S3)
  const beforeV = readCurrent().version
  llmResponse = { memory_summary: `v1\n## 索引\n- 虚构 → memories/rollout_summaries/${FOREIGN}.md`, registry: '# MEMORY.md\n- 虚构' }
  await tools['memory__phase2_integrate'].execute({})
  const job2 = lastJob()
  check(readCurrent().version === beforeV, '材料②：虚构路径 ⇒ 不发布（current.json 未变）')
  check(String(job2.last_error || '').includes('unmapped reference'), `材料②：失败原因可读（${String(job2.last_error || '').slice(0, 72)}）`)
  check(fs.existsSync(path.join(draftsDir(), FOREIGN + '.md')), '（前提）磁盘上**确实**有这个文件 —— 仍然不算可信、仍不发布')

  // ②c 形似但不精确（同一目录、同一后缀）也不豁免
  await clearQueue()
  await seedOne('44444444-5555-6666-7777-888888888888')
  const beforeV2 = readCurrent().version
  llmResponse = { memory_summary: 'v1\n## 索引\n- 形似 → memories/rollout_summaries/rollout_summaries-notes.md', registry: '# MEMORY.md\n- 形似' }
  await tools['memory__phase2_integrate'].execute({})
  check(readCurrent().version === beforeV2, '材料②c：只因"长得像" ⇒ 不豁免、不发布')

  // ③ 真形式凭据**仍被拦**
  const U = '5b54ab55-5a1d-483b-be03-92daef2635ce'
  const credCases = [
    ['Cookie 里的会话 id', `v1\n## 索引\n- 结论 → [[REF1]]\n- Cookie: SID=${U}`],
    ['Authorization: Bearer <长 token>', `v1\n## 索引\n- 结论 → [[REF1]]\n- Authorization: Bearer AbCdEf0123456789AbCdEf0123456789AbCdEf01`],
    ['认证用 session_id（形似 UUID 也是凭据）', `v1\n## 索引\n- 结论 → [[REF1]]\n- session_id: ${U}`],
    ['引用片段落在凭据字段内', `v1\n## 索引\n- session_id=memories/rollout_summaries/S_PLACEHOLDER.md`],
  ]
  for (const [label, tmpl] of credCases) {
    await clearQueue()
    const sid = '55555555-6666-7777-8888-999999999999'
    await seedOne(sid)
    const before = readCurrent().version
    llmResponse = { memory_summary: tmpl.replace('S_PLACEHOLDER', sid), registry: '# MEMORY.md\n- x' }
    await tools['memory__phase2_integrate'].execute({})
    const j = lastJob()
    const err = String(j.last_error || '')
    check(readCurrent().version === before && err.includes('unredacted secret'), `材料③：${label} ⇒ 仍被拦（${err.slice(0, 60)}）`)
  }
} finally {
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T216 D1-REFERENCE-MAP TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
