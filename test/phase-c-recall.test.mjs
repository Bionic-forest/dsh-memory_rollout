// 阶段 C（M6）：memory_recall 排序纳入新鲜度且保持只读；
// 以及 L7：memory_forget 只允许按精确 id 处理、禁用 tag 批量删除（§10.3）；
// P1-4：forget 置墓碑（status=forgotten）而非物理删除，墓碑条目绝不再被召回。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const table = (() => {
  const m = new Map()
  let putCount = 0
  return {
    put: (k, v) => { putCount++; m.set(k, v); return Promise.resolve() },
    get: (k) => m.get(k),
    delete: (k) => Promise.resolve(m.delete(k)),
    keys: () => m.keys(),
    entries: () => m.entries(),
    get size() { return m.size },
    get putCount() { return putCount },
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

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-phasecrecall-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const stamp = (n) => new Date(Date.now() - n * 86400000).toISOString()
const findEntry = (id) => { for (const [k, v] of table.entries()) if (k === id) return v; return null }

try {
  await apply(ctx, { recallLimit: 50 })
  assert.ok(tools.memory_recall, 'memory_recall tool registered')
  assert.ok(tools.memory_forget, 'memory_forget tool registered')

  // ── seed entries (recorded AFTER apply so the startup integrate sees an empty vault) ──
  const seed = (id, o) => table.put(id, { createdAt: o.createdAt || stamp(1), updatedAt: o.updatedAt || stamp(1), source: 'ui', ...o })
  seed('fresh-entry', { content: 'the alpha protocol is green', tags: ['proto'], updatedAt: stamp(1) })
  seed('stale-entry', { content: 'the beta protocol is green', tags: ['proto'], updatedAt: stamp(45) })
  seed('shared-a', { content: 'shared fact A', tags: ['shared'], updatedAt: stamp(1) })
  seed('shared-b', { content: 'shared fact B', tags: ['shared'], updatedAt: stamp(1) })

  // ── [1] t195 契约改向：同相关性下，>30 天未用的条目**失格**（不再是"排在后面"）──────
  console.log('[1] t195: >30 天未用 ⇒ 失格（对齐 codex `max_unused_days`）；fresh 正常召回')
  {
    const writesBefore = table.putCount
    const r = await tools.memory_recall.execute({ query: 'protocol', limit: 10 })
    check(r.entries.length === 1, '只召回未过期的那条（旧断言「两条都召回、stale 排第二」编码的是改前行为；t195 契约改向、**非放宽**）')
    check(r.entries[0].id === 'fresh-entry', '未过期条目被召回')
    check(!r.entries.some((e) => e.id === 'stale-entry'), 'stale（45 天未用）条目失格')
    check(table.putCount === writesBefore, 'recall 的**调用本身**不写（使用计数是异步/去抖的 best-effort 写，见 t195 测试）')
    // t195：使用计数是**异步**落盘的（读路径不等待）—— 等一拍再核。
    await new Promise((res) => setTimeout(res, 150))
    const fe = findEntry('fresh-entry')
    check(!!fe && (fe.usage_count || 0) >= 1 && !!fe.last_usage, `异步使用计数已落到被召回的条目（usage_count=${fe && fe.usage_count}, last_usage=${fe && !!fe.last_usage}）`)
  }

  // ── [2] P1-4/§10.3: forget tombstones the entry (status=forgotten), never by tag ──
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

  // ── [3] L7: tag-based batch delete is disabled (throws, deletes nothing) ──────
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

  // ── [4] L7: forget with no id throws an error ────────────────────────────────
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
