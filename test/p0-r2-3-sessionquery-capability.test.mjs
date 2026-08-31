// P0-R2-3 反例：`sessionQuery` 服务缺失（部署能力缺陷）绝不能被当作 `empty_source` 静默成功。
// 旧实现：sessionMessagesByPersistence() 在 sessionQuery 缺失时返回 null，drain 标它
// `empty_source` 最终成功——那是「插件没有读取会话的能力」，不是「会话真的空」。
// 本轮：①把 sessionQuery 声明为必需 inject（cordis 未提供即加载失败/禁用生成）；
// ②overview capabilities.stage1SourceRead 暴露能力缺失；③drain 对 persisted===null
// 标 `source_capability_missing`（专属原因），绝不再叫 empty_source。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

// 只读 DB 后端 + 捕获 webServer 路由，供 GET /dsh-rollout/overview。
function makeHarness(hasSessionQuery) {
  const routes = {}
  const webServer = { register: (r) => { routes[r.path] = r; return () => {} } }
  const get = (k) => {
    if (k === 'webServer') return webServer
    if (k === 'sessionQuery') return hasSessionQuery ? { readSession: async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [] }) } : undefined
    if (k === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    return undefined
  }
  const { ctx, domain } = makeCtx({ get, on: () => () => {} })
  return { ctx, domain, routes }
}

const getOverview = (routes) => {
  const req = { method: 'GET', on: () => {} }
  const res = { statusCode: 0, setHeader() {}, body: '', end(b) { res.body = b } }
  const h = routes['/dsh-rollout/overview'].handler
  return Promise.resolve(h(req, res)).then(() => JSON.parse(res.body || '{}'))
}

async function runScenario(name, hasSessionQuery, fn) {
  const dir = path.join(os.tmpdir(), `dsh-p0-r2-3-${name}-` + Date.now())
  fs.mkdirSync(dir, { recursive: true })
  process.env.DSH_HOME = dir
  const { ctx, domain, routes } = makeHarness(hasSessionQuery)
  await apply(ctx, { recallLimit: 20 })
  try {
    return await fn({ ctx, domain, routes, dir })
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

// ── 场景 1：sessionQuery 不存在（能力缺失）────────────────────────────────────
console.log('[1] sessionQuery 缺失：overview 暴露能力缺失 + drain 不标 empty_source')
await runScenario('missing', false, async ({ ctx, domain, routes }) => {
  const ov = await getOverview(routes)
  console.log('  status.capabilities:', JSON.stringify(ov.status && ov.status.capabilities))
  check(ov.status && ov.status.capabilities && ov.status.capabilities.stage1SourceRead === false,
    'overview capabilities.stage1SourceRead === false (capability gap surfaced, not silent)')

  await seedJob(domain, 's1', 'wm-cap')
  const res = await ctx.tools['memory__stage1_drain'].execute({})
  check(res.processed >= 1, 'drain processed the job')
  const job = Object.values(jobListOf(domain)).find((x) => String(x.session_id) === 's1')
  console.log('  drained job last_skip_reason:', (job && job.last_skip_reason) || '(none)')
  check(job && job.last_skip_reason !== 'empty_source', 'drained job is NOT labeled empty_source (capability missing ≠ empty session)')
  check(job && job.last_skip_reason === 'source_capability_missing', 'drained job carries the distinct source_capability_missing reason')
})

// ── 场景 2：sessionQuery 存在（能力可用，对照）────────────────────────────────
console.log('[2] sessionQuery 存在：overview 显示能力可用 + 真实空源仍标 empty_source')
await runScenario('present', true, async ({ ctx, domain, routes }) => {
  const ov = await getOverview(routes)
  console.log('  status.capabilities:', JSON.stringify(ov.status && ov.status.capabilities))
  check(ov.status && ov.status.capabilities && ov.status.capabilities.stage1SourceRead === true,
    'overview capabilities.stage1SourceRead === true (sessionQuery present)')

  // 会话真的空（sessionQuery 能读，但无消息）→ 真 empty_source 是合法的。
  await seedJob(domain, 's2', 'wm-empty')
  await ctx.tools['memory__stage1_drain'].execute({})
  const job = Object.values(jobListOf(domain)).find((x) => String(x.session_id) === 's2')
  check(job && job.status === 'succeeded_no_output' && job.last_skip_reason === 'empty_source',
    'a genuinely empty session is still a legitimate empty_source no-output (contrast)')
})

console.log(`\n${failed === 0 ? 'ALL P0-R2-3 SESSIONQUERY-CAPABILITY TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
