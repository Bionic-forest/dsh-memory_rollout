// P0-R2-1 反例：Phase2 唤醒必须覆盖**所有** memory_changes 生产入口（不止 remember / UI add）。
// 上一轮只把 requestPhase2Integrate 散落在 memory_remember / UI add；forget（memory_forget →
// forgetRecord）、note（memory_note）、UI delete（/dsh-rollout/entries action=delete →
// forgetRecord）写入 pending change 后**没有**唤醒 Phase 2，导致空闲期 change 长期 pending、
// 权威 current 不更新（P0-4 同类残留）。
// 本轮把唤醒收口到 writeChangeRecord（成功 put 后异步 request），故此处只测这三个入口：
// 分别**仅**执行 forget / note / UI delete（不手动 integrate、不产生 Stage1 事件），
// 断言其 pending change 最终被自动消费（consumed）且 current 反映变更。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const tmp = path.join(os.tmpdir(), 'dsh-p0-r2-1-' + Date.now())
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
const changesOf = (domain, kind) => {
  const out = []
  for (const [, c] of domain.table('memory_changes').entries()) if (c && c.kind === kind) out.push(c)
  return out
}
// 追踪「第 from 条之后新增的某 kind 变更」，避免跨 case 的同类变更累计误判。
const newChangesSince = (domain, kind, from) => changesOf(domain, kind).slice(from)
const anyConsumed = (list) => list.some((c) => c.status === 'consumed')

// 可控 LLM mock：extraction 无输出（不产生 Stage1 事件），consolidation 回显可配置 llmResponse。
let llmResponse = { memory_summary: 'v1\n## consolidated', registry: '# MEMORY.md' }
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

// fake webServer（捕获 /dsh-rollout/entries 路由，走 UI delete）。
const routes = {}
const webServer = { register: (r) => { routes[r.path] = r; return () => {} } }

const tools = {}
const { ctx, domain } = makeCtx({
  get: (k) =>
    k === 'llm' ? llmMock
      : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : k === 'webServer' ? webServer
          : k === 'sessionQuery' ? { readSession: async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [] }) }
            : undefined,
  tools: { register: (t) => { tools[t.name] = t } },
})

const root = () => path.join(tmp, 'memories')
const postEntries = (payload) => {
  const req = { method: 'POST', on: (ev, cb) => { if (ev === 'data') req._d = cb; else if (ev === 'end') req._e = cb } }
  const res = { statusCode: 0, setHeader() {}, body: '', end(b) { res.body = b } }
  const h = routes['/dsh-rollout/entries'].handler
  const p = h(req, res)
  req._d(JSON.stringify(payload))
  req._e()
  return p.then(() => JSON.parse(res.body || '{}'))
}

