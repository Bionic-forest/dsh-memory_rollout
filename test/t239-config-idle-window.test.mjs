// t239（T29 · 两个配置键）：`minRolloutIdleHours`（默认 6，1–720）、`maxRolloutAgeDays`（默认 10，1–3650）
// 必须**同处、同机制**，并且在**设置页/覆盖层可写**（`OVERLAYABLE_KEYS` 由导出的 `CONFIG_FIELDS` 派生）。
//
// 断言：
//   ① `Config({})` 的默认值是 6 / 10；
//   ② 取值校验：范围内通过、越界拒绝（0 / 721 / 3651 等）；
//   ③ 两个键都在 `CONFIG_FIELDS` 里（⇒ GUI 表单会渲染、`pickEditable` 允许写、`applyConfigOverlay` 会套用）；
//   ④ `DEFAULT_MIN_ROLLOUT_IDLE_HOURS` / `DEFAULT_MAX_ROLLOUT_AGE_DAYS` 两个常量与 codex 同值（6 / 10）。
import assert from 'node:assert'

const M = await import(new URL('../lib/index.js', import.meta.url).href)
const { Config, CONFIG_FIELDS, DEFAULT_MIN_ROLLOUT_IDLE_HOURS, DEFAULT_MAX_ROLLOUT_AGE_DAYS } = M

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const section = async (label, fn) => {
  try { return await fn() } catch (err) {
    check(false, `${label} 中断（改前树上属预期的断言级红）：${err && err.message ? err.message : err}`)
  }
}

await section('[t239] 配置键：默认值 + 校验 + 可写面', async () => {
  check(typeof Config === 'function' || (Config && typeof Config === 'object'), 'Config schema 可解析')
  const base = Config({})
  check(base.minRolloutIdleHours === 6, `默认 minRolloutIdleHours=6（实测 ${base.minRolloutIdleHours}）`)
  check(base.maxRolloutAgeDays === 10, `默认 maxRolloutAgeDays=10（实测 ${base.maxRolloutAgeDays}）`)
  check(DEFAULT_MIN_ROLLOUT_IDLE_HOURS === 6 && DEFAULT_MAX_ROLLOUT_AGE_DAYS === 10,
    `常量对齐 codex（${DEFAULT_MIN_ROLLOUT_IDLE_HOURS} / ${DEFAULT_MAX_ROLLOUT_AGE_DAYS}）`)

  // 范围内
  const ok = Config({ ...base, minRolloutIdleHours: 12, maxRolloutAgeDays: 30 })
  check(ok.minRolloutIdleHours === 12 && ok.maxRolloutAgeDays === 30, '范围内取值通过（12 / 30）')
  const edges = Config({ ...base, minRolloutIdleHours: 1, maxRolloutAgeDays: 1 })
  check(edges.minRolloutIdleHours === 1 && edges.maxRolloutAgeDays === 1, '下界通过（1 / 1）')
  const high = Config({ ...base, minRolloutIdleHours: 720, maxRolloutAgeDays: 3650 })
  check(high.minRolloutIdleHours === 720 && high.maxRolloutAgeDays === 3650, '上界通过（720 / 3650）')

  // 越界拒绝
  let threw = 0
  for (const bad of [{ minRolloutIdleHours: 0 }, { minRolloutIdleHours: 721 }, { maxRolloutAgeDays: 0 }, { maxRolloutAgeDays: 3651 }]) {
    try { Config({ ...base, ...bad }); } catch { threw++ }
  }
  check(threw === 4, `越界一律拒绝（4 例中拒绝 ${threw} 例）`)

  // 可写面（GUI 表单 + 覆盖层白名单都是从 CONFIG_FIELDS 派生的）
  const keys = (Array.isArray(CONFIG_FIELDS) ? CONFIG_FIELDS : []).map((f) => f && f.key)
  check(keys.includes('minRolloutIdleHours'), `CONFIG_FIELDS 含 minRolloutIdleHours（${keys.length} 个字段）`)
  check(keys.includes('maxRolloutAgeDays'), 'CONFIG_FIELDS 含 maxRolloutAgeDays（⇒ 设置页可渲染、覆盖层可写）')
  const f = (Array.isArray(CONFIG_FIELDS) ? CONFIG_FIELDS : []).find((x) => x && x.key === 'minRolloutIdleHours')
  check(!!f && f.type === 'number' && typeof f.label === 'string' && typeof f.hint === 'string',
    `字段描述齐备（type=${f && f.type}）`)
})

console.log(`\n${failed === 0 ? 'ALL T239 CONFIG-IDLE-WINDOW TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
