// 阶段 B 起步：Phase 2 增量输入选择 + 产物校验（纯函数）
import assert from 'node:assert'
const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { selectPhase2Inputs, validatePhase2Output } = await import(PLUGIN)
let failed = 0
const check = (cond, msg) => { if (cond) console.log('  ✓ ', msg); else { failed++; console.error('  ✗ ', msg) } }

console.log('[1] selectPhase2Inputs picks only changed/new outputs (incremental, §7.4)')
{
  const outputs = {
    a: { source_watermark: 'wm1', rollout_summary: 'x' },
    b: { source_watermark: 'wm2', rollout_summary: 'y' },
    c: { source_watermark: 'wm1', rollout_summary: 'z' },
  }
  // no baseline -> everything
  check(selectPhase2Inputs(outputs, '').length === 3, 'no baseline -> all 3')
  // baseline = wm1 -> only those differing from wm1
  const inc = selectPhase2Inputs(outputs, 'wm1')
  check(inc.length === 1 && inc[0].source_watermark === 'wm2', 'baseline wm1 -> only wm2 (changed) selected')
  check(selectPhase2Inputs(null, 'wm1').length === 0, 'no outputs -> empty')
}

console.log('[2] validatePhase2Output checks structure + secret leakage (§7.5)')
{
  const good = validatePhase2Output({ memory_summary: '# v1\nok', registry: '# REG\nok' })
  check(good.ok === true, 'valid output passes')
  const badStruct = validatePhase2Output({ memory_summary: '', registry: '' })
  check(badStruct.ok === false && badStruct.errors.some((e) => /memory_summary/.test(e)), 'empty summary fails structure')
  const secret = validatePhase2Output({ memory_summary: 'sk-abcDEF123456 secret', registry: 'x' })
  check(secret.ok === false && secret.errors.some((e) => /secret/.test(e)), 'unredacted secret fails')
  const redacted = validatePhase2Output({ memory_summary: 'key is [REDACTED]', registry: '' })
  check(redacted.ok === false && redacted.errors.some((e) => /registry/.test(e)), 'registry missing fails; already-redacted summary not a secret error')
}

console.log(`\n${failed === 0 ? 'ALL PHASE2-CORE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
