// t232（F2 · 评审 §三 F2）：**同一来源的多个版本 + 行段必须绑定到该版本**。
//
// 旧实现 `buildReferenceMap` 按物理路径去重 ⇒ 同一会话被追加的多个版本被合并成一个目录项（版本记的是
// **最先出现**的那个），而可引用区域取**整份文件**行数 ⇒ **旧版本条目引用新版本的行**仍判 ok。
//   本测试按**生产形态**（append-only 证据文件 + 每条输出自带 `source_ref` 行段）构造两个版本：
//     · 两个版本、两段行段在映射里**可区分**（各自代号 / watermark / 行段）；
//     · 旧版本代号引用新版本的行段 ⇒ **不通过**（含 segment 理由）；
//     · 新版本代号引用自己的行段 ⇒ 通过；裸代号 ⇒ 渲染成**它自己那一段**的行段（不落成"整份文件"）；
//     · 端到端：`validatePhase2Output` 对上述错配引用 ⇒ **整批不发布**。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildReferenceMap, referenceCatalogText, extractReferences, renderPhase2References,
  verifyReferenceTarget, validatePhase2Output,
} from '../lib/index.js'

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t232-' + Math.random().toString(36).slice(2, 8))
const root = path.join(HOME, 'memories')
fs.mkdirSync(path.join(root, 'rollout_summaries'), { recursive: true })

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

const S = 'c0ffee00-1111-4222-8333-444455556666'
const rel = `rollout_summaries/${S}.md`
const lines = [
  `session_id: ${S}`,                                  // 1
  'updated_at: 2026-09-15T00:00:00.000Z',              // 2
  'cwd: C:/proj',                                      // 3
  'slug: ver-one',                                     // 4
  '',                                                  // 5
  '# 会话草稿 版本一',                                   // 6
  '',                                                  // 7
  '- 结论：采用旧方案 A（version-1 的证据段）',             // 8
  '',                                                  // 9
  `session_id: ${S}`,                                  // 10
  'updated_at: 2026-09-15T01:00:00.000Z',              // 11
  'cwd: C:/proj',                                      // 12
  'slug: ver-two',                                     // 13
  '',                                                  // 14
  '# 会话草稿 版本二',                                   // 15
  '',                                                  // 16
  '- 用户纠正：撤销方案 A，改用方案 B（version-2 的证据段）',  // 17
]
fs.writeFileSync(path.join(root, rel), lines.join('\n') + '\n', 'utf8')

// 生产形态：每条 stage-1 输出自带 source_ref（path + 该版本证据段的行范围）。
const V1 = {
  job_id: 'j-v1', session_id: S, source_watermark: 'wm-v1', rollout_slug: 'ver-one',
  rollout_summary: '采用旧方案 A', generated_at: '2026-09-15T00:00:00.000Z',
  source_ref: { path: rel, startLine: 8, endLine: 8, citeSpan: lines[7], sessionId: S },
}
const V2 = {
  job_id: 'j-v2', session_id: S, source_watermark: 'wm-v2', rollout_slug: 'ver-two',
  rollout_summary: '撤销 A，改用 B', generated_at: '2026-09-15T01:00:00.000Z',
  source_ref: { path: rel, startLine: 17, endLine: 17, citeSpan: lines[16], sessionId: S },
}

// 改前树上没有 `byVersion` / `segment` 这些新面 —— 给**断言级红**而不是 TypeError 崩掉整份文件（0✓0✗）。
const section = async (label, fn) => {
  try { return await fn() } catch (err) {
    check(false, `${label} 中断（改前树上属预期的断言级红）：${err && err.message ? err.message : err}`)
  }
}

