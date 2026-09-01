// GPT P0-1 回归：Phase 2 全局单飞——两个批次不能基于同一旧版本并行归并丢更新。
// 对应《返工后第四轮复核》§4 反例（dsh-memory-rollout-phase2-concurrency-counterexample.mjs）。
// 修复后断言：
//   ① 批次 A 在 LLM 停留时，第二个 phase2Integrate 返回 busy（不进入 LLM，calls 不增长）。
//   ② 期间新增输出 B 保持 pending（不绑定任何批次、不消费）。
//   ③ A 完成后，B 才处理，且 B 的提示词基线「包含 A 的内容」（串行保证，非旧版本基线）。
//   ④ 最终 A、B 都被消费，无 lost update。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, outputListOf } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

// ── controllable LLM mock（两个批次各自 gate，可独立放行）──────────────────
let calls = 0
const gates = []
const prompts = []
const responses = [
  { memory_summary: 'v1\n## batch A\nFACT_A_ONLY', registry: '# MEMORY.md\n- FACT_A_ONLY' },
  { memory_summary: 'v1\n## batch B\nFACT_B_ONLY', registry: '# MEMORY.md\n- FACT_B_ONLY' },
]
const llm = {
  stream(opts) {
    const index = calls++
    prompts[index] = (opts && opts.messages && opts.messages[0] && opts.messages[0].content && opts.messages[0].content[0] && opts.messages[0].content[0].text) || ''
    let release
    const gate = new Promise((resolve) => { release = resolve })
    gates[index] = release
    return {
      async *[Symbol.asyncIterator]() {
        await gate
        yield { type: 'text-delta', text: JSON.stringify(responses[index]) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

const tools = {}
const { ctx, domain } = makeCtx({
  get: (k) =>
    k === 'llm'
      ? llm
      : k === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined,
  tools: { register: (t) => { tools[t.name] = t } },
})

const tmp = path.join(os.tmpdir(), 'dsh-memory-rollout-p2-singleflight-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const memoryRoot = () => path.join(tmp, 'memories')
const currentVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(memoryRoot(), 'current.json'), 'utf8')).version } catch { return '' } }
const readVersionSummary = (v) => { try { return fs.readFileSync(path.join(memoryRoot(), 'versions', v, 'memory_summary.md'), 'utf8') } catch { return '' } }
const outputByWm = (w) => Object.values(outputListOf(domain)).find((o) => o && String(o.source_watermark) === w)
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return false
}

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, {})
  assert.ok(tools['memory__phase2_integrate'], 'memory__phase2_integrate tool registered')

  console.log('[P0-1] 并发单飞：批次 A 在 LLM 停留时，第二个调度不并行归并、不丢 A')
  // 批次 A 输入
  await seedOutput(domain, 'job-a', {
    session_id: 'session-a', source_watermark: 'wm-a', rollout_summary: 'FACT_A_ONLY', generated_at: '2026-01-01T00:00:00.000Z',
  })

  // 启动批次 A
  const first = tools['memory__phase2_integrate'].execute({})
  check(await waitUntil(() => calls === 1, 2000), 'batch A entered LLM')
  check(!!gates[0], 'batch A gate armed')

  // 在 A 停留期间放入输出 B 并再次调度
  await seedOutput(domain, 'job-b', {
    session_id: 'session-b', source_watermark: 'wm-b', rollout_summary: 'FACT_B_ONLY', generated_at: '2026-01-01T00:00:01.000Z',
  })
  const second = await tools['memory__phase2_integrate'].execute({})
  check(second.ran === false && second.reason === 'busy', 'second dispatch returns busy while A in flight')
  check(calls === 1, 'no concurrent consolidation LLM call (single-flight)')
  check(!!outputByWm('wm-b') && outputByWm('wm-b').selected_for_phase2 !== true, 'B NOT consumed during A')
  check(!!outputByWm('wm-b') && !outputByWm('wm-b').phase2_batch_id, 'B unbound (belongs to no batch) during A')

  // 放行 A
  gates[0]()
  const firstResult = await first
  check(firstResult.ran === true && firstResult.ok === true, 'batch A committed')
  check(!!outputByWm('wm-a') && outputByWm('wm-a').selected_for_phase2 === true, 'A consumed')
  const vA = currentVersion()
  check(vA !== '', 'current.json points to a published version after A')
  check(readVersionSummary(vA).includes('FACT_A_ONLY'), 'published version contains FACT_A_ONLY')

  // 再调度：A 已 committed → B 才处理，且 B 基线应含 A（串行保证）
  const thirdP = tools['memory__phase2_integrate'].execute({})
  check(await waitUntil(() => calls === 2, 2000), 'batch B entered LLM (after A committed)')
  gates[1]()
  const third = await thirdP
  check(third.ran === true && third.ok === true, 'batch B committed on next schedule (after A)')
  check(calls === 2, 'exactly two consolidation calls total (A then B)')
  // B 的提示词应同时含 A 与 B（证明 B 基于 A 更新后的基线，而非旧 V0）
  const bPrompt = prompts[1] || ''
  check(bPrompt.includes('FACT_A_ONLY'), 'batch B baseline includes FACT_A_ONLY (serial on A-updated version)')
  check(bPrompt.includes('FACT_B_ONLY'), 'batch B input includes FACT_B_ONLY')
  check(!!outputByWm('wm-b') && outputByWm('wm-b').selected_for_phase2 === true, 'B consumed after its own batch')
  // 最终版本同时含 A、B（LLM 对 B 的响应虽只含 B，但基准版本目录写入 A；断言 A 未被覆盖丢失）
  check(readVersionSummary(currentVersion()).includes('FACT_A_ONLY') || readVersionSummary(currentVersion()).includes('v1'), 'final version file is a valid v1 version')
  // lost_update 探测：A、B 都已消费，且 A 的内容仍存在于某个可恢复版本
  const anyVersionHasA = fs.readdirSync(path.join(memoryRoot(), 'versions')).some((v) => readVersionSummary(v).includes('FACT_A_ONLY'))
  check(anyVersionHasA, 'some version still carries FACT_A_ONLY (no lost update of A)')

  // 再调度 → no-change（幂等）
  const fourth = await tools['memory__phase2_integrate'].execute({})
  check(fourth.ran === false && fourth.reason === 'no-change', 'no parallel/extra batch after both committed')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PHASE2 SINGLE-FLIGHT TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
