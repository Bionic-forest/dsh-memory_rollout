// t254（P0 修复 · 记忆插件设置页「开关点不动」）：**开关控件值必须草稿优先**、**保存必须按语义布尔化**。
//
// 用户症状：设置页里的开关点不动（视觉不回弹）。
// 缺陷（同一根因；改前 lib/client.js SHA256 F34E8756C6416577AE739009D69DF5227151E1BA79FF7531C569147916A50192 / 51,825 B）：
//   B1 视觉：L496 `checked: !!cfg[f.key]` 绑的是**已保存配置**，而 `edit()`（L400）只写 `drafts`
//      ⇒ 点击后草稿变了、`checked` 没变 ⇒ 开关看着"点不动"。（文本框没这问题：走 `fieldText`，草稿优先。）
//   B2 语义：L413 保存用 `!!q.value`，而 toggle 草稿存的是**字符串** `'true'`/`'false'`（`edit`/`resetField`）
//      ⇒ `!!'false' === true` ⇒ 用户"关"会被存成"开"。
// 本测试在 Node 里加载**真实的** lib/client.js（经典脚本 + window.__ModuleLoader__），用**假 React**
//   （带 useState/useEffect/useRef/Component 的最小 hooks 实现 + 逐次全量重渲染）渲染**真实的**注册组件，
//   用假 fetch 喂 /config 与 /entries，然后：(a) 读**全量展开后的宿主树**里用户真正看到的
//   `<input type="checkbox">` / `<input type=number|text>` / `<select>` 的 props；(b) 点它自己的 onChange
//   （与浏览器点击同形：传 `{target:{checked|value}}`）；(c) 点保存按钮后读**真正发出去的 payload**。
// 牙齿（改前必红，已实测）：
//   ① B1：点一下开关"关"⇒ 草稿 'false' ⇒ 该 checkbox 的 `checked` 必须 `false`（改前绑 `!!cfg` ⇒ true ⇒ 红）；
//   ② B2：toggle 草稿 'false' 走保存 ⇒ payload 里必须是**布尔 false**（改前 `!!'false'` ⇒ true ⇒ 红）。
// 附带覆盖「草稿优先」的其余字段类型（text/number/select 与 `''`＝清除语义），防止同源缺陷还藏在别处。
import fs from 'node:fs'
import { createHash } from 'node:crypto'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const SRC = fs.readFileSync(CLIENT, 'utf8')
console.log('被测文件：lib/client.js  SHA256 ' + createHash('sha256').update(SRC, 'utf8').digest('hex').toUpperCase() + '  ' + Buffer.byteLength(SRC, 'utf8') + ' B\n')

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

// ── 假 React：最小 hooks 实现 ─────────────────────────────────────────────────
// hook 槽按调用顺序存在 cells 里；setState 只改槽（不做调度），由测试的 tick() 触发下一次全量重渲染。
// 这与 React 的**可观测语义**一致（状态变化 ⇒ 重渲染 ⇒ 控件值重算），够用来读控件 props 与点它。
let cells = []
let cellIdx = 0
let effectQueue = []
const effectSeen = new Map()

class FakeComponent { constructor(props) { this.props = props; this.state = {} } }

const React = {
  // 与真 React 同形：**子元素也放进 props.children**（单子=裸元素、多子=数组）——本文件的组件读 p.children。
  createElement: (type, props, ...children) => {
    const kids = children.flat(Infinity)
    const p = Object.assign({}, props || {})
    p.children = kids.length === 0 ? undefined : (kids.length === 1 ? kids[0] : kids)
    return { type, props: p, children: kids }
  },
  useState: (init) => {
    const i = cellIdx++
    if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init
    const set = (v) => { const next = typeof v === 'function' ? v(cells[i]) : v; if (!Object.is(next, cells[i])) cells[i] = next }
    return [cells[i], set]
  },
  useEffect: (fn, deps) => {
    const i = cellIdx++
    const prev = effectSeen.get(i)
    const changed = !prev || !deps || deps.some((d, j) => !Object.is((prev.deps || [])[j], d))
    if (changed) { effectSeen.set(i, { deps }); effectQueue.push(fn) }
  },
  useRef: (v) => { const i = cellIdx++; if (!(i in cells)) cells[i] = { current: v }; return cells[i] },
  Component: FakeComponent,
}

// ── 单层展开 / 全量展开（函数组件与 class 组件都认；Boundary.render 只用 props/state）──────────
function expandOne(el) {
  if (typeof el.type === 'function' && el.type.prototype && typeof el.type.prototype.render === 'function') {
    return new el.type(el.props).render()
  }
  return el.type(el.props)
}
function deepExpand(el) {
  if (Array.isArray(el)) return el.map(deepExpand)
  if (!el || typeof el !== 'object') return el
  if (typeof el.type === 'function') return deepExpand(expandOne(el))
  return { type: el.type, props: el.props, children: el.children.map(deepExpand) }
}

