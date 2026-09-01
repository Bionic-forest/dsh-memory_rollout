// 阶段 C（P1-4 / P1-5）：生命周期完整治理 —— 谓词过滤 / 取代 / 去重 / 遗忘传播 / 引用验证。
// 对应《第三轮返工》§11.4（生命周期）与 §11.5（证据与引用）中不依赖 Phase B 批次/Step3 的部分。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply, validateSourceRef, contentOverlapRatio, normalizeContent } = await import(PLUGIN)

const table = (() => {
  const m = new Map()
  return {
    put: (k, v) => { m.set(k, v); return Promise.resolve() },
    get: (k) => m.get(k),
    delete: (k) => Promise.resolve(m.delete(k)),
    keys: () => m.keys(),
    entries: () => m.entries(),
    get size() { return m.size },
    _m: m,
  }
})()

// 真实 dsh-storage-domain 是多表隔离；本夹具只把 `entries` 保持在测试直接引用的 `table` 上，
// 其余表（stage1_jobs/stage1_outputs/phase2_jobs/memory_changes 等）用独立 Map，防止 `table.size`
// 被非 entries 表污染（第三轮返工第 4 步引入 memory_changes 后必须如此）。
const makeExtraTable = (backing) => ({
  put: (k, v) => { backing.set(k, v); return Promise.resolve() },
  get: (k) => backing.get(k),
  delete: (k) => Promise.resolve(backing.delete(k)),
  keys: () => backing.keys(),
  entries: () => backing.entries(),
  update: (k, fn) => {
    if (!backing.has(k)) return Promise.reject(new Error(`missing-key: ${k}`))
    const n = fn(backing.get(k))
    backing.set(k, n)
    return Promise.resolve(n)
  },
  get size() { return backing.size },
})
const extraTables = new Map()

const tools = {}
const ctx = {
  storageDomain: {
    open: async () => ({
      table: (name) => {
        if (name === 'entries') return table
        if (!extraTables.has(name)) extraTables.set(name, makeExtraTable(new Map()))
        return extraTables.get(name)
      },
      close: async () => {},
    }),
  },
  get: () => undefined,
  tools: { register: (t) => { tools[t.name] = t } },
  systemPrompt: { section: () => {} },
  effect: (fn) => fn(),
  on: () => () => {},
}

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-lifecycle-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const memoryRoot = () => path.join(tmp, 'memories')

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const stamp = (n) => new Date(Date.now() - n * 86400000).toISOString()
const findEntry = (id) => { for (const [k, v] of table.entries()) if (k === id) return v; return null }
const mem = (id) => {
  for (const [k, v] of table.entries()) if (k === id) return v
  return null
}

