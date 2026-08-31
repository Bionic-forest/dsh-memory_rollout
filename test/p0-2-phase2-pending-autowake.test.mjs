// P0 #2 反例：idle 时 memory_remember 产生的 pending change 无需新 Stage1 事件，
// 经统一 requestPhase2Integrate 自动进入 Phase2/current（不吞手动整合的契约由
// phase2-changes.test.mjs 另行保障）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const tmp = path.join(os.tmpdir(), 'dsh-p0-2-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })
process.env.DSH_HOME = tmp

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const waitUntil = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 15))
  }
  return false
}
const currentSummary = (root) => {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8')).version
    return fs.readFileSync(path.join(root, 'versions', v, 'memory_summary.md'), 'utf8')
  } catch { try { return fs.readFileSync(path.join(root, 'memory_summary.md'), 'utf8') } catch { return '' } }
}
const currentRegistry = (root) => {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8')).version
    return fs.readFileSync(path.join(root, 'versions', v, 'MEMORY.md'), 'utf8')
  } catch { try { return fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8') } catch { return '' } }
}
const changesOf = (domain, kind) => {
  const out = []
  for (const [, c] of domain.table('memory_changes').entries()) if (c && c.kind === kind) out.push(c)
  return out
}
const changesPending = (domain) => {
  const out = []
  for (const [, c] of domain.table('memory_changes').entries()) if (c && c.status === 'pending') out.push(c)
  return out
}

const content = 'the teal gateway is the primary router'
const llmResponse = { memory_summary: 'v1\n## consolidated\n' + content, registry: '# MEMORY.md\n- ' + content }
const llmMock = {
  stream: (opts) => {
    const isExtract = String(opts && opts.system).includes('memory-extraction')
    if (isExtract) return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: JSON.stringify(llmResponse) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

try {
  const tools = {}
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'llm' ? llmMock : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
    tools: { register: (t) => { tools[t.name] = t } },
  })
  await apply(ctx, { recallLimit: 20 })
  assert.ok(tools.memory_remember, 'memory_remember registered')

  const before = changesPending(domain).length
  await tools.memory_remember.execute({ content, tags: ['net'] }, { agent: { session: { id: 't-idle' } } })
  check(changesPending(domain).length === before + 1, 'a pending change was created by memory_remember')
  check(changesPending(domain).length >= 1, 'pending change exists before any manual integrate')

  const autoIntegrated = await waitUntil(() => changesOf(domain, 'remember').some((c) => c.status === 'consumed'), 4000)
  check(autoIntegrated, 'pending change auto-consumed WITHOUT a manual phase2_integrate call')
  check(currentSummary(path.join(tmp, 'memories')).includes(content), 'authoritative summary reflects the remembered content (auto phase2)')
  check(currentRegistry(path.join(tmp, 'memories')).includes(content), 'authoritative registry reflects the remembered content')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL P0-2 PHASE2 PENDING AUTOWAKE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
