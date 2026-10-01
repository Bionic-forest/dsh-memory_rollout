// 阶段 A · 接线第①步：session/disposed 只入队（落盘 dsh_rollout storage-domain 表）
// 接线③：disposer 入队后由 setImmediate 调度的 drainStage1Jobs 消费到期 pending 作业。
// 验证：disposer 入队 → job 经 drain 消费完成（status 非 pending）；同 session+watermark 去重。
// 存储访问：读 dsh_rollout 的 stage1_jobs 表（jobListOf）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const eventHandlers = {}
const readSession = async (id) => ({ session: { version: 4, isSeeded: false, id, cwd: 'C:/' + id, createdAt: 0 }, events: [] })
// 【C4 夹具适配】官方 `sessionPersistence` 供货面 + 时间信号（"静置"由 revision 第 4 段表达）。
//   C4 起 `session/disposed` 先取该会话的持久快照、再用**唯一**资格判定（静置 ≥ minRolloutIdleHours，默认 6h）
//   决定是否入队。这里给的就是**真宿主会提供的形状**（`{header, revision, sizeBytes}`）：
//   revision = `dev:ino:size:mtimeNs:ctimeNs`（官方 fileRevision 形状）⇒ 12h 前的 mtimeNs 即"已静置 12h"。
//   ⇒ 本夹具**不绕过任何资格门**：会话是被新语义**正常纳入**的。
const IDLE_HOURS = 12
const snapshotOf = (id, headerExtra = {}) => ({
  header: { version: 4, isSeeded: false, id, cwd: 'C:/' + id, createdAt: 0, ...headerExtra },
  revision: '1:2:3:' + Math.round((Date.now() - IDLE_HOURS * 3600000) * 1e6) + ':4',
  sizeBytes: 128,
})
const persistenceMock = { list: async () => [snapshotOf('s1')], locate: () => ({ path: 'Z:\\c4-not-exist\\log.jsonl' }) }

const { ctx, domain } = makeCtx({
  // sessionQuery present (persistence path): s1 empty transcript -> drain no_output.
  get: (k) => (k === 'sessionQuery' ? { readSession }
    : k === 'sessionPersistence' ? persistenceMock
      : undefined),
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
})

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-eventenq-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const readJobs = (d) => jobListOf(d)
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
  await apply(ctx, { autoTrigger: 'sessionEnd' })
  assert.ok(eventHandlers['session/disposed'], 'session/disposed handler registered')

  console.log('[1] session/disposed enqueues then drain consumes to a terminal status')
  const sess = { id: 's1', header: { cwd: 'C:/s1' }, deriveMessages: () => [] }
  eventHandlers['session/disposed'](sess)
  const drained1 = await waitUntil(() => {
    const j = Object.values(readJobs(domain)).find((x) => String(x.session_id) === 's1')
    return j && j.status !== 'pending'
  }, 3000)
  check(drained1, 'the s1 job was drained to a terminal status (no longer pending)')
  const jobs = readJobs(domain)
  const j1 = Object.values(jobs).find((x) => String(x.session_id) === 's1')
  check(j1 && j1.status === 'succeeded_no_output', 'the s1 job succeeded (no-output, empty transcript)')

  console.log('[2] duplicate session+watermark is deduped on re-trigger')
  eventHandlers['session/disposed'](sess)
  await new Promise((r) => setTimeout(r, 120))
  const jobs2 = readJobs(domain)
  check(Object.values(jobs2).filter((x) => String(x.session_id) === 's1').length === 1, 'still exactly one s1 job (deduped, no duplicate)')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL EVENT-ENQUEUE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