try {
  await apply(ctx, { recallLimit: 20 })
  assert.ok(tools.memory_forget && tools.memory_note && tools.memory__phase2_integrate, 'forget/note/integrate tools registered')
  assert.ok(routes['/dsh-rollout/entries'], '/dsh-rollout/entries route registered')

  // ── [A] memory_forget 唤醒（无手动 integrate、无 Stage1 事件）──────────────
  console.log('[A] forget 产生的 pending change 自动消费 + current 反映（不再含被遗忘内容）')
  {
    const forgotten = 'the obsidian vault is sealed forever'
    // ① 先记住 X 作基线（remember 的自动唤醒会把它放进 current）。
    llmResponse = { memory_summary: 'v1\n## consolidated\n' + forgotten, registry: '# MEMORY.md\n- ' + forgotten }
    const rRemember = await tools.memory_remember.execute({ content: forgotten, tags: ['vault'] }, { agent: { session: { id: 't-fg' } } })
    assert.ok(!!rRemember.id, 'remember X returned an id')
    const baseConsumed = await waitUntil(() => changesOf(domain, 'remember').some((c) => c.status === 'consumed'), 4000)
    check(baseConsumed, 'base remember change consumed')
    check(currentSummary(root()).includes(forgotten), 'baseline current contains X')
    // ② 仅 forget（LLM mock 恶意回显 X 以证明忘记排除剥离它）。
    const forgetBefore = changesOf(domain, 'forget').length
    const rForget = await tools.memory_forget.execute({ id: rRemember.id })
    check(rForget.deleted === 1, 'forget returns deleted=1')
    check(changesOf(domain, 'forget').length === forgetBefore + 1, 'a kind=forget pending change entered the stream')
    check(changesOf(domain, 'forget')[forgetBefore].status === 'pending', 'forget change present before any manual integrate / stage1 event')
    llmResponse = { memory_summary: 'v1\n## consolidated\n' + forgotten, registry: '# MEMORY.md\n- ' + forgotten }
    const forgetConsumed = await waitUntil(() => anyConsumed(newChangesSince(domain, 'forget', forgetBefore)), 5000)
    check(forgetConsumed, 'forget change auto-consumed WITHOUT manual phase2_integrate / NEW stage1 event')
    check(!currentSummary(root()).includes(forgotten), 'current no longer contains the forgotten content (forget exclusion applied)')
  }

  // ── [B] memory_note 唤醒（无手动 integrate、无 Stage1 事件）───────────────
  console.log('[B] note 产生的 pending change 自动消费 + current 反映该内容')
  {
    const noteContent = 'user prefers concise answers with tables and bullets'
    llmResponse = { memory_summary: 'v1\n## consolidated\n' + noteContent, registry: '# MEMORY.md\n- ' + noteContent }
    const noteBefore = changesOf(domain, 'note').length
    const rNote = await tools.memory_note.execute({ slug: 'concise-pref', content: noteContent })
    assert.ok(!!rNote.file, 'note wrote a file')
    check(changesOf(domain, 'note').length === noteBefore + 1, 'a kind=note pending change entered the stream')
    const noteConsumed = await waitUntil(() => anyConsumed(newChangesSince(domain, 'note', noteBefore)), 5000)
    check(noteConsumed, 'note change auto-consumed WITHOUT manual phase2_integrate / stage1 event')
    check(currentSummary(root()).includes(noteContent), 'current reflects the noted content')
  }

  // ── [C] UI delete 唤醒（/dsh-rollout/entries action=delete → forgetRecord）────
  console.log('[C] UI delete 产生的 pending change 自动消费 + current 反映')
  {
    const forgotten = 'the celestial observatory telescopes the periphery'
    llmResponse = { memory_summary: 'v1\n## consolidated\n' + forgotten, registry: '# MEMORY.md\n- ' + forgotten }
    const rememberBefore = changesOf(domain, 'remember').length
    const rRemember = await tools.memory_remember.execute({ content: forgotten, tags: ['astro'] }, { agent: { session: { id: 't-ui' } } })
    assert.ok(!!rRemember.id, 'remember X returned an id')
    await waitUntil(() => anyConsumed(newChangesSince(domain, 'remember', rememberBefore)), 4000)
    check(currentSummary(root()).includes(forgotten), 'baseline current contains X')
    // 仅 UI delete（路由走 forgetRecord，不手动 integrate、无 Stage1 事件）。
    const forgetBefore = changesOf(domain, 'forget').length
    const del = await postEntries({ action: 'delete', id: rRemember.id })
    check(del.deleted === true, 'UI delete returns deleted=true (route returns boolean)')
    check(changesOf(domain, 'forget').length === forgetBefore + 1, 'UI delete produced a kind=forget change')
    llmResponse = { memory_summary: 'v1\n## consolidated\n' + forgotten, registry: '# MEMORY.md\n- ' + forgotten }
    const uiConsumed = await waitUntil(() => anyConsumed(newChangesSince(domain, 'forget', forgetBefore)), 5000)
    check(uiConsumed, 'UI-delete forget change auto-consumed WITHOUT manual integrate / stage1 event')
    check(!currentSummary(root()).includes(forgotten), 'current no longer contains the UI-deleted content')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL P0-R2-1 PHASE2-WAKE-ALL-CHANGES TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
