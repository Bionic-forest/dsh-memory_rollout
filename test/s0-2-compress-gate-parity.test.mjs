// S0-2「注册表与总纲同等待遇」compress 门（永久回归测试；原为 t149 的一次性复验驱动）：
// 显式压缩门对**两者**都开。
//
// 判据（run-tests.ps1 会用本文件）：
//   只有注册表超上限 → enqueued=true（同等待遇）
//   只有总纲超上限   → enqueued=true（反向 sanity，旧代码也过）
//   （反向对照：修复前「只有注册表超限」得 enqueued=false / not-over-cap —— 旧门只管总纲）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply, summaryCapFromTokens, registryCapFromTokens } = await import(PLUGIN)

const sumCap = summaryCapFromTokens(4000)
const regCap = registryCapFromTokens(4000)
console.log(`\n[t149 同等待遇驱动] summaryCap=${sumCap}  registryCap=${regCap}`)

let failed = 0
const check = (c, m) => { if (c) console.log('  PASS  ' + m); else { failed++; console.error('  FAIL  ' + m) } }

/** 在一个隔离 DSH_HOME 里跑一次 compress 显式入口，返回结果 */
async function runCase(name, summaryChars, registryChars) {
  const HOME = path.join(os.tmpdir(), 'g149-gate-' + Math.random().toString(36).slice(2, 8))
  const memDir = path.join(HOME, 'memories')
  fs.mkdirSync(memDir, { recursive: true })
  const { ctx } = makeCtx({
    get: (k) => (k === 'llm'
      ? { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: '{"memory_summary":"v1\\n## 索引\\n- x","registry":"# MEMORY.md\\n- x"}' }; yield { type: 'finish', reason: { kind: 'stop' } } } }) }
      : k === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined),
  })
  process.env.DSH_HOME = HOME
  await apply(ctx, {})
  // ⚠ apply 之后再落盘：无 .phase2-authoritative 标记时 apply 会跑确定性重建覆盖根文件（t149 实测）
  fs.writeFileSync(path.join(memDir, 'memory_summary.md'), 'v1\n## 索引\n' + '行\n'.repeat(Math.ceil(summaryChars / 2)).slice(0, summaryChars), 'utf8')
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# MEMORY.md\n' + 'R'.repeat(registryChars), 'utf8')
  const r = await ctx.tools['memory_integrate'].execute({ compress: true })
  const sumOnDisk = Array.from(fs.readFileSync(path.join(memDir, 'memory_summary.md'), 'utf8')).length
  const regOnDisk = Array.from(fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8')).length
  console.log(`  [${name}] 落盘 summary=${sumOnDisk} registry=${regOnDisk} ⇒ ${JSON.stringify(r)}`)
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
  return r
}

// A) 只有注册表超上限
const a = await runCase('A 只有注册表超限', Math.floor(sumCap / 2), regCap + 500)
check(a && a.enqueued === true, `只有注册表超上限也能开门（enqueued=${a && a.enqueued}，reason=${a && a.reason}）`)

// B) 只有总纲超上限（反向 sanity）
const b = await runCase('B 只有总纲超限', sumCap + 500, Math.floor(regCap / 2))
check(b && b.enqueued === true, `只有总纲超上限仍能开门（enqueued=${b && b.enqueued}，reason=${b && b.reason}）`)

console.log(`\n${failed === 0 ? 'ALL S0-2 COMPRESS-GATE PARITY TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
