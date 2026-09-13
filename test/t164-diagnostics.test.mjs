// t164（R1 §6.2 + 表述边界）：`droppedDurableConclusions` 降为**可选诊断**（默认关、不阻断、不持久化），
// 且提示词里"丢结论会导致批次被拒绝"的**错误表述已修正**；S0-2 只声明「输入完整性」。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, seedOutput } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

let failed = 0
const check = (c, m) => { if (c) console.log('  ✓ ', m); else { failed++; console.error('  ✗ ', m) } }

function makeEnv(config) {
  const HOME = path.join(os.tmpdir(), 't164-diag-' + Math.random().toString(36).slice(2, 8))
  const memDir = path.join(HOME, 'memories')
  fs.mkdirSync(memDir, { recursive: true })
  process.env.DSH_HOME = HOME
  let lastPrompt = ''
  const { ctx, domain } = makeCtx({
    get: (k) => (k === 'llm'
      ? {
          stream: (opts) => {
            lastPrompt = opts && opts.messages && opts.messages[0] && opts.messages[0].content && opts.messages[0].content[0] ? opts.messages[0].content[0].text || '' : ''
            // 罐头输出：**故意**不回显旧结论 ⇒ 旧文本行在新文件里无落点（诊断的触发条件）
            const payload = JSON.stringify({ memory_summary: 'v1\n## 索引\n- 只留一条新结论 T164D → memories/x.md', registry: '# MEMORY.md\n- 只留一条新结论 T164D' })
            return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: payload }; yield { type: 'finish', reason: { kind: 'stop' } } } }
          },
        }
      : k === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined),
  })
  return { HOME, memDir, ctx, domain, prompt: () => lastPrompt }
}

const seedCurrent = (memDir) => {
  fs.writeFileSync(path.join(memDir, 'memory_summary.md'), 'v1\n## 索引\n- 一条久远的持久结论：DSH 的会话日志按天分片，恢复时要按帧校验完整性，少了帧就说明尾部被截断。\n', 'utf8')
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# MEMORY.md\n- 另一条持久结论：插件的权威记忆写在 current.json 指向的版本目录里，根目录只是稳定入口镜像。\n', 'utf8')
}

const captureWarn = async (fn) => {
  const warns = []
  const old = console.warn
  console.warn = (...a) => { warns.push(a.map(String).join(' ')) }
  try { return { val: await fn(), warns } } finally { console.warn = old }
}

// ─────────── A) 默认关 ───────────
console.log('\n[t164 可选诊断] A) 默认（phase2Diagnostics = false）')
{
  const env = makeEnv()
  await seedOutput(env.domain, 't164d-a1', { rollout_summary: 'T164D 输入 A', selected_for_phase2: false })
  await apply(env.ctx, {})
  seedCurrent(env.memDir)
  const { val: res, warns } = await captureWarn(() => env.ctx.tools['memory__phase2_integrate'].execute({}))
  console.log('  res.diagnostics =', JSON.stringify(res && res.diagnostics))
  check(res && res.ok === true, '整合成功（诊断不影响主流程）')
  // t193 契约改向（有依据，不是放宽）：关掉诊断时，返回体**不再带 `diagnostics` 键**（原为 `null`）。
  //   理由：本工具声明了严格 output schema（`additionalProperties: false`），而宿主 schema 方言
  //   **不支持 null 型对象属性**（校验器按 `node.type` 单值字符串分派）⇒ 保留 `null` 会让**默认配置**下
  //   的返回体被输出校验层判非法（= 真机 `memory__phase2_integrate` 报错的那一类）。语义不变：键缺席 ≡ 诊断关闭。
  check(res && !('diagnostics' in res), `关掉时返回体不带 diagnostics 键（实测 present=${res ? 'diagnostics' in res : 'n/a'}）`)
  check(!res || !('droppedConclusions' in res), '旧的 droppedConclusions 字段已移除（改名 + 降级）')
  check(!warns.some((w) => w.includes('diagnostic')), `关掉时**零诊断告警**（实测 ${warns.length} 条 stderr 告警）`)
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

// ─────────── B) 打开 ───────────
console.log('\n[t164 可选诊断] B) 显式打开（phase2Diagnostics = true）')
{
  const env = makeEnv()
  await seedOutput(env.domain, 't164d-b1', { rollout_summary: 'T164D 输入 B', selected_for_phase2: false })
  await apply(env.ctx, { phase2Diagnostics: true })
  seedCurrent(env.memDir)
  const { val: res, warns } = await captureWarn(() => env.ctx.tools['memory__phase2_integrate'].execute({}))
  const d = res && res.diagnostics
  console.log('  res.diagnostics =', JSON.stringify(d))
  check(res && res.ok === true, '整合仍然成功（诊断**不阻断发布**）')
  check(!!d && typeof d === 'object', '打开时有 diagnostics 对象')
  check(d && d.advisory === true, 'advisory=true（可选提示，不是判据）')
  check(d && d.persisted === false, 'persisted=false（**未写进作业记录**，如实声明）')
  check(d && d.suspectedCount > 0, `启发式发现可疑丢行（实测 suspectedCount=${d && d.suspectedCount}）`)
  check(!!d && !!d.note && /cannot tell|advisory/i.test(d.note), 'note 里写明能力边界（区分不了合并/改写/退出/真丢失）')
  check(warns.some((w) => w.includes('[diagnostic]')), `打开时有诊断告警且标明 advisory（实测 ${warns.length} 条）`)
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

// ─────────── C) 提示词表述纠偏 + S0-2 边界 ───────────
console.log('\n[t164 表述] C) 提示词：不再宣称"丢结论会拒绝批次"，只声明输入完整性')
{
  const env = makeEnv()
  await seedOutput(env.domain, 't164d-c1', { rollout_summary: 'T164D 输入 C', selected_for_phase2: false })
  await apply(env.ctx, {})
  seedCurrent(env.memDir)
  await env.ctx.tools['memory__phase2_integrate'].execute({})
  const p = env.prompt()
  check(p.length > 0, '拿到了提示词')
  check(!p.includes('the batch is REJECTED'), '**已删除**"a dropped durable conclusion … the batch is REJECTED"这句错误表述')
  check(p.includes('YOUR RESPONSIBILITY'), '标题改为把"不合并丢结论"的责任落到模型侧（YOUR RESPONSIBILITY）')
  check(/input completeness is guaranteed by the caller/.test(p), '只声明「输入完整性由调用方保证」（程序侧把尾部交给了模型）')
  check(/cannot judge whether your merge lost meaning|cannot tell a legitimate merge/.test(p), '明写程序**无法判断语义是否有损**（不冒充"真实模型不会遗漏"）')
  check(!/will not (be )?miss|loses nothing|no loss/.test(p), '提示词里没有任何"不会遗漏"的暗示')
  try { fs.rmSync(env.HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL T164 DIAGNOSTICS-BOUNDARY TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
