// One-off isolated test for P0-3: secondary-candidate draft nesting is gone.
// 接线③：disposer 只 enqueue「被处置的那个会话」（trigger），不再由 pipelinePhase1 选择次级候选。
// 因此 secNoNew / secNew 不会作为次级候选被重新提炼/重写 → 原草稿保持 byte-identical、无套娃。
// 迁移：断言 trigger 经 drain 消费为 no_output（空 transcript），且 secNoNew/secNew 无任何
// stage-1 作业（次级候选不再被 re-drafted），草稿原样保留。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const eventHandlers = {}
const queryMock = {
  readSession: async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [] }),
}
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'sessionQuery' ? queryMock : undefined),
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
})

const tmpHome = path.join(os.tmpdir(), 'dsh-memory_rollout-p03-test-' + Date.now())
process.env.DSH_HOME = tmpHome
fs.mkdirSync(tmpHome, { recursive: true })

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

const memoryRoot = () => path.join(tmpHome, 'memories')
const summariesDir = () => path.join(memoryRoot(), 'rollout_summaries')
const readDraft = (name) => fs.readFileSync(path.join(summariesDir(), name), 'utf8')
const readJobs = () => jobListOf(domain)
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return false
}

try {
  const config = {
    autoTrigger: 'sessionEnd',
    precompactAuto: false,
  }
  await apply(ctx, config)
  console.log('plugin apply() OK, memoryRoot =', memoryRoot())

  fs.mkdirSync(summariesDir(), { recursive: true })
  // secNoNew: summarized AFTER lastActivity → NO new activity → must be skipped at selection.
  // secNew:   summarized BEFORE lastActivity → HAS new activity → candidate, must read raw.
  const noNewDraft = 'session_id: secNoNew\nupdated_at: 2026-08-21T00:00:00.000Z\ncwd: C:/secNoNew\n\n# 会话草稿 Old NoNew\n## 会话草稿\noriginal no-new content'
  const newDraft = 'session_id: secNew\nupdated_at: 2026-08-20T00:00:00.000Z\ncwd: C:/secNew\n\n# 会话草稿 Old New\n## 会话草稿\noriginal new-content draft'
  fs.writeFileSync(path.join(summariesDir(), 'secNoNew.md'), noNewDraft)
  fs.writeFileSync(path.join(summariesDir(), 'secNew.md'), newDraft)

  // Fire the session/disposed handler with a fake trigger session.
  assert.ok(eventHandlers['session/disposed'], 'session/disposed handler registered')
  eventHandlers['session/disposed']({ id: 'trigger', header: { cwd: 'C:/trigger' } })
  const trigDone = await waitUntil(() => {
    const j = Object.values(readJobs()).find((x) => String(x.session_id) === 'trigger')
    return j && j.status !== 'pending'
  }, 3000)

  console.log('\n[P0-3] no-new-activity secondary must NOT be re-drafted (no nesting)')
  check(readDraft('secNoNew.md') === noNewDraft, 'secNoNew draft byte-identical (skipped, not rewritten)')
  check(readDraft('secNew.md') === newDraft, 'secNew draft byte-identical (not re-wrapped)')

  const jobs = readJobs()
  const trigJob = Object.values(jobs).find((x) => String(x.session_id) === 'trigger')
  check(trigDone && trigJob && trigJob.status === 'succeeded_no_output', 'trigger is a no-output no-op (empty transcript) — proves drain ran')
  check(!Object.keys(jobs).some((k) => k.startsWith('secNoNew::')), 'no stage-1 job for secNoNew (skipped, not re-drafted)')
  check(!Object.keys(jobs).some((k) => k.startsWith('secNew::')), 'no stage-1 job for secNew (secondary no longer selected by disposer)')
  check(fs.existsSync(path.join(summariesDir(), 'trigger.md')) === false, 'no empty trigger draft written (no-op)')

  console.log('\n[P0-3] pipeline drafts are untouched (no re-summarization / no nesting)')
  const rewrapReproducer = fs.readFileSync(path.join(summariesDir(), 'secNoNew.md'), 'utf8')
  check(rewrapReproducer.indexOf(noNewDraft) !== -1 && !rewrapReproducer.includes('## 原始字面快照'), 'no nested-draft growth marker')
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL P0-3 TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
