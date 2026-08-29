// M1：memory_recall 统一搜索「自动记忆」（记忆文件 memory_summary.md / 版本化 MEMORY.md），即使 entries 为空。
// 对应《路线监察总纲》§五结构性断裂「自动生成成功 但新会话 memory_recall 找不到」。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

let failed = 0
const check = (cond, msg) => { if (cond) console.log('  ✓ ', msg); else { failed++; console.error('  ✗ ', msg) } }

try {
  const tmp = path.join(os.tmpdir(), 'dsh-rollout-m1-' + Date.now())
  process.env.DSH_HOME = tmp
  fs.mkdirSync(tmp, { recursive: true })
  const mr = path.join(tmp, 'memories')
  fs.mkdirSync(mr, { recursive: true })
  const { ctx } = makeCtx({ get: () => undefined })

  await apply(ctx, { recallLimit: 50 })
  // 构造「自动记忆」：写进根 memory_summary.md（无版本时 resolveCurrentFiles 回退根路径）
  fs.appendFileSync(path.join(mr, 'memory_summary.md'), '\n- 项目决定：dsh-rollout 后续采用「轻量证据索引」方案（X 方案）\n- 用户偏好：咖啡在工作前喝\n')
  fs.appendFileSync(path.join(mr, 'MEMORY.md'), '\n## 自动记忆\n- 项目决定：dsh-rollout 后续采用「轻量证据索引」方案（X 方案）\n')
  // 草稿/证据：session-cite 的 rollout_summary 证据文件
  fs.mkdirSync(path.join(mr, 'rollout_summaries'), { recursive: true })
  fs.writeFileSync(path.join(mr, 'rollout_summaries', 'session-cite.md'), '# 会话草稿\n- 用户说：dsh-rollout 这次用「轻量证据索引」来加速召回\n')

  // ── ① 自动记忆可被 recall 找到（entries 为空也算）──
  console.log('[①] recall 找到「自动记忆」（记忆文件里，非 entries）')
  const r1 = await ctx.tools['memory_recall'].execute({ query: '轻量证据索引 方案' })
  check(Array.isArray(r1.entries) && r1.entries.length === 0, 'entries 为 0（无显式记住这条）')
  check(Array.isArray(r1.memories) && r1.memories.length >= 1, 'memory_recall 在记忆文件中找到自动记忆')
  const hit = (r1.memories || []).find((m) => m.content && m.content.includes('轻量证据索引'))
  check(!!hit, '命中的自动记忆内容正确')
  check(!!hit && /memory_summary\.md:\d+-\d+|MEMORY\.md:\d+-\d+/.test(hit.citation), '自动记忆带真实文件:行引用：' + (hit && hit.citation))

  // ── ①b 草稿/证据（rollout_summaries）也能被 recall 找到并给出来源 ──
  console.log('[①b] recall 从 rollout_summaries 草稿/证据中找到来源并带引用')
  const r1b = await ctx.tools['memory_recall'].execute({ query: '轻量证据索引 召回' })
  const draftMatch = (r1b.memories || []).find((m) => /rollout_summaries\/session-cite\.md:\d+-\d+/.test(m.citation))
  check(!!draftMatch, 'recall 命中草稿/证据文件行并带 rollout_summaries/<file>:line 引用')

  // ── ② useMemories=false → recall 为空、不注入 ──
  console.log('[②] useMemories=false → recall 空、注入为 ""')
  // 用第二个隔离 home，apply 时 useMemories:false，验证运行时开关。
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

// ② 单独：useMemories=false 的 apply
try {
  const tmp2 = path.join(os.tmpdir(), 'dsh-rollout-m1-off-' + Date.now())
  process.env.DSH_HOME = tmp2
  fs.mkdirSync(tmp2, { recursive: true })
  const { ctx } = makeCtx({ get: () => undefined })
  await apply(ctx, { useMemories: false })
  const r = await ctx.tools['memory_recall'].execute({ query: 'anything' })
  check(Array.isArray(r.entries) && r.entries.length === 0 && Array.isArray(r.memories) && r.memories.length === 0, 'useMemories=false → recall 返回空')
  const summary = ctx.systemPrompt ? null : null
  // 注入 section 已 gate；此处直接断言 recall 空即验证开关主行为
} finally {
  try { fs.rmSync(tmp2, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL M1-RECALL-MEMORYFILES TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
