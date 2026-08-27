// 阶段 C 起步：记忆生命周期（新鲜度）+ 召回排序（§10.1/§10.4）纯函数
import assert from 'node:assert'
const PLUGIN = 'file:///D:/%E8%BD%AF%E4%BB%B6/Deepseek/plugins/dsh-rollout/lib/index.js'
const { freshnessOf, scoreMemory } = await import(PLUGIN)
let failed = 0
const check = (c, m) => { if (c) console.log('  ✓ ', m); else { failed++; console.error('  ✗ ', m) } }

console.log('[1] freshnessOf (§10.1)')
{
  const now = Date.now()
  const d = (n) => new Date(now - n * 86400000).toISOString()
  check(freshnessOf({ updatedAt: d(1) }, now) === 'fresh', 'used 1d ago -> fresh')
  check(freshnessOf({ updatedAt: d(10) }, now) === 'aging', 'used 10d ago -> aging')
  check(freshnessOf({ updatedAt: d(45) }, now) === 'stale', 'used 45d ago -> stale')
  check(freshnessOf({ status: 'superseded', updatedAt: d(1) }, now) === 'superseded', 'superseded wins regardless of recency')
  check(freshnessOf({ status: 'forgotten' }, now) === 'forgotten', 'forgotten -> forgotten')
  check(freshnessOf({ last_used_at: d(2) }, now) === 'fresh', 'last_used_at used when present')
}

console.log('[2] scoreMemory (§10.4: relevance + freshness + usage)')
{
  // high relevance + fresh + used => top; stale + low relevance => bottom
  const top = scoreMemory({ usage_count: 5 }, { relevance: 1, freshness: 1 })
  const bottom = scoreMemory({ usage_count: 0 }, { relevance: 0.1, freshness: 0 })
  check(top > bottom, 'relevant+fresh+used scores above irrelevant+stale+unused')
  const mid = scoreMemory({ usage_count: 2 }, { relevance: 0.5, freshness: 0.5 })
  check(mid > bottom && mid < top, 'mid between top and bottom')
  check(scoreMemory({}, { relevance: 0 }) === 0, 'zero relevance/freshness/usage -> 0')
}

console.log(`\n${failed === 0 ? 'ALL PHASE-C-CORE TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
