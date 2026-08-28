// 阶段 C（M6）：memory_recall 排序纳入新鲜度/使用反馈 + 召回后记录 usage；
// 以及 L7：memory_forget 只允许按精确 id 处理、禁用 tag 批量删除（§10.3）；
// P1-4：forget 置墓碑（status=forgotten）而非物理删除，墓碑条目绝不再被召回。
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

const tmp = path.join(os.tmpdir(), 'dsh-rollout-phasecrecall-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const stamp = (n) => new Date(Date.now() - n * 86400000).toISOString()
const findEntry = (id) => { for (const [k, v] of table.entries()) if (k === id) return v; return null }
const usageOf = (id) => { const v = findEntry(id); return v ? Number(v.usage_count || 0) : null }

try {
  await apply(ctx, { recallLimit: 50 })
  assert.ok(tools.memory_recall, 'memory_recall tool registered')
  assert.ok(tools.memory_forget, 'memory_forget tool registered')

  // ── seed entries (recorded AFTER apply so the startup integrate sees an empty vault) ──
  const seed = (id, o) => table.put(id, { createdAt: o.createdAt || stamp(1), updatedAt: o.updatedAt || stamp(1), source: 'ui', ...o })
  seed('fresh-entry', { content: 'the alpha protocol is green', tags: ['proto'], updatedAt: stamp(1) })
  seed('stale-entry', { content: 'the beta protocol is green', tags: ['proto'], updatedAt: stamp(45) })
  seed('used-entry', { content: 'the zeta widget setup is done', tags: ['widget'], updatedAt: stamp(1), usage_count: 5 })
  seed('unused-entry', { content: 'the eta widget setup is done', tags: ['widget'], updatedAt: stamp(1), usage_count: 0 })
  seed('shared-a', { content: 'shared fact A', tags: ['shared'], updatedAt: stamp(1) })
  seed('shared-b', { content: 'shared fact B', tags: ['shared'], updatedAt: stamp(1) })

  // ── [1] M6: same relevance, different freshness → fresh before stale ──────────
  console.log('[1] recall ranks fresh above a same-relevance stale entry')
  {
    const r = await tools.memory_recall.execute({ query: 'protocol', limit: 10 })
    check(r.entries.length === 2, 'two entries matched (protocol)')
    check(r.entries[0].id === 'fresh-entry', 'fresh entry ranked first')
    check(r.entries[1].id === 'stale-entry', 'stale entry ranked second')
  }

  // ── [2] M6: usage feedback is recorded on recall (last_used_at + usage_count++) ──
  console.log('[2] recall records usage: last_used_at set, usage_count incremented')
  {
    const a = findEntry('fresh-entry')
    check(a && typeof a.last_used_at === 'string' && a.last_used_at.length > 0, 'fresh-entry last_used_at set on recall')
    check(usageOf('fresh-entry') === 1, 'fresh-entry usage_count incremented to 1')
    const b = findEntry('stale-entry')
    check(b && b.last_used_at.length > 0, 'stale-entry last_used_at set on recall')
    check(usageOf('stale-entry') === 1, 'stale-entry usage_count incremented to 1')
  }

  // ── [3] M6: same relevance + same freshness → higher usage_count ranked first ──
  console.log('[3] recall ranks a previously-used entry above an unused one')
  {
    const r = await tools.memory_recall.execute({ query: 'widget', limit: 10 })
    check(r.entries.length === 2, 'two entries matched (widget)')
    check(r.entries[0].id === 'used-entry', 'used (usage_count=5) entry ranked first')
    check(r.entries[1].id === 'unused-entry', 'unused entry ranked second')
    check(usageOf('used-entry') === 6, 'used-entry usage_count incremented 5 -> 6 on recall')
    check(usageOf('unused-entry') === 1, 'unused-entry usage_count incremented 0 -> 1 on recall')
  }

  // ── [4] P1-4/§10.3: forget tombstones the entry (status=forgotten), never by tag ──
  // 设计强制：memory_forget 置墓碑而非物理删除 —— 条目保留（可溯源），但从召回/读取路径排除。
  console.log('[4] P1-4: memory_forget tombstones the exact id, never by tag')
  {
    const r = await tools.memory_forget.execute({ id: 'shared-a' })
    check(r.deleted === 1, 'exact-id forget processed 1 entry')
    const a = findEntry('shared-a')
    check(a !== null && a.status === 'forgotten', 'shared-a kept but marked forgotten (tombstone)')
    check(findEntry('shared-b') !== null, 'shared-b untouched')
    // 墓碑条目绝不再被召回（高相关性也不返回）。
    const sr = await tools.memory_recall.execute({ query: 'shared', limit: 10 })
    check(!sr.entries.some((e) => e.id === 'shared-a'), 'forgotten shared-a is NOT recalled')
    check(sr.entries.some((e) => e.id === 'shared-b'), 'active shared-b still recalled')
  }

  // ── [5] L7: tag-based batch delete is disabled (throws, deletes nothing) ──────
  console.log('[5] memory_forget rejects tag-based batch delete')
  {
    let threw = false
    try {
      await tools.memory_forget.execute({ tag: 'shared' })
    } catch (e) {
      threw = true
      check(/exact id/i.test(String(e.message)), 'error tells user to pass an exact id')
    }
    check(threw, 'tag delete threw (disabled)')
    check(findEntry('shared-b') !== null, 'shared-b still present after rejected tag delete')
  }

  // ── [6] L7: forget with no id throws an error ────────────────────────────────
  console.log('[6] memory_forget with no id/tag throws')
  {
    let threw = false
    try {
      await tools.memory_forget.execute({})
    } catch {
      threw = true
    }
    check(threw, 'no-arg forget threw')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PHASE-C-RECALL TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
