// 阶段 A 验收：重启后作业不丢、可继续消费（总纲 §15 完成标志）
// 组合 stage1Recover（重启恢复，回收过期 running→pending）+ drainStage1Jobs（继续消费）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply, stage1Recover } = await import(PLUGIN)

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
  get: () => undefined, // no sessionQuery/llm -> drained job reduces to no_output
  tools: { register: (t) => { tools[t.name] = t } },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
}

const tmp = path.join(os.tmpdir(), 'dsh-rollout-restart-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const stateFile = () => path.join(tmp, 'memories', '.stage1-state.json')
const readJobs = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')).jobs || {} } catch { return {} } }

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, {})

  // Pre-restart state: one pending job + one running job whose lease expired.
  const now = Date.now()
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
  fs.writeFileSync(stateFile(), JSON.stringify({
    jobs: {
      's1::wm1': { id: 'j1', session_id: 's1', source_watermark: 'wm1', status: 'running', lease_expires_at: new Date(now - 5000).toISOString(), lease_owner: 'w1' },
      's2::wm2': { id: 'j2', session_id: 's2', source_watermark: 'wm2', status: 'pending', available_at: '', lease_owner: '' },
    },
    outputs: {},
    global: {},
  }), 'utf8')

  // "Restart" recovery: reclaim the expired running job back to pending.
  const n = stage1Recover(stateFile(), now)
  check(n === 1, 'restart recovery reclaims the expired running job')
  const after = readJobs()
  check(after['s1::wm1'].status === 'pending', 'expired running job -> pending after restart')
  check(after['s2::wm2'].status === 'pending', 'pending job survives restart untouched')

  // Continue consumption: drain processes the recovered + pending jobs.
  const res = await tools['memory__stage1_drain'].execute({})
  const final = readJobs()
  check(res.processed >= 2, 'drain consumed the recovered + pending jobs')
  check(final['s1::wm1'].completed_at || final['s1::wm1'].status !== 'pending', 'recovered job was submitted')
  check(final['s2::wm2'].completed_at, 'pending job was submitted')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PIPELINE-RESTART-STYLE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
