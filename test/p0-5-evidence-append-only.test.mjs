// P0 #5 反例：同 session 第二 watermark 产出后，第一 output 的 source_ref 仍可验证（append-only）。
// 旧实现：证据文件一 session 一文件、覆盖写 → 第二 watermark 会覆盖旧行，4 份 source_ref 失配。
// 本次改为 append-only：路径稳定为 rollout_summaries/<session>.md，新块追加在旧行之后，
// 旧 output 的 source_ref（指向旧行段）在追加后仍可通过 validateSourceRef。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, outputListOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply, validateSourceRef } = await import(PLUGIN)

const tmp = path.join(os.tmpdir(), 'dsh-p0-5-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })
process.env.DSH_HOME = tmp

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return false
}

let payload = { rollout_summary: 'first watermark summary alpha', raw_memory: 'raw-a', slug: 'a', keywords: 'a', title: 'A' }
const msgEvent = (id, text) => ({ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const readSession = async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [msgEvent(id, 'this is a long enough message for session ' + id + ' that triggers the model extraction of a durable fact')] })
const llmMock = { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(payload) }; yield { type: 'finish', reason: { kind: 'stop' } } } }) }

try {
  const root = () => path.join(tmp, 'memories')
  const { ctx, domain } = makeCtx({
    get: (k) =>
      k === 'llm' ? llmMock
        : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : k === 'sessionQuery' ? { readSession } : undefined,
  })
  await apply(ctx, { maxModelAttemptsPerDay: 100, recallLimit: 20 })

  await seedJob(domain, 'ev-sess', 'wm1')
  await ctx.tools['memory__stage1_drain'].execute({})
  const done1 = await waitUntil(() => {
    const out = Object.values(outputListOf(domain)).find((o) => String(o.session_id) === 'ev-sess' && String(o.source_watermark) === 'wm1')
    return out && out.source_ref && fs.existsSync(path.join(root(), 'rollout_summaries', 'ev-sess.md'))
  }, 3000)
  check(done1, 'first watermark produced output + evidence file')
  const firstOut = Object.values(outputListOf(domain)).find((o) => String(o.session_id) === 'ev-sess' && String(o.source_watermark) === 'wm1')
  const firstRef = firstOut && firstOut.source_ref
  check(firstRef && validateSourceRef(firstRef, root()).ok === true, 'FIRST output source_ref validates before second watermark')

  // 第二次 watermark：同 session 追加一个新摘要块（append-only，不改旧行）。
  payload = { rollout_summary: 'second watermark summary beta', raw_memory: 'raw-b', slug: 'b', keywords: 'b', title: 'B' }
  await seedJob(domain, 'ev-sess', 'wm2')
  await ctx.tools['memory__stage1_drain'].execute({})
  const done2 = await waitUntil(() => {
    const out = Object.values(outputListOf(domain)).find((o) => String(o.session_id) === 'ev-sess' && String(o.source_watermark) === 'wm2')
    return out && out.source_ref
  }, 3000)
  check(done2, 'second watermark produced its own output + source_ref')

  const secondOut = Object.values(outputListOf(domain)).find((o) => String(o.session_id) === 'ev-sess' && String(o.source_watermark) === 'wm2')
  check(!!secondOut && secondOut.source_ref && validateSourceRef(secondOut.source_ref, root()).ok === true, 'SECOND output source_ref validates')
  check(validateSourceRef(firstRef, root()).ok === true, 'FIRST output source_ref STILL validates after second watermark (old rows unchanged)')
  const evTxt = fs.readFileSync(path.join(root(), 'rollout_summaries', 'ev-sess.md'), 'utf8')
  check(evTxt.includes('first watermark summary alpha'), 'first summary still present (append did not overwrite)')
  check(evTxt.includes('second watermark summary beta'), 'second summary appended')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL P0-5 EVIDENCE APPEND-ONLY TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
