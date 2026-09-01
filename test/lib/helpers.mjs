// dsh-memory-rollout 测试共享 helper：构造多表 fake storageDomain（dsh_rollout 域），
// 供迁移后的阶段 A/阶段 B 测试「读表」断言，替代旧 `.stage1-state.json` 文件读。
//
// fake `domain.table(name)` 返回 per-name 的 Map 后端，支持 storage-domain 的
// put/get/update/delete/keys/entries/size（update 是唯一真原子读改写：fn 见当前值，
// 只作用于该记录；key 不存在则 reject）。`entries()` 返回 Map 迭代器。
//
// GPT P0-7 强化：
//   - update 把「冻结的深拷贝」传给 fn，并断言 fn 返回新对象而非原地改传入对象
//     （原地改会抛 TypeError，抓住「后端写失败但内存已被提前改」的隐患）。
//   - 支持故障注入：设 `domain._fault = (ctx) => boolean`，任一 put/update 写前若返回
//     true 则 reject，可模拟「第 N 次写失败/进程退出」的跨 key 半提交。
//
// 用法：
//   const { ctx, domain } = makeCtx({ get: ..., on: (ev,cb)=>{...; return ()=>{} } })
//   await apply(ctx, {...})
//   const jobs = jobListOf(domain)          // { key: jobRecord }
//   const meta = metaOf(domain)             // { runDay, modelAttemptsToday, ... }
//   await seedJob(domain, 's1', 'wm1', {...}) // 直接往 stage1_jobs 表塞一条作业

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const k of Object.keys(o)) deepFreeze(o[k])
    Object.freeze(o)
  }
  return o
}
const clone = (o) => {
  if (o == null || typeof o !== 'object') return o
  if (Array.isArray(o)) return o.map(clone)
  const out = {}
  for (const k of Object.keys(o)) out[k] = clone(o[k])
  return out
}

export function createFakeDomain() {
  const byName = new Map()
  function table(name) {
    if (!byName.has(name)) {
      const m = new Map()
      byName.set(name, {
        map: m,
        put: (k, v) => {
          if (domain._fault && domain._fault({ table: name, op: 'put', key: k })) return Promise.reject(new Error(`fault-injected put:${name}:${k}`))
          m.set(k, v)
          return Promise.resolve()
        },
        get: (k) => m.get(k),
        delete: (k) => {
          const had = m.delete(k)
          return Promise.resolve(had)
        },
        keys: () => m.keys(),
        entries: () => m.entries(),
        update: (k, fn) => {
          if (!m.has(k)) return Promise.reject(new Error(`missing-key: ${k}`))
          if (domain._fault && domain._fault({ table: name, op: 'update', key: k })) return Promise.reject(new Error(`fault-injected update:${name}:${k}`))
          // GPT P0-7：传入冻结深拷贝，原地改会抛 TypeError；fn 必须返回新对象。
          const next = fn(deepFreeze(clone(m.get(k))))
          m.set(k, next)
          return Promise.resolve(next)
        },
        get size() {
          return m.size
        },
      })
    }
    return byName.get(name)
  }
  const domain = { byName, table, _fault: null }
  return domain
}

/** 构造默认 ctx；可用 overrides 覆盖 get/tools/systemPrompt/effect/on。返回 { ctx, domain, tools }。 */
export function makeCtx(overrides = {}) {
  const domain = overrides.domain || createFakeDomain()
  const tools = {
    register(t) {
      if (t && t.name) this[t.name] = t
    },
  }
  const base = {
    storageDomain: { open: async () => domain },
    get: () => undefined,
    tools,
    systemPrompt: { section: () => {} },
    effect: (fn) => fn(),
    on: () => () => {},
  }
  const ctx = { ...base, ...overrides }
  return { ctx, domain, tools }
}

/** 读取 stage1_jobs 表 → { key: jobRecord }（key = <sid>::<wm>）。 */
export function jobListOf(domain) {
  const out = {}
  for (const [k, v] of domain.table('stage1_jobs').entries()) out[k] = v
  return out
}

/** 按 session_id 过滤出全部 job（数组）。 */
export function jobBySession(domain, sid) {
  return Object.values(jobListOf(domain)).filter((x) => x && String(x.session_id) === String(sid))
}

/** 读取 stage1_outputs 表 → { jobId: outputRecord }。 */
export function outputListOf(domain) {
  const out = {}
  for (const [k, v] of domain.table('stage1_outputs').entries()) out[k] = v
  return out
}

/** 读取 stage1_meta 表 meta 记录（跨日预算 / 水位）。 */
export function metaOf(domain) {
  return domain.table('stage1_meta').get('meta') || {}
}

/** 往 stage1_jobs 表塞一条作业（供测试预置）。字段可覆盖，默认 pending。返回 { key, job }。 */
export function seedJob(domain, sessionId, watermark, opts = {}) {
  const now = opts.createdAt ? new Date(opts.createdAt) : new Date()
  const key = `${String(sessionId)}::${String(watermark)}`
  const job = {
    id: opts.id || 'j-seed-' + Math.random().toString(36).slice(2, 8),
    session_id: String(sessionId),
    source_watermark: String(watermark),
    status: opts.status || 'pending',
    attempt_count: opts.attemptCount ?? 0,
    max_attempts: opts.maxAttempts ?? 3,
    available_at: opts.availableAt ?? now.toISOString(),
    lease_owner: opts.leaseOwner || '',
    lease_expires_at: opts.leaseExpiresAt || '',
    last_error: opts.lastError || '',
    last_error_code: opts.lastErrorCode || '',
    last_error_message: opts.lastErrorMessage || '',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    completed_at: opts.completedAt || '',
    ...(opts.extra || {}),
  }
  return domain.table('stage1_jobs').put(key, job).then(() => ({ key, job }))
}

/** 往 stage1_outputs 表塞一条产物（key=jobId）。返回写入的产物对象。 */
export function seedOutput(domain, jobId, output = {}) {
  const obj = {
    job_id: jobId,
    session_id: output.session_id || '',
    source_watermark: output.source_watermark || '',
    rollout_summary: output.rollout_summary || '',
    raw_memory_or_evidence_excerpt: output.raw_memory || output.raw_memory_or_evidence_excerpt || '',
    rollout_slug: output.rollout_slug || output.slug || '',
    keywords: output.keywords || '',
    content_hash: output.content_hash || '',
    generated_at: output.generated_at || new Date().toISOString(),
    effective_provider: output.effective_provider || output.provider || '',
    effective_model: output.effective_model || output.model || '',
    selected_for_phase2: output.selected_for_phase2 ?? false,
    ...output,
  }
  return domain.table('stage1_outputs').put(jobId, obj).then(() => obj)
}

/** 写入 stage1_meta 表 meta 记录（跨日预算 / 水位 / 错误）。 */
export function setMeta(domain, meta) {
  return domain.table('stage1_meta').put('meta', meta).then(() => meta)
}