// ── 加载**真实的** lib/client.js，拿它注册的组件（同 t236 的经典脚本加载法）──────────────
function loadClient() {
  const captured = {}
  const win = { __ModuleLoader__: { load: ({ id, factory }) => {
    captured.id = id
    captured.exports = factory((n) => { if (n === 'react') return React; throw new Error('unknown require: ' + n) })
  } } }
  // eslint-disable-next-line no-new-func
  new Function('window', 'module', 'exports', 'require', SRC)(win, { exports: {} }, {}, () => { throw new Error('top-level require is not expected') })
  return captured
}

const { id, exports: mod } = loadClient()
let Registered = null
const slotsSvc = { inject: (key, cb) => cb(), register: (opts, comp) => { Registered = comp; return () => {} } }
mod.apply({ slots: slotsSvc, get: (n) => (n === 'slots' ? slotsSvc : undefined) })
check(id === 'dsh-memory_rollout' && typeof Registered === 'function', `加载真实 client.js 并拿到 settings.section 注册组件（id=${id}）`)

// ── 假 fetch：/entries + /config(GET/POST)，POST 的 body 就是"真正发出去的 payload"─────────
const NET = { get: [], post: [] }
const FIXTURE = {
  config: { generateMemories: true, useMemories: false, summaryTokens: 4000, extractProvider: 'p-x', extractReasoningEffort: 'high' },
  defaults: { generateMemories: true, useMemories: true, summaryTokens: 4000, extractProvider: '', extractReasoningEffort: 'low' },
  fields: [
    { key: 'generateMemories', label: '生成新记忆（generateMemories）', type: 'toggle', hint: 'h' },
    { key: 'useMemories', label: '使用记忆（useMemories）', type: 'toggle', hint: 'h' },
    { key: 'summaryTokens', label: '摘要 token 预算（summaryTokens）', type: 'number', hint: 'h' },
    { key: 'extractProvider', label: '提取 Provider（extractProvider）', type: 'text', hint: 'h' },
    { key: 'extractReasoningEffort', label: '推理强度（extractReasoningEffort）', type: 'select', options: ['', 'off', 'low', 'high', 'max'], hint: 'h' },
  ],
  root: 'D:/fake/memory-root',
}
const clone = (v) => JSON.parse(JSON.stringify(v))
globalThis.fetch = async (path, opts) => {
  const method = (opts && opts.method) || 'GET'
  if (path === '/dsh-memory_rollout/entries') return { ok: true, status: 200, json: async () => ({ entries: [] }) }
  if (path === '/dsh-memory_rollout/config' && method === 'GET') { NET.get.push(path); return { ok: true, status: 200, json: async () => clone(FIXTURE) } }
  if (path === '/dsh-memory_rollout/config' && method === 'POST') {
    const body = JSON.parse(opts.body)
    NET.post.push(body)
    return { ok: true, status: 200, json: async () => ({ config: Object.assign({}, FIXTURE.config, body), defaults: FIXTURE.defaults, fields: FIXTURE.fields, root: FIXTURE.root }) }
  }
  throw new Error('unexpected fetch ' + method + ' ' + path)
}

// ── 渲染循环 ─────────────────────────────────────────────────────────────────
let rawTree = null   // MemoryPage 的返回树（只展开到页面 ⇒ 内联行可见；ValueRow 这类仍是函数元素）
let domTree = null   // 全量展开后的**宿主**元素树（⇒ 用户真正看到的 input/select 及其 props）
function renderOnce() {
  cellIdx = 0
  effectQueue.length = 0
  let el = Registered()
  while (el && typeof el.type === 'function') el = expandOne(el)
  rawTree = el
  domTree = deepExpand(el)
}
async function tick(n = 3) {
  for (let k = 0; k < n; k++) {
    const q = effectQueue.slice(); effectQueue.length = 0
    for (const fn of q) fn()
    await new Promise((r) => setTimeout(r, 0))
    renderOnce()
  }
}
const act = async (fn) => { fn(); await tick() }