try {
  await apply(ctx, { recallLimit: 50 })
  assert.ok(tools.memory_recall, 'memory_recall registered')
  assert.ok(tools.memory_forget, 'memory_forget registered')
  assert.ok(tools.memory_remember, 'memory_remember registered')
  assert.ok(tools.memory_integrate, 'memory_integrate registered')

  const seed = (id, o) => table.put(id, { createdAt: o.createdAt || stamp(1), updatedAt: o.updatedAt || stamp(1), source: 'ui', ...o })
  const remember = (args, sid) => tools.memory_remember.execute(args, { agent: { session: { id: sid || 't1' } } })

  // ── [1] P1-4: forgotten 绝不召回（高相关性也不返回）───────────────────────────
  console.log('[1] forgotten never recalled')
  {
    seed('forgot-proto', { content: 'the forbidden alpha protocol is green', tags: ['proto'] })
    seed('active-proto', { content: 'the beta protocol is green', tags: ['proto'] })
    await tools.memory_forget.execute({ id: 'forgot-proto' })
    const r = await tools.memory_recall.execute({ query: 'protocol', limit: 10 })
    check(!r.entries.some((e) => e.id === 'forgot-proto'), 'forgotten entry excluded even at high relevance')
    check(r.entries.some((e) => e.id === 'active-proto'), 'active entry still recalled')
    const f = findEntry('forgot-proto')
    check(f && f.status === 'forgotten', 'forgotten entry is a tombstone (status=forgotten)')
  }

  // ── [2] P1-4 / §10.2: superseded 默认不返回；审计可看 + 能追 superseded_by 替代 ──
  console.log('[2] superseded hidden by default, visible in audit, superseded_by traced')
  {
    seed('old-fact', { content: 'the old protocol is blue', tags: ['proto'] })
    const res = await remember({ content: 'the new protocol is green', tags: ['proto'], supersedes: ['old-fact'] })
    const old = findEntry('old-fact')
    check(old.status === 'superseded', 'old-fact marked superseded')
    check(old.superseded_by === res.id, 'old-fact.superseded_by points at the replacement entry')
    const r = await tools.memory_recall.execute({ query: 'protocol', limit: 10 })
    check(!r.entries.some((e) => e.id === 'old-fact'), 'superseded fact NOT recalled by default')
    check(r.entries.some((e) => e.id === res.id), 'replacement entry recalled')
    const audit = await tools.memory_recall.execute({ query: 'protocol', limit: 10, includeSuperseded: true })
    const audited = audit.entries.find((e) => e.id === 'old-fact')
    check(!!audited, 'audit mode returns the superseded fact')
    check(audited.status === 'superseded' && audited.supersededBy === res.id, 'audited entry carries status + supersededBy')
  }

  // ── [3] §10.2 去重：同内容不新增（merged，count 不变，id 相同）─────────────────
  console.log('[3] remember dedupes identical content (no duplicate fact)')
  {
    check(normalizeContent('  Foo   BAR ') === 'foo bar', 'normalizeContent lowercases + collapses whitespace')
    const size0 = table.size
    const r1 = await remember({ content: 'the gamma preference is fixed', tags: ['pref'] })
    const r2 = await remember({ content: 'the gamma preference is fixed', tags: ['pref'] })
    check(r1.merged === false, 'first remember creates a new entry')
    check(r2.id === r1.id, 'second remember returns the SAME id (no new id)')
    check(r2.merged === true, 'second remember reports merged')
    check(table.size === size0 + 1, 'only one entry created (no duplicate)')
    check(!!mem(r1.id).updatedAt, 'merged entry refreshes updatedAt')
  }

  // ── [4] §10.2: remember 显式 supersedes 后旧条目 status=superseded、superseded_by 指向新 id ──
  console.log('[4] remember(supersedes:[id]) + auto high-overlap supersede')
  {
    seed('old-tool', { content: 'the legacy tool is deprecated', tags: ['tool'] })
    const res = await remember({ content: 'the modern tool is preferred', tags: ['tool'], supersedes: ['old-tool'] })
    const old = findEntry('old-tool')
    check(old.status === 'superseded', 'explicit supersedes: old-tool -> superseded')
    check(old.superseded_by === res.id, 'old-tool.superseded_by = new entry id')
    // 自动取代：内容高度重合（词重叠 >= 阈值）但不是同内容 → 自动 superseded。
    seed('old-autosuper', { content: 'the legacy widget is deprecated', tags: ['wg'] })
    const auto = await remember({ content: 'the legacy widget is deprecated now', tags: ['wg'] })
    const oa = findEntry('old-autosuper')
    check(oa.status === 'superseded' && oa.superseded_by === auto.id, 'auto-supersede: high-overlap entry superseded')
    check(contentOverlapRatio('the legacy widget is deprecated', 'the legacy widget is deprecated now') >= 0.75, 'overlap ratio reflects high similarity')
  }

  // ── [5] §10.3 / P1-4: forget 后召回与注入读取路径均不含该内容 ─────────────────
  console.log('[5] forget excludes content from recall AND from injected summary/registry')
  {
    seed('ghost-pref', { content: 'the ghost preference is meant to vanish', tags: ['pref'] })
    // 动的时候先 integrate 一次，让 summary 暂时写入（对照组）；再 forget + integrate 后应消失。
    // 注：为验证「读取路径排除」，直接在 forget 后 integrate 并断言 summary/registry 不含该内容。
    await tools.memory_forget.execute({ id: 'ghost-pref' })
    const r = await tools.memory_integrate.execute({})
    check(r.changed === true, 'integrate regenerates after forget (fingerprint changed)')
    const summary = fs.existsSync(path.join(memoryRoot(), 'memory_summary.md'))
      ? fs.readFileSync(path.join(memoryRoot(), 'memory_summary.md'), 'utf8')
      : ''
    const registry = fs.existsSync(path.join(memoryRoot(), 'MEMORY.md'))
      ? fs.readFileSync(path.join(memoryRoot(), 'MEMORY.md'), 'utf8')
      : ''
    check(!summary.includes('ghost preference'), 'memory_summary.md excludes the forgotten content')
    check(!registry.includes('ghost preference'), 'MEMORY.md excludes the forgotten content')
    const rec = await tools.memory_recall.execute({ query: 'ghost', limit: 10 })
    check(!rec.entries.some((e) => e.id === 'ghost-pref'), 'recall excludes the forgotten content')
  }

  // ── [6] P1-5: validateSourceRef 校验路径存在/行号范围/内容关联 ───────────────
  console.log('[6] validateSourceRef verifies real file+line evidence')
  {
    fs.mkdirSync(path.join(memoryRoot(), 'rollout_summaries'), { recursive: true })
    const rel = 'rollout_summaries/verify.md'
    // 行1-2 为相关内容；行5 才出现一个无关词。
    fs.writeFileSync(
      path.join(memoryRoot(), rel),
      'the protocol is green\nprotocol green line two\n\n\nan unrelated line here\n',
      'utf8',
    )
    // good: path exists + line range valid + content shares a token with the span
    check(validateSourceRef({ path: rel, startLine: 1, endLine: 2 }, memoryRoot(), { content: 'protocol green' }).ok === true, 'good: file+range+content association ok')
    // good: endLine 0 = to end of file
    check(validateSourceRef({ path: rel, startLine: 1, endLine: 0 }, memoryRoot(), { content: 'protocol green' }).ok === true, 'good: endLine 0 means to EOF')
    // bad: missing file
    check(validateSourceRef({ path: 'rollout_summaries/nope.md', startLine: 1, endLine: 1 }, memoryRoot(), { content: 'x' }).ok === false, 'bad: missing file rejected')
    // bad: startLine out of range
    check(validateSourceRef({ path: rel, startLine: 99, endLine: 100 }, memoryRoot(), { content: 'x' }).ok === false, 'bad: startLine out of range rejected')
    // bad: endLine < startLine
    check(validateSourceRef({ path: rel, startLine: 3, endLine: 2 }, memoryRoot(), { content: 'x' }).ok === false, 'bad: endLine before startLine rejected')
    // bad: unsafe/traversal path
    check(validateSourceRef({ path: '../secret.md', startLine: 1, endLine: 1 }, memoryRoot(), { content: 'x' }).ok === false, 'bad: traversal path rejected')
    // bad: content unrelated to the cited lines
    check(validateSourceRef({ path: rel, startLine: 1, endLine: 2 }, memoryRoot(), { content: 'quantum flute alchemy' }).ok === false, 'bad: unrelated content rejected')
  }

  // ── [7] 生命周期谓词不影响既有召回排序（回归自检）────────────────────────
  console.log('[7] recall still ranks stale below fresh (weight, not exclusion)')
  {
    seed('life-fresh', { content: 'the fresh lifecycle item is set', tags: ['lc'], updatedAt: stamp(1) })
    seed('life-stale', { content: 'the stale lifecycle item is set', tags: ['lc'], updatedAt: stamp(45) })
    const r = await tools.memory_recall.execute({ query: 'lifecycle', limit: 10 })
    check(r.entries.length === 2, 'both active entries recalled (stale is NOT excluded, just de-weighted)')
    check(r.entries[0].id === 'life-fresh', 'fresh ranks above stale (freshnessWeight down-weights stale)')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PHASE-C-LIFECYCLE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
