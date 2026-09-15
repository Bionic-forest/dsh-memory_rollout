// t235（F5 返修 · 独立复核 §5）：**最终基线复核必须在发布写锁内**。
//
// 复核复现：锁外基线闸门（"模型等待期间变了"）能拦住，但检查之后到 `withWrite(publish)` 之间还夹着
// 引用观测状态更新、所有权检查等步骤；在**这个窗口**里发布一个新版本，旧批仍会拿旧材料发布并覆盖它。
// 本测试把并发发布**注入到"引用观测状态更新"处**（与复核的干预时点一致），然后断言：
//   · 旧批不得发布（ok:false / 理由含 baseline-changed / 状态 retry_wait / 指针不推进）；
//   · 并发发布的新结论仍在权威面上。
// 合成数据 + 临时 DSH_HOME + 模拟宿主，不调真实模型。
import assert from 'node:assert'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, setMeta } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t235-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const root = () => path.join(HOME, 'memories')
const readText = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const readCurrent = () => { try { return JSON.parse(readText(path.join(root(), 'current.json'))) } catch { return null } }
const sha = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex')

const llmMock = {
  stream: () => {
    const payload = JSON.stringify({ memory_summary: 'v1\n## BATCH-LOCAL', registry: '# MEMORY.md\nBATCH-LOCAL' })
    return {
      async *[Symbol.asyncIterator]() {
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

/** 模拟"另一条合法写路径"发布版本（与 `publishPhase2Version` 同形）。 */
const publishConcurrently = (id, summary, registry) => {
  const vd = path.join(root(), 'versions', id)
  fs.mkdirSync(vd, { recursive: true })
  fs.writeFileSync(path.join(vd, 'memory_summary.md'), summary, 'utf8')
  fs.writeFileSync(path.join(vd, 'MEMORY.md'), registry, 'utf8')
  fs.writeFileSync(path.join(vd, 'manifest.json'), JSON.stringify({
    version: id, summary_sha256: sha(summary), registry_sha256: sha(registry),
    phase2_authoritative: true, selection_scope: 'batch-inputs', created_at: new Date().toISOString(),
  }, null, 2), 'utf8')
  fs.writeFileSync(path.join(root(), 'current.json'), JSON.stringify({ version: id }), 'utf8')
  fs.writeFileSync(path.join(root(), 'memory_summary.md'), summary, 'utf8')
  fs.writeFileSync(path.join(root(), 'MEMORY.md'), registry, 'utf8')
}

const CONC_SUMMARY = 'v1\n## CONCURRENT-AFTER-CHECK'
const CONC_REGISTRY = '# MEMORY.md\nCONCURRENT-AFTER-CHECK'

// ── 注入点：`phase2_jobs` 的**引用观测状态更新**（锁外基线闸门之后、发布写锁之前） ──────────
let armed = false
let injected = false
const pj = domain.table('phase2_jobs')
const origUpdate = pj.update
pj.update = async (k, fn) => {
  const out = await origUpdate(k, fn)
  if (armed && out && Object.prototype.hasOwnProperty.call(out, 'reference_codes')) {
    armed = false
    injected = true
    publishConcurrently('v-concurrent-after-check', CONC_SUMMARY, CONC_REGISTRY)
  }
  return out
}

try {
  await apply(ctx, {})
  assert.ok(REG['memory__phase2_integrate'], 'phase2 tool registered')

  // 先建立权威面（第一版正常发布）。
  await seedOutput(domain, 'j-first', { session_id: 's-first', source_watermark: 'wm-1', rollout_summary: 'first', generated_at: '2026-09-15T00:00:00.000Z' })
  await setMeta(domain, { lastSuccessWatermark: '', lastPhase2At: '' })
  const p1 = await REG['memory__phase2_integrate'].execute({})
  check(p1.ok === true, `前置：首批正常发布（ok=${p1.ok}）`)

  // 第二批：在"锁外检查已通过"之后注入并发发布。
  await seedOutput(domain, 'j-second', { session_id: 's-second', source_watermark: 'wm-2', rollout_summary: 'second', generated_at: '2026-09-15T01:00:00.000Z' })
  armed = true
  const p2 = await REG['memory__phase2_integrate'].execute({})
  check(injected === true, '注入生效：并发发布发生在锁外检查之后的窗口里')
  const errs = Array.isArray(p2.errors) ? p2.errors.join(' | ') : String(p2.errors || '')
  check(p2.ok === false, `旧批**不得发布**（ok=${p2.ok}）`)
  check(errs.includes('baseline-changed') && errs.includes('before the publish lock'),
    `理由写明"发布锁前基线已变"（"${errs.slice(0, 120)}…"）`)
  const after = readCurrent()
  check(after && after.version === 'v-concurrent-after-check', `指针仍指向并发发布版（实测 ${after && after.version}）`)
  check(readText(path.join(root(), 'memory_summary.md')) === CONC_SUMMARY, '并发新结论没有被旧批覆盖')
  check(!readText(path.join(root(), 'memory_summary.md')).includes('BATCH-LOCAL'), '权威总纲里不含旧批产物')
  check(!fs.existsSync(path.join(root(), 'versions', String(p2.batchId || '_none_'))), `旧批没有留下自己的版本目录（batchId=${p2.batchId}）`)
  const jobs = [...domain.table('phase2_jobs').entries()].map(([, j]) => j)
  const j2 = jobs.find((j) => j && j.status === 'retry_wait')
  check(!!j2 && String(j2.last_error || '').includes('baseline-changed'), `批记录落 retry_wait + 理由（status=${j2 && j2.status}）`)
} finally {
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T235 F5 PUBLISH-LOCK-BASELINE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
