// t234（F2 返修 · 独立复核 §4）：**版本身份必须跨越「原始输出 → 渲染 → 校验 → 发布」全过程**。
//
// 复核复现的缺陷：生产链是 `renderPhase2References`（代号 → 物理路径 + 行段）**先**、
// `validatePhase2Output` **后**；渲染后文本里已无版本信息，而校验期按"最新版本"重新解析 ⇒
//   · `[[REF旧:旧段]]`（合法旧引用）→ 被当成最新版本 ⇒ 行段越界 ⇒ **误拒**；
//   · `[[REF旧:新段]]`（旧版本冒用新段）→ 被当成最新版本 ⇒ 行段成立 ⇒ **误发布**。
// 本测试**走真实函数链**（`apply` → `memory__phase2_integrate` → `processPhase2Batch` → 发布）：
//   ① 合法：同一批**同时**引用两个版本各自的行段 ⇒ 可发布，且产物里两条引用都指向正确行段；
//   ② 错配：旧代号 + 新段 ⇒ **不可发布**（理由含 evidence segment），指针不动、无新版本目录。
// 用的都是合成数据 + 临时 DSH_HOME + 模拟宿主，不调真实模型。
import assert from 'node:assert'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, setMeta } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t234-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const root = () => path.join(HOME, 'memories')
const readCurrent = () => { try { return JSON.parse(fs.readFileSync(path.join(root(), 'current.json'), 'utf8')) } catch { return null } }
const verSummary = (v) => { try { return fs.readFileSync(path.join(root(), 'versions', v, 'memory_summary.md'), 'utf8') } catch { return '' } }
const sha = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex')

// 生产形态：同一会话的 append-only 证据文件，版本一在第 8 行、版本二在第 17 行。
const S = 'd2340000-1111-4222-8333-444455556666'
const rel = `rollout_summaries/${S}.md`
const lines = [
  `session_id: ${S}`, 'updated_at: 2026-09-15T00:00:00.000Z', 'cwd: C:/proj', 'slug: ver-one', '', '# 会话草稿 版本一', '',
  '- 结论：采用旧方案 A（version-1 的证据段）', '',
  `session_id: ${S}`, 'updated_at: 2026-09-15T01:00:00.000Z', 'cwd: C:/proj', 'slug: ver-two', '', '# 会话草稿 版本二', '',
  '- 用户纠正：撤销方案 A，改用方案 B（version-2 的证据段）',
]
fs.mkdirSync(path.join(root(), 'rollout_summaries'), { recursive: true })
fs.writeFileSync(path.join(root(), rel), lines.join('\n') + '\n', 'utf8')

// ── 模拟整合模型：**从提示词里的可信目录读出代号 → 水位的映射**，再据此构造引用 ────────────
let mode = 'legit'
let oldWm = 'wm-old'
let newWm = 'wm-new'
let catalogSeen = ''
const catalogOf = (prompt) => {
  const out = {}
  const re = /- \[\[(REF\d+)\]\] = ([^\n]*?)\| watermark=([^|\n]+)(?:\| lines=(\d+)-(\d+))?/g
  let m
  while ((m = re.exec(prompt)) !== null) out[String(m[3]).trim()] = { code: m[1], lines: m[4] && m[5] ? `${m[4]}-${m[5]}` : '' }
  return out
}
const llmMock = {
  stream: (opts) => {
    const isExtraction = String((opts && opts.system) || '').includes('memory-extraction')
    let payload = { rollout_summary: 's', raw_memory: 'r', slug: 's', keywords: '', title: '' }
    if (!isExtraction) {
      const prompt = String(((opts.messages || [])[0] || {}).content?.[0]?.text || '')
      catalogSeen = prompt
      const cat = catalogOf(prompt)
      const eOld = cat[oldWm] || { code: 'REF1', lines: '8-8' }
      const eNew = cat[newWm] || { code: 'REF2', lines: '17-17' }
      const summary = mode === 'legit'
        ? `v1\n## 索引\n- 旧结论（已被推翻，保留背景）[[${eOld.code}:${eOld.lines}]]\n- 新结论 B（生效）[[${eNew.code}:${eNew.lines}]]`
        : `v1\n## 索引\n- 旧结论误配新段 [[${eOld.code}:${eNew.lines}]]`
      payload = { memory_summary: summary, registry: '# MEMORY.md\n- 合成注册表' }
    }
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: JSON.stringify(payload) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}
const REG = {}
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm' ? llmMock
    : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  tools: { register: (t) => { if (t && t.name) REG[t.name] = t } },
})
const jobsOf = () => [...domain.table('phase2_jobs').entries()].map(([, j]) => j)
const seedVersionOutputs = async (suffix, baseTime) => {
  const ref = (startLine, endLine) => ({ path: rel, startLine, endLine, citeSpan: lines[startLine - 1], sessionId: S })
  const stamp = sha(suffix)
  await seedOutput(domain, `j-${suffix}-old`, {
    session_id: S, source_watermark: `wm-old${suffix}`, rollout_slug: 'ver-one',
    rollout_summary: '采用旧方案 A', generated_at: new Date(baseTime).toISOString(),
    source_ref: ref(8, 8), content_hash: stamp.slice(0, 8),
  })
  await seedOutput(domain, `j-${suffix}-new`, {
    session_id: S, source_watermark: `wm-new${suffix}`, rollout_slug: 'ver-two',
    rollout_summary: '撤销 A，改用 B', generated_at: new Date(baseTime + 3600000).toISOString(),
    source_ref: ref(17, 17), content_hash: stamp.slice(8, 16),
  })
}

