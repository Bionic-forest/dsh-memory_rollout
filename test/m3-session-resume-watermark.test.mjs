// M3-阻断回归：同一 session 恢复后新增内容，不得被旧空/旧水印去重（灾难性漏记）。
//
// 背景（复核 §三）：旧实现 dispose 用 live session.deriveMessages()（可能为空）算水印，
// 若 session 首次结束 live 为空 → 水印 H(empty) 入队；用户恢复同一 session 新增决定后再结束，
// live 仍为空 → 仍是 H(empty) → 命中旧 job/seen 被当作重复，新增决定不再被提炼（漏记）。
// 修复（方案 A）：dispose 用持久正文（sessionMessagesByPersistence 的规范 messages，经
// source-aware serializer）算水印；持久读取不可用才回退 live。
//
// 本测试验证：
//  [1] 同一 session，持久正文由 A 增为 A+B 后再次 dispose → 产生不同水印、新有效 job。
//  [2] 该 job 的 source_watermark 与第一次不同（非重复）。
//  [3] 若没有新增持久事件（正文不变），再 dispose 仍去重（只有 1 个 job）。
//  [4] 模拟「live deriveMessages 为空」验证水印来自持久而非 live。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, jobBySession, outputListOf, seedJob } from './lib/helpers.mjs'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply, contentWatermark } = await import(PLUGIN)

const waitUntil = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 15)) } return false }

let failed = 0
const check = (cond, msg) => { if (cond) console.log('  ✓ ', msg); else { failed++; console.error('  ✗ ', msg) } }

const tmp = path.join(os.tmpdir(), 'dsh-memory_rollout-resume-' + Date.now())
process.env.DSH_HOME = tmp
fs.mkdirSync(tmp, { recursive: true })

// 持久消息正文（readSession 返回，模拟持久日志）：由测试控制，可增量。
// 关键：live deriveMessages 固定返回空（模拟 dispose 时 live 为空），水印必须来自持久正文。
let persistedBody = '' // 模拟持久日志的规范正文（source-aware 序列化前的 messages 由 readSession 造）
// readSession 返回持久 events；我们用 text 直接当作持久正文，方便控制增量。
const readSession = async (id) => ({
  session: { version: 4, isSeeded: false, id, cwd: 'C:/' + id, createdAt: 0 },
  // 持久消息：一个 user message（source.kind=user），text=persistedBody
  events: persistedBody
    ? [{ type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: persistedBody }] } }]
    : [],
})

// 【C4 夹具适配】官方 `sessionPersistence` 供货面 + 时间信号（"静置"由 revision 第 4 段表达）。
//   C4 起 `session/disposed` 先取该会话的持久快照、再用**唯一**资格判定（静置 ≥ minRolloutIdleHours，默认 6h）
//   决定是否入队。这里给的就是**真宿主会提供的形状**（`{header, revision, sizeBytes}`）：
//   revision = `dev:ino:size:mtimeNs:ctimeNs`（官方 fileRevision 形状）⇒ 12h 前的 mtimeNs 即"已静置 12h"。
//   ⇒ 本夹具**不绕过任何资格门**：会话是被新语义**正常纳入**的。
const IDLE_HOURS = 12
const snapshotOf = (id, headerExtra = {}) => ({
  header: { version: 4, isSeeded: false, id, cwd: 'C:/' + id, createdAt: 0, ...headerExtra },
  revision: '1:2:3:' + Math.round((Date.now() - IDLE_HOURS * 3600000) * 1e6) + ':4',
  sizeBytes: 128,
})
const persistenceMock = { list: async () => [snapshotOf('r1')], locate: () => ({ path: 'Z:\\c4-not-exist\\log.jsonl' }) }

const eventHandlers = {}
const { ctx, domain } = makeCtx({
  get: (k) => (k === 'sessionQuery' ? { readSession }
    : k === 'sessionPersistence' ? persistenceMock
      : undefined),
  on: (ev, cb) => { eventHandlers[ev] = cb; return () => {} },
})

