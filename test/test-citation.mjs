// One-off isolated test for citation format (P#8 / GPT P1 "Codex 引用格式不兼容").
// Verifies memory_recall's citation_entries use the Codex `path:start-end|note=[...]`
// form pointing at a REAL file + line range, not the old `sessionId:index` form.
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { apply } = await import(PLUGIN)

const table = (() => {
  const m = new Map()
  return {
    put: (k, v) => { m.set(k, v); return Promise.resolve() },
    delete: (k) => Promise.resolve(m.delete(k)),
    keys: () => m.keys(),
    entries: () => m.entries(),
    get size() { return m.size },
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

const tmpHome = path.join(os.tmpdir(), 'dsh-rollout-cite-' + Date.now())
process.env.DSH_HOME = tmpHome
fs.mkdirSync(tmpHome, { recursive: true })
const memoryRoot = () => path.join(tmpHome, 'memories')

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

try {
  const config = { recallLimit: 10 }
  await apply(ctx, config)
  console.log('apply() OK')

  // Seed two long-term entries (sess-1 matches 'powershell', sess-2 'rmbg').
  table.put('e1', { content: 'The user prefers PowerShell for shell tasks.', tags: ['pref'], sessionId: 'sess-1', createdAt: '2026-08-27T00:00:00.000Z', source: 'ui' })
  table.put('e2', { content: 'RMBG is the background remover tool.', tags: ['tool'], sessionId: 'sess-2', createdAt: '2026-08-27T00:00:00.000Z', source: 'ui' })

  // MEMORY.md only materializes e1's line (so e2 must fall back to its draft).
  // The lines are chosen so each matching line has a stable, known 1-based index.
  const regLines = [
    '# MEMORY.md',
    '',
    'DeepSeek Harness memory registry. Grouped by task family.',
    '',
    '# Long-term memories',
    '',
    '- [pref] The user prefers PowerShell for shell tasks. (session=sess-1, updated=2026-08-27T00:00:00.000Z)',
  ]
  fs.mkdirSync(memoryRoot(), { recursive: true })
  fs.writeFileSync(path.join(memoryRoot(), 'MEMORY.md'), regLines.join('\n'), 'utf8')

  // Create a draft for sess-2 so the fallback path has a real file to cite.
  const draftsDir = path.join(memoryRoot(), 'rollout_summaries')
  fs.mkdirSync(draftsDir, { recursive: true })
  const draftBody = 'session_id: sess-2\ncwd: C:/sess-2\n\n# 会话草稿\n## 会话草稿\nRMBG related session body spanning a few lines.\n'
  fs.writeFileSync(path.join(draftsDir, 'sess-2.md'), draftBody, 'utf8')

  const recall = tools.memory_recall
  assert.ok(recall, 'memory_recall tool registered')

  // ── [1] entry found in MEMORY.md → `MEMORY.md:N-N` ──────────────────────────
  console.log('[1] citation points at MEMORY.md with a real line range')
  {
    const r = await recall.execute({ query: 'powershell', limit: 3 })
    check(r.entries.length === 1, 'one entry matched (sess-1)')
    check(/^MEMORY\.md:\d+-\d+\|note=\[.*\]$/.test(r.citation.replace(/[\s\S]*?<citation_entries>\n/, '').split('\n')[0]), 'citation entry is `MEMORY.md:start-end|note=[...]`')
    // e1's line is index 6 (0-based) => line 7.
    check(r.citation.includes('MEMORY.md:7-7'), 'cities the actual MEMORY.md line 7 for sess-1 entry')
    check(!/\bsess-1:\d+\b/.test(r.citation), 'no legacy `sessionId:index` citation form')
  }

  // ── [2] entry NOT in MEMORY.md but a draft exists → draft `path:start-end` ───
  console.log('[2] citation falls back to the session rollout draft path')
  {
    const r = await recall.execute({ query: 'rmbg', limit: 3 })
    check(r.entries.length === 1, 'one entry matched (sess-2)')
    check(r.citation.includes('rollout_summaries/sess-2.md:1-'), 'cites the session draft file with a line range')
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL CITATION-FORMAT TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
