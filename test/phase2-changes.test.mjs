// 第三轮返工第 4 步（R5 / P1-2）：建立统一变更流 memory_changes，Phase 2 统一解释并反映到权威
// memory_summary.md / MEMORY.md；forget 墓碑强语义（内容即使新增也绝不进权威摘要/召回）。
// 对应设计 §13《第三轮》§11.4 验收点：
//   ① memory_remember 后（change 入流）权威 summary/registry 在下一批更新为含该内容。
//   ② memory_forget 后：权威 summary/registry 不再含该内容 + 普通召回不含（即使近期新增同词内容）。
//   ③ forget 与新增同批时 forgot 优先（生成后校验被遗忘内容不存在）。
//   ④ note/draft/import 同批内容有 source_ref 且进权威（或至少记录 change 可重放）。
//   ⑤ supersede 后旧事实不召回、可追 superseded_by（权威版本生成路径排除旧事实）。
import assert from 'node:assert'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, setMeta } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

// ── controllable LLM mock ───────────────────────────────────────────────────
let consolidationCalls = 0
let lastConsolidationPrompt = ''
let llmReturnNull = false
let llmResponse = { memory_summary: 'v1\n## consolidated', registry: '# MEMORY.md\nconsolidated registry' }
const llmMock = {
  stream: (opts) => {
    const isExtract = opts && String(opts.system).includes('memory-extraction')
    if (isExtract) {
      return { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
    }
    consolidationCalls++
    lastConsolidationPrompt =
      (opts.messages && opts.messages[0] && opts.messages[0].content && opts.messages[0].content[0] && opts.messages[0].content[0].text) || ''
    if (llmReturnNull) throw new Error('llm down')
    const payload = JSON.stringify(llmResponse)
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: payload }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

// ── fake webServer (for the import route test) ──────────────────────────────
const routes = {}
const webServer = { register: (r) => { routes[r.path] = r; return () => {} } }

const tools = {}
const { ctx, domain } = makeCtx({
  get: (k) =>
    k === 'llm'
      ? llmMock
      : k === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : k === 'webServer'
          ? webServer
          : undefined,
  tools: { register: (t) => { tools[t.name] = t } },
})

const tmp = path.join(os.tmpdir(), 'dsh-rollout-changes-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })
const root = () => path.join(tmp, 'memories')
const summaryFile = () => path.join(root(), 'memory_summary.md')
const registryFile = () => path.join(root(), 'MEMORY.md')
const currentFile = () => path.join(root(), 'current.json')
const readCurrent = () => { try { return JSON.parse(fs.readFileSync(currentFile(), 'utf8')) } catch { return null } }
const verSummary = (v) => { try { return fs.readFileSync(path.join(root(), 'versions', v, 'memory_summary.md'), 'utf8') } catch { return '' } }
const verRegistry = (v) => { try { return fs.readFileSync(path.join(root(), 'versions', v, 'MEMORY.md'), 'utf8') } catch { return '' } }
const currentSummary = () => { const c = readCurrent(); return c && c.version ? verSummary(c.version) : (() => { try { return fs.readFileSync(summaryFile(), 'utf8') } catch { return '' } })() }
const currentRegistry = () => { const c = readCurrent(); return c && c.version ? verRegistry(c.version) : (() => { try { return fs.readFileSync(registryFile(), 'utf8') } catch { return '' } })() }
const changeListOf = () => { const out = {}; for (const [k, v] of domain.table('memory_changes').entries()) out[k] = v; return out }
const changesOf = (kind) => Object.values(changeListOf()).filter((c) => c.kind === kind)
const changesPending = () => Object.values(changeListOf()).filter((c) => c.status === 'pending')
const changesConsumed = () => Object.values(changeListOf()).filter((c) => c.status === 'consumed')

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const remember = (args) => tools.memory_remember.execute(args, { agent: { session: { id: 't-chg' } } })

try {
  await apply(ctx, { recallLimit: 50 })
  assert.ok(tools['memory_remember'], 'memory_remember registered')
  assert.ok(tools['memory_forget'], 'memory_forget registered')
  assert.ok(tools['memory_note'], 'memory_note registered')
  assert.ok(tools['memory__phase2_integrate'], 'memory__phase2_integrate registered')

  // ── ① remember 入流 → 下一批权威版本含该内容 ──────────────────────────────
  console.log('[①] memory_remember 入流，权威版本在下一批更新为含该内容')
  {
    const content = 'the teal gateway is the primary router'
    llmResponse = { memory_summary: 'v1\n## consolidated\n' + content, registry: '# MEMORY.md\n- ' + content }
    consolidationCalls = 0
    const rRemember = await remember({ content, tags: ['net'] })
    check(!!rRemember.id, 'remember returns an entry id')
    check(changesOf('remember').length === 1, 'a kind=remember change entered the stream')
    check(changesPending().length === 1, 'the remember change is pending')
    check(changesOf('remember')[0].payload.content === content, 'change payload carries the remembered content')
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === true, 'batch committed after remember')
    check(lastConsolidationPrompt.includes(content), 'consolidation prompt received the remembered content')
    check(currentSummary().includes(content), 'authoritative summary reflects the remembered content')
    check(currentRegistry().includes(content), 'authoritative registry reflects the remembered content')
    check(changesConsumed().length === 1, 'remember change consumed after the batch')
    const chg = changesOf('remember')[0]
    check(chg.status === 'consumed' && !!chg.phase2_batch_id, 'consumed change has phase2_batch_id')
  }

  // ── ② forget 后权威版本不再含该内容；普通召回也不含（即使新增同词内容）─────
  console.log('[②] memory_forget 后权威 summary/registry 与该内容隔离 + 普通召回不含')
  {
    const forgotten = 'the obsidian vault is sealed'
    const sameWord = 'the obsidian protocol is active'
    // ① 先记住 X 并将其整合进权威版本。
    llmResponse = { memory_summary: 'v1\n## consolidated\n' + forgotten, registry: '# MEMORY.md\n- ' + forgotten }
    const rX = await remember({ content: forgotten, tags: ['vault'] })
    check(!!rX.id, 'remember X ok')
    await tools['memory__phase2_integrate'].execute({})
    // ② 遗忘 X（墓碑）。
    const rForget = await tools.memory_forget.execute({ id: rX.id })
    check(rForget.deleted === 1, 'forget returns deleted=1')
    check(changesOf('forget').length === 1, 'a kind=forget tombstone change entered the stream')
    // ③ 记住一个与 X 有同词的新内容（模拟「近期新增含该词的内容」）。
    const rY = await remember({ content: sameWord, tags: ['obsidian'] })
    check(!!rY.id, 'remember Y ok')
    check(rY.id !== rX.id, 'Y is a distinct entry from X')
    // ④ 下一批：LLM 恶意回显被遗忘内容 X + 保留 Y。生成后校验必须剥离 X。
    llmResponse = {
      memory_summary: 'v1\n## consolidated\n' + forgotten + '\n' + sameWord,
      registry: '# MEMORY.md\n- ' + forgotten + '\n- ' + sameWord,
    }
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === true, 'batch committed after forget+remember')
    check(lastConsolidationPrompt.includes('MUST NOT APPEAR'), 'prompt carries the forget exclusion rule')
    check(lastConsolidationPrompt.includes(forgotten), 'prompt names the forgotten content to exclude')
    check(!currentSummary().includes(forgotten), 'authoritative summary does NOT contain forgotten content')
    check(!currentRegistry().includes(forgotten), 'authoritative registry does NOT contain forgotten content')
    check(currentSummary().includes(sameWord), 'authoritative summary keeps the NEW same-word content')
    check(currentRegistry().includes(sameWord), 'authoritative registry keeps the NEW same-word content')
    // 普通召回：X 绝不返回，即使查询词出现在 Y 中。
    const rec = await tools.memory_recall.execute({ query: 'obsidian', limit: 10 })
    check(!rec.entries.some((e) => e.id === rX.id), 'recall does NOT return the forgotten entry')
    check(rec.entries.some((e) => e.id === rY.id), 'recall returns the new same-word entry')
    const forgetChg = changesOf('forget')[0]
    check(forgetChg.status === 'consumed' && !!forgetChg.phase2_batch_id, 'forget tombstone change consumed')
  }

  // ── ③ forget 与新增同批 → forgot 最高优先（生成后校验被遗忘内容不存在）─────
  console.log('[③] forget 与新增同批时 forget 最高优先（被遗忘内容不存在）')
  {
    const forgotten = 'the crimson cipher is unbreakable'
    const sameWord = 'the crimson algorithm is preferred'
    // 记住 X + 遗忘 X + 记住 Y 都发生在同一批之前（三个变更都 pending）。
    const rX = await remember({ content: forgotten, tags: ['cipher'] })
    await tools.memory_forget.execute({ id: rX.id })
    llmResponse = { memory_summary: 'v1\n## consolidated\n' + forgotten, registry: '# MEMORY.md\n- ' + forgotten }
    const rY = await remember({ content: sameWord, tags: ['cipher'] })
    // 三个变更（remember X / forget X / remember Y）应同批冻结。
    check(changesPending().length === 3, 'three changes pending before the same batch')
    // 下一批：LLM 同时回显 X（应被剥）与 Y（应保留）。
    llmResponse = {
      memory_summary: 'v1\n## consolidated\n' + forgotten + '\n' + sameWord,
      registry: '# MEMORY.md\n- ' + forgotten + '\n- ' + sameWord,
    }
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === true, 'batch committed')
    check(!currentSummary().includes(forgotten), 'forgotten content absent from authoritative summary')
    check(currentSummary().includes(sameWord), 'new same-word content present in authoritative summary')
    check(!currentRegistry().includes(forgotten), 'forgotten content absent from authoritative registry')
    check(currentRegistry().includes(sameWord), 'new same-word content present in authoritative registry')
  }

  // ── ④ note 入流（有 source_ref）且进权威版本 ─────────────────────────────
  console.log('[④] note 内容有 source_ref 且随批进权威版本')
  {
    const noteContent = 'user prefers concise answers with tables'
    llmResponse = { memory_summary: 'v1\n## consolidated\n' + noteContent, registry: '# MEMORY.md\n- ' + noteContent }
    const rNote = await tools.memory_note.execute({ slug: 'concise-pref', content: noteContent })
    check(!!rNote.file, 'note wrote a file')
    check(changesOf('note').length === 1, 'a kind=note change entered the stream')
    check(changesOf('note')[0].source_ref === rNote.file, 'note change carries source_ref')
    check(changesOf('note')[0].payload.content === noteContent, 'note change payload carries the content')
    llmResponse = { memory_summary: 'v1\n## consolidated\n' + noteContent, registry: '# MEMORY.md\n- ' + noteContent }
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === true, 'batch committed')
    check(currentSummary().includes(noteContent), 'authoritative summary reflects note')
    check(changesOf('note')[0].status === 'consumed', 'note change consumed')
    check(changesPending().length === 0, 'no pending changes remain after batch')
  }

  // ── ⑤ supersede 后旧事实不召回、可追 superseded_by，权威版本排除旧事实 ────
  console.log('[⑤] supersede 后旧事实不召回、可追替代链，权威版本排除旧事实')
  {
    const oldFact = 'the legacy facade is blue'
    const newFact = 'the modern facade is green'
    const rOld = await remember({ content: oldFact, tags: ['facade'] })
    const rNew = await remember({ content: newFact, tags: ['facade'], supersedes: [rOld.id] })
    check(changesOf('supersede').length >= 1, 'a kind=supersede change entered the stream')
    // 召回：默认不返回旧事实，返回新事实；审计可追 superseded_by。
    const rec = await tools.memory_recall.execute({ query: 'facade', limit: 10 })
    check(!rec.entries.some((e) => e.id === rOld.id), 'superseded fact NOT recalled by default')
    check(rec.entries.some((e) => e.id === rNew.id), 'replacement fact recalled')
    const audit = await tools.memory_recall.execute({ query: 'facade', limit: 10, includeSuperseded: true })
    const audited = audit.entries.find((e) => e.id === rOld.id)
    check(!!audited && audited.supersededBy === rNew.id, 'audit traces superseded_by to the replacement')
    // 权威版本生成路径排除旧事实：LLM 恶意回显，生成后校验剥离。
    llmResponse = { memory_summary: 'v1\n## consolidated\n' + oldFact + '\n' + newFact, registry: '# MEMORY.md\n- ' + oldFact + '\n- ' + newFact }
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === true && r.ok === true, 'batch committed after supersede')
    check(!currentSummary().includes(oldFact), 'authoritative summary excludes the superseded old fact')
    check(currentSummary().includes(newFact), 'authoritative summary keeps the replacement fact')
    check(!currentRegistry().includes(oldFact), 'authoritative registry excludes the superseded old fact')
    const supChg = changesOf('supersede').find((c) => c.payload && c.payload.targetId === rOld.id)
    check(!!supChg && supChg.status === 'consumed', 'supersede change consumed')
  }

  // ── 预期：上述各批之后，当前版本已含最新权威内容（无回归）──────────────
  console.log('[幂等] 无新变更时再次调度为 no-change（不重复消费/不重发布）')
  {
    const before = currentSummary()
    const r = await tools['memory__phase2_integrate'].execute({})
    check(r.ran === false && r.reason === 'no-change', 'no-change when nothing pending')
    check(currentSummary() === before, 'authoritative summary unchanged (idempotent)')
  }

  // ── ④b import 变更可重放（通过 /dsh-rollout/import 路由触发）──────────────
  console.log('[④b] import 入流：产生 kind=import 变更记录（可重放）')
  {
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
    const bundle = {
      format: 'dsh-rollout-memory-backup',
      version: 1,
      files: [{ path: 'rollout_summaries/imp.md', content: b64('# imported session') }],
      entries: [{ id: 'imp-1', content: 'imported durable fact', createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z' }],
    }
    const importBefore = changesOf('import').length
    const req = { method: 'POST', on: (ev, cb) => { if (ev === 'data') req._d = cb; else if (ev === 'end') req._e = cb } }
    const res = { statusCode: 0, setHeader() {}, body: '', end(b) { res.body = b } }
    const handler = routes['/dsh-rollout/import'].handler
    const p = handler(req, res)
    req._d(JSON.stringify(bundle))
    req._e()
    const out = await p
    const parsed = JSON.parse(res.body || '{}')
    check(parsed.ok === true, 'import route succeeds')
    check(changesOf('import').length === importBefore + 1, 'a kind=import change entered the stream')
    const impChg = changesOf('import')[0]
    check(impChg.status === 'pending', 'import change is pending (re-playable)')
    check(impChg.payload && impChg.payload.entryCount === 1 && impChg.payload.fileCount === 1, 'import change payload records counts')
    check(impChg.priority >= 80, 'import change carries a high priority')
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PHASE2-CHANGES TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