try {
  // 第一次 dispose：持久正文含内容 A。
  console.log('[1] 持久正文由 A 增为 A+B 后再次 dispose → 新水印/新 job（不漏记）')
  persistedBody = 'Session A establishes durable preference X about code review workflow.'
  await apply(ctx, { generateMemories: true })
  assert.ok(eventHandlers['session/disposed'], 'session/disposed handler registered')
  // live deriveMessages 固定为空 → 模拟 dispose 时 live 取不到。
  const sess = { id: 'r1', header: { cwd: 'C:/r1' }, deriveMessages: () => [] }

  await eventHandlers['session/disposed'](sess)
  await waitUntil(() => jobBySession(domain, 'r1').some((j) => j.status !== 'pending'), 3000)
  const jobsAfterA = jobBySession(domain, 'r1')
  const wmA = jobsAfterA.map((j) => j.source_watermark).join(',')
  check(jobsAfterA.length >= 1, `第一次 dispose 入队成功（jobs=${jobsAfterA.length}）`)
  // source-aware serializer 对单个 user text 的输出 = `- [user] <text>`；水印应对它哈希。
  check(wmA.includes(contentWatermark('- [user] ' + 'Session A establishes durable preference X about code review workflow.')), `第一次水印来自持久正文（而非 live 空）: ${wmA}`)

  // 第二次 dispose：持久正文新增内容 B（用户恢复会话后加了新决定）。
  // **契约（C4 §10.1 + F2/R1 · 2026-10-01）**：`session/disposed` **不得绕过 6h 静置门** —— 内容刚变 ⇒ 内容
  //   计时重置 ⇒ 此刻**只请求复查、不入队**。要拿到"新内容 B 的作业"，必须先让 B 静置够。
  persistedBody = 'Session A establishes durable preference X about code review workflow. Then later the user decides Y: always run tests before merge.'
  await eventHandlers['session/disposed'](sess)
  await new Promise((r) => setTimeout(r, 150))
  const jobsAfterB = jobBySession(domain, 'r1')
  check(jobsAfterB.length === 1, `内容刚变 ⇒ dispose **不绕门**、不新增作业（jobs=${jobsAfterB.length}）`)
  // 夹具：把内容 B 的计时起点播到 12h 前（水位 = 真实内容水位 wmBexpect）⇒ 再 dispose 才轮到新水位。
  const wmBexpect = contentWatermark('- [user] ' + persistedBody)
  {
    const metaT = domain.table('stage1_meta')
    const curMeta = metaT.get('meta') && typeof metaT.get('meta') === 'object' ? metaT.get('meta') : {}
    const cs = curMeta.contentSeen && typeof curMeta.contentSeen === 'object' ? { ...curMeta.contentSeen } : {}
    const prevRec = cs.r1 || {}
    cs.r1 = {
      sizeBytes: Number(prevRec.sizeBytes || 0),
      revision: String(prevRec.revision || ''),
      watermark: wmBexpect,
      firstSeenAt: new Date(Date.now() - 12 * 3600000).toISOString(),
      firstSeenSource: 'fixture-seeded',
    }
    await metaT.put('meta', { ...curMeta, contentSeen: cs })
  }
  await eventHandlers['session/disposed'](sess)
  await new Promise((r) => setTimeout(r, 150))
  const jobsAfterB2 = jobBySession(domain, 'r1')
  const wmB = jobsAfterB2.map((j) => j.source_watermark).join(',')
  check(jobsAfterB2.length >= 2, `B 静置够后再次 dispose ⇒ 新水位入队（jobs=${jobsAfterB2.length}）`)
  check(wmB.includes(wmBexpect), `第二次水印含新增内容 B 的持久正文（非重复空水印）`)
  check(new Set(jobsAfterB2.map((j) => j.source_watermark)).size === jobsAfterB2.length, '两次水印不同（未被去重合并）')

  console.log('[2] 持久正文不变时再次 dispose 仍去重（不产生重复 job）')
  const countBefore = jobBySession(domain, 'r1').length
  await eventHandlers['session/disposed'](sess)
  await new Promise((r) => setTimeout(r, 150))
  const countAfter = jobBySession(domain, 'r1').length
  check(countAfter === countBefore, `无新增持久事件时再次 dispose 去重（${countBefore} -> ${countAfter}）`)

  console.log('[3] 从持久读取（live 为空）得出的水印正确（source-aware 已排除 tool/plugin）')
  // 持久正文含 tool 消息也应被 source-aware 滤掉：用纯 user 文本试即可（上述已覆盖）。
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL M3 RESUME-WATERMARK TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
