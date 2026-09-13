// t193：**工具返回体 vs 声明 output.schema** 的宿主等价校验（含 `additionalProperties: false`）。
//
// 为什么要有这个测试（这一类的教训）：
//   真机调用 `memory__phase2_integrate` 时宿主报
//     `tool "memory__phase2_integrate" returned invalid output: "value.wake" is not a declared property (additionalProperties: false)`
//   —— 即**返回体多了一个未声明字段**。而此前所有单测都是**直接调 handler 后断言字段值**，
//   **从不经过宿主的输出校验层** ⇒ 这类缺陷整体漏网。本文件把"宿主那一步"补上：
//   对**每个** `memory__*` 工具，用它的**声明 schema 严格校验它的真实返回体**。
//
// 校验器覆盖本插件实际用到的方言子集（与宿主同语义）：
//   type(object/array/string/integer/number/boolean/null)、
//   properties、**属性级 `required: true`**（本方言写在属性里，不是顶层 required 数组）、
//   `additionalProperties: false`（未声明键 ⇒ 报错，文案与宿主一致）、items、enum、以及嵌套递归。
// 靶目录一律 `os.tmpdir()`；测试后清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput, seedJob, setMeta } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-t193-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}

// ── 宿主等价的 schema 校验（只覆盖本插件用到的子集） ─────────────────────────
function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (Number.isInteger(v)) return 'integer'
  return typeof v
}
function validateValue(schema, value, where, errors) {
  if (!schema || typeof schema !== 'object') return
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${where} is not one of the declared enum values`)
    return
  }
  if (schema.type) {
    const actual = typeOf(value)
    const wanted = schema.type === 'number' ? ['number', 'integer'] : [schema.type]
    if (!wanted.includes(actual)) {
      errors.push(`${where} must be ${schema.type} (got ${actual})`)
      return
    }
  }
  if (schema.type === 'object' || schema.properties) {
    const props = schema.properties || {}
    for (const [key, prop] of Object.entries(props)) {
      if (prop && prop.required === true && (value === undefined || value === null || typeof value !== 'object' || !(key in value))) {
        errors.push(`${where}.${key} is required but missing`)
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          if (schema.additionalProperties === false) {
            // 与宿主逐字同款文案（真机报错原文见文件头）
            errors.push(`${where}.${key} is not a declared property (additionalProperties: false)`)
          }
          continue
        }
        validateValue(props[key], value[key], `${where}.${key}`, errors)
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateValue(schema.items, item, `${where}[${i}]`, errors))
  }
}
const validateReturn = (schema, value) => {
  const errors = []
  validateValue(schema, value, 'value', errors)
  return errors
}

// ── 场景 ────────────────────────────────────────────────────────────────────
const past = new Date(Date.now() - 120000).toISOString()
const newCtx = () => {
  const tools = {}
  const { ctx, domain } = makeCtx({
    get: (k) =>
      k === 'llm'
        ? {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'text-delta', text: JSON.stringify({ memory_summary: 'v1\n## t193', registry: '# MEMORY.md\nt193' }) }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }),
        }
        : k === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : k === 'sessionQuery'
            ? { readSession: async (id) => ({ session: { version: 0, id, cwd: 'C:/' + id, createdAt: 0 }, events: [] }) }
            : undefined,
    tools: { register: (t) => { tools[t.name] = t } },
  })
  const home = path.join(tmp, 'h-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  return { ctx, domain, tools }
}

try {
  const { ctx, domain, tools } = newCtx()
  await apply(ctx, {})

  // 起点：先把每个工具都"跑一遍"，覆盖有代表性的返回体。
  // ① phase2 的**早退路径**（真机命中过的那条）：无待办 ⇒ `{ran:false, reason:'no-change', wake}`。
  await tools['memory__phase2_integrate'].execute({})
  // ② 恢复路径（published 批补提交 ⇒ `{ran:true, ok:true, …, wake}`）。
  await seedOutput(domain, 'o-t193', { source_watermark: 'wm-t193', session_id: 's-t193', rollout_summary: 't193', phase2_batch_id: 'B-t193', selected_for_phase2: false, generated_at: past })
  await domain.table('phase2_jobs').put('B-t193', {
    id: 'B-t193', status: 'published', input_ids: ['o-t193'], change_ids: [], lease_owner: '', lease_expires_at: past,
    attempt_count: 1, max_attempts: 3, available_at: past, staging_version: 'v-x', last_error: '',
    created_at: past, updated_at: past,
  })
  await tools['memory__phase2_integrate'].execute({})
  // ③ stage-1 drain（无待办也是合法返回）。
  await tools['memory__stage1_drain'].execute({})
  // ④ 归档/恢复（dry-run，最安全的路径）。
  await tools['memory__archive_vault'].execute({ dryRun: true })
  await tools['memory__restore_vault'].execute({ dryRun: true })
  // ⑤ 长期记忆四件套。
  await tools['memory_remember'].execute({ content: 't193 probe fact' })
  await tools['memory_recall'].execute({ query: 't193 probe' })
  await tools['memory_note'].execute({ content: 't193 probe note', slug: 't193-probe-note' })
  await tools['memory_integrate'].execute({})
  await tools['memory_precompact'].execute({ content: 't193 probe checkpoint', title: 't193' })

  // ── 穷举：每个 memory* 工具都必须声明严格 schema，且真实返回体必须过它 ──
  const names = Object.keys(tools).filter((n) => n.startsWith('memory')).sort()
  check(names.length >= 10, `捕获到 memory* 工具（实测 ${names.length} 个：${names.join(', ')}）`)

  /** 每个工具的返回体样本：同一个工具可给多个样本（覆盖不同分支）。 */
  const samples = {
    memory__stage1_drain: [{}, {}],
    memory__archive_vault: [{ dryRun: true }],
    memory__restore_vault: [{ dryRun: true }],
    memory_remember: [{ content: 't193 probe fact' }],
    memory_recall: [{ query: 't193 probe' }],
    memory_forget: [{ id: 'nonexistent-id-t193' }],
    memory_note: [{ content: 't193 probe note', slug: 't193-probe-note' }],
    memory_integrate: [{}],
    memory_precompact: [{ content: 't193 probe checkpoint', title: 't193' }],
  }

  for (const name of names) {
    const tool = tools[name]
    const schema = tool.output && tool.output.schema
    check(!!schema, `${name}：声明了 output.schema`)
    check(!!(schema && schema.additionalProperties === false), `${name}：schema 是严格对象（additionalProperties: false）`)
    if (!schema) continue
    const outs = []
    if (name === 'memory__phase2_integrate') {
      // 三条路径的真实返回体：① 早退（no-change/busy 之一）② 恢复（published 批补提交）③ 处理失败/成功
      outs.push(await tools[name].execute({}))
      for (const [tag, status] of [['b', 'published'], ['c', 'failed_terminal']]) {
        await seedOutput(domain, `o-t193-${tag}`, { source_watermark: `wm-t193-${tag}`, session_id: `s-t193-${tag}`, rollout_summary: 't193', phase2_batch_id: `B-t193-${tag}`, selected_for_phase2: false, generated_at: past })
        await domain.table('phase2_jobs').put(`B-t193-${tag}`, {
          id: `B-t193-${tag}`, status, input_ids: [`o-t193-${tag}`], change_ids: [], lease_owner: '', lease_expires_at: past,
          attempt_count: 1, max_attempts: 3, available_at: past, staging_version: 'v-x', last_error: '',
          created_at: past, updated_at: past,
        })
        outs.push(await tools[name].execute({}))
      }
    } else {
      for (const args of samples[name] || [{}]) {
        try {
          outs.push(await tools[name].execute(args))
        } catch (err) {
          outs.push({ __threw: String((err && err.message) || err) })
        }
      }
    }
    outs.forEach((value, i) => {
      const errors = validateReturn(schema, value)
      check(errors.length === 0, `${name}[样本${i + 1}] 返回体通过声明 schema${errors.length ? ' —— 违约：' + errors.join(' | ') : `（keys=${Object.keys(value).join(',') || '空'}）`}`)
    })
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T193 TOOL-OUTPUT-SCHEMA TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
