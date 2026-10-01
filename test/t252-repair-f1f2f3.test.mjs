// t252（返修批 2026-10-01 · 外部独立评估 §三/§六 的**发布门槛**）：F1 消费身份 / F2 内容计时 /
//   F3 回补公平 / 顺手收口（恒零字段、no-time-signal 计数、done 文案、撤删除的运行时断言）/ D-07 交错写。
//
// 牙齿口径（改前树 = `lib/index.js.pre-f1f2f3-2026-10-01`，SHA `C89A0ACE…`）：
//   · A（F1）：改前树**不比对**消费水位 ⇒ 反例里刚更新的正文会进入提炼请求 ⇒ A1/A2 必红。
//   · B（F2）：改前树按物理 mtime 判静置 ⇒ "长度变"与"不重算正文"这两个读数都不成立 ⇒ 必红。
//   · C（F3）：改前树没有公平规则 ⇒ 第 3 趟仍 `tooOldQueued=0` ⇒ 必红。
//   · D：改前树含两个恒零字段、无 noTimeSignal、文案仍是"已处理" ⇒ 必红。
//   · E：改前树无串行 meta 写 ⇒ 交错后可能丢一个写者的字段（定性；本树须全在）。
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeCtx, jobListOf, outputListOf, seedContentClock } from './lib/helpers.mjs'
import { contentWatermark } from '../lib/index.js'

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(PLUGIN)

const HOME = path.join(os.tmpdir(), 'dsh-memory_rollout-t252-' + Math.random().toString(36).slice(2, 8))
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log('  ✓ ', msg)
  else { failed++; console.error('  ✗ ', msg) }
}
const section = async (label, fn) => {
  try { return await fn() } catch (err) {
    check(false, `${label} 中断：${err && err.message ? err.message : err}`)
  }
}

const NOW = Date.now()
const HOUR = 3600000
const S_A = 'aaaa0000-0000-4000-8000-00000000000a'
const S_B = 'bbbb0000-0000-4000-8000-00000000000b'
const S_OLD = 'cccc0000-0000-4000-8000-00000000000c'
const BODY_V1 = 'V1 正文：' + '旧'.repeat(50)
const BODY_V2 = 'V2 新内容（刚更新）：' + '新'.repeat(50)

