// 阶段 A：stage-1 作业状态机核心（租约回收 + 退避）— 可单测纯函数
// 对应《向Codex原版系统看齐》§15 阶段 A（领取/租约/过期恢复、失败退避）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { stage1BackoffSeconds, reclaimStage1Jobs, mergeStage1Job, stage1Recover, claimStage1Job, enqueueStage1JobFile } = await import(PLUGIN)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

// ── stage1BackoffSeconds: 分级退避递增 ───────────────────────────────────────
console.log('[1] stage1BackoffSeconds is graded non-decreasing')
{
  const s1 = stage1BackoffSeconds(1)
  const s2 = stage1BackoffSeconds(2)
  const s3 = stage1BackoffSeconds(3)
  const s7 = stage1BackoffSeconds(7)
  check(s1 === 60, 'attempt 1 -> 60s')
  check(s2 === 120, 'attempt 2 -> 120s')
  check(s3 === 240, 'attempt 3 -> 240s')
  check(s7 <= 3600, 'attempt 7 capped at 3600s')
  check(s1 < s2 && s2 < s3, 'backoff increases with attempt')
}

// ── reclaimStage1Jobs: 租约过期回收 ─────────────────────────────────────────
console.log('[2] reclaimStage1Jobs recovers expired/interrupted runs')
{
  const now = Date.now()
  const state = {
    jobs: {
      expired: { status: 'running', lease_expires_at: new Date(now - 1000).toISOString(), lease_owner: 'w1' },
      live: { status: 'running', lease_expires_at: new Date(now + 60000).toISOString(), lease_owner: 'w2' },
      nolease: { status: 'running', lease_expires_at: '', lease_owner: 'w3' },
      done: { status: 'succeeded_with_output', lease_expires_at: new Date(now - 1000).toISOString() },
      pending: { status: 'pending', lease_expires_at: '' },
    },
  }
  const n = reclaimStage1Jobs(state, now)
  check(n === 2, 'reclaims the 2 interrupted jobs (expired + no-lease)')
  check(state.jobs.expired.status === 'pending' && state.jobs.expired.lease_owner === '', 'expired running -> pending, owner cleared')
  check(state.jobs.nolease.status === 'pending', 'running with no lease -> pending')
  check(state.jobs.live.status === 'running', 'live (unexpired) stays running')
  check(state.jobs.done.status === 'succeeded_with_output', 'completed job untouched')
  check(state.jobs.pending.status === 'pending', 'already-pending untouched')
}

// ── mergeStage1Job: 去重入队 ─────────────────────────────────────────────────
console.log('[3] mergeStage1Job dedupes by session_id + source_watermark')
{
  const now = new Date('2026-08-27T00:00:00.000Z')
  const state = { jobs: {} }
  const a = mergeStage1Job(state, 's1', 'wm-v1', now)
  check(a.queued === true, 'first enqueue for session+watermark is queued')
  check(a.job.status === 'pending' && a.job.session_id === 's1' && a.job.source_watermark === 'wm-v1', 'job fields set')
  const b = mergeStage1Job(state, 's1', 'wm-v1', now)
  check(b.queued === false && b.job.id === a.job.id, 'duplicate session+watermark NOT re-queued (same job id)')
  const c = mergeStage1Job(state, 's1', 'wm-v2', now)
  check(c.queued === true && c.job.source_watermark === 'wm-v2', 'new watermark -> a separate job')
  check(Object.keys(state.jobs).length === 2, 'two jobs (one per watermark)')
}

// ── stage1Recover: 重启恢复（读盘→回收→写回） ────────────────────────────────
console.log('[4] stage1Recover persists lease reclaim across a restart')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stage1-'))
  const p = path.join(dir, '.stage1-state.json')
  const now = Date.now()
  fs.writeFileSync(p, JSON.stringify({
    jobs: {
      expired: { status: 'running', lease_expires_at: new Date(now - 1000).toISOString(), lease_owner: 'w1' },
      live: { status: 'running', lease_expires_at: new Date(now + 60000).toISOString(), lease_owner: 'w2' },
      done: { status: 'succeeded_with_output' },
    },
  }), 'utf8')
  const n = stage1Recover(p, now)
  const reloaded = JSON.parse(fs.readFileSync(p, 'utf8'))
  check(n === 1, 'recover reclaims the expired running job')
  check(reloaded.jobs.expired.status === 'pending', 'expired running -> pending on disk')
  check(reloaded.jobs.live.status === 'running', 'live job stays running on disk')
  check(reloaded.jobs.done.status === 'succeeded_with_output', 'completed job untouched')
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── claimStage1Job: 领取 + 租约（drain 领取一步） ─────────────────────────────
console.log('[5] claimStage1Job claims an available pending job and leases it')
{
  const now = new Date('2026-08-27T00:00:00.000Z').getTime()
  const state = { jobs: {} }
  mergeStage1Job(state, 's2', 'wm-1', new Date(now - 10000)) // pending, available (created earlier)
  mergeStage1Job(state, 's3', 'wm-2', new Date(now + 10000)) // pending but available_at in FUTURE (not now)
  const picked = claimStage1Job(state, now, 60000, 'worker-1')
  check(picked !== null, 'claims an available job')
  check(picked.status === 'running' && picked.lease_owner === 'worker-1', 'claimed job -> running + owner')
  check(picked.lease_expires_at === new Date(now + 60000).toISOString(), 'lease set to now + leaseMs')
  check(claimStage1Job(state, now, 60000, 'worker-2') === null, 'no further available job (future one not due yet)')
}

// ── enqueueStage1JobFile: 事件只入队（落盘） ──────────────────────────────────
console.log('[6] enqueueStage1JobFile persists enqueue (event-only, no model run)')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stage1-'))
  const p = path.join(dir, '.stage1-state.json')
  const now = new Date('2026-08-27T00:00:00.000Z')
  const a = enqueueStage1JobFile(p, 's1', 'wm-v1', now)
  check(a.queued === true, 'first enqueue queued')
  const disk1 = JSON.parse(fs.readFileSync(p, 'utf8'))
  check(disk1.jobs && disk1.jobs['s1::wm-v1'] && disk1.jobs['s1::wm-v1'].status === 'pending', 'job persisted on disk as pending')
  const b = enqueueStage1JobFile(p, 's1', 'wm-v1', now)
  check(b.queued === false && b.job.id === a.job.id, 'duplicate session+watermark not re-queued on disk')
  const c = enqueueStage1JobFile(p, 's2', 'wm-v1', now)
  check(c.queued === true, 'different session -> new job')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'ALL STAGE1-STATE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
