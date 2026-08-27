// 阶段 A：stage-1 作业状态机核心（租约回收 + 退避）— 可单测纯函数
// 对应《向Codex原版系统看齐》§15 阶段 A（领取/租约/过期恢复、失败退避）。
import assert from 'node:assert'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { stage1BackoffSeconds, reclaimStage1Jobs } = await import(PLUGIN)

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

console.log(`\n${failed === 0 ? 'ALL STAGE1-STATE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