try {
  await section('[F2]', async () => {
  const map = buildReferenceMap({ memoryRoot: root, inputs: [V1, V2], sources: [], baselineTexts: [''] })
  const e1 = map.byVersion.get(`${S}::wm-v1`)
  const e2 = map.byVersion.get(`${S}::wm-v2`)

  check(map.entries.length === 2, `同一来源的两个版本 = 两个代号（实测 ${map.entries.length}）`)
  check(!!e1 && !!e2 && e1.code !== e2.code, `两个版本各有独立代号（${e1 && e1.code} / ${e2 && e2.code}）`)
  check(e1 && e1.sourceVersion === 'wm-v1' && e2 && e2.sourceVersion === 'wm-v2', '版本字段各自独立（不再只记最先出现那个）')
  check(e1 && e1.citableRegion === '8-8' && e2 && e2.citableRegion === '17-17',
    `可引用区 = 该版本自己的证据段（${e1 && e1.citableRegion} / ${e2 && e2.citableRegion}）`)
  const publicPath = e1 && e1.publicPath
  check(map.byPublic.get(publicPath) === e2, '路径级索引指向**最新版本**（追加写里行段更大者）')

  // ① 旧版本代号引用新版本的行段 ⇒ 不通过（F2 的修法点）。
  const bad = verifyReferenceTarget(e1, { memoryRoot: root, lineRange: { start: 17, end: 17 } })
  check(bad.ok === false && bad.reasons.some((r) => r.includes('evidence segment')),
    `旧版本引用新段被拒（reasons=${JSON.stringify(bad.reasons)}）`)
  // ② 各自引用自己的段 ⇒ 通过。
  check(verifyReferenceTarget(e1, { memoryRoot: root, lineRange: { start: 8, end: 8 } }).ok === true,
    '旧版本引用自己的段通过')
  check(verifyReferenceTarget(e2, { memoryRoot: root, lineRange: { start: 17, end: 17 } }).ok === true,
    '新版本引用自己的段通过')

  // ③ 裸代号 ⇒ 渲染成该代号自己的行段（不落成"整份文件"）。
  const r = renderPhase2References(`- 最终：B 有效 [[${e2.code}]]`, map)
  check(r.text.includes(`${publicPath}:17-17`), `裸代号渲染为该版本自己的行段（实测 ${r.text}）`)
  check(r.unmapped.length === 0 && r.unverified.length === 0, '映射内引用不留 unverified/unmapped')

  // ④ 目录把"版本 + 段"一并给模型（模型才有机会选对版本）。
  const cat = referenceCatalogText(map)
  check(cat.includes('watermark=wm-v1') && cat.includes('lines=8-8') && cat.includes('watermark=wm-v2') && cat.includes('lines=17-17'),
    '目录里两个版本的 watermark 与行段都可见')
  check(cat.includes("that version's evidence line range") || cat.includes('evidence line range'),
    '目录显式说明"代号绑定该版本证据段、跨版本行段会被拒"')

  // ⑤ 端到端（发布闸门）：错配引用 ⇒ 不发布；正确引用 ⇒ 通过。
  const badOut = { memory_summary: `v1\n## 索引\n- 旧结论 [[${e1.code}:17-17]]`, registry: '# MEMORY.md\n- x' }
  const vb = validatePhase2Output(badOut, { references: map })
  check(vb.ok === false && vb.errors.some((e) => e.includes('evidence segment')),
    `错配引用 ⇒ 整批不发布（errors=${JSON.stringify(vb.errors)}）`)
  const goodOut = { memory_summary: `v1\n## 索引\n- 最新结论 [[${e2.code}:17-17]]`, registry: '# MEMORY.md\n- x' }
  const vg = validatePhase2Output(goodOut, { references: map })
  check(vg.ok === true, `正确引用 ⇒ 通过（errors=${JSON.stringify(vg.errors)}）`)

  // ⑥ 抽取层：两个代号都能被识别（不是只认路径）。
  const ex = extractReferences(`[[${e1.code}]] 与 [[${e2.code}]]`, map)
  check(ex.tokens.length === 2 && ex.unmapped.length === 0, `两个代号都可解析（tokens=${ex.tokens.length}）`)
  })
} finally {
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T232 F2 SOURCE-VERSION-REFS TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