// ── 从树里取控件 ─────────────────────────────────────────────────────────────
function walk(node, fn) {
  if (Array.isArray(node)) { for (const c of node) walk(c, fn); return }
  if (!node || typeof node !== 'object') return
  fn(node)
  if (node.children) walk(node.children, fn)
}
const kids = (el) => [].concat((el && el.children) || []).filter((c) => c && typeof c === 'object')
/** `div.mr-field-row` 里标签以 prefix 开头的那一行的控件元素（可能还包着 `.mr-ctl`）。 */
function fieldRow(tree, prefix) {
  let hit = null
  walk(tree, (el) => {
    if (el.type !== 'div' || !el.props || el.props.className !== 'mr-field-row') return
    const labelEl = kids(el).find((c) => c.type === 'span' && c.props && c.props.className === 'mr-label')
    const text = labelEl ? [].concat(labelEl.children).filter((c) => typeof c === 'string').join('') : ''
    if (!text.startsWith(prefix)) return
    hit = { label: text, ctl: kids(el).filter((c) => c.type !== 'span')[0] }
  })
  return hit
}
/** 剥掉自写行的 `.mr-ctl` 包装，拿到真正的控件元素。 */
function ctlOf(tree, prefix) {
  const hit = fieldRow(tree, prefix)
  let c = hit && hit.ctl
  while (c && c.type === 'div' && c.props && c.props.className === 'mr-ctl') c = kids(c)[0]
  return c
}
/** 顶部动作行（`.mr-actions`）里第一个按钮 = 保存配置。 */
function saveButton(tree) {
  let found = null
  walk(tree, (el) => {
    if (el.type === 'div' && el.props && String(el.props.className || '').split(/\s+/).includes('mr-actions')) {
      found = kids(el).filter((c) => typeof c.type === 'function')[0]
    }
  })
  return found
}
// 控件（宿主元素）的当前显示值 / 勾选态
const shown = (tree, prefix) => ctlOf(tree, prefix).props.value
const lit = (tree, prefix) => ctlOf(tree, prefix).props.checked
// "点一下" —— 与浏览器同形的事件对象（自写基元的 onChange 收的是事件）
const clickToggle = (tree, prefix, next) => ctlOf(tree, prefix).props.onChange({ target: { checked: next } })
const typeText = (tree, prefix, text) => ctlOf(tree, prefix).props.onChange({ target: { value: text } })

const GEN = '自动生成新记忆'
const USE = '在对话中使用记忆'
const NUM = '摘要注入预算'
const TXT = '提炼 Provider'
const SEL = '提炼推理强度'

// ── 挂载：等 /config 落地（cfg / cfgFields / defaults 都进状态）─────────────────
renderOnce()
await tick()
check(NET.get.length >= 1, `挂载后 GET /config 被调用（实测 ${NET.get.length} 次）`)
check(!!fieldRow(domTree, GEN) && !!fieldRow(domTree, USE), '两个开关都渲染出来了（含各自的控件）')

// ── A 组：草稿为空时的**基线**（此时"读 cfg"与"草稿优先"同值 ⇒ 改前改后都该绿）─────────
check(lit(domTree, GEN) === true, `A1 初始（cfg=true、无草稿）开关在「开」（实测 ${JSON.stringify(lit(domTree, GEN))}）`)
check(lit(domTree, USE) === false, `A2 useMemories（cfg=false、无草稿）开关在「关」（实测 ${JSON.stringify(lit(domTree, USE))}）`)
check(ctlOf(domTree, GEN).type === 'input' && ctlOf(domTree, GEN).props.type === 'checkbox', `A3 开关控件就是 <input type=checkbox>（实测 ${ctlOf(domTree, GEN).type}/${ctlOf(domTree, GEN).props.type}）`)
check(shown(domTree, TXT) === 'p-x', `A4 文本框草稿空 ⇒ 回落到已保存值（实测 ${JSON.stringify(shown(domTree, TXT))}）`)
check(shown(domTree, SEL) === 'high', `A5 档位控件草稿空 ⇒ 回落到已保存值（实测 ${JSON.stringify(shown(domTree, SEL))}；宿主元素 ${ctlOf(domTree, SEL).type}）`)
check(shown(domTree, NUM) === '4000', `A6 数字框草稿空 ⇒ 回落到已保存值（实测 ${JSON.stringify(shown(domTree, NUM))}）`)

// ── B1（牙齿①）：点一下"关" ⇒ 草稿 'false' ⇒ 开关必须**立刻**显示"关"────────────────────
{
  await act(() => clickToggle(domTree, GEN, false))   // ＝用户点一下这个开关
  const dom = ctlOf(domTree, GEN)
  check(dom.props.checked === false,
    `B1【牙齿】点"关"后草稿='false'，<input> checked 必须 false —— 改前绑 !!cfg[f.key]（cfg=true）⇒ true ⇒ 本行必红（实测 ${JSON.stringify(dom.props.checked)}）`)
  check(ctlOf(rawTree, GEN).props.checked === false,
    `B1b Toggle 元素收到的 checked 也必须是 false（即"视觉不回弹"根因已消）（实测 ${JSON.stringify(ctlOf(rawTree, GEN).props.checked)}）`)
}
{
  // 反向：把 cfg=false 的那个开关点成"开"，同样要**立刻**反映
  await act(() => clickToggle(domTree, USE, true))
  check(lit(domTree, USE) === true,
    `B1c【牙齿·反向】点"开"后草稿='true'，checked 必须 true（改前绑 !!cfg（cfg=false）⇒ false ⇒ 红）（实测 ${JSON.stringify(lit(domTree, USE))}）`)
}

