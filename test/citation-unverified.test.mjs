// 阶段 0 · 第七项：引用不得返回占位来源
// 对应《向Codex原版系统看齐》§5.4 / §9.3「不得用 MEMORY.md:1-1 之类占位引用」。
// 当某条记忆既不在 MEMORY.md、也无可验证的会话草稿时，引用必须明确标记为
// 不可验证，而不是伪造一个指向并未证实包含该记忆的行号。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const table = (() => {
  const m = new Map()
  return {
    put: (k, v) => { m.set(k, v); return Promise.resolve() },
    delete: (k) => Promise.resolve(m.delete(k)),
    keys: () => m.keys(),
    entries: () => m.entries(),
    get size() { return m.size },
    _m: m,
  }
})()
const tools = {}
const ctx = {
  storageDomain: { open: async () => ({ table: (name) => table, close: async () => {} }) },
  get: () => undefined,
  tools: { register: (t) => { tools[t.name] = t } },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
}

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-unverified-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const memoryRoot = () => path.join(tmp, 'memories')

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  await apply(ctx, { recallLimit: 10 })
  // An entry whose text is NOT materialized in MEMORY.md and whose session has no
  // draft → the citation must mark it unverified, never MEMORY.md:1-1.
  table.put('e1', { content: 'the gamma protocol is green', tags: ['x'], sessionId: 'no-such-session', createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z', source: 'ui' })
  fs.mkdirSync(memoryRoot(), { recursive: true })
  fs.writeFileSync(path.join(memoryRoot(), 'MEMORY.md'), '# MEMORY.md\n(no gamma line here)\n', 'utf8')

  const r = await tools.memory_recall.execute({ query: 'gamma', limit: 5 })
  console.log('  citation:', JSON.stringify(r.citation))
  check(r.entries.length === 1, 'entry matched')
  check(/unverified/.test(r.citation), 'citation marks the entry unverified')
  check(!/MEMORY\.md:1-1/.test(r.citation), 'NO fabricated MEMORY.md:1-1 placeholder')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL CITATION-UNVERIFIED TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
