// One-off isolated test for P0-3: secondary-candidate draft nesting is gone.
// Drives the real pipelinePhase1 via the session/disposed event, with a mocked
// sessionQuery (empty persisted events) so we can prove the secondary candidate
// reads from PERSISTENCE (empty → no-op) instead of re-wrapping the old draft.
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply } = await import(PLUGIN)

const table = (() => {
  const m = new Map()
  return {
    put: (k, v) => { m.set(k, v); return Promise.resolve() },
    delete: (k) => Promise.resolve(m.delete(k)),
    keys: () => m.keys(),
    entries: () => m.entries(),
    get size() { return m.size },
  }
})()

const eventHandlers = {}
const queryMock = {
  readSession: async (id) => ({ session: { cwd: 'C:/' + id }, events: [] }),
}
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: (k) => (k === 'sessionQuery' ? queryMock : undefined),
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
}

const tmpHome = path.join(os.tmpdir(), 'dsh-rollout-p03-test-' + Date.now())
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
const statePath = () => path.join(memoryRoot(), '.pipeline-state.json')
const readState = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'))

try {
  const config = {
    autoTrigger: 'sessionEnd',
    minIdleHours: 0,
    maxDraftAgeDays: 10,
    maxExtractPerTrigger: 2,
    maxPipelineRunsPerDay: 100,
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

  fs.writeFileSync(
    statePath(),
    JSON.stringify({
      sessions: {
        secNoNew: { sessionId: 'secNoNew', lastActivityAt: '2026-08-20T00:00:00.000Z', summarizedAt: '2026-08-21T00:00:00.000Z' },
        secNew: { sessionId: 'secNew', lastActivityAt: '2026-08-26T00:00:00.000Z', summarizedAt: '2026-08-20T00:00:00.000Z' },
      },
      global: { lastPhase2At: '', runsToday: 0, runDay: '' },
    }),
    'utf8',
  )

  // Fire the session/disposed handler with a fake trigger session.
  assert.ok(eventHandlers['session/disposed'], 'session/disposed handler registered')
  eventHandlers['session/disposed']({ id: 'trigger', header: { cwd: 'C:/trigger' } })
  // Let the setImmediate-scheduled pipeline (async) finish.
  await new Promise((r) => setTimeout(r, 200))

  console.log('\n[P0-3] no-new-activity secondary must NOT be re-drafted (no nesting)')
  check(readDraft('secNoNew.md') === noNewDraft, 'secNoNew draft byte-identical (skipped, not rewritten)')
  check(readDraft('secNew.md') === newDraft, 'secNew draft byte-identical (read raw persistence → empty → no rewrite, NOT re-wrapped)')
  const trigRec = readState().sessions.trigger
  check(trigRec && trigRec.lastExtractStatus === 'succeeded_no_output', 'trigger is a no-output no-op (empty transcript) — proves pipeline ran')
  check(fs.existsSync(path.join(summariesDir(), 'trigger.md')) === false, 'no empty trigger draft written (no-op)')

  console.log('\n[P0-3] pipeline state reflects no re-summarization of unchanged sessions')
  const st = readState()
  check(st.sessions.secNoNew.summarizedAt === '2026-08-21T00:00:00.000Z', 'secNoNew summarizedAt unchanged')
  check(st.sessions.secNew.summarizedAt === '2026-08-20T00:00:00.000Z', 'secNew summarizedAt unchanged (empty raw → no-op, not marked)')
  // The old bundling bug would REWRITE secNoNew (writing its own markdown as the new summary).
  const rewrapReproducer = fs.readFileSync(path.join(summariesDir(), 'secNoNew.md'), 'utf8')
  check(rewrapReproducer.indexOf(noNewDraft) !== -1 && !rewrapReproducer.includes('## 原始字面快照'), 'no nested-draft growth marker')
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL P0-3 TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