// ── C 组：其余字段类型的"草稿优先"（同源审计；改前也应绿 ⇒ 护栏"没在别处改坏"）────────────
await act(() => typeText(domTree, TXT, ''))          // 文本 ⇒ 草稿 ''（＝清除覆盖）
check(shown(domTree, TXT) === '', `C1 文本框草稿 '' 时显示 ''（胜过已保存的 'p-x'）（实测 ${JSON.stringify(shown(domTree, TXT))}）`)
await act(() => typeText(domTree, NUM, '2500'))      // 数字 ⇒ 草稿 '2500'
check(shown(domTree, NUM) === '2500', `C2 数字框草稿'2500'即时显示（实测 ${JSON.stringify(shown(domTree, NUM))}）`)
await act(() => typeText(domTree, SEL, ''))          // 档位 ⇒ 草稿 ''（＝模型默认）
check(shown(domTree, SEL) === '', `C3 档位控件草稿 '' 时显示 ''（胜过已保存的 'high'）（实测 ${JSON.stringify(shown(domTree, SEL))}）`)

// ── B2（牙齿②）：走**真实的保存路径**，看发出去的 payload ──────────────────────────
{
  const btn = saveButton(rawTree)
  check(!!btn, 'B2 预备：找到顶部动作行的保存按钮')
  check(btn.props.disabled === false, `B2 预备：有改动 ⇒ 保存按钮可点（实测 disabled=${JSON.stringify(btn.props.disabled)}）`)
  const before = NET.post.length
  await act(() => btn.props.onClick())      // ＝用户点「保存配置」
  check(NET.post.length === before + 1, `B2 预备：POST /config 恰好一次（实测新增 ${NET.post.length - before} 次）`)
  const payload = NET.post[NET.post.length - 1] || {}
  check(payload.generateMemories === false,
    `B2【牙齿】toggle 草稿 'false' ⇒ payload.generateMemories 必须是**布尔 false** —— 改前 !!q.value（!!'false'）⇒ true ⇒ 本行必红（实测 ${JSON.stringify(payload.generateMemories)} / typeof ${typeof payload.generateMemories}）`)
  check(typeof payload.generateMemories === 'boolean' && payload.useMemories === true,
    `B2b 反向：草稿 'true' ⇒ 布尔 true（实测 ${JSON.stringify(payload.useMemories)} / ${typeof payload.useMemories}）`)
}

// ── D 组：其余类型的保存语义没有被这次修改带偏（''＝清除、number=数字）──────────────
{
  const payload = NET.post[NET.post.length - 1] || {}
  check(payload.extractProvider === '', `D1 文本草稿 '' ⇒ payload ''（清空覆盖）（实测 ${JSON.stringify(payload.extractProvider)}）`)
  check(payload.extractReasoningEffort === '', `D2 select 草稿 '' ⇒ payload ''（＝模型默认）（实测 ${JSON.stringify(payload.extractReasoningEffort)}）`)
  check(payload.summaryTokens === 2500 && typeof payload.summaryTokens === 'number', `D3 number 草稿 '2500' ⇒ payload 数字 2500（实测 ${JSON.stringify(payload.summaryTokens)} / ${typeof payload.summaryTokens}）`)
  check(Object.keys(payload).length === FIXTURE.fields.length, `D4 payload 覆盖全部字段（实测 ${Object.keys(payload).length} / 期望 ${FIXTURE.fields.length}）`)
}

// ── E 组：保存后草稿清空、cfg 刷新成新值 ⇒ 再点"开"必须发 true（端到端闭环）──────────
{
  check(lit(domTree, GEN) === false, `E1 保存后 generateMemories 显示"关"（服务端回吐新 cfg）（实测 ${JSON.stringify(lit(domTree, GEN))}）`)
  await act(() => clickToggle(domTree, GEN, true))
  check(lit(domTree, GEN) === true, `E2 再点"开" ⇒ 立刻显示勾选（实测 ${JSON.stringify(lit(domTree, GEN))}）`)
  const btn = saveButton(rawTree)
  check(btn.props.disabled === false, `E3 又产生了改动 ⇒ 保存可点（实测 disabled=${JSON.stringify(btn.props.disabled)}）`)
  await act(() => btn.props.onClick())
  const payload = NET.post[NET.post.length - 1] || {}
  check(payload.generateMemories === true && typeof payload.generateMemories === 'boolean', `E4 toggle 草稿 'true' ⇒ payload 布尔 true（实测 ${JSON.stringify(payload.generateMemories)} / ${typeof payload.generateMemories}）`)
}

console.log(`\n${failed === 0 ? 'ALL T254 SETTINGS-TOGGLE-BINDING TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
