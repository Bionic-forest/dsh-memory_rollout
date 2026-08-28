// GPT P0-5 回归：Phase 2 发布/提交前的所有权 token 校验。
// 场景：批次 A 在 LLM 停留时被「另一个 worker」抢走（改掉 lease_owner/lease_token），
// A 放行后应判定丢失所有权：不发布（current.json 不动）、不消费（output 不标 consumed）、
// 且 batch 不置 committed。防止旧 worker 在失去租约后仍改权威基线。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, outputListOf } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

let release = () => {}
const llm = {
  stream() {
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise((r) => { release = r })
        yield { type: 'text-delta', text: JSON.stringify({ memory_summary: 'v1\n## stolen', registry: '# MEMORY.md\nstolen' }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}
const tools = {}
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm' ? llm : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  tools: { register: (t) => { tools[t.name] = t } },
})

const tmp = path.join(os.tmpdir(), 'dsh-rollout-p2-ownertoken-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const memoryRoot = () => path.join(tmp, 'memories')
const readCurrent = () => { try { return JSON.parse(fs.readFileSync(path.join(memoryRoot(), 'current.json'), 'utf8')) } catch { return null } }
const outputByWm = (w) => Object.values(outputListOf(domain)).find((o) => o && String(o.source_watermark) === w)
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)) }
  return false
}

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, {})
  assert.ok(tools['memory__phase2_integrate'], 'tool registered')

  console.log('[P0-5] 所有权丢失：批次被抢后旧 worker 不得发布/消费')
  await seedOutput(domain, 'job-a', { session_id: 's1', source_watermark: 'wm-a', rollout_summary: 'FACT_A', generated_at: '2026-01-01T00:00:00.000Z' })

  const first = tools['memory__phase2_integrate'].execute({})
  check(await waitUntil(() => Array.from(domain.table('phase2_jobs').entries()).some(([, j]) => j && j.status === 'running'), 2000), 'a running batch exists (in LLM)')
  const running = Array.from(domain.table('phase2_jobs').entries()).find(([, j]) => j && j.status === 'running')
  const batchId = running[0]
  // 模拟另一个 worker 抢走：改掉 lease_owner + lease_token，使旧 owner 失效。
  await domain.table('phase2_jobs').update(batchId, (cur) => ({ ...cur, lease_owner: 'other-boot', lease_token: 'stolen-token' }))
  release()
  const result = await first

  check(result.ran === false && result.reason === 'lost-ownership', 'result reports lost-ownership (not published)')
  check(result.ok === false, 'not ok (no false success)')
  check(!!readCurrent() ? readCurrent().version !== batchId : true, 'current.json did NOT switch to the stolen batch')
  check(!!outputByWm('wm-a') && outputByWm('wm-a').selected_for_phase2 !== true, 'output NOT consumed after ownership loss')
  const j = domain.table('phase2_jobs').get(batchId)
  check(j && j.status !== 'committed', 'batch NOT committed after ownership loss')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PHASE2 OWNERSHIP-TOKEN TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
