// t236（T28 修复 · 设置页"记忆库"不可见）：**客户端半必须按新宿主的 inject 契约声明服务**。
//
// 现象：新宿主（0.1.5-rc.1）设置侧栏里没有 rollout / 记忆库那一项。
// 根因（现测）：新宿主的客户端运行器规定「**插件上下文只暴露它在 inject 里声明的服务**」——
//   `@deepseek-ai/dsh-cordis-client-runner\lib\client.js`（SHA E78C94D66A75D69448179EC58C17EED8435415109B963A0FFCA903CAF2F8EF03）：
//     L314  ctx.serviceName 访问由 fiber 的 inject 声明守门
//     L320–L323 未声明 ⇒ 报错「service "X" is not declared by your plugin」
//     L581  用 fiber.inject 决定等待哪些服务（ctx.get(name) === undefined 即 waitingFor）
//   而本插件的客户端半**没有 `exports.inject`**、只调用 `ctx.get('slots')`，在该模型下拿到 undefined，
//   被自己的 `if (slots === undefined) return` **静默吞掉** ⇒ `settings.section` 从未注册 ⇒ 页面不出现。
//   对照可见页面 `dsh-done-sound\lib\client.js`（SHA A69858B0DCC0F32EE42A06D8D668AC62CA867CCB4C581F71B0F786C1A5E4BC9E）：
//   L1357 `exports.inject = ['slots', 'remote', …]`；L1331 `ctx.slots.inject('settings.section', …)`；label 传**字符串**。
//
// 本测试在 Node 里加载**真实的** `lib/client.js`（经典脚本 + window.__ModuleLoader__），用假 React/假 ctx
// 复刻上述 gate，断言：
//   ① `exports.inject` 含 'slots'；
//   ② ctx 只暴露已声明服务时，`apply()` **仍然**注册了 `settings.section`；
//   ③ 注册项 id/order 正确、**label 是字符串**；
//   ④ 未暴露任何服务时 `apply()` 不炸（防御性早退保留）。
import assert from 'node:assert'
import fs from 'node:fs'

const CLIENT = new URL('../lib/client.js', import.meta.url)

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

// ── 假 React（组件不会被 render，只需可 createElement）──────────────────────
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  Fragment: 'Fragment',
}
// ── 假 slot 服务：记录 inject/register 调用 ─────────────────────────────────
function makeSlots() {
  const calls = { inject: [], register: [] }
  return {
    calls,
    svc: {
      inject: (key, cb) => { calls.inject.push(key); return cb() },
      register: (opts, component) => { calls.register.push({ opts, component }); return () => {} },
    },
  }
}

/** 加载 client.js 并返回其 exports（经典脚本：先给 window.__ModuleLoader__）。 */
function loadClient() {
  const src = fs.readFileSync(CLIENT, 'utf8')
  const captured = {}
  const win = { __ModuleLoader__: { load: ({ id, factory }) => { captured.id = id; captured.exports = factory((name) => { if (name === 'react') return fakeReact; throw new Error('unknown require: ' + name) }) } } }
  // eslint-disable-next-line no-new-func
  new Function('window', 'module', 'exports', 'require', src)(win, { exports: {} }, {}, () => { throw new Error('top-level require is not expected') })
  return captured
}

/**
 * 复刻新宿主的 gate：**插件上下文只暴露它 inject 里声明的服务**。
 * @param declared - 该客户端半声明的服务名集合（来自 exports.inject）
 */
function makeGatedCtx(declared, slotsSvc) {
  const exposed = (name) => (declared.has(name) ? (name === 'slots' ? slotsSvc : undefined) : undefined)
  return {
    // 服务属性访问：未声明 ⇒ 与新宿主一致地"取不到"（真实宿主是报错，这里取不到即可触发同一条早退）
    get slots() { return exposed('slots') },
    get: (name) => exposed(name),
  }
}

const { id, exports: mod } = loadClient()
check(id === 'dsh-memory_rollout', `模块 id 正确（实测 ${id}）`)
check(typeof mod.apply === 'function', '导出了 apply')
const declared = new Set(Array.isArray(mod.inject) ? mod.inject : [])
check(declared.has('slots'), `客户端半声明了 'slots' 服务（实测 inject=${JSON.stringify(mod.inject)}）`)

// ① 已按契约声明 ⇒ 注册必须发生
{
  const { calls, svc } = makeSlots()
  mod.apply(makeGatedCtx(declared, svc))
  check(calls.inject.includes('settings.section'), `apply() 里 inject('settings.section') 被调用（实测 ${JSON.stringify(calls.inject)}）`)
  check(calls.register.length === 1, `register() 恰好一次（实测 ${calls.register.length}）`)
  const reg = calls.register[0] || { opts: {} }
  check(reg.opts && reg.opts.name === 'settings.section', `注册到 settings.section（实测 ${reg.opts && reg.opts.name}）`)
  check(reg.opts && reg.opts.id === 'dsh-memory_rollout', `id 正确（实测 ${reg.opts && reg.opts.id}）`)
  check(reg.opts && reg.opts.order === 30, `order=30（实测 ${reg.opts && reg.opts.order}）`)
  check(typeof (reg.opts && reg.opts.label) === 'string', `label 是**字符串**（实测 ${typeof (reg.opts && reg.opts.label)}；对照 dsh-done-sound 传字符串）`)
  check(typeof reg.component === 'function', '注册了组件函数')
}

// ② 对照/回归：服务完全取不到时不抛错（防御性早退保留，不把宿主拖崩）
{
  const { svc } = makeSlots()
  let threw = null
  try { mod.apply(makeGatedCtx(new Set(), svc)) } catch (err) { threw = err }
  check(threw === null, `服务不可得时 apply() 不抛错（实测 ${threw ? String(threw.message) : '无异常'}）`)
}

console.log(`\n${failed === 0 ? 'ALL T236 CLIENT SETTINGS-PAGE REGISTRATION TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
