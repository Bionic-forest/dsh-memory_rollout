// t80/t82 验收：记忆总纲三层闸门 + 一次性强制压缩 + 分层披露 + 上限参数化 + 压缩批与安全门对齐。
// 在隔离沙箱（DSH_HOME=临时目录）里跑；真实记忆库只读。
//
// 大总纲夹具：优先用环境变量 T80_FIXTURE 指向的真实 memory_summary.md；
// 没有就用**合成**的 >120k 字符总纲（保证本测试可随仓库自带、不依赖 225KB 私有夹具）。
import assert from 'node:assert'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, setMeta } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const M = await import(PLUGIN)
const { apply, clampPromptInputs, summaryCapFromTokens, registryCapFromTokens, validatePhase2Output } = M
const sha256 = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex')

let lastPrompt = ''
let lastSystem = ''
let consolidationCalls = 0
let llmResponse = { memory_summary: 'v1\n## ok', registry: '# MEMORY.md\nok' }
const llmMock = {
  stream: (opts) => {
    if (opts && String(opts.system).includes('memory-extraction')) {
      return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    }
    consolidationCalls++
    lastSystem = String((opts && opts.system) || '')
    lastPrompt =
      (opts && opts.messages && opts.messages[0] && opts.messages[0].content && opts.messages[0].content[0] &&
        opts.messages[0].content[0].text) || ''
    const payload = JSON.stringify(llmResponse)
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: payload }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

const tools = {}
const { ctx, domain } = makeCtx({
  get: (k) =>
    k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined,
  tools: { register: (t) => { tools[t.name] = t } },
})

const tmp = path.join(os.tmpdir(), 'dsh-t80-gate-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const root = () => path.join(tmp, 'memories')
const currentFile = () => path.join(root(), 'current.json')
const readCurrent = () => { try { return JSON.parse(fs.readFileSync(currentFile(), 'utf8')) } catch { return null } }
const verSummary = (v) => { try { return fs.readFileSync(path.join(root(), 'versions', v, 'memory_summary.md'), 'utf8') } catch { return '' } }

function writeCurrent(summary, registry) {
  const id = 'p2-t80-' + Math.random().toString(36).slice(2, 8)
  const vd = path.join(root(), 'versions', id)
  fs.mkdirSync(vd, { recursive: true })
  fs.writeFileSync(path.join(vd, 'memory_summary.md'), summary, 'utf8')
  fs.writeFileSync(path.join(vd, 'MEMORY.md'), registry, 'utf8')
  fs.writeFileSync(path.join(vd, 'manifest.json'), JSON.stringify({
    version: id, summary_file: 'memory_summary.md', registry_file: 'MEMORY.md', manifest_file: 'manifest.json',
    summary_sha256: sha256(summary), registry_sha256: sha256(registry),
    phase2_authoritative: true, created_at: new Date().toISOString(),
  }, null, 2), 'utf8')
  fs.writeFileSync(currentFile(), JSON.stringify({ version: id }), 'utf8')
  return id
}

let failed = 0
const check = (cond, msg) => { if (cond) console.log('  ✓ ', msg); else { failed++; console.error('  ✗ ', msg) } }
const clearQueue = async () => { const t = domain.table('phase2_jobs'); for (const k of [...t.keys()]) await t.delete(k) }

// ── 大总纲夹具（真实优先，否则合成）──
function bigFixture() {
  const p = process.env.T80_FIXTURE
  if (p) { try { const s = fs.readFileSync(p, 'utf8'); if (Array.from(s).length > 120000) return { text: s, real: true } } catch { /* fallthrough */ } }
  const body = Array.from({ length: 900 }, (_, i) => `#### 2026-01-${(i % 28) + 1}\n- D:\\proj${i}: task-${i}（合成夹具，无私有数据）: ` + 'x'.repeat(120)).join('\n')
  return { text: 'v1\n## User Profile\n- (synthetic fixture)\n## What\'s in Memory\n### 会话草稿\n' + body, real: false }
}
const FIX = bigFixture()
const REAL_SUMMARY = FIX.text
const MARK_LEN = 10

try {
  await apply(ctx, {})

  console.log(`[夹具] 大总纲来源=${FIX.real ? '真实 memory_summary.md' : '合成'}  字符数=${Array.from(REAL_SUMMARY).length}`)

  // ── ⑥ 上限参数化 ──
  console.log('[⑥] 上限参数化')
  check(summaryCapFromTokens(4000) === 14400, `summaryTokens=4000 → ${summaryCapFromTokens(4000)}`)
  check(summaryCapFromTokens(8000) === 28800 && summaryCapFromTokens(12000) === 43200, '8000→28800 / 12000→43200')
  check(summaryCapFromTokens(undefined) === 14400, '未设 → 14400')
  check(registryCapFromTokens(4000) === 24000, `registry → ${registryCapFromTokens(4000)}`)
  check(summaryCapFromTokens(4000) < 16000, '生成上限 < 注入闸门 16000')

  // ── ① L1 输入限量 ──
  console.log('[①] L1 输入限量')
  const inputs25 = Array.from({ length: 25 }, (_, i) => ({ source_watermark: 'wm' + i, session_id: 's' + i, rollout_summary: 'X'.repeat(2000) }))
  const clad = clampPromptInputs(inputs25, REAL_SUMMARY, 'R'.repeat(20000), {})
  check(Array.from(REAL_SUMMARY).length > 120000, `大总纲字符数=${Array.from(REAL_SUMMARY).length} > 120k`)
  // S0-2（2026-09-13）：当前权威文件**整篇传入、不再截断**——旧断言「截到 12000 / 6000」已退役，
  // 那正是「模型没看到 ⇒ 全文替换时静默丢结论」的根因。现在断言相反的不变量：整篇原样 + 截断状态可观测。
  check(clad.currentSummary === REAL_SUMMARY, `currentSummary 整篇传入（${Array.from(clad.currentSummary).length} 字符，未截断）`)
  check(clad.currentRegistry === 'R'.repeat(20000), `currentRegistry 整篇传入（${clad.currentRegistry.length} 字符，未截断）`)
  check(clad.truncatedCurrent.summary === false && clad.truncatedCurrent.registry === false, 'truncatedCurrent 恒为 false（当前权威文件不截断）')
  check(clad.currentChars.summary === Array.from(REAL_SUMMARY).length && clad.currentChars.registry === 20000, 'currentChars 如实反映整篇长度（可观测）')
  check(clad.inputs.length === 20 && clad.droppedInputs === 5, `inputs=${clad.inputs.length} dropped=${clad.droppedInputs}`)
  check(clad.inputs.every((x) => x.rollout_summary.length <= 600 + MARK_LEN), '每条 input ≤600+mark')
  check(clad.clampedInputs === 20, `clampedInputs=${clad.clampedInputs}（增量输入被截断的条数，可观测）`)

  // ── ② L2 生成限长 ──
  console.log('[②] L2 生成限长')
  writeCurrent('v1\n## 旧总纲', '# MEMORY.md\n旧注册表')
  await seedOutput(domain, 'j-a', { source_watermark: 'wmA', session_id: 'sA', rollout_summary: 'a durable fact', generated_at: '2026-01-01T00:00:00.000Z' })
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  await tools['memory__phase2_integrate'].execute({})
  check(lastSystem.includes('HARD SIZE BUDGET') && lastSystem.includes('NEVER copy the registry verbatim'), 'system 规则 4/5')
  check(lastSystem.includes('Progressive disclosure') && lastSystem.includes('Every line must carry durable information'), 'system 规则 6/7')
  check(lastSystem.includes('Keep everything already present unless a new input supersedes it'), '原规则 1 保留')
  check(lastPrompt.includes('## SIZE BUDGET') && lastPrompt.includes(String(summaryCapFromTokens(4000))), 'prompt 含动态 SIZE BUDGET=14400')
  check(!lastPrompt.includes('## COMPRESSION MODE'), '普通批不含 COMPRESSION MODE')

  // ── ③ L3 校验拒收 ──
  console.log('[③] L3 尺寸校验 + 回归')
  const capS = summaryCapFromTokens(4000)
  check(validatePhase2Output({ memory_summary: 'v1\n' + 'x'.repeat(capS), registry: '# ok' }, { maxSummaryChars: capS, maxRegistryChars: 24000 }).ok === false, '超限拒收')
  check(validatePhase2Output({ memory_summary: 'v1\nok', registry: '# ok' }, { maxSummaryChars: capS, maxRegistryChars: 24000 }).ok === true, '合规通过')
  check(validatePhase2Output({ memory_summary: '# v1\nx', registry: '# ok' }).ok === false, '回归：非裸 v1')
  check(validatePhase2Output({ memory_summary: 'v1', registry: '' }).ok === false, '回归：registry 空')
  check(validatePhase2Output({ memory_summary: 'v1 sk-' + 'a'.repeat(40), registry: '# ok' }).ok === false, '回归：未脱敏秘密')
  check(validatePhase2Output({ memory_summary: 'v1', registry: 'see rollout_summaries/../../etc/passwd.md' }).ok === false, '回归：越界引用')
  check(validatePhase2Output({ memory_summary: 'v1\nok', registry: '# ok' }, {}).ok === true, '不传上限 → 向后兼容')
  // t82 负控：`session_id: <uuid>` 一定会被安全门拒（复现 p2-mtwnex4u-513mae 的失败形态）
  const sessHit = validatePhase2Output({ memory_summary: 'v1\n- 会话 session_id: 5b54ab55-5a1d-483b-be03-92daef2635ce', registry: '# ok' }, { maxSummaryChars: capS, maxRegistryChars: 24000 })
  check(sessHit.ok === false && sessHit.errors.some((e) => e.includes('unredacted secret')), '负控：`session_id: <uuid>` 被安全门拒（根因复现）')
  // 保留 `[REDACTED]` 与既有 `(session=…)` 写法不触发门
  check(validatePhase2Output({ memory_summary: 'v1\n- 结论（session=5b54ab55-5a1d-483b-be03-92daef2635ce）', registry: '# ok' }, { maxSummaryChars: capS, maxRegistryChars: 24000 }).ok === false, 't82 更正：`(session=<完整uuid>)` 也触发门（规则 8 长 token 启发式）')

  // ── ③-e2e 超限不发布 ──
  console.log('[③-e2e] 超限输出端到端不发布 / 合规发布')
  const idA = writeCurrent('v1\n## 旧总纲A', '# MEMORY.md\n旧A')
  llmResponse = { memory_summary: 'v1\n' + 'y'.repeat(capS + 500), registry: '# MEMORY.md\nbig' }
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  await seedOutput(domain, 'j-b', { source_watermark: 'wmB', session_id: 'sB', rollout_summary: 'b fact', generated_at: '2026-01-02T00:00:00.000Z' })
  await tools['memory__phase2_integrate'].execute({})
  check(readCurrent() && readCurrent().version === idA, '超限不发布，current.json 未变')
  await clearQueue()
  llmResponse = { memory_summary: 'v1\n## 索引\n- 结论A → memories/rollout_summaries/sA.md', registry: '# MEMORY.md\nok' }
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  await tools['memory__phase2_integrate'].execute({})
  check(readCurrent().version !== idA, `合规发布新版本 ${readCurrent().version}`)

  // ── t83 普通批：注册表含 `session_id:` → 负控 / 正控 ──
  console.log('[t83] 普通批同款禁令 + 注册表含 `session_id:` 的负控/正控')
  check(lastSystem.includes('ABSOLUTELY FORBIDDEN'), 't83：普通批 system 含「禁 key: value 元数据」')
  check(lastSystem.includes('never attach a label or key to a session id'), 't83：普通批 system 含「禁给 session id 加键名」')
  check(lastSystem.includes('never un-redact'), 't83：普通批 system 含「[REDACTED] 原样保留」')
  check(lastSystem.includes('Keep everything already present unless a new input supersedes it'), 't83：原规则 1 仍在')
  for (const k of ['session_id', 'token', 'api_key', 'secret', 'auth', 'password', 'access_token', 'client_secret']) {
    check(lastSystem.includes(k), `t83：普通批点名禁用 ${k}`)
  }
  const U3 = '5b54ab55-5a1d-483b-be03-92daef2635ce'
  const REG_WITH_SID = `# MEMORY.md\n# Long-term memories\n- [tag] 某事实 (session_id: ${U3})\n`
  // 负控：普通批（有新的 stage-1 输入），模型照抄注册表的 session_id: → 被拒、不发布
  await clearQueue()
  const idN = writeCurrent('v1\n## 旧', REG_WITH_SID)
  llmResponse = { memory_summary: `v1\n- 结论（session_id: ${U3}）`, registry: REG_WITH_SID }
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  await seedOutput(domain, 'j-n1', { source_watermark: 'wmN1', session_id: 'sN1', rollout_summary: 'new durable fact', generated_at: '2026-01-03T00:00:00.000Z' })
  await tools['memory__phase2_integrate'].execute({})
  check(lastPrompt.includes('session_id:'), 't83：普通批 prompt 确实把含 `session_id:` 的注册表喂给了模型（风险真实）')
  check(!lastPrompt.includes('## COMPRESSION MODE'), 't83：该批确为普通批（非压缩批）')
  check(readCurrent().version === idN, 't83 负控：普通批照抄 session_id: → 被拒、current.json 未变')
  // 正控：合规（无键名元数据、索引+指针）→ 发布
  await clearQueue()
  llmResponse = { memory_summary: 'v1\n## 索引\n- 结论N → memories/rollout_summaries/sN1.md', registry: '# MEMORY.md\n- 结论N' }
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  await seedOutput(domain, 'j-n2', { source_watermark: 'wmN2', session_id: 'sN2', rollout_summary: 'another fact', generated_at: '2026-01-04T00:00:00.000Z' })
  await tools['memory__phase2_integrate'].execute({})
  check(readCurrent().version !== idN, `t83 正控：合规输出发布新版本 ${readCurrent().version}`)
  check(Array.from(verSummary(readCurrent().version)).length <= capS, 't83 正控：新总纲 ≤ 上限')

  // ── ④/⑤ 一次性强制压缩 + 分层披露 + t82 提示词对齐 ──
  console.log('[④/⑤/t82] 强制压缩：显式触发 + 上限内 + 指针 + 禁 key:value 元数据')
  await clearQueue()
  const big = 'v1\n' + Array.from({ length: 400 }, (_, i) => `- 结论${i}：` + 'z'.repeat(300)).join('\n')
  const idBig = writeCurrent(big, '# MEMORY.md\nbig')
  check(Array.from(big).length > capS, `超限总纲=${Array.from(big).length} > ${capS}`)
  await tools['memory_integrate'].execute({})
  check([...domain.table('phase2_jobs').entries()].filter(([, j]) => j && j.mode === 'compress').length === 0, '不传 compress → 不创建压缩批')
  const enq = await tools['memory_integrate'].execute({ compress: true })
  const cJobs = [...domain.table('phase2_jobs').entries()].filter(([, j]) => j && j.mode === 'compress')
  check(enq.enqueued === true && !!enq.batchId, `compress:true → enqueued（batchId=${enq.batchId}）`)
  check(cJobs.length === 1 && cJobs[0][1].input_ids.length === 0 && cJobs[0][1].change_ids.length === 0, '恰 1 个压缩批且无 input/change')
  llmResponse = { memory_summary: 'v1\n## 索引\n' + Array.from({ length: 30 }, (_, i) => `- 结论${i} → memories/rollout_summaries/s${i}.md`).join('\n'), registry: '# MEMORY.md\nindex' }
  await tools['memory__phase2_integrate'].execute({})
  check(lastPrompt.includes('## COMPRESSION MODE'), '压缩批 prompt 含 COMPRESSION MODE')
  check(lastPrompt.includes('ABSOLUTELY FORBIDDEN'), 't82：prompt 含「禁 key: value 元数据」')
  for (const k of ['session_id', 'token', 'api_key', 'secret', 'auth', 'password', 'access_token', 'client_secret']) {
    check(lastPrompt.includes(k), `t82：点名禁用 ${k}`)
  }
  check(lastPrompt.includes('[REDACTED]'), 't82：要求既有 [REDACTED] 原样保留')
  check(lastPrompt.includes('never attach a label or key to a session id'), 't82：禁止给会话 id 加键名/标签')
  check(!lastPrompt.includes('keep the existing inline style'), 't82：不再建议 (session=<id>) 写法（该写法也会撞门）')
  // t82 双陷阱实证（探针）：两种键名写法都被拒；裸 id / 短 id 通过
  const UU = '5b54ab55-5a1d-483b-be03-92daef2635ce'
  check(validatePhase2Output({ memory_summary: `v1\n- x session_id: ${UU}`, registry: '# ok' }, { maxSummaryChars: capS, maxRegistryChars: 24000 }).ok === false, 't82 陷阱1：`session_id: <uuid>` 被拒')
  check(validatePhase2Output({ memory_summary: `v1\n- x（session=${UU}）`, registry: '# ok' }, { maxSummaryChars: capS, maxRegistryChars: 24000 }).ok === false, 't82 陷阱2：`(session=<uuid>)` 也被拒')
  check(validatePhase2Output({ memory_summary: `v1\n- x ${UU}`, registry: '# ok' }, { maxSummaryChars: capS, maxRegistryChars: 24000 }).ok === true, '裸 uuid（无键名）→ 通过')
  check(validatePhase2Output({ memory_summary: 'v1\n- x (session=5b54ab55)', registry: '# ok' }, { maxSummaryChars: capS, maxRegistryChars: 24000 }).ok === true, '短 id 带键名 → 通过')
  const after = readCurrent()
  check(after.version !== idBig, `压缩批成功发布新版本 ${after.version}`)
  const ns = verSummary(after.version)
  check(Array.from(ns).length <= capS, `新总纲=${Array.from(ns).length} ≤ ${capS}`)
  check(ns.includes('rollout_summaries/s0.md'), '分层披露：含指针')
  // 发布产物必须仍能过 L3（含安全门）
  check(validatePhase2Output({ memory_summary: ns, registry: '# MEMORY.md\nindex' }, { maxSummaryChars: capS, maxRegistryChars: 24000 }).ok === true, '发布产物仍通过 L3 全部门')

  // ── ⑦ entries 零改动 + 调度器不自动创建压缩批 ──
  console.log('[⑦] entries 零改动 + 调度器不自动压')
  const entriesBefore = JSON.stringify([...domain.table('entries').entries()])
  const nBefore = [...domain.table('phase2_jobs').entries()].filter(([, j]) => j && j.mode === 'compress').length
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  await tools['memory__phase2_integrate'].execute({})
  const nAfter = [...domain.table('phase2_jobs').entries()].filter(([, j]) => j && j.mode === 'compress').length
  check(nAfter === nBefore, `调度器未新增压缩批（${nBefore}→${nAfter}）`)
  check(JSON.stringify([...domain.table('entries').entries()]) === entriesBefore, 'entries 表逐字未变')

  // ── ④-b 确定性索引化（大总纲 → 上限内 + 指针）──
  console.log('[④-b] 确定性索引化可达上限内')
  const idx = 'v1\n## User Profile\n- 索引\n## What\'s in Memory\n' +
    REAL_SUMMARY.split('\n').filter((l) => /^####\s/.test(l) || /^- /.test(l)).slice(0, 80)
      .map((l) => '- ' + Array.from(l.replace(/^#+\s*/, '').replace(/^-\s*/, '')).slice(0, 80).join('') + ' → memories/rollout_summaries/<sessionId>.md').join('\n')
  check(Array.from(idx).length <= capS, `索引化=${Array.from(idx).length} ≤ ${capS}（源 ${Array.from(REAL_SUMMARY).length}）`)
} catch (e) {
  failed++
  console.error('  ✗ 未捕获异常: ' + String((e && e.stack) || e))
}

console.log('')
if (failed > 0) { console.error(`${failed} CHECK(S) FAILED`); process.exit(1) }
console.log('ALL T80/T82 GATE TESTS PASSED')
