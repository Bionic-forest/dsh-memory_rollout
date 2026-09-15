// t233（F5 · 评审 §三 F5）：模型等待期间权威面被**另一条合法写路径**推进 ⇒ 旧批**不得**用它手里的旧基线发布。
//
// 旧实现：检测到权威面变化时**拒收执行者结果后用构建 prompt 时的旧权威回落重发** —— 那条 prompt 在模型
// 调用前就读好了旧文件，于是"等待期间新发布的结论"会被整篇重写覆盖。
// 本测试用**模拟宿主 + 假 llm** 复现最小场景：
//   · 先正常发布一版（建立 current.json / versions/）；
//   · 再开一批，把整合模型调用**按住**，在等待期间由"另一条合法写路径"发布新版本（v-concurrent）；
//   · 松开模型 ⇒ 断言：本批 **不发布**（ok:false / 理由含 baseline-changed / 状态 retry_wait / 指针未推进），
//     且并发发布的新结论**仍在权威面上**。
// 不调真实模型、不碰真实 storages/memories（全程临时 DSH_HOME）。
import assert from 'node:assert'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, setMeta } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t233-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const root = () => path.join(HOME, 'memories')
const summaryFile = () => path.join(root(), 'memory_summary.md')
const readText = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const readCurrent = () => { try { return JSON.parse(readText(path.join(root(), 'current.json'))) } catch { return null } }
const sha = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex')
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)) }
  return false
}

// ── 假 llm：整合调用可被"按住"，以便在等待期间插入并发发布 ────────────────────
let pauseNextConsolidation = false
let consolidationInFlight = false
let releaseConsolidation = () => {}
let consolidationCalls = 0
const llmMock = {
  stream: (opts) => {
    const payload = JSON.stringify({ memory_summary: 'v1\n## BATCH-LOCAL', registry: '# MEMORY.md\nBATCH-LOCAL' })
    return {
      async *[Symbol.asyncIterator]() {
        consolidationCalls++
        if (pauseNextConsolidation) {
          pauseNextConsolidation = false
          consolidationInFlight = true
          await new Promise((r) => { releaseConsolidation = r })
        }
        yield { type: 'text-delta', text: payload }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

const REG = {}
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm' ? llmMock
    : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
  tools: { register: (t) => { if (t && t.name) REG[t.name] = t } },
})

/** 模拟"另一条合法写路径"发布一个版本：版本目录 + 指针切换 + 根镜像（与 publishPhase2Version 同形）。 */
const publishConcurrently = (id, summary, registry) => {
  const vd = path.join(root(), 'versions', id)
  fs.mkdirSync(vd, { recursive: true })
  fs.writeFileSync(path.join(vd, 'memory_summary.md'), summary, 'utf8')
  fs.writeFileSync(path.join(vd, 'MEMORY.md'), registry, 'utf8')
  fs.writeFileSync(path.join(vd, 'manifest.json'), JSON.stringify({
    version: id, summary_file: 'memory_summary.md', registry_file: 'MEMORY.md', manifest_file: 'manifest.json',
    summary_sha256: sha(summary), registry_sha256: sha(registry), phase2_authoritative: true,
    selection_scope: 'batch-inputs', created_at: new Date().toISOString(),
  }, null, 2), 'utf8')
  fs.writeFileSync(path.join(root(), 'current.json'), JSON.stringify({ version: id }), 'utf8')
  fs.writeFileSync(summaryFile(), summary, 'utf8')
  fs.writeFileSync(path.join(root(), 'MEMORY.md'), registry, 'utf8')
}

const CONCURRENT_SUMMARY = 'v1\n## CONCURRENT-LEGAL-CONCLUSION'
const CONCURRENT_REGISTRY = '# MEMORY.md\nCONCURRENT-LEGAL-CONCLUSION'

try {
  await apply(ctx, {})
  assert.ok(REG['memory__phase2_integrate'], 'phase2 tool registered')

  // ── ① 正常发布一版，建立权威面 ────────────────────────────────────────────
  await seedOutput(domain, 'j-first', { session_id: 's-first', source_watermark: 'wm-1', rollout_summary: 'first', generated_at: '2026-09-15T00:00:00.000Z' })
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  const p1 = await REG['memory__phase2_integrate'].execute({})
  check(p1.ran === true && p1.ok === true, `① 首批正常发布（ran=${p1.ran} ok=${p1.ok}）`)
  const v1 = readCurrent()
  check(!!v1 && !!v1.version, `① 指针指向已发布版本（${v1 && v1.version}）`)

  // ── ② 第二批：模型等待期间由"另一条合法写路径"发布新结论 ────────────────────
  await seedOutput(domain, 'j-second', { session_id: 's-second', source_watermark: 'wm-2', rollout_summary: 'second', generated_at: '2026-09-15T01:00:00.000Z' })
  pauseNextConsolidation = true
  consolidationInFlight = false
  consolidationCalls = 0
  const pending = REG['memory__phase2_integrate'].execute({})
  const entered = await waitUntil(() => consolidationInFlight, 3000)
  check(entered === true, '② 整合模型调用已进入等待（此刻插入并发发布）')
  publishConcurrently('v-concurrent', CONCURRENT_SUMMARY, CONCURRENT_REGISTRY)
  const midCur = readCurrent()
  check(midCur && midCur.version === 'v-concurrent', '② 并发发布已切换指针（模拟另一条合法写路径）')
  releaseConsolidation()
  const p2 = await pending

  // ── ③ 断言：旧批不发布，新结论仍在 ─────────────────────────────────────────
  check(p2.ran === true && p2.ok === false, `③ 旧批**不发布**（ran=${p2.ran} ok=${p2.ok}）`)
  const errs = Array.isArray(p2.errors) ? p2.errors.join(' | ') : String(p2.errors || '')
  check(errs.includes('baseline-changed'), `③ 拒发理由写明基线变化（"${errs.slice(0, 90)}…"）`)
  const after = readCurrent()
  check(after && after.version === 'v-concurrent', `③ 指针仍指向并发发布版（实测 ${after && after.version}）`)
  check(readText(summaryFile()) === CONCURRENT_SUMMARY, '③ 并发结论**没有被旧批的 BATCH-LOCAL 覆盖**')
  check(!readText(summaryFile()).includes('BATCH-LOCAL'), '③ 权威总纲里不含旧批产物')
  check(!fs.existsSync(path.join(root(), 'versions', p2.batchId || '_none_')),
    `③ 旧批没有留下自己的版本目录（batchId=${p2.batchId}）`)
  const jobs = [...domain.table('phase2_jobs').entries()].map(([, j]) => j)
  const j2 = jobs.find((j) => j && j.status === 'retry_wait')
  check(!!j2 && String(j2.last_error || '').includes('baseline-changed'),
    `③ 批记录落 retry_wait + 理由（status=${j2 && j2.status}）`)
  check(!!j2 && Number(j2.attempt_count) === 1, `③ 已记 1 次尝试（不回滚计数）`)
} finally {
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T233 F5 BASELINE-GUARD TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
