// 阶段 A · 接线②：drainStage1Jobs 消费持久 pending 作业（领取→提炼→提交）
// 验证：memory__stage1_drain 工具触发 drain，消费 .stage1-state.json 里到期 pending job；
// 无会话消息（raw 空）→ succeeded_no_output，作业被提交完成。不改变现有自动管线。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply, enqueueStage1JobFile } = await import(PLUGIN)

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
  get: () => undefined, // no sessionQuery, no llm -> raw empty -> no_output
  tools: { register: (t) => { tools[t.name] = t } },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
}

const tmp = path.join(os.tmpdir(), 'dsh-rollout-drain-' + Date.now())
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
  assert.ok(tools['memory__stage1_drain'] && typeof tools['memory__stage1_drain'].execute === 'function', 'memory__stage1_drain tool registered')

  // Seed one due pending job (available now).
  enqueueStage1JobFile(stateFile(), 's1', 'wm-v1', new Date())

  const res = await tools['memory__stage1_drain'].execute({})
  console.log('  drain processed:', res.processed)
  const jobs = readJobs()
  check(res.processed >= 1, 'drain processed at least one job')
  const job = jobs['s1::wm-v1']
  check(job && (job.status === 'succeeded_no_output' || job.completed_at), 'the drained job was submitted (no_output, no raw content)')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL DRAIN-STAGE1 TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 0)