const snap = (id, idleHours, sizeBytes = 128) => ({
  header: { version: 4, isSeeded: false, id, cwd: 'C:/t252', createdAt: 0 },
  revision: '1:2:3:' + Math.round((NOW - idleHours * HOUR) * 1e6) + ':4',
  sizeBytes,
})
const msgEvent = (id, text) => ({
  type: 'user/message', seq: 0, time: 0, surfaceOp: 'append',
  data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const EXTRACTION = { rollout_summary: 's', raw_memory: 'r', slug: 's', keywords: '', title: 't' }
const CONSOLIDATION = { memory_summary: 'v1\n## c', registry: '# MEMORY.md\nok' }

/** 假宿主：可动态改正文与快照；分别统计"提炼"与"整合"的假模型调用次数。 */
const boot = async (initial, opts = {}) => {
  let calls = 0
  let current = initial
  // 观测口径（复核 §六 B）：除模型调用外，**直接计数假 `readSession` 调用**（= 实际读源次数），
  //   不再用 `contentBodyReads` 代指全管线读正文次数（它只是"内容时钟辅助函数"的部分读取）。
  const counter = { extraction: 0, consolidation: 0, readCalls: 0 }
  const state = { body: opts.body || BODY_V1 }
  const persistence = {
    list: async () => { calls += 1; return calls === 1 ? [] : current },
    locate: () => ({ path: 'Z:\\t252-not-exist\\log.jsonl' }),
  }
  const handlers = {}
  const readSession = async (id) => {
    counter.readCalls += 1
    return {
      session: { version: 4, isSeeded: false, id, cwd: 'C:/t252', createdAt: 0 },
      events: [msgEvent(id, state.body)],
    }
  }
  const llm = {
    stream: (o) => {
      const isExtraction = !!(o && String(o.system).includes('memory-extraction'))
      if (isExtraction) counter.extraction += 1
      else counter.consolidation += 1
      const payload = isExtraction ? EXTRACTION : CONSOLIDATION
      return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: JSON.stringify(payload) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
    },
  }
  const { ctx, domain, tools } = makeCtx({
    on: (ev, cb) => { handlers[ev] = cb; return () => {} },
    get: (k) => (k === 'sessionQuery' ? { readSession }
      : k === 'sessionPersistence' ? persistence
        : k === 'llm' ? llm
          : k === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined),
    tools: { register: (t) => { tools[t.name] = t } },
  })
  await apply(ctx, { minRolloutIdleHours: 6, maxRolloutAgeDays: 10, ...(opts.cfg || {}) })
  return {
    ctx, domain, tools, handlers, counter, state,
    setSnapshots: (s) => { current = s },
    metaOf: () => domain.table('stage1_meta').get('meta') || {},
  }
}
const jobsFor = (domain, id) => Object.keys(jobListOf(domain) || {}).filter((k) => k.startsWith(id + '::'))
const outsFor = (domain, id) => Object.values(outputListOf(domain) || {}).filter((o) => o && o.session_id === id)

// ── A. F1：消费时内容身份复核（评估 §三 F1 的反例）───────────────────────────────
await section('[t252-A] F1：入队后正文被改 ⇒ 自动作业作废、不提炼；显式作业引用实消版本', async () => {
  const h = await boot([snap(S_A, 12)], { body: BODY_V1 })
  const r1 = await h.tools['memory__ingest_scan'].execute({})
  check(r1.enqueued === 1, `A0 静置 12h ⇒ 入队 1 条（enqueued=${r1.enqueued}）`)
  const keys1 = jobsFor(h.domain, S_A)
  // 正文水位由 pipeline（`messagesToDraftBody` + `contentWatermark`）算出 ⇒ 夹具不自造算式，
  //   直接**抓实际键**（`<sid>::<16 位十六进制>`）。
  const wm1 = keys1.length === 1 ? String(keys1[0].split('::')[1] || '') : ''
  check(keys1.length === 1 && /^[0-9a-f]{16}$/.test(wm1),
    `A0 入队键 = <sid>::<当时正文水位>（${keys1[0]}）`)

  // 反例第 2 步：正文换成"刚更新的新内容"（物理长度也变）
  h.state.body = BODY_V2
  h.setSnapshots([snap(S_A, 0, 256)])
  const d1 = await h.tools['memory__stage1_drain'].execute({})
  const job1 = (jobListOf(h.domain) || {})[keys1[0]] || {}
  check(h.counter.extraction === 0,
    `A1 ★ 刚更新的正文**没有进入**自动提炼请求（提炼调用=${h.counter.extraction}；改前树为 1 ⇒ 必红）`)
  check(job1.status === 'succeeded_no_output' && job1.last_skip_reason === 'superseded-by-newer-content',
    `A1 作业**作废**、终态无产物（status=${job1.status} last_skip_reason=${job1.last_skip_reason}）`)
  check(outsFor(h.domain, S_A).length === 0, `A1 没有产物（stage1_outputs 实测 ${outsFor(h.domain, S_A).length} 条）`)

  // 反例第 3 步：把"新内容"的计时起点播到 12h 前，并给**可靠基线**（非空 watermark + 当前 revision）
  //   ⇒ 新水位应被**重新入队**并正常提炼。（R1 起：只播时间、不给基线 ⇒ 线索一变即按新内容重置。）
  // ⚠️ revision 用 **idle 0**（= 一个**新的**物理时间）而不是 12h：`scanSeen` 的"活动水位"是**物理时间**，
  //   若与首趟相同会被去重守卫当成"同一活动已处理"而跳过；内容计时另由下面播种的 12h 记录给出
  //   —— 这正是"物理时间 ≠ 内容计时"的夹具表达。
  const snapA2 = snap(S_A, 0, 256)
  await seedContentClock(h.domain, S_A, new Date(NOW - 12 * HOUR).toISOString(), 256, 'wm-new', snapA2.revision)
  h.setSnapshots([snapA2])
  const r2 = await h.tools['memory__ingest_scan'].execute({})
  const keys2 = jobsFor(h.domain, S_A)
  const wm2 = keys2.map((k) => String(k.split('::')[1] || '')).filter((w) => w !== wm1)[0] || ''
  check(keys2.length === 2 && !!wm2,
    `A2 新版本按**新水位**重新入队（键数=${keys2.length}；新水位=${wm2} ≠ 旧水位=${wm1}）`)
  const d2 = await h.tools['memory__stage1_drain'].execute({})
  const outs = outsFor(h.domain, S_A)
  check(h.counter.extraction >= 1 && outs.length === 1,
    `A2 ★ 同内容重试仍能正常推进（提炼调用=${h.counter.extraction} 产物=${outs.length}）`)
  check(outs.length === 1 && outs[0].source_watermark === wm2,
    `A3 ★ 产物引用**实际消费的那一版**（source_watermark=${outs[0] && outs[0].source_watermark} = 新作业水位 ${wm2}；旧水位=${wm1}）`)

  // 显式入口（memory_ingest_session）：入队后正文再变 ⇒ **不作废**（即时），但产出必须引用实消版本
  const h2 = await boot([snap(S_B, 0, 128)], { body: BODY_V1 })
  const e = await h2.tools['memory_ingest_session'].execute({ sessionId: S_B })
  const wmClaim = String((jobsFor(h2.domain, S_B)[0] || '').split('::')[1] || '')
  h2.state.body = BODY_V2
  h2.setSnapshots([snap(S_B, 0, 256)])
  await h2.tools['memory__stage1_drain'].execute({})
  const o2 = outsFor(h2.domain, S_B)
  const seenKeys2 = [...h2.domain.table('stage1_seen').entries()].map(([k]) => String(k))
  check(o2.length === 1 && !!o2[0].source_watermark && o2[0].source_watermark !== wmClaim,
    `A4 ★ 显式作业保持即时、但产出**不引用旧水位**（产出水位=${o2[0] && o2[0].source_watermark} ≠ 入队水位=${wmClaim}）`)
  check(seenKeys2.some((k) => k.endsWith('::' + (o2[0] && o2[0].source_watermark))),
    `A4 seen-index 也按**实消版本**记账（${seenKeys2.filter((k) => k.includes('00000000000b')).join(',')}）`)
  check(!!e && e.queued !== false, `A4 显式入口确实入了队（queued=${e && e.queued}）`)
})

// ── B. F2：内容计时（不做全量重算；内容变才读正文并重置）────────────────────────
await section('[t252-B] F2：内容计时 —— 不每趟重算正文；长度变才读一次并重置', async () => {
  const h = await boot([snap(S_A, 12)], { body: BODY_V1 })
  const b1 = await h.tools['memory__ingest_scan'].execute({})
  check(b1.contentBodyReads === 0, `B1 首次观测只**播种**、不读正文（contentBodyReads=${b1.contentBodyReads}）`)
  const b2 = await h.tools['memory__ingest_scan'].execute({})
  check(b2.contentBodyReads === 0, `B2 同尺寸再扫**不读正文**（contentBodyReads=${b2.contentBodyReads}）——不是每趟全量重算`)
  const rec = (h.metaOf().contentSeen || {})[S_A]
  check(!!rec && rec.firstSeenSource === 'seeded-from-file-mtime' && Number(rec.sizeBytes) === 128,
    `B2 计时记录标明**播种来源**（firstSeenSource=${rec && rec.firstSeenSource}）`)

  h.state.body = BODY_V2
  h.setSnapshots([snap(S_A, 12, 256)])
  const b3 = await h.tools['memory__ingest_scan'].execute({})
  check(b3.contentBodyReads === 1, `B3 物理长度变 ⇒ 只读**那一条**正文一次（contentBodyReads=${b3.contentBodyReads}）`)
  check(b3.fresh === 1 && b3.enqueued === 0,
    `B3 ★ 内容变了 ⇒ **重置**计时、判 fresh（fresh=${b3.fresh} enqueued=${b3.enqueued}）`)
})

// ── C. F3：回补公平（持续新流量下，旧候选在 K 趟内仍能入队；每趟不超预算）──────────
await section('[t252-C] F3：回补公平 —— 第 K 趟强制留 1 格给回补', async () => {
  const K = 3            // 必须与 lib/index.js 的 BACKFILL_FAIRNESS_K 一致
  const passes = []
  const h = await boot([], { cfg: { maxSourcesPerStartup: 2 } })
  for (let n = 1; n <= K; n++) {
    // 每趟都提供 2 条**新的**、已静置 12h 的候选（模拟"持续新流量"）+ 同一条 30 天的旧会话
    const freshA = 'dddd0000-0000-4000-8000-0000000000' + String(n) + '1'
    const freshB = 'dddd0000-0000-4000-8000-0000000000' + String(n) + '2'
    // ⚠️ `snap()` 第二参单位是**小时** ⇒ "30 天" = 30*24（第一版写成 30 会被当 30h、不进回补池）。
    h.setSnapshots([snap(S_OLD, 30 * 24), snap(freshA, 12), snap(freshB, 12)])
    const r = await h.tools['memory__ingest_scan'].execute({})
    passes.push(r)
  }
  check(passes.every((r) => r.enqueued <= 2), `C1 每趟总量 ≤ 预算（实测 ${passes.map((r) => r.enqueued).join('/')}）`)
  check(passes.slice(0, K - 1).every((r) => r.tooOldQueued === 0),
    `C2 前 K-1 趟仍优先窗内（tooOldQueued=${passes.slice(0, K - 1).map((r) => r.tooOldQueued).join('/')}）`)
  check(passes[K - 1].tooOldQueued === 1,
    `C3 ★ 第 K 趟强制留 1 格 ⇒ 旧候选入队（tooOldQueued=${passes[K - 1].tooOldQueued}；改前树恒为 0 ⇒ 必红）`)
  check(jobsFor(h.domain, S_OLD).length === 1, `C3 旧会话**确实**有了 1 条作业（实测 ${jobsFor(h.domain, S_OLD).length}）`)
  check(passes[K - 1].enqueued === 2, `C4 公平趟总量仍 ≤ 预算（enqueued=${passes[K - 1].enqueued}）`)
})

// ── D. 顺手收口（评估 §六）────────────────────────────────────────────────────
await section('[t252-D] 顺手收口：恒零字段 / no-time-signal 计数 / done 文案 / 撤删除的运行时断言', async () => {
  const h = await boot([snap(S_A, 12)], {})
  const r = await h.tools['memory__ingest_scan'].execute({})
  check(!('tooOldDeferred' in r) && !('notIdleDeferred' in r),
    `D1 恒零字段已删（实测 ${('tooOldDeferred' in r)}/${('notIdleDeferred' in r)}）`)
  check(r.noTimeSignal === 0 && typeof r.contentBodyReads === 'number',
    `D2 新可观测面存在（noTimeSignal=${r.noTimeSignal} contentBodyReads=${r.contentBodyReads}）`)

  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const gone = ['delete_sessions', 'ingest-and-delete', 'judgeDeleteToolResult', 'stagesOf', 'evidenceReasonText']
  check(gone.every((t) => !src.includes(t)),
    `D3 ★ 撤删除的**运行时**断言：实现里 5 个归零面全无命中（${gone.filter((t) => src.includes(t)).join(',') || '无'}）`)
  check(!/name:\s*'[^']*delete/i.test(src), 'D4 注册的工具名里没有 delete 类（运行时读的是**发布的那份实现**）')
  check(src.includes('done(完成水位挡下)'), 'D5 done 与"整理完成"文案已分开（源码含 done(完成水位挡下)）')
  check(!src.includes('stats.tooOldDeferred'), 'D6 恒零字段的自增点也已绝迹')

  // 假生态里也断言一次"没有删除工具进入调用面"
  const toolNames = Object.keys(h.tools)
  check(toolNames.every((t) => !/delete/i.test(t)), `D4 本机注册的工具名：${toolNames.filter((t) => /delete/i.test(t)).join(',') || '无 delete 类'}`)
})

// ── E. D-07：并发元数据写的**可控交错**定性（不变量：各写者效果都在）─────────────
await section('[t252-E] D-07：扫描写者与复查写者交错 ⇒ 谁的字段都不丢', async () => {
  const h = await boot([snap(S_A, 12)], {})
  const [scanRes] = await Promise.all([
    h.tools['memory__ingest_scan'].execute({}),
    h.handlers['session/disposed']({ id: S_B }),
  ])
  const m = h.metaOf()
  check(!!m.scanLastAt && !!m.scanSeen && !!m.contentSeen,
    `E1 扫描写者的字段都在（scanLastAt=${!!m.scanLastAt} scanSeen=${!!m.scanSeen} contentSeen=${!!m.contentSeen}）`)
  check(!!m.idleRecheck && String(m.idleRecheck.source || '').length > 0,
    `E2 复查写者的字段也在（idleRecheck.source=${m.idleRecheck && m.idleRecheck.source}）`)
  check(scanRes.enqueued === 1, `E3 交错不破坏扫描结论（enqueued=${scanRes.enqueued}）`)
})

// ── F. memory_precompact：草稿立即落，但**提炼走正常 6h 资格**；只有 force 才即时（评估 §五）──────
await section('[t252-F] memory_precompact：默认不立即入队；force=true 才即时', async () => {
  const S_P = 'eeee0000-0000-4000-8000-00000000000f'
  const execOf = (id) => ({ agent: { session: { id, header: { cwd: 'C:/t252', id } } } })
  // 默认（= 模型自行调用）：会话"刚更新"（静置 0.5h）⇒ 草稿立即落、**不入队**、只留复查请求
  const h = await boot([snap(S_P, 0.5)], { body: BODY_V1 })
  const r = await h.tools['memory_precompact'].execute({ content: '关键要点' }, execOf(S_P))
  check(typeof r.file === 'string' && r.file.length > 0, `F1 默认调用仍**立即落草稿**（file=${r.file}）`)
  check(jobsFor(h.domain, S_P).length === 0,
    `F1 ★ 默认调用**不立即入队**（作业数=${jobsFor(h.domain, S_P).length}；改前树为 1 ⇒ 必红）`)
  const m = h.metaOf()
  check(!!m.idleRecheck && String(m.idleRecheck.source || '').includes('precompact-not-qualified'),
    `F1 只留一条复查请求（source=${m.idleRecheck && m.idleRecheck.source}）`)
  // force=true（用户明确要求）：立即入队
  const h2 = await boot([snap(S_P, 0.5)], { body: BODY_V1 })
  const r2 = await h2.tools['memory_precompact'].execute({ content: '关键要点', force: true }, execOf(S_P))
  check(jobsFor(h2.domain, S_P).length === 1,
    `F2 ★ force=true ⇒ **立即入队**（作业数=${jobsFor(h2.domain, S_P).length}）`)
  check(!!r2.file, `F2 草稿同样落盘（file=${r2.file}）`)
  // 静置够（播种 12h）⇒ 默认调用也能入队（"不绕门"不等于"收不到"）
  const h3 = await boot([snap(S_P, 12)], { body: BODY_V1 })
  const snapP = snap(S_P, 12)
  await seedContentClock(h3.domain, S_P, new Date(NOW - 12 * HOUR).toISOString(), 128, 'wm-p', snapP.revision)
  h3.setSnapshots([snapP])
  await h3.tools['memory_precompact'].execute({ content: '关键要点' }, execOf(S_P))
  check(jobsFor(h3.domain, S_P).length === 1,
    `F3 静置够（播种 12h）⇒ 默认调用正常入队（作业数=${jobsFor(h3.domain, S_P).length}）`)
})

// ── G. 复核矩阵（复核 §六 B）：内容身份 / 旧任务 / 队尾公平 —— 观测口径 = 模型输入 + 读源次数 + 产出水位 ──
await section('[t252-G] 复核矩阵：同长度新正文/同正文元信息变/旧任务无 kind/队尾公平（含预算 1）', async () => {
  // G1：新正文 + **长度相同** + revision 变化 ⇒ 重置；6h 内不自动提炼
  const S1 = 'a1a1a1a1-0000-4000-8000-000000000001'
  const g1 = await boot([snap(S1, 12)], { body: BODY_V1 })
  const g1a = await g1.tools['memory__ingest_scan'].execute({})
  check(g1a.enqueued === 1, `G1 先按 12h 内容建立基线并入队（enqueued=${g1a.enqueued}）`)
  const rec1 = (g1.metaOf().contentSeen || {})[S1]
  check(!!rec1 && !!rec1.watermark, `G1 R2：首趟入队后**回填了内容基线**（watermark=${rec1 && rec1.watermark}）`)
  const reads1 = g1.counter.readCalls
  g1.state.body = BODY_V2
  g1.setSnapshots([snap(S1, 0, 128)])          // 长度不变（128）、revision 变
  const g1b = await g1.tools['memory__ingest_scan'].execute({})
  check(g1.counter.readCalls === reads1 + 1, `G1 线索变 ⇒ 只核对**那一条**正文（读源 +${g1.counter.readCalls - reads1}）`)
  check(g1b.fresh === 1 && g1b.enqueued === 0,
    `G1 ★ 同长度新正文 ⇒ **重置**、6h 内不入队（fresh=${g1b.fresh} enqueued=${g1b.enqueued}；改前树看长度相等会放行 ⇒ 必红）`)
  await g1.tools['memory__stage1_drain'].execute({})
  check(g1.counter.extraction === 0, `G1 ★ 刚更新的正文**没有进入模型输入**（提炼调用=${g1.counter.extraction}）`)

  // G2：同正文 + 长度变化（**有可靠基线**）⇒ 不重置、不重复提炼（核对路径必须读一次）
  const S2 = 'a2a2a2a2-0000-4000-8000-000000000002'
  const g2 = await boot([snap(S2, 12)], { body: BODY_V1 })
  await g2.tools['memory__ingest_scan'].execute({})
  const reads2 = g2.counter.readCalls
  const jobs2a = jobsFor(g2.domain, S2).length
  g2.setSnapshots([snap(S2, 12, 256)])         // 长度变、**正文不变**（记录里仍是旧 sizeBytes/revision）
  const g2b = await g2.tools['memory__ingest_scan'].execute({})
  check(g2.counter.readCalls === reads2 + 1, `G2 线索变 ⇒ 核对一次正文（读源 +${g2.counter.readCalls - reads2}）`)
  check(g2b.fresh === 0 && g2b.enqueued === 0 && jobsFor(g2.domain, S2).length === jobs2a,
    `G2 ★ 同正文 ⇒ **不重置**、不重复提炼（fresh=${g2b.fresh} enqueued=${g2b.enqueued} 作业=${jobsFor(g2.domain, S2).length}）`)

  // G3：入队后正文变更 ⇒ 已由 [t252-A] 覆盖（模型输入 0 次 + 产出水位 = 实消版本）
  check(true, 'G3 入队后正文变更：见 [t252-A]（A1 模型输入 0 次 / A3 产出水位 = 实消版本）')

  // G4：旧版**无 `kind`** 的未完成任务 ⇒ 不冒用旧资格；合法恢复仍能推进
  const S3 = 'a3a3a3a3-0000-4000-8000-000000000003'
  const g4 = await boot([snap(S3, 12)], { body: BODY_V1 })
  await g4.tools['memory__ingest_scan'].execute({})
  const k4 = jobsFor(g4.domain, S3)[0]
  const job4 = Object.assign({}, jobListOf(g4.domain)[k4])
  delete job4.source_watermark_kind                  // 模拟**升级前**记录（旧版本无该字段）
  await g4.domain.table('stage1_jobs').put(k4, job4)
  g4.state.body = BODY_V2
  g4.setSnapshots([snap(S3, 0, 256)])
  await g4.tools['memory__stage1_drain'].execute({})
  const after4 = Object.assign({}, jobListOf(g4.domain)[k4])
  check(g4.counter.extraction === 0 && after4.status === 'succeeded_no_output',
    `G4 ★ 旧版无 kind 的任务**同样不冒用旧资格**（提炼调用=${g4.counter.extraction} status=${after4.status}；改前树会提炼 ⇒ 必红）`)
  check(outsFor(g4.domain, S3).length === 0, `G4 无产物（${outsFor(g4.domain, S3).length}）`)
  const snap4 = snap(S3, 0, 256)   // 同上：物理时间给"新"的（避开 scanSeen 活动水位去重），内容计时由播种给出
  await seedContentClock(g4.domain, S3, new Date(NOW - 12 * HOUR).toISOString(), 256, 'wm-g4', snap4.revision)
  g4.setSnapshots([snap4])
  await g4.tools['memory__ingest_scan'].execute({})
  await g4.tools['memory__stage1_drain'].execute({})
  check(g4.counter.extraction >= 1 && outsFor(g4.domain, S3).length === 1,
    `G4 合法恢复仍能推进（提炼调用=${g4.counter.extraction} 产物=${outsFor(g4.domain, S3).length}）`)

  // G5：**队尾**旧来源 + 持续前缀新候选（预算 2；再验预算 1 的跨趟轮换）
  const SOLD = 'a5a5a5a5-0000-4000-8000-000000000055'
  const g5 = await boot([], { cfg: { maxSourcesPerStartup: 2 } })
  const rows5 = []
  for (let n = 1; n <= 3; n++) {
    const fa = 'a6a6a6a6-0000-4000-8000-0000000000' + n + '1'
    const fb = 'a6a6a6a6-0000-4000-8000-0000000000' + n + '2'
    g5.setSnapshots([snap(fa, 12), snap(fb, 12), snap(SOLD, 30 * 24)])   // 旧来源在**队尾**
    rows5.push(await g5.tools['memory__ingest_scan'].execute({}))
  }
  check(rows5.every((r) => r.enqueued <= 2), `G5 预算 2：每趟 ≤ 预算（${rows5.map((r) => r.enqueued).join('/')}）`)
  check(rows5[0].tooOldDiscovered >= 1,
    `G5 ★ 队尾旧来源**被看见**（pass1 tooOldDiscovered=${rows5[0].tooOldDiscovered}；改前树达上限即 break ⇒ 恒 0 ⇒ 必红）`)
  check(rows5[2].tooOldQueued === 1 && jobsFor(g5.domain, SOLD).length === 1,
    `G5 ★ 第 K 趟拿到名额（pass3 tooOldQueued=${rows5[2].tooOldQueued}、旧来源作业=${jobsFor(g5.domain, SOLD).length}）`)
  const g6 = await boot([], { cfg: { maxSourcesPerStartup: 1 } })
  const rows6 = []
  for (let n = 1; n <= 3; n++) {
    const fc = 'a7a7a7a7-0000-4000-8000-0000000000' + n + '1'
    g6.setSnapshots([snap(fc, 12), snap(SOLD, 30 * 24)])
    rows6.push(await g6.tools['memory__ingest_scan'].execute({}))
  }
  check(rows6.every((r) => r.enqueued <= 1), `G5 预算 1：每趟 ≤ 预算（${rows6.map((r) => r.enqueued).join('/')}）`)
  check(rows6.some((r) => r.tooOldQueued === 1) && jobsFor(g6.domain, SOLD).length === 1,
    `G5 ★ 预算 1 也**跨趟轮换**出唯一名额（tooOldQueued=${rows6.map((r) => r.tooOldQueued).join('/')}、旧来源作业=${jobsFor(g6.domain, SOLD).length}）`)
})

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch {}
console.log(`\n${failed === 0 ? 'ALL T252 F1F2F3 REPAIR TESTS PASSED' : failed + ' TESTS FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
