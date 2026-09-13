// t164（R1 §6.3）：**完整请求预算** —— 单文件上限只管组件；真正要管的是整个请求：
// 两份旧文件之和 + 全部 memory_changes + 增量输入 + 提示词骨架 + 输出预留。
// 超预算 ⇒ 明确失败（不静默截断、不放大硬顶）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const mod = await import(PLUGIN)
const { apply, estimateRequestChars, requestTooLargeDiagnostic, REQUEST_HARD_MAX_CHARS } = mod

let failed = 0
const check = (c, m) => { if (c) console.log('  ✓ ', m); else { failed++; console.error('  ✗ ', m) } }

function makeEnv() {
  const HOME = path.join(os.tmpdir(), 't164-budget-' + Math.random().toString(36).slice(2, 8))
  const memDir = path.join(HOME, 'memories')
  fs.mkdirSync(memDir, { recursive: true })
  process.env.DSH_HOME = HOME
  let llmCalls = 0
  let lastPrompt = ''
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'llm'
      ? {
          stream: (opts) => {
            llmCalls++
            lastPrompt = opts && opts.messages && opts.messages[0] && opts.messages[0].content && opts.messages[0].content[0] ? opts.messages[0].content[0].text || '' : ''
            const payload = JSON.stringify({ memory_summary: 'v1\n## 索引\n- 结论 T164B → memories/x.md', registry: '# MEMORY.md\n- 结论 T164B' })
            return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
          },
        }
      : k === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined),
  })
  return { HOME, memDir, ctx, domain, llmCalls: () => llmCalls, prompt: () => lastPrompt }
}

const shaOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

console.log(`\n[t164 完整请求预算] REQUEST_HARD_MAX_CHARS = ${REQUEST_HARD_MAX_CHARS}`)
check(REQUEST_HARD_MAX_CHARS === 200000, `硬顶没有被"简单放大"（仍是 ${REQUEST_HARD_MAX_CHARS}）`)

// 纯函数自检
{
  const est = estimateRequestChars({ currentSummaryChars: 1000, currentRegistryChars: 2000, changesChars: 300, inputsChars: 400, promptChars: 5000, outputsReserveChars: 38400 })
  check(est.currentFilesChars === 3000, `currentFilesChars 是两份之和（实测 ${est.currentFilesChars}）`)
  check(est.scaffoldChars === 1300, `scaffoldChars = 提示词 − 已知部分（5000 − 3700 = 1300，实测 ${est.scaffoldChars}）`)
  check(est.totalChars === 5000 + 38400, `totalChars = 提示词 + 输出预留（实测 ${est.totalChars}）`)
  check(requestTooLargeDiagnostic(est) === '', '未超预算时诊断为空串')
  check(requestTooLargeDiagnostic({ ...est, totalChars: 200001 }) !== '', '超 1 字符即报超预算（边界）')
}

// ─────────── A) 两份文件各 120,000 码点：单文件都合法，加起来超预算 ───────────
console.log('\n  A) 两份旧文件各 120,000 码点（各自 < 20 万，但总和 + 输出预留 > 20 万）')
{
  const env = makeEnv()
  await seedOutput(env.domain, 't164b-a1', { rollout_summary: 'T164B 输入', selected_for_phase2: false })
  await apply(env.ctx, {})
  const sPath = path.join(env.memDir, 'memory_summary.md')
  const rPath = path.join(env.memDir, 'MEMORY.md')
  fs.writeFileSync(sPath, 'v1\n## 索引\n' + 'A'.repeat(120000), 'utf8')
  fs.writeFileSync(rPath, '# MEMORY.md\n' + 'B'.repeat(120000), 'utf8')
  const before = { s: shaOf(sPath), r: shaOf(rPath), sChars: Array.from(fs.readFileSync(sPath, 'utf8')).length }

  const res = await env.ctx.tools['memory__phase2_integrate'].execute({})
  const err = (res && Array.isArray(res.errors) && res.errors[0]) || ''
  console.log('  integrate:', JSON.stringify(res))
  console.log('  errors[0] =', err)

  check(res && res.ok === false, '明确失败（ok=false）')
  check(err.startsWith('request-too-large:'), `失败原因是**完整请求预算**（而不是单文件那条）：${err.slice(0, 60)}`)
  check(!err.startsWith('current-version-too-large'), '单文件早退**没有**触发（两份各自都合法）⇒ 说明这条是新覆盖，不是旧检查改名')
  check(env.llmCalls() === 0, `超预算时**模型零调用**（实测 ${env.llmCalls()}）—— 不把裁过的内容喂给模型`)
  check(shaOf(sPath) === before.s && shaOf(rPath) === before.r, '两份旧文件**字节零变化**（未发布、未截断）')
  check(Array.from(fs.readFileSync(sPath, 'utf8')).length === before.sChars, '旧文件没有被静默截断（长度不变）')
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

// ─────────── B) 预算内的正常批：给出构成，且当前文件整篇进提示词 ───────────
console.log('\n  B) 预算内：返回体给出请求构成，且当前文件整篇进提示词')
{
  const env = makeEnv()
  await seedOutput(env.domain, 't164b-b1', { rollout_summary: 'T164B 输入 B', selected_for_phase2: false })
  await apply(env.ctx, {})
  const sPath = path.join(env.memDir, 'memory_summary.md')
  const rPath = path.join(env.memDir, 'MEMORY.md')
  const sText = 'v1\n## 索引\n' + '- 旧结论 B\n'.repeat(300) + '- TAIL-T164B-BOTH-OK\n'
  const rText = '# MEMORY.md\n' + '- 注册表旧结论 B\n'.repeat(300) + '- TAIL-T164B-REG-OK\n'
  fs.writeFileSync(sPath, sText, 'utf8')
  fs.writeFileSync(rPath, rText, 'utf8')

  const res = await env.ctx.tools['memory__phase2_integrate'].execute({})
  console.log('  request =', JSON.stringify(res && res.request))
  check(res && res.ok === true, '预算内整合成功')
  const req = res && res.request
  check(!!req && typeof req === 'object', '返回体带 request（可观测）')
  check(req.currentFilesChars === Array.from(sText).length + Array.from(rText).length, `currentFilesChars = 两份之和（${req.currentFilesChars} vs ${Array.from(sText).length + Array.from(rText).length}）`)
  check(req.currentSummaryChars === Array.from(sText).length && req.currentRegistryChars === Array.from(rText).length, '两份分别计数')
  check(req.outputsReserveChars > 0, `输出预留 > 0（实测 ${req.outputsReserveChars}）`)
  check(req.totalChars === req.promptChars + req.outputsReserveChars, 'total = prompt + outputsReserve')
  check(requestTooLargeDiagnostic(req) === '', '该批未超预算')
  const p = env.prompt()
  check(p.includes('TAIL-T164B-BOTH-OK'), '当前总纲**整篇**进了提示词（尾部标记可见）')
  check(p.includes('TAIL-T164B-REG-OK'), '当前注册表**整篇**进了提示词（尾部标记可见）')
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T164 REQUEST-BUDGET TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
