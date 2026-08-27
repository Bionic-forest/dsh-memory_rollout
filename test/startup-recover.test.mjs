// 阶段 A · 验收：apply() 启动即恢复 + 排程消费（H1 修复）
// 此前 stage1Recover 只在测试里被直接调；apply() 启动只 integrate()，既不回收过期
// running，也不 setImmediate(drainStage1Jobs)。因此 DSH 在提炼中崩溃/重启后，磁盘
// 遗留的过期 running 作业永不被回收、永不消费 → 丢任务。
// 本测试：预置一个「过期 running」的 .stage1-state.json，然后通过 apply() 启动，
// 验证该 job 被自动回收为 pending 并被 drain 自动消费（最终不再 running）。
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
const tools = {}
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: () => undefined, // no sessionQuery/llm -> the expired running job reduces to no_output
  tools: { register: (t) => { tools[t.name] = t } },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
}

const tmp = path.join(os.tmpdir(), 'dsh-rollout-startup-' + Date.now())
process.env.DSH_HOME = tmp
const stateFile = () => path.join(tmp, 'memories', '.stage1-state.json')
const readJobs = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')).jobs || {} } catch { return {} } }

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

// Pre-seed an EXPIRED running job (as if DSH crashed mid-distill) BEFORE startup,
// so apply()'s startup recovery + drain must handle it.
const now = Date.now()
fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
fs.writeFileSync(stateFile(), JSON.stringify({
  jobs: {
    's1::wm1': { id: 'j1', session_id: 's1', source_watermark: 'wm1', status: 'running', lease_expires_at: new Date(now - 5000).toISOString(), lease_owner: 'w1', attempt_count: 0, max_attempts: 3, available_at: new Date(now - 5000).toISOString() },
  },
  outputs: {},
  global: {},
}), 'utf8')

await apply(ctx, {})

// Let the startup setImmediate(drainStage1Jobs) run and settle (drain is microtask-based,
// so a small real-time delay is deterministic and non-flaky).
await new Promise((r) => setTimeout(r, 100))

const jobs = readJobs()
const job = jobs['s1::wm1']
check(!!job, 'seeded job survives apply() startup')
check(job && job.status !== 'running', 'apply() startup no longer leaves the expired job running')
check(job && job.status === 'succeeded_no_output', 'apply() startup drained the recovered job to completion')
check(job && !!job.completed_at, 'recovered job was consumed (completed_at set)')

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`\n${failed === 0 ? 'ALL STARTUP-RECOVER TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
