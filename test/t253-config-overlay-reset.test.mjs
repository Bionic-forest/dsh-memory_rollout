// t253（设置页配置 overlay 格式统一 + 一键恢复默认）：**只测 lib/index.js 的对外行为**，
// 不改实现、不碰真实 DSH_HOME（每个用例一个临时 home）。
//
// 被测实现（`lib/index.js`，SHA256 前16 = `A7D0491BD19A74EC`）：
//   ① `readSettings()` 兼容**两种格式**：旧裸对象 `{summaryTokens:5000}` 与新包裹层
//      `{version:1, savedAt, values:{…}}`；
//   ② `saveSettings()` 现在写包裹层；
//   ③ `applyConfigOverlay()` 校验失败**不再静默**：保留 boot 配置，且写 `lastOverlayError.reason`
//      + `console.warn('[dsh-memory_rollout] settings overlay rejected: ' + reason + …)`；
//   ④ 配置路由 `POST /dsh-memory_rollout/config` 支持 `{action:'reset'}`：把现有 overlay **备份**为
//      `<DSH_HOME>/dsh-memory_rollout.settings.json.pre-reset`（同族只留最新 1）→ 删 overlay →
//      内存里把设置页可编辑键恢复为 `Config({})` 默认 → 返回 `{saved:true, reset:true, backup,
//      hasOverlay, config, defaults, fields, root}`；删不掉时 500。
//
// 用例（每条的 ①②③… 见正文）：
//   [1] 旧裸对象 overlay 能加载（load 期套用 ⇒ `config.summaryTokens === 5000`）
//   [2] 新包裹层能加载（同上）
//   [3] reset：真删 overlay + 备份在且内容 = 原份 + 内存**逐键**回 schema 默认
//   [4] reset 幂等：无 overlay 时 2xx / `hasOverlay===false` / 仍是默认
//   [5] 非法 overlay 不再静默：boot 配置保留（非法值**没进**内存）+ 有带原因的显性宣告
//
// ⚠️ 观测面说明（不许改实现的硬约束下的如实交代）：
//   `lastOverlayError.reason` 是 `apply()` 内部的闭包变量，**没有**从模块导出（导出的只有
//   `Config` / `CONFIG_FIELDS` 及纯助手）。因此 [5] 的"非空原因"以**实现里同一条 catch 分支发出的
//   `console.warn` 文本**为观测面（该文本由 `lastOverlayError.reason` 拼成："settings overlay
//   rejected: <reason>"），断言其**存在、非空、且确实是拒绝原因**。这是本实现**唯一**可在不改实现的
//   前提下取到的"非静默"证据；未取到的部分（闭包变量本身）在报告里如实标注。
//
// ⚠️ 牙齿（详见交付报告）：本文件在 `HEAD`（v0.1.27）那版 `lib/index.js` 上**必红** ——
//   旧 `readSettings()` 不认包裹层（`pickEditable()` 全部落空 ⇒ overlay 形同不存在）、
//   旧 `applyConfigOverlay()` 是 `catch {}` 静默、旧配置路由**没有** reset 分支（POST 落回
//   `pickEditable(body)` ⇒ `{action:'reset'}` 无可编辑键 ⇒ 400）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx } from './lib/helpers.mjs'

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

/**
 * 起一次插件装载。
 * 关键点：`applyConfigOverlay()` 是在 **`apply()` 开头**用**本实例自己的** `readSettings()` 套
 * 到**这一份 config 对象**上的（改前改后一致）⇒ 每个用例要独立验证 overlay 必须**自己一个模块实例**
 * （`?case=N` 缓存键破缓存），否则整文件只会在第一个 home 上套一次 overlay。
 */
