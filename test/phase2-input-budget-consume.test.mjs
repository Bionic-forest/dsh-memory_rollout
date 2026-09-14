// t144（S0-1）：预算裁剪与「消费提交」必须同口径 —— 不许「未见即消费」。
//
// 复现：一次积压 21 条未消费 stage1_outputs（> PROMPT_MAX_INPUTS=20 一条）。
//   - 提示词按预算只喂前 20 条（clampPromptInputs）；
//   - 若提交仍按「整批 input_ids」标 selected_for_phase2，则第 21 条**从未进过模型却被标已消费** ⇒ 静默丢来源。
//
// 本测试的判据（对每条输入都要成立）：
//   「**被标已消费**」 ⇔ 「**它的标记确实出现在本轮喂给模型的提示词里**」
// 并额外点名：**第 21 条不得"未见即消费"**。
//
// 只看 fake 表（helpers），不碰真实 storages/memories。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-s0input-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

const N = 21 // 比 PROMPT_MAX_INPUTS(20) 多 1 条即可复现
const markerOf = (i) => `S0MARKER-${String(i).padStart(2, '0')}`

let lastPrompt = ''
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm'
    ? {
        stream: (opts) => {
          lastPrompt = opts?.messages?.[0]?.content?.[0]?.text || ''
          const payload = JSON.stringify({
            // t216（D1）：引用改用**目录代号**（由代码渲染真实路径）；映射外的路径会被判"虚构引用"而拒发。
            memory_summary: 'v1\n## 索引\n- 结论S0 → [[REF1]]',
            registry: '# MEMORY.md\n- 结论S0',
          })
          return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
        },
      }
    : k === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      : undefined),
})

console.log(`\n[S0-1] 积压 ${N} 条未消费输入（> PROMPT_MAX_INPUTS）→ 每条要么被处理、要么明确留队`)
// 预置 21 条产物：key 即 id，rollout_summary 里放唯一标记
const ids = []
for (let i = 1; i <= N; i++) {
  const key = 's0out-' + String(i).padStart(2, '0')
  // t216（D1）：每条产物带真实 session_id ⇒ 可信引用映射里才有对应条目（否则指针无法被引用）。
  await seedOutput(domain, key, { session_id: 's-' + key, rollout_summary: markerOf(i), selected_for_phase2: false })
  ids.push(key)
}
// t216（D1）：引用映射只收录**目标真实存在**的来源 ⇒ 被引用的会话必须有真实草稿文件。
const draftsDir = path.join(HOME, 'memories', 'rollout_summaries')
fs.mkdirSync(draftsDir, { recursive: true })
for (const id of ids) {
  // 注意：草稿**不能**含 S0MARKER-*（否则会经「确定性重建」进入 MEMORY.md 而污染「是否进过提示词」的判定）。
  fs.writeFileSync(path.join(draftsDir, 's-' + id + '.md'), `session_id: s-${id}\ncwd: C:/tmp\n\n# 会话草稿\n- neutral body (draft exists so the reference is verifiable)\n`, 'utf8')
}
assert.equal(ids.length, N, 'seeded N outputs')
await apply(ctx, {})

const res = await ctx.tools['memory__phase2_integrate'].execute({})
console.log('  phase2 integrate 结果:', JSON.stringify(res))

// 逐条判定：被消费 与 是否真的进了提示词
const rows = ids.map((id) => {
  const o = domain.table('stage1_outputs').get(id) || {}
  const marker = markerOf(Number(id.slice(-2)))
  return { id, marker, consumed: o.selected_for_phase2 === true, inPrompt: lastPrompt.includes(marker) }
})
console.log('  输入#\t标记\t\t已消费\t进过提示词')
for (const r of rows) console.log(`  ${r.id}\t${r.marker}\t${r.consumed}\t${r.inPrompt}`)

const mismatch = rows.filter((r) => r.consumed !== r.inPrompt)
const notSeenButConsumed = rows.filter((r) => r.consumed && !r.inPrompt)

check(lastPrompt.length > 0, '本轮确实调用了一次整合模型（拿到了提示词）')
check(mismatch.length === 0, `「已消费」与「进过提示词」逐条一致（不一致 ${mismatch.length} 条${mismatch.length ? '：' + mismatch.map((r) => r.marker).join(',') : ''}）`)
check(notSeenButConsumed.length === 0, `不存在「未见即消费」（${notSeenButConsumed.length} 条${notSeenButConsumed.length ? '：' + notSeenButConsumed.map((r) => r.marker).join(',') : ''}）`)

// 点名第 21 条
const last = rows[N - 1]
check(!(last.consumed && !last.inPrompt), `第 ${N} 条（${last.marker}）不得"未见即消费"（consumed=${last.consumed} / inPrompt=${last.inPrompt}）`)
// 留队语义：本轮没进提示词的，必须仍为未消费（等下一批）
const queued = rows.filter((r) => !r.inPrompt)
check(queued.every((r) => !r.consumed), `本轮没进提示词的 ${queued.length} 条全部保持"未消费"（明确留队）`)
// 本轮进过提示词的，应当被消费掉（否则会重复喂）
const seen = rows.filter((r) => r.inPrompt)
check(seen.every((r) => r.consumed), `本轮进过提示词的 ${seen.length} 条全部标记为已消费`)

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}

console.log(`\n${failed === 0 ? 'ALL PHASE2 INPUT-BUDGET CONSUME TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
