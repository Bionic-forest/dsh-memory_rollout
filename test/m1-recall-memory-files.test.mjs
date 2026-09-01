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
const injtext = (s) => { try { return String(s.text()) } catch { return 'ERR:' + String((s && s.text) || 'no-text-fn') } }

try {
  const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-m1-' + Date.now())
  process.env.DSH_HOME = tmp
  fs.mkdirSync(tmp, { recursive: true })
  const mr = path.join(tmp, 'memories')
  fs.mkdirSync(mr, { recursive: true })
  const { ctx, domain } = makeCtx({ get: () => undefined })

  await apply(ctx, { recallLimit: 50 })
  // 构造「自动记忆」：写进根 memory_summary.md（无版本时 resolveCurrentFiles 回退根路径）
  fs.appendFileSync(path.join(mr, 'memory_summary.md'), '\n- 项目决定：dsh-memory_rollout 后续采用「轻量证据索引」方案（X 方案）\n- 用户偏好：咖啡在工作前喝\n')
  fs.appendFileSync(path.join(mr, 'MEMORY.md'), '\n## 自动记忆\n- 项目决定：dsh-memory_rollout 后续采用「轻量证据索引」方案（X 方案）\n')
  // 草稿/证据：session-cite 的 rollout_summary 证据文件
  fs.mkdirSync(path.join(mr, 'rollout_summaries'), { recursive: true })
  fs.writeFileSync(path.join(mr, 'rollout_summaries', 'session-cite.md'), '# 会话草稿\n- 用户说：dsh-memory_rollout 这次用「轻量证据索引」来加速召回\n')

  // ── ① 自动记忆可被 recall 找到（entries 为空也算）──
  console.log('[①] recall 找到「自动记忆」（记忆文件里，非 entries）')
  const r1 = await ctx.tools['memory_recall'].execute({ query: '轻量证据索引 方案' })
  check(Array.isArray(r1.entries) && r1.entries.length === 0, 'entries 为 0（无显式记住这条）')
  check(Array.isArray(r1.memories) && r1.memories.length >= 1, 'memory_recall 在记忆文件中找到自动记忆')
  const hit = (r1.memories || []).find((m) => m.content && m.content.includes('轻量证据索引'))
  check(!!hit, '命中的自动记忆内容正确')
  check(!!hit && /memory_summary\.md:\d+-\d+|MEMORY\.md:\d+-\d+/.test(hit.citation), '自动记忆带真实文件:行引用：' + (hit && hit.citation))
  // M1-R3：自动-only 时 count 计入 memories
  check(r1.count === (r1.entries || []).length + (r1.memories || []).length, 'count = entries + memories（M1-R3）')
  check(r1.entries.length === 0 && r1.count > 0, '自动-only 返回时 count > 0')

  // ── ①b 草稿/证据（rollout_summaries）也能被 recall 找到并给出来源 ──
  console.log('[①b] recall 从 rollout_summaries 草稿/证据中找到来源并带引用')
  const r1b = await ctx.tools['memory_recall'].execute({ query: '轻量证据索引 召回' })
  const draftMatch = (r1b.memories || []).find((m) => /rollout_summaries\/session-cite\.md:\d+-\d+/.test(m.citation))
  check(!!draftMatch, 'recall 命中草稿/证据文件行并带 rollout_summaries/<file>:line 引用')

  // ── ①c M1-R1：forgotten 事实即使仍在旧草稿里，默认 recall 也不返回 ──
  console.log('[①c] M1-R1：forgotten 草稿不复活（生命周期全来源裁决）')
  await domain.table('entries').put('e-ghost', { id: 'e-ghost', content: 'the ghost preference must vanish forever', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: 'tool', status: 'forgotten', superseded_by: '' })
  fs.writeFileSync(path.join(mr, 'rollout_summaries', 'ghost.md'), '# 旧会话\n- the ghost preference must vanish forever\n')
  const r1c = await ctx.tools['memory_recall'].execute({ query: 'ghost preference vanish' })
  check(!(r1c.memories || []).some((m) => m.content && m.content.includes('ghost preference')), 'forgotten 事实未从草稿/证据复活（M1-R1）')

  // ── ①d M1-R2：否定/冲突事实不被子串去重吞掉 ──
  console.log('[①d] M1-R2：否定事实不被去重吞掉（仅完全相等去重，不猜子串）')
  await domain.table('entries').put('e-proxy', { id: 'e-proxy', content: '允许使用代理', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: 'tool', status: 'active', superseded_by: '' })
  fs.writeFileSync(path.join(mr, 'rollout_summaries', 'neg.md'), '# 新决定\n- 最新决定：不允许使用代理\n')
  const r1d = await ctx.tools['memory_recall'].execute({ query: '允许使用代理' })
  check((r1d.memories || []).some((m) => m.content && m.content.includes('不允许使用代理')), '「不允许使用代理」未被「允许使用代理」吞掉（M1-R2 保守去重）')

  // ── ①e M1-R4：更相关（命中词数更多）的草稿应进入 top 1-2（不按目录顺序抢跑） ──
  console.log('[①e] M1-R4：草稿按相关度选 1-2（更相关候选胜出）')
  fs.writeFileSync(path.join(mr, 'rollout_summaries', 'draft-cite.md'), '# A\n- 项目用了「轻量证据索引」\n')
  fs.writeFileSync(path.join(mr, 'rollout_summaries', 'draft-imp.md'), '# A\n- 这次用「轻量证据索引」来加速召回（两者都命中）\n')
  const r1e = await ctx.tools['memory_recall'].execute({ query: '轻量证据索引 召回' })
  check((r1e.memories || []).some((m) => /draft-imp\.md:\d+-\d+/.test(m.citation)), '更相关的 draft-imp（命中2词）进入返回（M1-R4）')

  // ── ①f M1-R2/R3：生命周期精确匹配——旧原句不复活、新否定可召回（forgotten + superseded；含真实注册表后缀） ──
  console.log('[①f] M1-R2/R3：旧原句（含 writeRegistry 固定后缀）不复活 + 新否定可召回')
  const mkEntry = (id, content, status) => domain.table('entries').put(id, { id, content, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: 'tool', status, superseded_by: '' })
  for (const status of ['forgotten', 'superseded']) {
    await mkEntry('e-proxy-' + status, '允许使用代理', status)
    // 草稿：旧原句（line2）+ 新否定（line3）
    fs.writeFileSync(path.join(mr, 'rollout_summaries', 'proxy-' + status + '.md'), '# 会话\n- 允许使用代理\n- 最新决定：不允许使用代理\n')
    // 真实 MEMORY.md 注册表固定后缀行（writeRegistry 格式）：`- [pref] 允许使用代理 (session=…, updated=…)`
    fs.appendFileSync(path.join(mr, 'MEMORY.md'), `\n- [pref] 允许使用代理 (session=s1, updated=2026-08-29T00:00:00.000Z)\n- [pref] 最新决定：不允许使用代理 (session=s2, updated=2026-08-29T00:00:00.000Z)\n`)
    // query '代理' 同时命中旧/新
    const r = await ctx.tools['memory_recall'].execute({ query: '代理' })
    check(!(r.memories || []).some((m) => m.content && m.content.includes('允许使用代理') && !m.content.includes('不允许使用代理')), `${status}：旧原句「允许使用代理」不复活（草稿 + 注册表后缀行，用例A）`)
    check((r.memories || []).some((m) => m.content && m.content.includes('不允许使用代理')), `${status}：新否定「不允许使用代理」可召回（用例B，不被墓碑压掉）`)
    await domain.table('entries').delete('e-proxy-' + status)
  }

  // ── ② useMemories=false → recall 为空、不注入 ──
  console.log('[②] useMemories=false → recall 空、注入为 ""')
  // 用第二个隔离 home，apply 时 useMemories:false，验证运行时开关。
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

// ② 单独：useMemories=false 的 apply
try {
  const tmp2 = path.join(os.tmpdir(), 'dsh-memory_rollout-m1-off-' + Date.now())
  process.env.DSH_HOME = tmp2
  fs.mkdirSync(tmp2, { recursive: true })
  // M1-R5：捕获注入 section，断言 useMemories=false 时 text() 严格为空
  const sections = []
  const { ctx } = makeCtx({ systemPrompt: { section: (sec) => sections.push(sec) }, get: () => undefined })
  await apply(ctx, { useMemories: false })
  const r = await ctx.tools['memory_recall'].execute({ query: 'anything' })
  check(Array.isArray(r.entries) && r.entries.length === 0 && Array.isArray(r.memories) && r.memories.length === 0, 'useMemories=false → recall 返回空')
  const injectSection = sections.find((s) => s && s.name === 'dsh-memory_rollout')
  check(!!injectSection, '捕获到 dsh-memory_rollout 注入 section（M1-R5）')
  check(injectSection && injtext(injectSection) === '', 'useMemories=false → 注入 section.text() 严格为空')
} finally {
  try { fs.rmSync(tmp2, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL M1-RECALL-MEMORYFILES TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