async function boot(caseTag, cfgSeed) {
  const home = path.join(os.tmpdir(), 'dsh-t253-' + caseTag + '-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const routes = {}
  const webServer = { register: (r) => { routes[r.path] = r; return () => {} } }
  const { ctx } = makeCtx({ get: (k) => (k === 'webServer' ? webServer : undefined) })
  const mod = await import('../lib/index.js?t253=' + caseTag)
  // 让本用例可完全区分三个数：schema 默认 / boot（patch.yml 解析值）/ overlay 值。
  const cfg = { ...cfgSeed }
  await mod.apply(ctx, cfg)
  return { home, mod, cfg, ctx, routes }
}

/** POST 一次配置路由，返回 { status, json }。 */
async function postConfig(booted, payload) {
  const h = booted.routes['/dsh-memory_rollout/config']
  assert.ok(h && typeof h.handler === 'function', 'config route registered')
  const req = { method: 'POST', on: (ev, cb) => { if (ev === 'data') req._d = cb; else if (ev === 'end') req._e = cb } }
  const res = { statusCode: 0, setHeader() {}, body: '', end(b) { res.body = b } }
  const p = h.handler(req, res)
  req._d(JSON.stringify(payload))
  req._e()
  await p
  let json = {}
  try { json = JSON.parse(res.body || '{}') } catch {}
  return { status: res.statusCode, json }
}

/** 逐键比对"配置视图 vs schema 默认"，返回差异列表（只比 overlayable 键）。 */
function diffAgainstDefaults(mod, view) {
  const defaults = mod.Config({})
  const out = []
  for (const f of mod.CONFIG_FIELDS) {
    const k = f.key
    const want = defaults[k]
    const got = view ? view[k] : undefined
    if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${k}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`)
  }
  return { defaults, out }
}

const CASES = [
  ['[1] 旧裸对象 overlay', async () => {
    const b = await boot('c1', {})
    const sp = path.join(b.home, 'dsh-memory_rollout.settings.json')
    fs.writeFileSync(sp, '{"summaryTokens":5000}', 'utf8')
    await b.mod.apply(b.ctx, b.cfg)
    check(b.cfg.summaryTokens === 5000, `旧裸对象被套用：config.summaryTokens=${b.cfg.summaryTokens}（期望 5000，schema 默认 ${b.mod.Config({}).summaryTokens}）`)
  }],
  ['[2] 新包裹层 overlay', async () => {
    const b = await boot('c2', {})
    const sp = path.join(b.home, 'dsh-memory_rollout.settings.json')
    fs.writeFileSync(sp, JSON.stringify({ version: 1, savedAt: '2026-10-01T00:00:00.000Z', values: { summaryTokens: 5000 } }), 'utf8')
    await b.mod.apply(b.ctx, b.cfg)
    check(b.cfg.summaryTokens === 5000, `包裹层被套用：config.summaryTokens=${b.cfg.summaryTokens}（期望 5000）`)
  }],
  ['[3] reset 行为', async () => {
    // 预留一份两键 overlay（两键都不是 schema 默认：5000≠4000、33≠10）⇒ 「套用/回默认」都可判。
    const b = await boot('c3', { summaryTokens: 4000, recallLimit: 10 })
    const sp = path.join(b.home, 'dsh-memory_rollout.settings.json')
    const bak = sp + '.pre-reset'
    const pre = '{"summaryTokens":5000,"recallLimit":33}'
    // 先单独验证"这份 overlay 真的被套用了"（否则"回默认"可能只是套用失败）。
    fs.writeFileSync(sp, pre, 'utf8')
    await b.mod.apply(b.ctx, b.cfg)
    check(b.cfg.summaryTokens === 5000 && b.cfg.recallLimit === 33,
      `前置：overlay 已生效（summaryTokens=${b.cfg.summaryTokens} recallLimit=${b.cfg.recallLimit}）`)

    const r = await postConfig(b, { action: 'reset' })
    const j = r.json
    check(r.status === 200, `HTTP 200（实测 ${r.status}）`)
    check(j.reset === true, `① 响应 reset===true（实测 ${JSON.stringify(j.reset)}）`)
    check(j.saved === true, `响应 saved===true（实测 ${JSON.stringify(j.saved)}）`)
    check(j.hasOverlay === false, `响应 hasOverlay===false（实测 ${JSON.stringify(j.hasOverlay)}）`)
    check(fs.existsSync(sp) === false, `② overlay 文件已不存在（实测 exists=${fs.existsSync(sp)}；路径名 settings.json）`)
    check(fs.existsSync(bak) === true, `③ 备份存在（${path.basename(bak)}）`)
    const bakText = read(bak)
    let bakObj = null
    try { bakObj = JSON.parse(bakText) } catch {}
    check(bakObj && bakObj.summaryTokens === 5000 && bakObj.recallLimit === 33,
      `③ 备份内容 = reset 前那份（实测 ${JSON.stringify(bakObj)}）`)
    check(typeof j.backup === 'string' && j.backup === path.basename(bak),
      `响应 backup = 备份文件名（实测 ${JSON.stringify(j.backup)}）`)
    // ④ 内存 config 的**每一个** overlayable 键都等于 Config({}) 默认（逐键，不是只比一个）。
    const inMem = {}
    for (const f of b.mod.CONFIG_FIELDS) inMem[f.key] = b.cfg[f.key] !== undefined ? b.cfg[f.key] : b.mod.Config({})[f.key]
    const memDiff = diffAgainstDefaults(b.mod, inMem)
    check(memDiff.out.length === 0,
      `④ 内存 config 逐键 = schema 默认（${b.mod.CONFIG_FIELDS.length} 个键；差异 ${memDiff.out.length} 处${memDiff.out.length ? '：' + memDiff.out.slice(0, 3).join(' | ') : ''}）`)
    const viewDiff = diffAgainstDefaults(b.mod, j.config)
    check(viewDiff.out.length === 0, `响应 config 视图逐键 = schema 默认（差异 ${viewDiff.out.length} 处）`)
    const defDiff = diffAgainstDefaults(b.mod, j.defaults)
    check(defDiff.out.length === 0, `响应 defaults 逐键 = schema 默认（差异 ${defDiff.out.length} 处）`)
    check(typeof j.fields !== 'undefined' && Array.isArray(j.fields) && j.fields.length === b.mod.CONFIG_FIELDS.length,
      `响应带 fields 清单（${Array.isArray(j.fields) ? j.fields.length : typeof j.fields} 项）`)
    check(typeof j.root === 'string' && j.root.length > 0, `响应带 root（${JSON.stringify(j.root)}）`)
  }],
  ['[4] reset 幂等（无 overlay）', async () => {
    const b = await boot('c4', {})
    const sp = path.join(b.home, 'dsh-memory_rollout.settings.json')
    check(fs.existsSync(sp) === false, '前置：本用例没有 overlay 文件')
    const r = await postConfig(b, { action: 'reset' })
    check(r.status === 200, `无 overlay 时 reset 不报错（HTTP ${r.status}）`)
    check(r.json.reset === true, `reset===true（实测 ${JSON.stringify(r.json.reset)}）`)
    check(r.json.hasOverlay === false, `hasOverlay===false（实测 ${JSON.stringify(r.json.hasOverlay)}）`)
    check(r.json.backup === '', `没有可备份的 overlay ⇒ backup 为空（实测 ${JSON.stringify(r.json.backup)}）`)
    const inMem = {}
    for (const f of b.mod.CONFIG_FIELDS) inMem[f.key] = b.cfg[f.key] !== undefined ? b.cfg[f.key] : b.mod.Config({})[f.key]
    const d = diffAgainstDefaults(b.mod, inMem)
    check(d.out.length === 0, `config 仍是 schema 默认（差异 ${d.out.length} 处${d.out.length ? '：' + d.out.slice(0, 3).join(' | ') : ''}）`)
    // 再来一次也不炸（幂等的幂等）
    const r2 = await postConfig(b, { action: 'reset' })
    check(r2.status === 200 && r2.json.reset === true && r2.json.hasOverlay === false,
      `第二次 reset 同样 2xx + hasOverlay=false（HTTP ${r2.status}）`)
  }],
  ['[5] 非法 overlay 不再静默', async () => {
    // boot（patch.yml 解析值）= 4000；非法 overlay 想写 "abc"（非数字，Config 校验必抛）。
    const b = await boot('c5', { summaryTokens: 4000 })
    const sp = path.join(b.home, 'dsh-memory_rollout.settings.json')
    fs.writeFileSync(sp, '{"summaryTokens":"abc"}', 'utf8')
    let warns = []
    const origWarn = console.warn
    console.warn = (...a) => { warns.push(a.map((x) => String(x)).join(' ')) }
    try { await b.mod.apply(b.ctx, b.cfg) } finally { console.warn = origWarn }
    check(b.cfg.summaryTokens === 4000, `boot 配置被保留：config.summaryTokens=${b.cfg.summaryTokens}（≠ 非法值 "abc"）`)
    check(b.cfg.summaryTokens !== 'abc', `非法值没有进内存（实测类型 ${typeof b.cfg.summaryTokens}）`)
    const rejection = warns.filter((w) => w.includes('settings overlay rejected'))
    check(rejection.length > 0, `非静默：有显性宣告（"settings overlay rejected"，实测 ${rejection.length} 条 / 共 ${warns.length} 条 warn）`)
    const raw = (rejection[0] || '').trim()
    const reason = raw.includes('settings overlay rejected:') ? raw.split('settings overlay rejected:')[1].trim() : ''
    check(reason.length > 0, `拒绝原因非空字符串（实测 ${JSON.stringify(reason.slice(0, 120))}）`)
    check(/summaryTokens/.test(reason), `原因指向出问题的键 summaryTokens（实测 ${JSON.stringify(reason.slice(0, 120))}）`)
  }],
]

for (const [label, fn] of CASES) {
  console.log('\n' + label)
  try {
    await fn()
  } catch (err) {
    check(false, `${label} 中断：${err && err.message ? err.message : err}`)
  }
}

console.log(`\n${failed === 0 ? 'ALL T253 CONFIG-OVERLAY-RESET TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