try {
  await apply(ctx, {})
  assert.ok(REG['memory__phase2_integrate'], 'phase2 tool registered')
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })

  // ── ① 合法：同一批同时引用两个版本各自的段 ⇒ 可发布 ─────────────────────────
  oldWm = 'wm-oldA'; newWm = 'wm-newA'; mode = 'legit'
  await seedVersionOutputs('A', Date.parse('2026-09-15T00:00:00.000Z'))
  const p1 = await REG['memory__phase2_integrate'].execute({})
  check(p1.ran === true && p1.ok === true, `① 合法旧引用 + 新引用同一批 ⇒ 可发布（ran=${p1.ran} ok=${p1.ok}）`)
  check(catalogSeen.includes('watermark=wm-oldA') && catalogSeen.includes('watermark=wm-newA'),
    '① 批提示词里两个版本各自成条目（watermark 可见）')
  const cur1 = readCurrent()
  const out1 = cur1 ? verSummary(cur1.version) : ''
  check(out1.includes(`${rel}:8-8`), `① 产物里保留旧版本自己的行段（:8-8；实测 ${out1.replace(/\n/g, ' ⏎ ').slice(0, 120)}）`)
  check(out1.includes(`${rel}:17-17`), '① 产物里保留新版本自己的行段（:17-17）')
  if (!p1.ok) console.log('    errors:', JSON.stringify(p1.errors))

  // ── ② 错配：旧代号 + 新段 ⇒ 不可发布 ───────────────────────────────────────
  oldWm = 'wm-oldB'; newWm = 'wm-newB'; mode = 'mismatch'
  await seedVersionOutputs('B', Date.parse('2026-09-15T02:00:00.000Z'))
  const curBefore = readCurrent()
  const p2 = await REG['memory__phase2_integrate'].execute({})
  const errs = Array.isArray(p2.errors) ? p2.errors.join(' | ') : String(p2.errors || '')
  check(p2.ran === true && p2.ok === false, `② 旧代号冒用新段 ⇒ 不发布（ran=${p2.ran} ok=${p2.ok}）`)
  check(errs.includes('evidence segment'), `② 理由写明行段不属于该版本（"${errs.slice(0, 110)}…"）`)
  const curAfter = readCurrent()
  check(curAfter && curBefore && curAfter.version === curBefore.version,
    `② 指针未推进（前=${curBefore && curBefore.version} 后=${curAfter && curAfter.version}）`)
  const b2 = jobsOf().find((j) => j && j.status === 'retry_wait')
  check(!!b2, `② 该批落 retry_wait（实测 ${b2 && b2.status}）`)
} finally {
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T234 F2 VERSION-IDENTITY E2E TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
