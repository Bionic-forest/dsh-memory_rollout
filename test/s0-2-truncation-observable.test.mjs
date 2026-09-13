// t149（S0-2 收口）：**截断可观测** —— 契约第 4 条「每批可在作业结果里观测
// 『是否发生截断 / 截断字符数 / 截断文件』」的永久回归测试。
//
// 此前该信息只存在于纯函数返回值与提示词文本里，作业结果（batch 返回体）看不到；
// 本测试盯住「批结果里有 `truncation` 且三项事实齐备」。
//
// 两个场景：
//   A) 增量输入超每条上限（600）⇒ truncated=true，count/charsCut/perInputLimit 齐备
//   B) 一切都在限内        ⇒ truncated=false，count=0 / charsCut=0
//
// ⚠ 夹具顺序：当前权威文件必须在 `await apply(ctx, {})` **之后**落盘（否则 apply 期的
//   确定性重建会覆盖它 —— 实测写入 200,565 码点会被改回 169）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

let failed = 0
const check = (c, m) => { if (c) console.log('  ✓ ', m); else { failed++; console.error('  ✗ ', m) } }

async function runCase(name, inputChars) {
  const HOME = path.join(os.tmpdir(), 's0-2-trunc-obs-' + Math.random().toString(36).slice(2, 8))
  const memDir = path.join(HOME, 'memories')
  fs.mkdirSync(memDir, { recursive: true })
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'llm'
      ? {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'text-delta', text: JSON.stringify({ memory_summary: 'v1\n## 索引\n- 结论 T149 → memories/x.md', registry: '# MEMORY.md\n- 结论 T149' }) }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }),
        }
      : k === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined),
  })
  process.env.DSH_HOME = HOME
  await apply(ctx, {})
  // apply 之后再落盘当前权威文件（小文件 ⇒ 当前文件侧不应有截断）
  fs.writeFileSync(path.join(memDir, 'memory_summary.md'), 'v1\n## 索引\n- 小总纲\n', 'utf8')
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# MEMORY.md\n- 小注册表\n', 'utf8')

  for (let i = 1; i <= 3; i++) {
    await seedOutput(domain, `obs-0${i}`, { rollout_summary: 'Z'.repeat(inputChars), selected_for_phase2: false })
  }
  const res = await ctx.tools['memory__phase2_integrate'].execute({})
  console.log(`  [${name}] 输入 ${inputChars} 字符 ×3 ⇒ truncation=${JSON.stringify(res && res.truncation)}`)
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
  return res
}

console.log('\n[S0-2 / t149] 截断可观测：作业结果里必须能看到「是否截断 / 截断字符数 / 截断文件」')

// ── A) 有序有截断 ──
const a = await runCase('A 增量输入超限', 900)
const t = a && a.truncation
check(a && a.ok === true, '整合成功（ok=true）')
check(!!t && typeof t === 'object', '批结果里带 truncation 对象')
check(t && t.truncated === true, `truncated=true（实测 ${t && t.truncated}）`)
check(t && Array.isArray(t.currentFilesTruncated) && t.currentFilesTruncated.length === 0, '当前权威文件未被截断（currentFilesTruncated 为空）')
check(t && t.currentCharsCut === 0, '当前权威文件被截字符数 = 0')
check(t && t.incrementalInputs && t.incrementalInputs.count === 3, `被截的增量输入条数 = 3（实测 ${t && t.incrementalInputs && t.incrementalInputs.count}）`)
check(t && t.incrementalInputs && t.incrementalInputs.charsCut > 0, `截断字符数 > 0（实测 ${t && t.incrementalInputs && t.incrementalInputs.charsCut}）`)
check(t && t.incrementalInputs && t.incrementalInputs.perInputLimit === 600, `每条上限 = 600（实测 ${t && t.incrementalInputs && t.incrementalInputs.perInputLimit}）`)
check(t && t.currentChars && t.currentChars.summary > 0, 'currentChars 如实反映当前总纲整篇长度')
check(t && t.droppedInputs === 0, `本批没有因条数上限被丢弃的输入（droppedInputs=${t && t.droppedInputs}）`)

// ── B) 无截断 ──
const b = await runCase('B 全在限内', 100)
const t2 = b && b.truncation
check(!!t2 && t2.truncated === false, `truncated=false（实测 ${t2 && t2.truncated}）`)
check(t2 && t2.incrementalInputs && t2.incrementalInputs.count === 0, '被截条数 = 0')
check(t2 && t2.incrementalInputs && t2.incrementalInputs.charsCut === 0, '截断字符数 = 0')
check(t2 && t2.currentFilesTruncated && t2.currentFilesTruncated.length === 0, '当前权威文件未被截断')

console.log(`\n${failed === 0 ? 'ALL S0-2 TRUNCATION-OBSERVABLE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
