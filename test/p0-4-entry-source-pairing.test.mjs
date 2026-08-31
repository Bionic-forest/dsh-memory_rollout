// P0 #4 反例：同 session 的无关 entry 不得引用 stage1 摘要（entry↔source_ref 语义配对）。
// 旧实现：sourceRefForEntry 按 sessionId 关联后只查「文件行存在 + citeSpan 在文件里」，
// citeSpan 是摘要文本、必然命中 → 同 session 的无关 entry 也会误引用 stage1 摘要。
// 本次改为用 citeless ref + '{ content: e.content }' 强制校验 entry 内容确在该行段内。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const tmp = path.join(os.tmpdir(), 'dsh-p0-4-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })
process.env.DSH_HOME = tmp

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

const SUMMARY = 'the evidence session established a durable preference for pnpm over npm'
const UNRELATED = 'the unrelated trivia about quantum entanglement'

try {
  const root = () => path.join(tmp, 'memories')
  const { ctx, domain } = makeCtx({ get: () => undefined })
  await apply(ctx, { recallLimit: 20 })
  assert.ok(ctx.tools.memory_remember && ctx.tools.memory_recall, 'remember/recall tools registered')

  // 直接造一条 stage1_output（带 source_ref）+ 写证据文件。
  const evidence = { path: 'rollout_summaries/sess.md', startLine: 1, endLine: 1, citeSpan: SUMMARY, sessionId: 'sess' }
  await seedOutput(domain, 'j-ev', { session_id: 'sess', source_watermark: 'wm1', rollout_summary: SUMMARY, source_ref: evidence })
  fs.mkdirSync(path.join(root(), 'rollout_summaries'), { recursive: true })
  fs.writeFileSync(path.join(root(), 'rollout_summaries', 'sess.md'), SUMMARY + '\n', 'utf8')

  const rRemember = await ctx.tools.memory_remember.execute(
    { content: UNRELATED, tags: ['unrelated'] },
    { agent: { session: { id: 'sess' } } },
  )
  check(!!rRemember.id, 'unrelated entry remembered in the SAME session')
  const r = await ctx.tools.memory_recall.execute({ query: 'quantum entanglement', limit: 10 })
  const hit = r.entries.find((e) => e.sessionId === 'sess')
  check(!!hit, 'unrelated entry is recalled')
  check(hit && !/rollout_summaries\/sess\.md:1-1|note=\[recalled from memory\]/.test(r.citation), 'unrelated entry does NOT cite the stage1 summary source_ref')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL P0-4 ENTRY-SOURCE PAIRING TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
