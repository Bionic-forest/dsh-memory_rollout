// dsh-memory_rollout — cross-session memory vault for DeepSeek Harness (Client half).
//
// Registers a "记忆库 / Memory" page in the settings section. The page lists,
// adds, and deletes vault entries through the host half's webServer JSON route
// (GET/POST /dsh-memory_rollout/entries), and adds a Settings block that:
//   - reads + edits the plugin config (GET/POST /dsh-memory_rollout/config),
//   - exports the whole memories/ tree for backup (GET /dsh-memory_rollout/export),
//   - imports a backup file (POST /dsh-memory_rollout/import).
//
// Client entries must be classic scripts that register via
// window.__ModuleLoader__.load({ id, factory }); the factory receives a
// synchronous `require` and returns the module exports.
window.__ModuleLoader__.load({
  id: 'dsh-memory_rollout',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const name = 'dsh-memory_rollout'

    // Generic JSON fetch against a host webServer route. `payload` may be an object
    // (JSON-stringified) or a raw string (sent as-is, used by import which re-posts
    // an already-serialized backup bundle).
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

    function MemoryPage() {
      const [entries, setEntries] = React.useState([])
      const [error, setError] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      // ── settings / config state ──────────────────────────────────────────
      const [cfg, setCfg] = React.useState({})
      const [cfgDefaults, setCfgDefaults] = React.useState({})
      const [cfgFields, setCfgFields] = React.useState([])
      const [memRoot, setMemRoot] = React.useState('')
      const [loadingCfg, setLoadingCfg] = React.useState(true)
      const [cfgSaving, setCfgSaving] = React.useState(false)
      const [status, setStatus] = React.useState('')

      const refresh = () => {
        apiEntries('GET')
          .then((res) => setEntries(res && Array.isArray(res.entries) ? res.entries : []))
          .catch((err) => setError(String((err && err.message) || err)))
      }

      const loadConfig = () => {
        api('/dsh-memory_rollout/config', 'GET')
          .then((res) => {
            const c = res && res.config ? res.config : {}
            setCfg(c)
            setCfgDefaults((res && res.defaults) || {})
            setCfgFields((res && res.fields) || [])
            setMemRoot((res && res.root) || '')
          })
          .catch((err) => setStatus('配置加载失败：' + String((err && err.message) || err)))
          .then(() => setLoadingCfg(false))
      }

      React.useEffect(() => {
        refresh()
        loadConfig()
      }, [])

      const remove = (id) => {
        apiEntries('POST', { action: 'delete', id })
          .then(() => refresh())
          .catch((err) => setError(String((err && err.message) || err)))
      }

      const add = () => {
        const content = draft.trim()
        if (!content || busy) return
        setBusy(true)
        apiEntries('POST', { action: 'add', content, tags: [] })
          .then(() => {
            setDraft('')
            refresh()
          })
          .catch((err) => setError(String((err && err.message) || err)))
          .then(() => setBusy(false))
      }

      // ── config form helpers ──────────────────────────────────────────────
      const setCfgValue = (key, value) =>
        setCfg((prev) => Object.assign({}, prev, { [key]: value }))

      const isNonDefault = (key) => {
        const cur = cfg[key]
        const def = cfgDefaults[key]
        if (cur === undefined || def === undefined) return false
        return String(cur) !== String(def)
      }

      const saveConfig = () => {
        // Coerce values by declared field type so the host validation sees
        // numbers/booleans, not the input's raw strings.
        const payload = {}
        for (const f of cfgFields) {
          const v = cfg[f.key]
          if (f.type === 'number') {
            const n = Number(v)
            payload[f.key] = Number.isFinite(n) ? n : v
          } else if (f.type === 'toggle') {
            payload[f.key] = !!v
          } else {
            payload[f.key] = String(v == null ? '' : v)
          }
        }
        setCfgSaving(true)
        setStatus('')
        api('/dsh-memory_rollout/config', 'POST', payload)
          .then((res) => {
            const c = (res && res.config) || cfg
            setCfg(c)
            setCfgDefaults((res && res.defaults) || cfgDefaults)
            setStatus('配置已保存')
          })
          .catch((err) => setStatus('保存失败：' + String((err && err.message) || err)))
          .then(() => setCfgSaving(false))
      }

      // ── import ────────────────────────────────────────────────────────────
      const onImportFile = (e) => {
        const file = e.target.files && e.target.files[0]
        e.target.value = '' // allow re-selecting the same file to re-trigger
        if (!file) return
        setStatus('导入中…')
        const reader = new FileReader()
        reader.onload = () => {
          api('/dsh-memory_rollout/import', 'POST', String(reader.result || ''))
            .then((res) => {
              setStatus(
                '导入完成：' +
                  (res.fileCount || 0) +
                  ' 个文件，' +
                  (res.entryCount || 0) +
                  ' 条记忆' +
                  (res.backup ? '（原记忆已备份为 ' + res.backup + '）' : ''),
              )
              refresh()
              loadConfig()
            })
            .catch((err) => setStatus('导入失败：' + String((err && err.message) || err)))
        }
        reader.onerror = () => setStatus('读取文件失败')
        reader.readAsText(file)
      }

      // ── render helpers ───────────────────────────────────────────────────
      const renderConfigField = (f) => {
        const value = cfg[f.key]
        let control
        if (f.type === 'select') {
          control = React.createElement(
            'select',
            {
              value: value == null ? '' : String(value),
              onChange: (ev) => setCfgValue(f.key, ev.target.value),
            },
            (Array.isArray(f.options) ? f.options : []).map((o) =>
              React.createElement('option', { key: o, value: o }, o === '' ? '（模型默认）' : o),
            ),
          )
        } else if (f.type === 'toggle') {
          control = React.createElement('input', {
            type: 'checkbox',
            checked: !!value,
            onChange: (ev) => setCfgValue(f.key, ev.target.checked),
          })
        } else if (f.type === 'number') {
          control = React.createElement('input', {
            type: 'number',
            value: value == null ? '' : String(value),
            onChange: (ev) => setCfgValue(f.key, ev.target.value),
            style: { width: '80px' },
          })
        } else {
          control = React.createElement('input', {
            type: 'text',
            value: value == null ? '' : String(value),
            onChange: (ev) => setCfgValue(f.key, ev.target.value),
            style: { flex: 1 },
          })
        }
        return React.createElement(
          'div',
          {
            key: f.key,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              justifyContent: 'space-between',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
            React.createElement(
              'div',
              null,
              f.label + (isNonDefault(f.key) ? ' （≠ 默认）' : ''),
              f.hint
                ? React.createElement(
                    'span',
                    {
                      title: f.hint,
                      style: {
                        display: 'inline-block',
                        marginLeft: '5px',
                        width: '14px',
                        height: '14px',
                        lineHeight: '14px',
                        textAlign: 'center',
                        borderRadius: '50%',
                        border: '1px solid rgba(128,128,128,0.5)',
                        color: 'rgba(128,128,128,0.9)',
                        fontSize: '10px',
                        cursor: 'help',
                        verticalAlign: 'middle',
                      },
                    },
                    '?',
                  )
                : null,
            ),
            f.hint
              ? React.createElement('div', { style: { fontSize: '11px', opacity: 0.65 } }, '(悬浮 ? 查看解释)')
              : null,
          ),
          control,
        )
      }

      const rows = entries.map((e) =>
        React.createElement(
          'div',
          {
            key: e.id,
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: '10px',
              padding: '10px 12px',
              border: '1px solid rgba(128,128,128,0.35)',
              borderRadius: '8px',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 } },
            React.createElement('div', null, e.content),
            React.createElement(
              'div',
              { style: { fontSize: '12px', opacity: 0.7 } },
              (Array.isArray(e.tags) && e.tags.length ? '#' + e.tags.join(' #') + ' · ' : '') +
                String(e.createdAt || '').slice(0, 16),
            ),
          ),
          React.createElement('button', { onClick: () => remove(e.id), style: { flexShrink: 0 } }, '删除'),
        ),
      )

      return React.createElement(
        'div',
        { style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' } },
        React.createElement('div', { style: { fontWeight: 600 } }, '记忆库（dsh-memory_rollout 跨会话记忆）'),

        // ── Settings: config form + import/export ────────────────────────────
        React.createElement(
          'div',
          {
            style: {
              border: '1px solid rgba(128,128,128,0.35)',
              borderRadius: '8px',
              padding: '12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            },
          },
          React.createElement('div', { style: { fontWeight: 600 } }, '设置'),
          memRoot
            ? React.createElement('div', { style: { fontSize: '12px', opacity: 0.7 } }, '记忆根目录：' + memRoot)
            : null,
          loadingCfg
            ? React.createElement('div', { style: { opacity: 0.6 } }, '加载配置…')
            : React.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                cfgFields.map(renderConfigField),
                React.createElement(
                  'button',
                  { onClick: saveConfig, disabled: cfgSaving, style: { alignSelf: 'flex-start' } },
                  cfgSaving ? '保存中…' : '保存配置',
                ),
              ),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            React.createElement(
              'a',
              { href: '/dsh-memory_rollout/export', download: true, style: { flexShrink: 0 } },
              '导出记忆',
            ),
            React.createElement(
              'label',
              { style: { flexShrink: 0, cursor: 'pointer' } },
              React.createElement('input', {
                type: 'file',
                accept: '.json,application/json',
                style: { display: 'none' },
                onChange: onImportFile,
              }),
              '导入记忆',
            ),
            status ? React.createElement('span', { style: { fontSize: '12px', color: '#98c379' } }, status) : null,
          ),
        ),

        // ── quick-add ───────────────────────────────────────────────────────
        React.createElement(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          React.createElement('input', {
            value: draft,
            onChange: (ev) => setDraft(ev.target.value),
            placeholder: '快速记一条…',
            style: { flex: 1 },
          }),
          React.createElement('button', { onClick: add, disabled: busy }, '添加'),
        ),
        error ? React.createElement('div', { style: { color: '#e06c75' } }, error) : null,
        entries.length === 0
          ? React.createElement('div', { style: { opacity: 0.6 } }, '暂无记忆。让 Agent 用 memory_remember 记录、memory_recall 回忆。')
          : rows,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'dsh-memory_rollout', order: 30, label: () => '记忆库' },
          () => React.createElement(MemoryPage, null),
        ),
      )
    }

    exports.name = name
    exports.apply = apply
    return module.exports
  },
})
