// S0-2（2026-09-13 · GPT 大纲 §12）：**旧权威文件尾部独有结论必须活过整合**。
//
// 缺陷（修复前）：整合提示词把「当前总纲 / 当前注册表」按 `PROMPT_CURRENT_SUMMARY_CHARS=12000` /
// `PROMPT_CURRENT_REGISTRY_CHARS=6000` **截断**（clampChars）后，再让模型做**全文替换**⇒
// 截断点之后的独有结论**模型根本没看到**，新版本里自然消失 = **静默丢结论**（注册表侧实测已越线）。
//
// 本测试的判据：把一条独有结论放在注册表**远超 6,000 字符的尾部**；模型只回显「它在提示词里看到的
// 当前文件」（+ 一条新结论）——这正是"全文替换"的真实形态。然后断言该尾部结论仍在发布产物里。
//   · 修复前：提示词里的 MEMORY.md 被截到 6,000 ⇒ 尾部结论不在提示词 ⇒ 回显内容不含它 ⇒ **失败**
//   · 修复后：当前文件**整篇传入** ⇒ 结论在提示词里 ⇒ 回显保留 ⇒ **通过**
//
// 只看隔离沙箱（DSH_HOME=临时目录）+ fake 表，不碰真实 storages/memories。
import assert from 'node:assert'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const sha256 = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex')
const tmp = path.join(os.tmpdir(), 'dsh-s0-2-authfile-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const root = () => path.join(tmp, 'memories')
const currentFile = () => path.join(root(), 'current.json')

let failed = 0
const check = (cond, msg) => { if (cond) console.log('  ✓ ', msg); else { failed++; console.error('  ✗ ', msg) } }

// ── 构造「旧权威注册表」：>6,000 字符，且把**独有结论放在尾部** ─────────────────
const TAIL = 'TAIL-CONCLUSION-9b26ef1d: 旧注册表尾部独有结论，整合后不得静默丢失'
const filler = Array.from({ length: 140 }, (_, i) => `- 历史结论 ${String(i).padStart(3, '0')}: ${'x'.repeat(50)}`)
const oldRegistry = '# MEMORY.md\n' + filler.join('\n') + '\n' + TAIL + '\n'
const oldSummary = 'v1\n## 旧总纲\n- 旧结论 A（v1 首行契约）\n'
const tailOffset = oldRegistry.indexOf(TAIL)
assert.ok(tailOffset > 6000, `夹具自检：尾部结论 offset=${tailOffset} 必须 > 6000（旧实现必栽）`)

function writeCurrent(summary, registry) {
  const id = 'p2-s02-' + Math.random().toString(36).slice(2, 8)
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

// ── 模型：**只回显它在提示词里看到的当前文件**（+ 一条新结论）────────────────────
let lastPrompt = ''
const sectionOf = (prompt, header) => {
  const i = prompt.indexOf(header)
  if (i < 0) return ''
  const rest = prompt.slice(i + header.length)
  const m = rest.match(/\n## /)          // 下一节
  return (m ? rest.slice(0, m.index) : rest).replace(/^\n+|\n+$/g, '')
}
const llmMock = {
  stream: (opts) => {
    lastPrompt = (opts?.messages?.[0]?.content?.[0]?.text) || ''
    const seenSummary = sectionOf(lastPrompt, '## CURRENT memory_summary.md').replace(/^v1\s*\n/, '')
    const seenRegistry = sectionOf(lastPrompt, '## CURRENT MEMORY.md')
    const payload = JSON.stringify({
      memory_summary: 'v1\n' + seenSummary + '\n- 新结论 B（本批新增）',
      registry: seenRegistry + '\n- 新结论 B（本批新增）',
    })
    return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  },
}
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
})

console.log('\n[S0-2] 旧注册表尾部独有结论 —— 整篇传入，整合后不得丢')
try {
  const seededId = writeCurrent(oldSummary, oldRegistry)
  await seedOutput(domain, 'o-s02', { source_watermark: 'wm-s02', session_id: 's-s02', rollout_summary: 'a new durable fact for the batch', generated_at: new Date().toISOString() })
  await apply(ctx, {})
  const res = await ctx.tools['memory__phase2_integrate'].execute({})
  console.log('  integrate:', JSON.stringify(res))

  const readOr = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
  const publishedRegistry = readOr(path.join(root(), 'MEMORY.md'))
  const verId = (() => { try { return JSON.parse(readOr(currentFile())).version } catch { return '' } })()
  const verRegistry = readOr(path.join(root(), 'versions', verId, 'MEMORY.md'))

  check(lastPrompt.length > 0, '拿到了提示词')
  check(res.ran === true && res.ok === true, '整合完成并发布 (ran/ok)')
  // ★ 核心断言（S0-2 的硬判据）
  check(lastPrompt.includes(TAIL), '提示词里含旧注册表**尾部**独有结论（= 当前文件整篇传入，未截断）')
  check(publishedRegistry.includes(TAIL), '发布版（根镜像 MEMORY.md）仍含该尾部独有结论')
  check(verRegistry.includes(TAIL), `发布版本 ${verId} 仍含该尾部独有结论`)
  // 反自欺：确实发生了一次真实整合（内容变了、且换了新版本）
  check(publishedRegistry !== oldRegistry, '确实是一次真实整合（内容已变，非原样拷贝）')
  check(seededId !== verId, '发布了新版本（不是原地覆盖）')
  check(publishedRegistry.includes('新结论 B（本批新增）'), '新结论也进来了（增量合并不只是保守拷贝）')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL S0-2 AUTHORITATIVE-FILE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
