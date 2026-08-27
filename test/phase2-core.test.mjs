// 阶段 B：Phase 2 增量输入选择 + 产物校验（纯函数）
// M1：selectPhase2Inputs 只挑「未被消费」(selected_for_phase2 === false) 的产物，
//     不再依赖单一 lastSuccessWatermark 基线的相等比较（避免重复/漏整合）。
// M3：validatePhase2Output 增加 memory_summary 首行裸 `v1` 校验 + registry 安全引用校验。
import assert from 'node:assert'
const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { selectPhase2Inputs, validatePhase2Output } = await import(PLUGIN)
let failed = 0
const check = (cond, msg) => { if (cond) console.log('  ✓ ', msg); else { failed++; console.error('  ✗ ', msg) } }

console.log('[1] selectPhase2Inputs picks only NOT-consumed outputs (§7.4 / M1)')
{
  const outputs = {
    a: { source_watermark: 'wm1', rollout_summary: 'x' },
    b: { source_watermark: 'wm2', rollout_summary: 'y' },
    c: { source_watermark: 'wm1', rollout_summary: 'z' },
  }
  // 全部未消费 -> 全选（无论基线）
  check(selectPhase2Inputs(outputs, '').length === 3, 'all un-selected -> all 3 (no baseline)')
  const marked = { ...outputs, a: { ...outputs.a, selected_for_phase2: true } }
  const inc = selectPhase2Inputs(marked, '')
  check(inc.length === 2 && inc.every((o) => !o.selected_for_phase2), 'consumed "a" is skipped; only b,c remain')
  // 基线参数保留但不再驱动选择：即使传 wm1，被消费的 a 也不会重复选；b,c 仍入选
  const inc2 = selectPhase2Inputs(marked, 'wm1')
  check(inc2.length === 2 && inc2.every((o) => String(o.source_watermark) !== 'wm1' || !o.selected_for_phase2), 'baseline no longer drives selection (only !selected_for_phase2)')
  check(selectPhase2Inputs(null, 'wm1').length === 0, 'no outputs -> empty')
}

console.log('[2] 多水印、已消费不重选（M1 防重复整合）')
{
  const multi = {
    m1: { source_watermark: 'wm2', selected_for_phase2: true },
    m2: { source_watermark: 'wm3', selected_for_phase2: false },
    m3: { source_watermark: 'wm1', selected_for_phase2: true },
    m4: { source_watermark: 'wm4', selected_for_phase2: false },
  }
  const r = selectPhase2Inputs(multi, 'wm1')
  check(r.length === 2 && r.every((o) => !o.selected_for_phase2), 'only un-selected wm3/wm4 remain; consumed wm2/wm1 not re-selected')
  check(r.some((o) => String(o.source_watermark) === 'wm3') && r.some((o) => String(o.source_watermark) === 'wm4'), 'multi-watermark outputs all returned (not dropped by a single baseline)')
}

console.log('[3] validatePhase2Output checks structure + v1 + safe refs + secret (§7.5 / M3)')
{
  const good = validatePhase2Output({ memory_summary: 'v1\nok', registry: '# REG\nok' })
  check(good.ok === true, 'valid output (bare v1 first line) passes')
  const noV1 = validatePhase2Output({ memory_summary: '# v1\nok', registry: '# REG\nok' })
  check(noV1.ok === false && noV1.errors.some((e) => /v1/i.test(e)), 'missing bare "v1" marker fails')
  const badRef = validatePhase2Output({ memory_summary: 'v1\nok', registry: '- rollout_summaries/../../etc/passwd.md (cwd=x)' })
  check(badRef.ok === false && badRef.errors.some((e) => /unsafe reference/i.test(e)), 'unsafe registry reference (..) fails')
  const absRef = validatePhase2Output({ memory_summary: 'v1\nok', registry: '- /abs/rollout_summaries/x.md' })
  check(absRef.ok === false && absRef.errors.some((e) => /unsafe reference/i.test(e)), 'absolute reference fails')
  const badStruct = validatePhase2Output({ memory_summary: '', registry: '' })
  check(badStruct.ok === false && badStruct.errors.some((e) => /memory_summary/.test(e)), 'empty summary fails structure')
  const secret = validatePhase2Output({ memory_summary: 'sk-abcDEF123456 secret', registry: 'x' })
  check(secret.ok === false && secret.errors.some((e) => /secret/.test(e)), 'unredacted secret fails')
  const redacted = validatePhase2Output({ memory_summary: 'key is [REDACTED]', registry: '' })
  check(redacted.ok === false && redacted.errors.some((e) => /registry/.test(e)), 'registry missing fails; already-redacted summary not a secret error')
}

console.log(`\n${failed === 0 ? 'ALL PHASE2-CORE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
