// t191（收口 t190 发现②）：**busy-rerun 补跑趟不得绕过启动来源上限**。
//
// 背景：t189 把「每次启动最多 N 个来源」绑在启动那一趟 drain 上；但 `drainStage1Jobs` 的 busy-rerun latch
//   原先调 `scheduleStage1Drain()` **不传预算** ⇒ 启动趟运行中又被另一请求触发时，补跑趟**无上限且绕过 30s 间隔**。
// t191 口径（选 A：让启动上限成为**每次启动的真约束**）：预算做成**可继承对象** `{ remaining }`，
//   补跑趟继承"在飞那一趟"的剩余预算（同一对象继续扣减）；预算耗尽仍走 `STARTUP_SOURCE_SPACING_MS` 间隔唤醒。
//
// 本测试用**挂住 `sessionQuery.readSession`** 制造确定性的 busy（drain 在提炼前必读来源会话）：
//   启动趟领取第 1 条并卡在读会话 → 此时再调一次 drain 入口（显式工具走同一入口）⇒ 置 busy-rerun latch
//   → 放行读取 → 统计"启动这一轮总处理条数"必须 ≤ N。
//   改前（还原口树 `5757528C…`）补跑趟无预算 ⇒ 会把剩余来源全跑掉（实测 5 条）⇒ 本文件必红。
//
// 靶目录一律 `os.tmpdir()`（不指向真实记忆根）；测试后清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedJob, jobListOf } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const m = await import(PLUGIN)
const { apply } = m
const DEFAULT_MAX_SOURCES_PER_STARTUP = m.DEFAULT_MAX_SOURCES_PER_STARTUP

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-t191-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 可挂住的读会话（确定性 busy 点）：drain 提炼前必经此路。
let pauseRead = false
let readInFlight = false
let releaseRead = () => {}
const llmMock = {
  stream: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', text: JSON.stringify({ memory_summary: 'v1\n## t191', registry: '# MEMORY.md\nt191' }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }),
}

const newCtx = () => {
  const tools = {}
  const { ctx, domain } = makeCtx({
    get: (k) =>
      k === 'llm'
        ? llmMock
        : k === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : k === 'sessionQuery'
            ? {
              readSession: async (id) => {
                if (pauseRead) {
                  readInFlight = true
                  await new Promise((r) => { releaseRead = r })
                }
                return { session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [] }
              },
            }
            : undefined,
    tools: { register: (t) => { tools[t.name] = t } },
  })
  const home = path.join(tmp, 'h-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  return { ctx, domain, tools, root: () => path.join(home, 'memories') }
}
const past = new Date(Date.now() - 120000).toISOString()
/** "被处理过"的来源：离开 pending，或至少被领取过一次。 */
const touchedCount = (domain) =>
  Object.values(jobListOf(domain)).filter((j) => j && (j.status !== 'pending' || (j.attempt_count || 0) > 0)).length

try {
  const { ctx, domain, tools } = newCtx()
  for (const sid of ['r1', 'r2', 'r3', 'r4', 'r5']) await seedJob(domain, sid, 'wm-' + sid, { availableAt: past })

  check(DEFAULT_MAX_SOURCES_PER_STARTUP === 2, `每启动来源上限默认 N=2（实测 ${DEFAULT_MAX_SOURCES_PER_STARTUP}）`)

  pauseRead = true
  readInFlight = false
  await apply(ctx, { maxSourcesPerStartup: DEFAULT_MAX_SOURCES_PER_STARTUP })
  const entered = await waitUntil(() => readInFlight, 2500)
  check(entered === true, '启动趟已卡在读会话（确定性 busy）')

  // 忙时再触发一次（显式工具与事件路径走同一入口 ⇒ 置 busy-rerun latch）
  const busyRes = await tools['memory__stage1_drain'].execute({})
  check(busyRes && busyRes.processed === 0, `忙时的请求被 latch（processed=0，实测 ${busyRes && busyRes.processed}）`)

  pauseRead = false
  releaseRead()
  await sleep(900)

  const touched = touchedCount(domain)
  check(touched <= DEFAULT_MAX_SOURCES_PER_STARTUP,
    `补跑趟继承同一预算 ⇒ 启动这一轮总处理 ${touched} ≤ N=${DEFAULT_MAX_SOURCES_PER_STARTUP}（改前补跑趟无预算，会跑到 5 ⇒ 该断言在还原口树上必红）`)
  check(Object.values(jobListOf(domain)).length - touched >= 1, `仍有来源留给后续趟次（未丢，实测剩 ${Object.values(jobListOf(domain)).length - touched}）`)
  await sleep(500)
  check(touchedCount(domain) <= DEFAULT_MAX_SOURCES_PER_STARTUP, '30s 间隔照旧生效：短暂等待后仍不超过上限（补跑趟没有立刻补足剩余来源）')
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T191 BOOT-BUDGET-RERUN TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
