// S0-2 硬顶 fail-closed（永久回归测试；原为 t149 的一次性复验驱动）：
// 整篇超 PROMPT_CURRENT_HARD_MAX_CHARS 时必须「明确失败」，绝不把截断后的当前权威文件交给模型做全文替换。
//
// 判据（run-tests.ps1 会用本文件）：
//   整篇超硬顶：模型**不被调用**（llmCalls=0）+ 批记录带 current-version-too-large + 根文件**零变化**
//   （反向对照：修复前代码会照旧跑并把**截断**后的内容发布 ⇒ 尾部独有结论消失 = 静默丢结论，
//     实测 5 条断言红 —— 故本文件在修复前必红，具备检验效力）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const HOME = path.join(os.tmpdir(), 'g149-hardmax-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(path.join(HOME, 'memories'), { recursive: true })
process.env.DSH_HOME = HOME

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const mod = await import(PLUGIN)
const { apply, summaryCapFromTokens, registryCapFromTokens } = mod

const sumCap = summaryCapFromTokens(4000)
const regCap = registryCapFromTokens(4000)
const HARD_MAX = 200000
const TAIL = 'TAIL-HARDMAX-149-must-not-vanish'

const memDir = path.join(HOME, 'memories')
const summaryPath = path.join(memDir, 'memory_summary.md')
const registryPath = path.join(memDir, 'MEMORY.md')

// 造一份**整篇超硬顶**的当前总纲：尾部放独有结论
// ⚠ 必须在 apply() 之后再落盘：无 .phase2-authoritative 标记时 apply 会跑一次确定性重建，
//   把根文件覆盖掉（t149 实测：写 200,565 码点 → apply 后变 169 码点，夹具失效）。
const bigSummary = 'v1\n## 索引\n- 头\n' + 'S'.repeat(HARD_MAX + 500) + `\n- ${TAIL} → memories/x.md\n`
const shaOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
let before = {}

let llmCalls = 0
let lastPrompt = ''
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm'
    ? {
        stream: (opts) => {
          llmCalls++
          lastPrompt = opts?.messages?.[0]?.content?.[0]?.text || ''
          // 模型只会回显它在提示词里看到的东西（+ 一条新结论）——这是"全文替换"的真实形态
          const body = lastPrompt.includes(TAIL) ? bigSummary : `v1\n## 索引\n- 新结论 H149\n`
          const payload = JSON.stringify({ memory_summary: body, registry: '# MEMORY.md\n- 小注册表\n- 新 H149\n' })
          return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
        },
      }
    : k === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      : undefined),
})

await seedOutput(domain, 'h149out-01', { rollout_summary: 'H149 新输入', selected_for_phase2: false })
await apply(ctx, {})

// apply 之后再落盘当前权威文件（避开 apply 期的确定性重建）
fs.writeFileSync(summaryPath, bigSummary, 'utf8')
fs.writeFileSync(registryPath, '# MEMORY.md\n- 小注册表\n', 'utf8')
before = { summary: shaOf(summaryPath), registry: shaOf(registryPath), chars: Array.from(fs.readFileSync(summaryPath, 'utf8')).length }

console.log(`\n[t149 硬顶驱动] 当前总纲整篇 = ${before.chars} 码点（硬顶 ${HARD_MAX}，summaryCap=${sumCap}，registryCap=${regCap}）`)
const res = await ctx.tools['memory__phase2_integrate'].execute({})
console.log('  integrate 结果:', JSON.stringify(res))

const jobs = [...domain.table('phase2_jobs').entries()].map(([k, v]) => ({ id: k, ...v }))
console.log('  批记录:', JSON.stringify(jobs.map((j) => ({ id: j.id, status: j.status, last_error: (j.last_error || '').slice(0, 90) }))))

const after = { summary: shaOf(summaryPath), registry: shaOf(registryPath), chars: Array.from(fs.readFileSync(summaryPath, 'utf8')).length }
const stillHasTail = fs.readFileSync(summaryPath, 'utf8').includes(TAIL)
console.log(`  根文件 ${before.summary.slice(0, 12)} → ${after.summary.slice(0, 12)}（${after.chars} 码点）；尾部结论还在? ${stillHasTail}`)

let failed = 0
const check = (c, m) => { if (c) console.log('  PASS  ' + m); else { failed++; console.error('  FAIL  ' + m) } }

const failedJob = jobs.some((j) => String(j.last_error || '').includes('current-version-too-large'))
check(llmCalls === 0, `整篇超硬顶时**模型未被调用**（llmCalls=${llmCalls}）⇒ 没拿截断内容去做全文替换`)
check(failedJob, `批记录带明确失败原因 current-version-too-large（实测 ${failedJob ? '命中' : '未命中'}）`)
check(res && res.ok !== true, `integrate 未报成功（ok=${res && res.ok}）`)
check(!stillHasTail === false, `尾部独有结论**仍在**根文件里（未被截断发布覆盖）`)
check(after.summary === before.summary, `根 memory_summary.md **字节零变化**（未发布新版本）`)

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n${failed === 0 ? 'ALL S0-2 HARD-MAX FAIL-CLOSED TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
