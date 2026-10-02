// dsh-memory_rollout — cross-session memory vault for DeepSeek Harness (Client half).
//
// 注册「记忆库 / Memory」设置页：经宿主 webServer JSON 路由读写记忆库与插件配置：
//   GET/POST /dsh-memory_rollout/entries | /config、GET /export、POST /import。
//
// 视觉（2026-10-01 · 队长拍板 B + A 兜底）：**用官方客户端组件库**达到"同源"，不自己涂 ——
//   ① 框架**不用**官方 `SettingsForm`（bundle L6918-6956）：它的 footer L6940-6953 **无条件**画一个
//      保存按钮、**没有 props 可关**（禁用逻辑 L6930 `!state.dirty || state.invalid || state.saving`）
//      ⇒ 会把第二个保存按钮塞进卡片、与顶部动作行冲突。改为本文件自写的卡片分支，并把它原本替我们
//      做的四件事补齐：`!available`⇒`labels.unavailable`（L6925-6929）、`!writable`⇒顶部
//      `labels.readOnly`（L6934-6938）、`!dirty||invalid||saving`⇒禁用（L6930）、
//      `failed`⇒页脚 `labels.saveFailed`（L6942-6945）。
//      **只丢官方框架外壳，不丢官方观感**：字段行仍全部走官方基元（②③④）；
//   ② 字段控件 `SettingsValueField`（L6973 起：`{id,label,hint,invalid,invalidLabel,
//      text,onEdit,numeric,overridden,overriddenLabel,onReset,resetLabel,disabled,placeholder}`）；
//   ③ 档位型选择 `SegmentedControl`（L3444-3493：`{id,value,options:[{value,label,title?}],onChange,label,
//      disabled,className}`，**`onChange` 传裸值** L3486）；
//   ④ 动作 `Button`、布尔 `Switch`、图标（`hasP` 逐个探测，缺则不打）。
//   **`SettingsFormModel` 不用**：其构造要 `scope`（L7166），而 `scope` 由框架页面提供者注入，
//   我们的 `settings.section` 直接渲染组件拿不到（见《本体-rollout-设置页基元取证-2026-10-01.md》§三）。
// 两级回退（页面绝不消失）：`require` 失败/基元缺失 ⇒ 纯元素 + 本文件 CSS；基元抛错 ⇒ 错误边界翻全局
//   开关后重渲染纯元素版。`onChange` 一律兼容"裸值/事件对象"两种形态。
// 契约一字不动：`window.__ModuleLoader__.load`、`exports.inject=['slots']`、`settings.section`
//   （`id/order/label:'记忆库'`）、四个路由、字段语义（`''`＝模型默认）、导入导出、状态与错误提示。
window.__ModuleLoader__.load({
  id: 'dsh-memory_rollout',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const name = 'dsh-memory_rollout'

    // ── 官方客户端组件库（取不到 ⇒ 全程走纯元素回退）──────────────────────────────
    const P = (() => { try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return null } })()
    const primitivesEnabled = { on: true }
    const hasP = (n) => !!(primitivesEnabled.on && P && typeof P[n] === 'function')
    const plain = (props) => !!(props && props.forcePlain) || !primitivesEnabled.on
    const val = (v) => (v && v.target !== undefined ? (v.target.type === 'checkbox' ? v.target.checked : v.target.value) : v)

    async function api(path, method, payload) {
      const opts = { method, headers: {} }
      if (payload !== undefined) {
        opts.headers['Content-Type'] = 'application/json'
        opts.body = typeof payload === 'string' ? payload : JSON.stringify(payload)
      }
      const res = await fetch(path, opts)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status)
      return data
    }
    const apiEntries = (method, payload) => api('/dsh-memory_rollout/entries', method, payload)

    // ── 回退用样式表（纯元素路径的版式；官方基元自带样式，不依赖这些）────────────────
    const CSS = [
      '.mr-page{display:flex;flex-direction:column;gap:14px;padding:4px 14px 16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.mr-h{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mr-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;gap:10px;padding:12px 14px}',
      '.mr-card-hd{display:flex;align-items:baseline;gap:6px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mr-card-t{font-size:13px;font-weight:600}',
      '.mr-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.mr-meta{font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px 12px 0;word-break:break-all}',
      '.mr-rows{display:flex;flex-direction:column}',
      '.mr-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.mr-rows>.mr-row:first-child{border-top:none}',
      '.mr-label{color:var(--dsw-alias-label-primary);min-width:0}',
      '.mr-in,.mr-sel{background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:4px 8px;min-width:0;box-sizing:border-box}',
      '.mr-in:focus,.mr-sel:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.mr-in-num{width:88px}',
      '.mr-in-grow{flex:1}',
      // 动作行（标题下方常驻）：四个按钮同一容器 ⇒ 同一 gap/高度/圆角；次级按钮走官方 `outline`。
      '.mr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mr-actions-note{flex-basis:100%;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      // 自写卡片分支（替代官方 `SettingsForm` 外壳）的等价性文案位。
      '.mr-frame{display:flex;flex-direction:column;gap:10px}',
      '.mr-frame-note{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.mr-frame-foot{display:flex;align-items:center;gap:8px}',
      '.mr-btn{font:inherit;font-size:13px;padding:4px 12px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);line-height:1.6}',
      '.mr-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-brand-text)}',
      '.mr-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}',
      '.mr-btn-primary:disabled{background:var(--dsw-alias-button-primary-dimmed);border-color:var(--dsw-alias-button-primary-dimmed);cursor:default}',
      '.mr-btn-ghost{background:none;color:var(--dsw-alias-label-secondary)}',
      '.mr-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.mr-status{font-size:12px;color:var(--dsw-alias-state-success-primary)}',
      '.mr-err{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.mr-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:10px 12px}',
      '.mr-ent{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 12px}',
      '.mr-ent+.mr-ent{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.mr-ent-main{display:flex;flex-direction:column;gap:4px;min-width:0;word-break:break-word}',
      '.mr-ent-meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mr-add{display:flex;gap:8px;align-items:center}',
      '.mr-hidden{display:none}',
      '.mr-sec-hd{display:flex;align-items:baseline;gap:10px;margin:4px 0 6px}',
      '.mr-sec-t{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.mr-sec{margin-top:24px}',
      '.mr-sec-h{margin-bottom:4px}',
      '.mr-sec-name{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.mr-sec-intro{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0 0 8px}',
      '.mr-rows{gap:16px}',
      '.mr-field{display:flex;flex-direction:column;gap:6px}',
      '.mr-field-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.mr-line{display:block;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
      '.mr-keyname{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary);opacity:.75}',
      '.mr-ctl{display:flex;align-items:center;gap:6px}',
      '.mr-page .mr-ent-card{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);margin:12px}',
      '.mr-ent-tap{display:flex;gap:8px;flex:1;min-width:0;cursor:pointer}',
      '.mr-ent-caret{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}',
      '.mr-ent-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.mr-ent-meta2{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}',
      '.mr-ent-side{display:flex;align-items:center;gap:6px;flex-shrink:0}',
      '.mr-ent-sep{width:1px;height:18px;background:var(--dsw-alias-border-l1);margin:0 4px}',
      '.mr-list-tabs{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mr-tab{font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;background:none;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.mr-tab-on{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
      '.mr-group-hd{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:8px 12px 2px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.mr-ent-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mr-ent-time{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.mr-ent-acts{display:flex;gap:6px;margin-left:auto}',
      '.mr-ent-sum{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px;word-break:break-word}',
      '.mr-ent-body{margin-top:6px;font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.mr-page .mr-ent-side{align-self:stretch;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;justify-content:flex-end}',
      '.mr-page .mr-ent-tap{width:100%;border:0;padding:0;background:none;color:inherit;font:inherit;text-align:left}',
      '.mr-page .mr-ent-title{font-size:15px;line-height:1.5}',
      '.mr-page .mr-ent-sum{font-size:13px;line-height:1.65}',
      '.mr-page .mr-ent-tap:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}',
    ].join('')


    // ── 基元适配器：有官方基元就用，否则纯元素（功能/文案一致）──────────────────────
    // `variant` 可选，`primary` ⇒ 官方主按钮，其余 ⇒ **`outline`**：bundle 里官方 `Button` 的族只有
    //   `ghost`(默认)/`primary`/`outline`/`toolbar`（Button.module.css L2-68、bundle L3216 默认值
    //   `variant = "ghost"`），**没有 `secondary`** —— 传 `'secondary'` 只会落一个 `undefined` 类名，
    //   按钮拿到基类 `.button{border:none}` ⇒ **没有边框**（复制/删除/添加/复制路径 都受影响）。
    //   故非主按钮一律映射成真实存在的 `'outline'`（有边框 + hover），与动作行三个次级按钮同一观感。
    const Btn = (p) => hasP('Button') && !plain(p)
      ? React.createElement(P.Button, {
        onClick: p.onClick, disabled: p.disabled, title: p.title,
        variant: p.variant || (p.primary ? 'primary' : 'outline'),
        icon: p.icon || undefined,
      }, p.children)
      : React.createElement('button', { className: p.primary ? 'mr-btn mr-btn-primary' : 'mr-btn mr-btn-ghost', onClick: p.onClick, disabled: p.disabled, title: p.title }, p.icon || null, p.children)

    const Txt = (p) => hasP('Input') && !plain(p)
      ? React.createElement(P.Input, { value: p.value == null ? '' : String(p.value), onChange: (v) => p.onChange(val(v)), placeholder: p.placeholder })
      : React.createElement('input', { type: p.kind === 'number' ? 'number' : 'text', className: 'mr-in ' + (p.extraClass || ''), value: p.value == null ? '' : String(p.value), onChange: (ev) => p.onChange(ev.target.value), placeholder: p.placeholder })

    const Toggle = (p) => hasP('Switch') && !plain(p)
      ? React.createElement(P.Switch, { checked: !!p.checked, onChange: (v) => p.onChange(!!val(v)) })
      : React.createElement('input', { type: 'checkbox', checked: !!p.checked, onChange: (ev) => p.onChange(ev.target.checked) })

    // SegmentedControl：2–5 个短选项（官方档位选择器形态）；官方传**裸值**（L3486），仍做兼容。
    const Seg = (p) => {
      const opts = p.options.map((o) => ({ value: String(o.value), label: o.label, title: o.title }))
      const cur = p.value == null ? '' : String(p.value)
      if (hasP('SegmentedControl') && !plain(p)) {
        return React.createElement(P.SegmentedControl, { id: p.id, value: cur, options: opts, label: p.label, disabled: !!p.disabled, onChange: (v) => p.onChange(val(v)) })
      }
      if (hasP('SegmentedTabs') && !plain(p)) {
        return React.createElement(P.SegmentedTabs, { items: opts, value: cur, label: p.label, onChange: (v) => p.onChange(val(v)) })
      }
      // **A 兜底**：官方分段控件不可用 ⇒ 自写 `<select>`（仍放进官方行容器里）
      return React.createElement('select', { className: 'mr-sel', value: cur, disabled: !!p.disabled, onChange: (ev) => p.onChange(ev.target.value) },
        opts.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label)))
    }

    // 官方 `SettingsValueField`（文本/数字字段的官方行）；不可用 ⇒ 自写行。
    const ValueRow = (p) => {
      // v4（用户口径 · 修订稿 §三）：`line` = **行内短句**（默认可见，官方 hint）；
      //   `adv` = **进阶解释**（（v5 已删）
      //   没有 adv 的字段**不给 说明**（help 传 undefined）。`keyName` 作为弱化辅助文字并排。
      if (hasP('SettingsValueField') && !plain(p)) {
        // 两行制：第 1 行 = 名称 + 控件（官方控件）；第 2 行 = **完整说明**（官方 hint）。
        // **不传 help、不渲染任何 说明 / details**。
        return React.createElement(P.SettingsValueField, {
          id: p.id, label: p.label, text: p.text, numeric: !!p.numeric, invalid: !!p.invalid,
          hint: p.full || undefined,
          overridden: !!p.overridden, overriddenLabel: p.labels.overridden,
          onReset: p.onReset || (() => {}), resetLabel: p.labels.reset,
          onEdit: (t) => p.onEdit(val(t)),
        })
      }
      return React.createElement('div', { className: 'mr-field' },
        React.createElement('div', { className: 'mr-field-row' },
          React.createElement('span', { className: 'mr-label' }, p.label + (p.overridden ? ' ' + p.labels.overridden : '')),
          React.createElement('div', { className: 'mr-ctl' },
          React.createElement(Txt, { kind: p.numeric ? 'number' : 'text', value: p.text, extraClass: p.numeric ? 'mr-in-num' : 'mr-in-grow', onChange: p.onEdit, forcePlain: p.forcePlain }))),
        p.full ? React.createElement('div', { className: 'mr-line' }, p.full) : null)
    }

    // 卡片分支（**不再**套官方 `SettingsForm` 外壳 —— 它的 footer 无条件画保存按钮、无 props 可关，
    //   见 bundle L6940-6953）。同一套 `labels`/状态语义；等价性四条自补：
    //   ① `!available` ⇒ `labels.unavailable` 一行（替代整卡）；
    //   ② `!writable` ⇒ 卡片顶部 `labels.readOnly` 一行；
    //   ③ 保存按钮的禁用 = `!dirty || invalid || saving` —— 保存按钮在顶部动作行（`saveBlocked`）；
    //   ④ `failed` ⇒ 卡片页脚 `labels.saveFailed`。
    const Frame = (p) => {
      if (!p.state.available) {
        return React.createElement('p', { className: 'mr-frame-note', role: 'status' }, p.labels.unavailable)
      }
      return React.createElement('div', { className: 'mr-frame' },
        !p.state.writable ? React.createElement('p', { className: 'mr-frame-note', role: 'status' }, p.labels.readOnly) : null,
        p.children,
        p.state.failed ? React.createElement('div', { className: 'mr-frame-foot' },
          React.createElement('span', { className: 'mr-err', role: 'status' }, p.labels.saveFailed)) : null)
    }

    // 视图切换适配器：官方 SegmentedTabs（L3261）优先 → SegmentedControl（L3444）→ 自写标签按钮。
    const Tabs = (p) => {
      const items = p.options.map((o) => ({ value: String(o.value), label: o.label }))
      const cur = String(p.value)
      if (hasP('SegmentedTabs')) return React.createElement(P.SegmentedTabs, { items, value: cur, label: p.label, onChange: (v) => p.onChange(val(v)) })
      if (hasP('SegmentedControl')) return React.createElement(P.SegmentedControl, { id: 'mr-view', value: cur, options: items, label: p.label, onChange: (v) => p.onChange(val(v)) })
      return React.createElement('div', { className: 'mr-list-tabs' }, items.map((o) => React.createElement('button', { key: o.value, className: 'mr-tab' + (o.value === cur ? ' mr-tab-on' : ''), onClick: () => p.onChange(o.value) }, o.label)))
    }

    // 官方图标（逐个探测；缺则不打，不影响功能）
    const ico = (n, size) => (hasP(n) ? React.createElement(P[n], { size: size || 14 }) : null)

    /** 错误边界：基元渲染抛错 ⇒ 翻全局开关、重渲染纯元素版（页面不消失）。 */
    let Boundary
    if (typeof React.Component === 'function') {
      Boundary = class extends React.Component {
        constructor(props) { super(props); this.state = { failed: false } }
        static getDerivedStateFromError() { return { failed: true } }
        componentDidCatch(err) { primitivesEnabled.on = false; try { console.warn('[dsh-memory_rollout] primitives render failed, falling back to plain elements:', err && err.message ? err.message : err) } catch {} }
        render() { return this.state.failed ? this.props.fallback() : this.props.children }
      }
    } else {
      Boundary = function Boundary(props) { return props.children }
    }

    // ── 设置章节规格（2026-10-01 v4）────────────────────────────────────────────
    // 事实来源：lib/index.js CONFIG_FIELDS（L202-268）。hint = **行内短句**（默认可见，10-20 字级）；
    //   adv = **进阶解释**（仅放进官方 help 说明，点开才看）——两者**不是同一串文字**；没有 adv 的字段
    //   **不给 说明**。unit 附在中文名后的括号里。未列出的 key 一律落进「高级设置」⇒ 原字段永远可访问。
    const NAME = {
      generateMemories: '自动生成新记忆', useMemories: '在对话中使用记忆',
      summaryTokens: '摘要注入预算', maxQuickSteps: '快速检索步数', recallLimit: '单次召回上限',
      maxUnusedDays: '条目资格窗口', extractProvider: '提炼 Provider', extractModel: '提炼模型',
      extractReasoningEffort: '提炼推理强度', maxExtractTokens: '提炼输入上限',
      minRolloutIdleHours: '静置摄取窗口', consolidationProvider: '整合 Provider',
      consolidationModel: '整合模型', consolidationReasoningEffort: '整合推理强度',
      consolidationExecutor: '整合承载方式', maxSourcesPerStartup: '单次启动来源上限',
      minRemainingQuotaPercent: '整合额度门', phase2Diagnostics: '整合诊断（可选）',
    }
    const UNIT = { summaryTokens: 'token', maxQuickSteps: '步', recallLimit: '条', maxUnusedDays: '天', maxExtractTokens: 'token', minRolloutIdleHours: '小时', maxSourcesPerStartup: '个', minRemainingQuotaPercent: '%' }
    const LINE = {
      generateMemories: '关闭后不再自动生成（手动入口仍可用）',
      useMemories: '关闭后不注入、不召回记忆',
      summaryTokens: '越大注入总纲越多',
      maxQuickSteps: '越小越省，默认 5，≤12',
      recallLimit: '一次最多返回几条，默认 10，≤50',
      maxUnusedDays: '超过这么多天没用过的条目不召回',
      extractProvider: '留空 = 用默认 Provider',
      extractModel: '留空 = 用 agent 默认模型',
      extractReasoningEffort: '默认 / 关闭 / 低 / 高 / 最高',
      maxExtractTokens: '超长会话先截断到此输入上限',
      minRolloutIdleHours: '会话静置这么久后才提炼，默认 6',
      consolidationProvider: '留空 = 用默认 Provider',
      consolidationModel: '留空 = 用 agent 默认模型',
      consolidationReasoningEffort: '默认 / 关闭 / 低 / 高 / 最高',
      consolidationExecutor: 'plugin-background = 插件内单次调用，不建会话',
      maxSourcesPerStartup: '每次启动最多处理几个来源，默认 2',
      minRemainingQuotaPercent: '额度剩余低于此值就暂缓整合，默认 25',
      phase2Diagnostics: '默认关；只出诊断、不阻断发布',
    }
    const ADV = {
      generateMemories: '会话结束后自动入队提炼；与「在对话中使用记忆」是两个独立开关。',
      useMemories: '注入与召回同时受此开关控制；生成侧不受影响。',
      maxUnusedDays: '0 = 只有刚用过的条目具资格；从未用过的条目按更新时间判断是否仍在窗口内。',
      extractReasoningEffort: '留空 = 模型默认；off 不推理。模型拒绝该值时会自动去掉重试。',
      consolidationReasoningEffort: '留空 = 模型默认；off 不推理。模型拒绝该值时会自动去掉重试。',
      consolidationExecutor: 'restricted-session-experiment = 建受限会话执行（会继承预设、可能留下会话痕迹）。',
      maxSourcesPerStartup: '只约束启动那一趟 drain；剩余来源由后续趟次/事件继续处理，不会丢。',
      minRemainingQuotaPercent: '剩余恰好等于阈值时放行；显式 memory__integrate 不受此门限制。',
      minRolloutIdleHours: '值越大进记忆越晚；越小越快，但可能切到仍在写入的会话。',
      phase2Diagnostics: '每批多跑一次「疑似丢旧结论」启发式检查；只看文本变化，区分不了合理归并，不是闸门。',
      maxExtractTokens: '指传给模型的输入 token（不是输出）。',
    }
    // v5（用户口径：两行制、别搞说明）：第 2 行 = **完整说明**。默认**用宿主 CONFIG_FIELDS 的 hint 原文**；
    //   只有两个字段按实现改成更诚实的口径 ——
    //   summaryTokens：注入按 lib/index.js L7789 `maxChars = (summaryTokens||4000) * 4`（1 token ≈ 4 字符）；
    //     生成总纲的预算按 L424-426 `tokens × SUMMARY_CHARS_PER_TOKEN × SUMMARY_BUDGET_RATIO`（= ×4×0.9）。
    //   maxExtractTokens：L4384-4399 `truncateTranscript`：cap = max(200, maxTokens×4)，tailBudget = cap×0.4，
    //     中段省略并插入显式标记（L4388-4389）。
    const FULL = {
      summaryTokens: '注入总纲（memory_summary.md）的预算，按 1 token ≈ 4 字符折算：注入时按 tokens × 4 字符截断（4000 ⇒ 约 16,000 字符）；生成总纲时的预算为 tokens × 4 × 0.9（4000 ⇒ 14,400 字符）。只影响注入的总纲，与对话长度无关。默认 4000，最大 12000。',
      maxExtractTokens: '传给提炼模型的**最大输入** token，默认 200000（按 cap = maxTokens × 4 ⇒ 约 800,000 字符上限）。超长会话仍会先截断：**保留开头 + 结尾（尾部约 40%）**，**中段省略并留下显式标记** ⇒ 中段内容可能不被提炼。**值越大越贵。**',
    }

    const SECTIONS = [
      { title: '基本设置', intro: '是否生成新记忆、是否在对话里使用记忆；记忆存哪里。',
        keys: ['generateMemories', 'useMemories'] },
      { title: '记忆使用', intro: '控制每次带进对话、以及召回的记忆量。',
        keys: ['summaryTokens', 'maxQuickSteps', 'recallLimit', 'maxUnusedDays'] },
      { title: '记忆提炼', intro: '把一次会话炼成草稿时用的模型与限制。',
        keys: ['extractProvider', 'extractModel', 'extractReasoningEffort', 'maxExtractTokens', 'minRolloutIdleHours'] },
      { title: '记忆整合', intro: '跨会话整合（Phase 2）用的模型与限制。',
        keys: ['consolidationProvider', 'consolidationModel', 'consolidationReasoningEffort'] },
      { title: '高级设置', intro: '低频技术参数，一般不用改。', collapsed: true,
        keys: ['consolidationExecutor', 'maxSourcesPerStartup', 'minRemainingQuotaPercent', 'phase2Diagnostics'] },
    ]
    const GROUP_OF = (() => { const m = {}; for (const s of SECTIONS) for (const k of s.keys) m[k] = s.title; return m })()

    // ── 页面 ────────────────────────────────────────────────────────────────
    function MemoryPage() {
      const [entries, setEntries] = React.useState([])
      const [error, setError] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [cfg, setCfg] = React.useState({})            // 已保存值（服务端真相）
      const [drafts, setDrafts] = React.useState({})      // 未保存草稿（field -> text；'' = 清除覆盖）
      const [cfgDefaults, setCfgDefaults] = React.useState({})
      const [cfgFields, setCfgFields] = React.useState([])
      const [memRoot, setMemRoot] = React.useState('')
      const [loadingCfg, setLoadingCfg] = React.useState(true)
      const [cfgSaving, setCfgSaving] = React.useState(false)
      const [cfgFailed, setCfgFailed] = React.useState(false)
      const [cfgResetting, setCfgResetting] = React.useState(false)   // 恢复默认在飞
      const [confirmReset, setConfirmReset] = React.useState(false)   // 两段式内联确认
      // 「有没有 overlay」：**只有** reset 的响应体带 `hasOverlay`（服务端 GET /config 不返回它）⇒
      //   `null` = 未知（按钮可用），只有明确拿到 `false` 才把按钮置灰。
      const [hasOverlay, setHasOverlay] = React.useState(null)
      const importRef = React.useRef(null)
      const [status, setStatus] = React.useState('')
      // ② 列表：视图分段 / 展开项 / 待确认删除项 / Toast
      const [view, setView] = React.useState('time')
      const [openId, setOpenId] = React.useState('')
      const [confirmId, setConfirmId] = React.useState('')
      const [toast, setToast] = React.useState('')
      const [settingsOpen, setSettingsOpen] = React.useState(true)          // 设置区整体可折叠
      const [openGroups, setOpenGroups] = React.useState({})                // 组折叠（高级设置默认折叠）
      const isGroupOpen = (s) => (openGroups[s.title] === undefined ? !s.collapsed : !!openGroups[s.title])
      const toggleGroup = (s) => setOpenGroups((prev) => Object.assign({}, prev, { [s.title]: !isGroupOpen(s) }))
      const toastTimer = React.useRef(null)
      const showToast = (msg) => {
        setToast(String(msg || ''))
        try { if (toastTimer.current) clearTimeout(toastTimer.current) } catch {}
        toastTimer.current = setTimeout(() => setToast(''), 3000)
      }

      const FL = { unavailable: '插件未就绪', readOnly: '只读', saveFailed: '保存失败', save: '保存配置', saving: '保存中…', overridden: '（≠ 默认）', reset: '重置' }

      const refresh = () => {
        apiEntries('GET')
          .then((res) => setEntries(res && Array.isArray(res.entries) ? res.entries : []))
          .catch((err) => setError(String((err && err.message) || err)))
      }
      const loadConfig = () => {
        api('/dsh-memory_rollout/config', 'GET')
          .then((res) => {
            setCfg((res && res.config) || {})
            setDrafts({})
            setCfgDefaults((res && res.defaults) || {})
            setCfgFields((res && res.fields) || [])
            setMemRoot((res && res.root) || '')
            setHasOverlay(null)   // GET 不返回 hasOverlay ⇒ 回到"未知"
            setConfirmReset(false)
          })
          .catch((err) => setStatus('配置加载失败：' + String((err && err.message) || err)))
          .then(() => { setLoadingCfg(false); setCfgFailed(false) })
      }
      React.useEffect(() => { refresh(); loadConfig() }, [])

      const remove = (id) => apiEntries('POST', { action: 'delete', id }).then(refresh).catch((err) => setError(String((err && err.message) || err)))
      const add = () => {
        const content = draft.trim()
        if (!content || busy) return
        setBusy(true)
        apiEntries('POST', { action: 'add', content, tags: [] })
          .then(() => { setDraft(''); refresh() })
          .catch((err) => setError(String((err && err.message) || err)))
          .then(() => setBusy(false))
      }

      // ── 草稿层：对齐官方 `SettingsFormModel` 语义（staged 文本 → 保存才写；空串 = 清除覆盖）
      const isNum = (f) => f.type === 'number'
      const fieldText = (f) => {
        const d = drafts[f.key]
        if (d !== undefined) return d
        const v = cfg[f.key]
        return v == null ? '' : String(v)
      }
      // 开关控件值同样**草稿优先**（与 `fieldText` 同一条口径）：草稿里 toggle 存的是字符串
      //   `'true'`/`'false'`（`edit` L400 / `resetField` L401-404），而已保存值可能是 JSON 布尔
      //   ⇒ 两种形态都按**语义**读，别用 `!!`（`!!'false' === true`）。
      const boolField = (f) => {
        const d = drafts[f.key]
        const v = d === undefined ? cfg[f.key] : d
        return typeof v === 'boolean' ? v : String(v) === 'true'
      }
      const fieldParsed = (f) => {
        const d = drafts[f.key]
        if (d === undefined) return { ok: true, clear: false, value: cfg[f.key] }
        const t = String(d).trim()
        if (t === '') return { ok: true, clear: true, value: '' }
        if (isNum(f)) { const n = Number(t); return Number.isFinite(n) ? { ok: true, clear: false, value: n } : { ok: false } }
        return { ok: true, clear: false, value: t }
      }
      const dirty = Object.keys(drafts).some((k) => String(drafts[k]) !== String(cfg[k] == null ? '' : cfg[k]))
      const invalid = cfgFields.some((f) => !fieldParsed(f).ok)
      const isNonDefault = (f) => {
        const cur = cfg[f.key]; const def = cfgDefaults[f.key]
        if (cur === undefined || def === undefined) return false
        return String(cur) !== String(def)
      }
      const edit = (f, text) => setDrafts((prev) => Object.assign({}, prev, { [f.key]: text }))
      const resetField = (f) => {
        const def = cfgDefaults[f.key]
        setDrafts((prev) => Object.assign({}, prev, { [f.key]: def == null ? '' : String(def) }))
      }
      const discard = () => setDrafts({})
      const saveConfig = () => {
        if (invalid) return
        const payload = {}
        for (const f of cfgFields) {
          const q = fieldParsed(f)
          if (!q.ok) return
          if (q.clear) payload[f.key] = ''
          // B2：toggle 的 `!!'false' === true` ⇒ "关"会被存成"开"。按**语义**布尔化；无草稿时
          //   `fieldParsed` 直接回 cfg 的**布尔**，故两种形态都要认。
          else payload[f.key] = isNum(f) ? q.value : (f.type === 'toggle' ? (typeof q.value === 'boolean' ? q.value : String(q.value) === 'true') : String(q.value))
        }
        setCfgSaving(true); setCfgFailed(false); setStatus('')
        api('/dsh-memory_rollout/config', 'POST', payload)
          .then((res) => {
            setCfg((res && res.config) || cfg)
            setCfgDefaults((res && res.defaults) || cfgDefaults)
            setDrafts({})
            setHasOverlay(null)   // POST 保存同样不返回 hasOverlay ⇒ 回到"未知（可用）"
            setStatus('配置已保存')
          })
          .catch((err) => { setCfgFailed(true); setStatus('保存失败：' + String((err && err.message) || err)) })
          .then(() => setCfgSaving(false))
      }

      // ── 任务 A：一键恢复默认（POST {action:'reset'}）──────────────────────────────
      //   服务端：把现有 overlay 备份成 `…settings.json.pre-reset`（同族只留最新 1）→ 删 overlay →
      //   内存里把可编辑字段恢复成 schema 默认 → 返回**新状态**（`config/defaults/fields/root/hasOverlay`）。
      //   所以成功分支**用响应体刷新表单**（立刻显示默认值），不是自己猜默认值。删不掉时服务端回 HTTP 500
      //   ⇒ `api()` 抛错 ⇒ 只走失败分支、如实显示，绝不假装成功。
      const doReset = () => {
        setConfirmReset(false)
        setCfgResetting(true)
        setStatus('')
        api('/dsh-memory_rollout/config', 'POST', { action: 'reset' })
          .then((res) => {
            setCfg((res && res.config) || {})
            setCfgDefaults((res && res.defaults) || cfgDefaults)
            if (res && Array.isArray(res.fields) && res.fields.length) setCfgFields(res.fields)
            if (res && typeof res.root === 'string') setMemRoot(res.root)
            setDrafts({})
            if (res && res.hasOverlay === false) setHasOverlay(false)
            const bak = res && res.backup ? String(res.backup) : ''
            // 有备份 ⇒ 说明本来改过；无备份 ⇒ 本来就在默认态。官方 `Toast` 不在时由 toastNode 退化成
            //   `.mr-status` 文案（同一条消息，不重复两处）。
            showToast(bak ? '已恢复默认配置（原配置已备份为 ' + bak + '）' : '当前已是默认配置')
          })
          .catch((err) => setStatus('恢复失败：' + String((err && err.message) || err)))
          .then(() => setCfgResetting(false))
      }

      // 导出：仍走 `/dsh-memory_rollout/export`（服务端带 `Content-Disposition: attachment`）。用一次性
      //   `<a download>` 触发，**不改变窗口位置**（桌面端不把窗口导航到下载 URL）。
      const triggerExport = () => {
        try {
          const a = document.createElement('a')
          a.href = '/dsh-memory_rollout/export'
          a.download = ''
          a.rel = 'noopener'
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
        } catch (err) { setStatus('导出失败：' + String((err && err.message) || err)) }
      }

      const onImportFile = (e) => {
        const file = e.target.files && e.target.files[0]
        e.target.value = '' // 允许重选同一文件再次触发
        if (!file) return
        setStatus('导入中…')
        const reader = new FileReader()
        reader.onload = () => {
          api('/dsh-memory_rollout/import', 'POST', String(reader.result || ''))
            .then((res) => {
              setStatus('导入完成：' + (res.fileCount || 0) + ' 个文件，' + (res.entryCount || 0) + ' 条记忆' + (res.backup ? '（原记忆已备份为 ' + res.backup + '）' : ''))
              refresh(); loadConfig()
            })
            .catch((err) => setStatus('导入失败：' + String((err && err.message) || err)))
        }
        reader.onerror = () => setStatus('读取文件失败')
        reader.readAsText(file)
      }

      // ── 字段渲染：布尔 / 档位(2–5 项 ⇒ B: 分段控件) / 数字 / 文本 / 大选项集(A 兜底)──────
      const renderField = (f) => {
        const opts = Array.isArray(f.options) ? f.options : []
        const labelNode = React.createElement('div', { className: 'mr-label' }, f.label + (isNonDefault(f) ? ' ' + FL.overridden : ''))
        if (f.type === 'toggle') {
          const cn = NAME[f.key] || f.label
          const full = FULL[f.key] || f.hint || ''
          return React.createElement('div', { key: f.key, className: 'mr-field' },
            React.createElement('div', { className: 'mr-field-row' },
              React.createElement('span', { className: 'mr-label' }, cn + (isNonDefault(f) ? ' ' + FL.overridden : '')),
              React.createElement(Toggle, { checked: boolField(f), onChange: (v) => edit(f, v ? 'true' : 'false') })),
            full ? React.createElement('div', { className: 'mr-line' }, full) : null)
        }
        if (f.type === 'select') {
          const segOpts = opts.map((o) => ({ value: o, label: o === '' ? '默认' : o, title: o === '' ? '模型默认' : o }))
          const cn = NAME[f.key] || f.label
          const full = FULL[f.key] || f.hint || ''
          return React.createElement('div', { key: f.key, className: 'mr-field' },
            React.createElement('div', { className: 'mr-field-row' },
              React.createElement('span', { className: 'mr-label' }, cn + (isNonDefault(f) ? ' ' + FL.overridden : '')),
              React.createElement(Seg, { id: 'mr-' + f.key, value: fieldText(f), options: segOpts, label: cn, onChange: (v) => edit(f, v) })),
            full ? React.createElement('div', { className: 'mr-line' }, full) : null)
        }
        const q = fieldParsed(f)
        const label = (NAME[f.key] || f.label) + (UNIT[f.key] ? '（' + UNIT[f.key] + '）' : '')
        return React.createElement(ValueRow, {
          key: f.key, id: 'mr-' + f.key, label, full: FULL[f.key] || f.hint || '',
          text: fieldText(f), numeric: isNum(f), invalid: !q.ok, overridden: isNonDefault(f),
          labels: FL, onEdit: (t) => edit(f, t), onReset: () => resetField(f),
        })
      }

      // ── ② 列表：相对时间 / 时间分段 / 卡片化 / 折叠 / 复制 / 确认删除 / Toast ─────────
      // 官方 relativeTime(at, now)（L7950）返回结构 {unit,n}（unit ∈ now/minutes/hours/days/months/
      //   years）⇒ 文案由我们本地化；取不到则用同一口径自算。
      const relText = (iso) => {
        const at = Date.parse(String(iso || ''))
        if (!Number.isFinite(at)) return String(iso || '').slice(0, 16)
        const nowMs = Date.now()
        const MIN = 60000, H = 3600000, D = 86400000
        let r = null
        if (hasP('relativeTime')) { try { r = P.relativeTime(at, nowMs) } catch { r = null } }
        if (!r || !r.unit) {
          const d = Math.max(0, nowMs - at)
          if (d < MIN) r = { unit: 'now', n: 0 }
          else if (d < H) r = { unit: 'minutes', n: Math.floor(d / MIN) }
          else if (d < D) r = { unit: 'hours', n: Math.floor(d / H) }
          else if (d < 30 * D) r = { unit: 'days', n: Math.floor(d / D) }
          else if (d < 365 * D) r = { unit: 'months', n: Math.floor(d / (30 * D)) }
          else r = { unit: 'years', n: Math.floor(d / (365 * D)) }
        }
        const t = { now: '刚刚', minutes: r.n + ' 分钟前', hours: r.n + ' 小时前', days: r.n + ' 天前', months: r.n + ' 个月前', years: r.n + ' 年前' }
        return t[r.unit] || String(iso || '').slice(0, 16)
      }
      const bucketOf = (iso) => {
        const at = Date.parse(String(iso || ''))
        if (!Number.isFinite(at)) return '更早'
        const d = new Date(); d.setHours(0, 0, 0, 0)
        const today = d.getTime()
        if (at >= today) return '今天'
        if (at >= today - 6 * 86400000) return '本周'
        if (at >= today - 29 * 86400000) return '本月'
        return '更早'
      }
      const groups = (() => {
        const sorted = entries.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        if (view === 'all') return [{ title: '全部', items: sorted }]
        const m = new Map()
        for (const e of sorted) {
          const k = view === 'tag' ? (Array.isArray(e.tags) && e.tags.length ? String(e.tags[0]) : '未分类') : bucketOf(e.createdAt)
          if (!m.has(k)) m.set(k, [])
          m.get(k).push(e)
        }
        return Array.from(m, (kv) => ({ title: kv[0], items: kv[1] }))
      })()
      const tagNode = (t) => hasP('Tag')
        ? React.createElement(P.Tag, { key: 'tag-' + t, tone: 'outline' }, '#' + t)
        : React.createElement('span', { key: 'tag-' + t, className: 'mr-ent-time' }, '#' + t)
      const copyEntry = (e) => {
        const text = String(e.content || '')
        const done = (good) => showToast(good ? '已复制到剪贴板' : '复制失败（浏览器拒绝或不可用）')
        if (hasP('writeClipboard')) { try { P.writeClipboard(text).then(done, () => done(false)); return } catch {} }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(() => done(true), () => done(false)); return }
        } catch {}
        done(false)
      }
      const stop = (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation() }
      // 条目化（修订稿 §五）：**标题最先 → 正文预览 → 时间与标签最后**；复制/删除独立，删除最右。
      const textOf = (e) => String(e.content || '').replace(/\s+/g, ' ').trim()
      const titleOf = (e) => {
        const raw = String(e.content || '')
        const first = (raw.split('\n').find((l) => l.trim()) || e.title || '').trim()
        const t = String(e.title || first || '').trim()
        return t.length > 42 ? t.slice(0, 42) + '…' : (t || '(无标题)')
      }
      const previewOf = (e) => { const t = textOf(e); return t.length > 120 ? t.slice(0, 120) + '…' : t }
      const entryBodyFull = (e) => React.createElement('div', { className: 'mr-ent-body' }, String(e.content || ''))
      const entryActions = (e) => React.createElement('span', { className: 'mr-ent-acts' },
        React.createElement(Btn, { onClick: (ev) => { stop(ev); copyEntry(e) } }, '复制'),
        React.createElement('span', { className: 'mr-ent-sep' }, null),
        confirmId === e.id
          ? React.createElement(Btn, { primary: true, onClick: (ev) => { stop(ev); setConfirmId(''); remove(e.id); showToast('已删除') } }, '确认删除')
          : React.createElement(Btn, { onClick: (ev) => { stop(ev); setConfirmId(e.id); showToast('再点一次「确认删除」') } }, '删除'),
        confirmId === e.id ? React.createElement(Btn, { onClick: (ev) => { stop(ev); setConfirmId('') } }, '取消') : null)
      const entryMeta = (e) => React.createElement('span', { className: 'mr-ent-meta2' },
        React.createElement('span', { className: 'mr-ent-time' }, relText(e.createdAt)),
        (Array.isArray(e.tags) ? e.tags : []).map((t) => tagNode(t)))
      const entryMain = (e) => React.createElement('div', { className: 'mr-ent-main' },
        React.createElement('div', { className: 'mr-ent-title' }, titleOf(e)),
        openId === e.id ? entryBodyFull(e) : React.createElement('div', { className: 'mr-ent-sum' }, previewOf(e)),
        entryMeta(e))
      const entryRow = (e) => React.createElement('article', { key: e.id, className: 'mr-ent-card' },
        React.createElement('div', { className: 'mr-ent-tap', role: 'button', tabIndex: 0, 'aria-expanded': openId === e.id, onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpenId(openId === e.id ? '' : e.id) } }, onClick: () => setOpenId(openId === e.id ? '' : e.id) },
          React.createElement('span', { className: 'mr-ent-caret' }, openId === e.id ? '▾' : '▸'),
          entryMain(e)),
        React.createElement('div', { className: 'mr-ent-side' }, entryActions(e)))
      const listNode = React.createElement('div', null,
        React.createElement('div', { className: 'mr-list-tabs' },
          React.createElement(Tabs, {
            value: view, label: '记忆库视图',
            options: [{ value: 'all', label: '全部' }, { value: 'time', label: '按时间' }, { value: 'tag', label: '按标签' }],
            onChange: (v) => { setView(String(v)); setOpenId(''); setConfirmId('') },
          })),
        groups.map((g) => React.createElement('div', { key: 'grp-' + g.title, className: 'mr-group' },
          React.createElement('div', { className: 'mr-group-hd' }, g.title + ' · ' + g.items.length + ' 条'),
          g.items.map((e) => entryRow(e)))))
      const toastNode = toast
        ? (hasP('Toast')
            ? React.createElement(P.Toast, { text: toast, onDone: () => setToast('') })
            : React.createElement('div', { className: 'mr-status' }, toast))
        : null

      const formState = { available: true, writable: true, dirty, invalid, saving: cfgSaving, failed: cfgFailed }
      // 等价性 ③：保存按钮的禁用 = `!dirty || invalid || saving`（与官方框架 L6930 同一判据）。
      const saveBlocked = !dirty || invalid || cfgSaving

      return React.createElement('div', { className: 'mr-page' },
        React.createElement('style', null, CSS),
        React.createElement('div', { className: 'mr-h' }, '记忆库（dsh-memory_rollout 跨会话记忆）'),
        // ── 动作行（标题下方**常驻**、不在可折叠区内）：四个按钮同一容器 ⇒ 同一 gap/高度/圆角；
        //    保存为主按钮，其余三个次级（官方 `outline`）。确认态下「恢复默认」位置换成
        //    「确认恢复默认 / 取消」+ 一句风险说明（两段式内联确认，不用 `RiskConfirmation`）。
        React.createElement('div', { className: 'mr-actions' },
          React.createElement(Btn, { primary: true, onClick: saveConfig, disabled: saveBlocked }, cfgSaving ? FL.saving : FL.save),
          confirmReset
            ? React.createElement(Btn, { variant: 'outline', onClick: doReset, disabled: cfgResetting }, cfgResetting ? '恢复中…' : '确认恢复默认')
            : React.createElement(Btn, {
              variant: 'outline', onClick: () => setConfirmReset(true), disabled: cfgResetting || hasOverlay === false,
              title: hasOverlay === false ? '当前已是默认配置' : undefined,
            }, '恢复默认'),
          confirmReset ? React.createElement(Btn, { variant: 'ghost', onClick: () => setConfirmReset(false) }, '取消') : null,
          React.createElement(Btn, { variant: 'outline', onClick: triggerExport, icon: ico('IconDownloadOutlineRegular', 16) }, '导出记忆'),
          React.createElement(Btn, {
            variant: 'outline', icon: ico('IconUploadOutlineRegular', 16),
            onClick: () => { try { if (importRef.current) importRef.current.click() } catch (err) { setStatus('导入失败：' + String((err && err.message) || err)) } },
          }, '导入记忆'),
          // 导入仍用**隐藏 file input** 触发（与原先同一处逻辑）。
          React.createElement('input', { type: 'file', ref: importRef, accept: '.json,application/json', style: { display: 'none' }, onChange: onImportFile }),
          confirmReset ? React.createElement('span', { className: 'mr-actions-note' },
            '确认后会清空你已保存的配置，表单立即回到插件内置默认值（原配置会先备份为 …settings.json.pre-reset）。') : null),
        status ? React.createElement('div', { className: 'mr-status' }, status) : null,
        React.createElement('div', { className: 'mr-sec-hd' },
          React.createElement('span', { className: 'mr-sec-t', onClick: () => setSettingsOpen(!settingsOpen) }, (settingsOpen ? '▾ ' : '▸ ') + '设置'),
          React.createElement('span', { className: 'mr-hint' }, '改动后需点上方主按钮保存才生效')),
        React.createElement('div', { className: 'mr-card' + (settingsOpen ? '' : ' mr-hidden') },
          memRoot ? React.createElement('div', { className: 'mr-meta' },
            '记忆保存位置：' + memRoot,
            React.createElement(Btn, { onClick: () => { try { if (hasP('writeClipboard')) P.writeClipboard(memRoot).then((ok2) => showToast(ok2 ? '路径已复制' : '复制失败'), () => showToast('复制失败')); else showToast('路径：' + memRoot) } catch { showToast('复制失败') } } }, '复制路径')) : null,
          loadingCfg ? React.createElement('div', { className: 'mr-meta' }, '加载配置…')
            : React.createElement(Frame, { state: formState, labels: FL },
                React.createElement('div', null, SECTIONS.map((s) => {
                  const items = cfgFields.filter((f) => (GROUP_OF[f.key] || '高级设置') === s.title)
                  const others = s.title === '高级设置' ? cfgFields.filter((f) => !GROUP_OF[f.key]) : []
                  const all = items.concat(others)
                  if (!all.length) return null
                  const open = isGroupOpen(s)
                  return React.createElement('div', { key: 'sec-' + s.title, className: 'mr-sec' },
                    React.createElement('div', { className: 'mr-sec-h', onClick: () => toggleGroup(s) },
                      React.createElement('span', { className: 'mr-sec-name' }, (open ? '▾ ' : '▸ ') + s.title + '（' + all.length + '）')),
                    React.createElement('div', { className: 'mr-sec-intro' }, s.intro),
                    open ? React.createElement('div', { className: 'mr-rows' }, all.map(renderField)) : null)
                })))),
        React.createElement('div', { className: 'mr-sec-hd' }, React.createElement('span', { className: 'mr-sec-t' }, '记忆库')),
        React.createElement('div', { className: 'mr-add' },
          React.createElement(Txt, { value: draft, extraClass: 'mr-in-grow', onChange: (v) => setDraft(v), placeholder: '快速记一条…' }),
          React.createElement(Btn, { primary: true, onClick: add, disabled: busy }, '添加')),
        error ? React.createElement('div', { className: 'mr-err' }, error) : null,
        entries.length === 0
          ? React.createElement('div', { className: 'mr-card' }, React.createElement('div', { className: 'mr-empty' }, '暂无记忆。让 Agent 用 memory_remember 记录、memory_recall 回忆。'))
          : React.createElement('div', { className: 'mr-card' }, listNode),
        toastNode)
    }

    // ── 新宿主客户端契约（dsh-cordis-client-runner）───────────────────────────
    // 插件上下文**只暴露它在 inject 里声明的服务**（runner L314「serviceName access is gated by the
    //   fiber's inject declaration」、L320–L323 未声明即报错、L581 用 fiber.inject 决定等待哪些服务）。
    //   旧写法没有声明 inject、只靠 `ctx.get('slots')`，在新宿主里拿到 undefined，被早退静默吞掉 ⇒
    //   `settings.section` 从未注册 ⇒ 设置侧栏里「记忆库」整页不出现（本处修复的就是它）。对照可见官方
    //   页面 `dsh-client-ui-settings-account/lib/client.js`（L1357 `exports.inject = ['slots', …]`、
    //   L1331 `ctx.slots.inject('settings.section', …)`、label 传字符串）⇒ 本文件与它对齐。
    exports.inject = ['slots']

    function apply(ctx) {
      let slots
      try { slots = ctx.slots } catch { slots = undefined }
      if (slots === undefined) slots = ctx.get('slots')
      if (slots === undefined) return

      // Page-owned styles mount/unmount with MemoryPage, including primitive fallback.
      // Do not access an undeclared host styles service and silently lose all layout.

      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'dsh-memory_rollout', order: 30, label: '记忆库' },
          () => React.createElement(Boundary, { fallback: () => React.createElement(MemoryPage, null) }, React.createElement(MemoryPage, null)),
        ),
      )
    }

    exports.name = name
    exports.apply = apply
    return module.exports
  },
})
