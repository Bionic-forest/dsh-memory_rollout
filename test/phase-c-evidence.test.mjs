// 阶段 C · P1-1（证据层）：stage1 提炼成功时自动产出逐会话证据文件 + source_ref，
// 并与引用生成贯通（memoryCitationEntries 用真实 source_ref 生成精确引用，坏证据回退 unverified）。
// 对应《第三轮返工》§10 证据层 / §11.5 证据与引用验收。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, outputListOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply, validateSourceRef } = await import(PLUGIN)

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-evidence-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const memoryRoot = () => path.join(tmp, 'memories')

const msgEvent = (id, text) => ({
  type: 'user/message',
  seq: 0,
  time: 0,
  surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const readSession = async (id) => ({
  session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 },
  events: [msgEvent(id, 'this is a long enough message for session ' + id + ' that triggers the model extraction of a durable fact')],
})

const SUMMARY = 'the evidence session established a durable preference for pnpm over npm in this workspace'
const EXTRACTION = {
  rollout_summary: SUMMARY,
  raw_memory: 'raw evidence trace line for session ev-sess',
  slug: 'evidence-note',
  keywords: 'pnpm,preference',
  title: 'Evidence session',
}
const llmMock = {
  stream: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', text: JSON.stringify(EXTRACTION) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }),
}

const { ctx, domain } = makeCtx({
  get: (k) =>
    k === 'llm'
      ? llmMock
      : k === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : k === 'sessionQuery'
          ? { readSession }
          : undefined,
})

const readJobs = () => jobListOf(domain)
const readOutputs = () => outputListOf(domain)
const evFile = () => path.join(memoryRoot(), 'rollout_summaries', 'ev-sess.md')
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return false
}

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  const config = { autoTrigger: 'off', maxModelAttemptsPerDay: 100, recallLimit: 20 }
  await apply(ctx, config)
  assert.ok(ctx.tools.memory_recall, 'memory_recall registered')
  assert.ok(ctx.tools.memory_remember, 'memory_remember registered')
  assert.ok(ctx.tools['memory__stage1_drain'], 'memory__stage1_drain registered')

  // ── [1] drain 产出 succeeded_with_output → 自动证据文件存在且非空 ────────────
  console.log('[1] drain succeeds_with_output writes a non-empty per-session evidence file')
  {
    await seedJob(domain, 'ev-sess', 'wm-ev1')
    const res = await ctx.tools['memory__stage1_drain'].execute({})
    console.log('  drain processed:', res.processed)
    // 等 output + 证据文件落盘（异步 phase2 best-effort 不影响证据产物）。
    const done = await waitUntil(() => {
      const out = Object.values(readOutputs()).find((o) => String(o.session_id) === 'ev-sess')
      return out && !!out.source_ref && fs.existsSync(evFile())
    }, 3000)
    check(done, 'drain produced stage1_output with source_ref + evidence file')
    check(fs.existsSync(evFile()), 'rollout_summaries/ev-sess.md exists')
    const evTxt = fs.readFileSync(evFile(), 'utf8')
    check(evTxt.trim().length > 0, 'evidence file is non-empty')
    check(evTxt.includes(SUMMARY), 'evidence file contains the distilled summary')
    check(evTxt.includes('session_id: ev-sess'), 'evidence file header carries session_id')
  }

  // ── [2] source_ref.path 指向证据文件 + 行号合法 ─────────────────────────────
  console.log('[2] stage1_outputs.source_ref points at the evidence file with a valid line range')
  const out = Object.values(readOutputs()).find((o) => String(o.session_id) === 'ev-sess')
  let srcRef
  {
    check(!!out, 'one stage1_output for ev-sess exists')
    check(out && out.rollout_summary === SUMMARY, 'output carries the extracted rollout_summary')
    check(out && !!out.source_ref && typeof out.source_ref === 'object', 'output has a source_ref object')
    srcRef = out.source_ref
    check(srcRef && srcRef.path === 'rollout_summaries/ev-sess.md', 'source_ref.path points at the evidence file')
    check(
      srcRef && Number.isInteger(srcRef.startLine) && Number.isInteger(srcRef.endLine) &&
        srcRef.startLine >= 1 && srcRef.endLine >= srcRef.startLine,
      'source_ref line range is valid (start>=1, end>=start)',
    )
    check(srcRef && srcRef.sessionId === 'ev-sess', 'source_ref carries sessionId')
    check(srcRef && typeof srcRef.citeSpan === 'string' && srcRef.citeSpan.length > 0, 'source_ref carries a non-empty citeSpan')
  }

  // ── [3] validateSourceRef(source_ref, memoryRoot) 返回 ok ───────────────────
  console.log('[3] validateSourceRef resolves the source_ref against the real file')
  {
    const v = validateSourceRef(srcRef, memoryRoot())
    console.log('  validateSourceRef:', JSON.stringify(v))
    check(v.ok === true, 'validateSourceRef(source_ref, memoryRoot).ok === true')
  }

  // ── [4] memoryCitationEntries 用 source_ref（不再 unverified 整份草稿）────────
  console.log('[4] memoryCitationEntries cites the evidence file + precise line range')
  {
    await ctx.tools.memory_remember.execute(
      { content: SUMMARY, tags: ['evidence'] },
      { agent: { session: { id: 'ev-sess' } } },
    )
    const r = await ctx.tools.memory_recall.execute({ query: 'durable preference', limit: 10 })
    check(r.entries.some((e) => e.sessionId === 'ev-sess'), 'recall returns the linked entry')
    const expected = `rollout_summaries/ev-sess.md:${srcRef.startLine}-${srcRef.endLine}|note=[recalled from memory]`
    check(r.citation.includes(expected), 'citation uses the evidence file + precise line range: ' + expected)
    check(!/unverified/.test(r.citation), 'valid source_ref is NOT marked unverified')
    check(!r.citation.includes('rollout_summaries/ev-sess.md:1-'), 'does NOT fall back to whole-draft :1-N')
  }

  // ── [5a] 坏证据（证据文件被删）→ 回退 unverified ────────────────────────────
  console.log('[5a] deleted/broken evidence file → citation falls back to unverified')
  {
    fs.rmSync(evFile(), { force: true })
    const r = await ctx.tools.memory_recall.execute({ query: 'durable preference', limit: 10 })
    check(r.entries.some((e) => e.sessionId === 'ev-sess'), 'recall still returns the entry after evidence deleted')
    check(/unverified/.test(r.citation), 'broken evidence marked unverified')
    check(!r.citation.includes('rollout_summaries/ev-sess.md:'), 'no source_ref/whole-draft cite for broken evidence')
  }

  // ── [5b] 无证据（无 stage1_output 的会话）→ 回退 unverified ────────────────
  console.log('[5b] entry with no stage1_output → citation falls back to unverified')
  {
    await ctx.tools.memory_remember.execute(
      { content: 'the orphan session fact relates to tesseract geometry', tags: ['orphan'] },
      { agent: { session: { id: 'orphan-sess' } } },
    )
    const r = await ctx.tools.memory_recall.execute({ query: 'tesseract', limit: 10 })
    check(r.entries.some((e) => e.sessionId === 'orphan-sess'), 'orphan entry recalled')
    check(/unverified/.test(r.citation), 'entry with no stage1_output evidence marked unverified')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PHASE-C-EVIDENCE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
