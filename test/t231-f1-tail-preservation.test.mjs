// t231（F1 · 评审 §三 F1）：**长会话的末尾纠正不得在提炼前消失**。
//
// 旧实现 `truncateTranscript = raw.slice(0, cap)`（只留开头）⇒ 会话末尾的"撤销旧方案、改用新方案"根本进不了
// 模型，于是后续队列/引用/发布即便全对，也可能可靠地保存一个**已被用户推翻**的方案。
// 本测试走**真实提炼路径**（apply → `memory__stage1_drain`），并用假 llm 捕获"模型实际看到的输入文本"：
//   ① 头尾例子：开头提出 A、结尾明确否定 A 并确认 B ⇒ A 与 B **都要**在模型输入里，且中间有明确省略标注；
//   ② 中段例子：中段的关键事实仍会被省略 ⇒ 如实记录策略限制，**不宣称头尾方案无损**。
// 全程：合成数据 + 临时 DSH_HOME + 假宿主，**不调用真实模型**。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t231-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

// cap = max(200, maxExtractTokens × 4)。取小值让合成会话轻松超限，测试完全确定性。
const MAX_EXTRACT_TOKENS = 400
const CAP_CHARS = MAX_EXTRACT_TOKENS * 4

const extractionInputs = []      // 只收"提炼"这一步的输入（整合的输入另算，不混进索引）
const transcripts = new Map()
const msgEvent = (id, text) => ({
  type: 'user/message', seq: 0, time: 0, surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const readSession = async (id) => ({
  session: { version: 0, id, cwd: 'C:/proj', createdAt: 0 },
  events: [msgEvent(id, transcripts.get(id) || '')],
})
const EXTRACTION = { rollout_summary: '会话摘要（合成）', raw_memory: 'raw', slug: 'f1', keywords: 'k', title: 't' }
const CONSOLIDATION = { memory_summary: 'v1\n## 合成整合', registry: '# MEMORY.md\n- 合成整合' }
const llmMock = {
  stream: (opts) => {
    const isExtraction = String((opts && opts.system) || '').includes('memory-extraction')
    if (isExtraction) {
      const c = (opts && opts.messages && opts.messages[0] && opts.messages[0].content) || []
      extractionInputs.push(String((c[0] && c[0].text) || ''))
    }
    const payload = isExtraction ? EXTRACTION : CONSOLIDATION
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', text: JSON.stringify(payload) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}

const { ctx, domain } = makeCtx({
  get: (k) => (k === 'llm' ? llmMock
    : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      : k === 'sessionQuery' ? { readSession } : undefined),
})

const drain = () => ctx.tools['memory__stage1_drain'].execute({})

try {
  await apply(ctx, { maxExtractTokens: MAX_EXTRACT_TOKENS })
  assert.ok(ctx.tools['memory__stage1_drain'], 'drain tool registered')

  const head = '开头：我们决定采用旧方案 A（把危险删除直接硬删）。'
  const filler = '中段填充：与结论无关的排查流水账，用来把会话推过长度上限。'.repeat(70)
  const tail = '结尾（用户最终纠正）：撤销方案 A，改用方案 B；方案 B 已在本机验证通过。'

  // ── ① 头尾例子 ─────────────────────────────────────────────────────────────
  const S1 = 'f1a00000-1111-4222-8333-444455556666'
  transcripts.set(S1, head + filler + tail)
  await seedJob(domain, S1, 'wm-f1-a')
  const r1 = await drain()
  const t1 = extractionInputs[0] || ''
  check(r1 && r1.processed >= 1, `① 提炼真的跑过（processed=${r1 && r1.processed}）`)
  check(extractionInputs.length === 1, `① 捕获到 1 份提炼输入（实测 ${extractionInputs.length}）`)
  check(t1.includes('采用旧方案 A'), '① 开头（旧方案 A）进入模型输入')
  check(t1.includes('撤销方案 A') && t1.includes('改用方案 B'),
    '① **结尾的最终纠正（撤销 A / 改用 B）进入模型输入**（F1 的修法点）')
  check(t1.includes('因长度上限被省略'), '① 省略区段被**明确标注**（不是静默丢弃）')
  const iHead = t1.indexOf('采用旧方案 A'), iMark = t1.indexOf('因长度上限被省略'), iTail = t1.indexOf('撤销方案 A')
  check(iHead >= 0 && iMark > iHead && iTail > iMark,
    `① 顺序为「开头 → 省略标注 → 结尾」（${iHead} < ${iMark} < ${iTail}）`)
  check(t1.length <= CAP_CHARS + 16, `① 输入长度不超上限（实测 ${t1.length} ≤ ${CAP_CHARS + 16}）`)

  // ── ② 中段例子（记录策略限制）──────────────────────────────────────────────
  //   刻意把关键事实放在"头预算之后、尾预算之前"的**省略区**，用于如实登记"中段仍会丢"。
  const S2 = 'f1b00000-2222-4222-8333-444455556666'
  const padUnit = '中段填充：与结论无关的排查流水账。'          // 17 字符
  const mid = '中段关键事实：MIDDLE-KEY-FACT-1024（只出现在中段）。'
  transcripts.set(S2, head + padUnit.repeat(70) + mid + padUnit.repeat(45) + tail)
  await seedJob(domain, S2, 'wm-f1-b')
  const r2 = await drain()
  const t2 = extractionInputs[1] || ''
  check(r2 && r2.processed >= 1, `② 第二次提炼跑过（processed=${r2 && r2.processed}）`)
  check(t2.includes('撤销方案 A') && t2.includes('改用方案 B'), '② 结尾纠正仍在（头尾保留的稳定面）')
  check(!t2.includes('MIDDLE-KEY-FACT'), '② **中段关键事实确实被省略**（如实记录策略限制，不宣称无损）')
  check(t2.includes('因长度上限被省略'), '② 省略处仍有明确标注')
} finally {
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T231 F1 TAIL-PRESERVATION TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
