// dsh-rollout — Codex-adapted cross-session memory vault for DeepSeek Harness (Host half).
//
// Registry-ready cordis plugin: exports { name, apply, inject, Config } per the
// @deepseek-ai/dsh-* convention. This is the Codex-memory-mode DSH adaptation:
//   - Read path: inject a memory summary (总纲) + decision boundary + quick pass,
//     NOT a flat stream of recent entries.
//   - One session one draft: rollout_summaries/<sessionId>.md (short-term draft).
//   - Long-term layer: the `dsh_rollout` storage-domain `entries` table, with a
//     sessionId field so each entry is traceable to the session that produced it.
//   - Write discipline: only on explicit user request; never edit memory files
//     directly, only write extensions/ad_hoc/notes/<ts>-<slug>.md update notes.
//   - Integration pass (integrate): fingerprint + watermark → no-change skip →
//     regenerate MEMORY.md + memory_summary.md.
//   - Reference annotation: recall results carry a <oai-mem-citation> block and a
//     "may be stale" note.
//   - Management page: shows the new structure (summary / registry / drafts / notes).
//
// Naming note: storage-domain unit names must match UNIT_NAME_RE
// (/^[a-z][a-z0-9_]*$/ — snake_case, no hyphens), so the domain is
// 'dsh_rollout' while the npm package is 'dsh-rollout'.
// Config must be a schemastery schema: the harness plugin loader validates
// plugin Config with @deepseek-ai/schemastery (zod schemas fail with
// "invalid config: expected object, received undefined"). The storage-domain
// TABLE valueSchema, by contrast, must be a zod schema (dsh-storage-domain
// calls `.parse(record)` on it; schemastery has no `.parse`).
// schemastery exposes only a default export (alias z below).
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { Session } from '@deepseek-ai/dsh-session'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const name = 'dsh-rollout'

// Required services this plugin uses via direct props (ctx.tools / ctx.systemPrompt).
// webServer is read lazily with ctx.get('webServer') so it needs no inject entry.
export const inject = ['storageDomain', 'tools', 'systemPrompt']

/** Optional deployment tuning. */
export const Config = z.object({
  /** Maximum entries surfaced in the recall tool result. */
  recallLimit: z.number().step(1).min(1).max(50).default(10),
  /** Kept for config compatibility; this build injects only the memory summary (not a flat entry stream). */
  injectLimit: z.number().step(1).min(0).max(30).default(8),
  /** Max characters of memory_summary.md injected into each system-prompt assembly. */
  summaryTokens: z.number().step(1).min(200).max(12000).default(4000),
  /** Quick-pass step budget in the injected memory instructions. */
  maxQuickSteps: z.number().step(1).min(1).max(12).default(5),
  /** Optional override of the memory root; empty = <ds_home>/memories. */
  memoryRoot: z.string().default(''),

  // ── Phase 2: auto-trigger + two-phase pipeline (no-LLM skeleton) ──────────
  // These tune the `session/disposed` + `session/event` auto-trigger pipeline.
  // Phase 2 = candidate selection + integration; the draft-write step now runs
  // the Phase-3 LLM extraction on the trigger session (see Phase-3 fields below).
  // Both phases stay context-loss-safe: any LLM failure falls back to the
  // literal snapshot, so the skeleton never regresses and never breaks the host.
  /** Auto-trigger mode: 'sessionEnd' runs the pipeline when a session is disposed; 'off' disables auto-trigger (manual tool calls still work). */
  autoTrigger: z.string().pattern(/^(sessionEnd|off)$/).default('sessionEnd'),
  /** A session must be idle this many hours before it qualifies as a pipeline candidate. */
  minIdleHours: z.number().step(0.5).min(0).max(240).default(6),
  /** Skip candidate sessions whose draft is older than this many days (stale pruning). */
  maxDraftAgeDays: z.number().step(1).min(1).max(90).default(10),
  /** Max candidate sessions extracted (draft-written) per pipeline run. */
  maxExtractPerTrigger: z.number().step(1).min(1).max(10).default(2),
  /** Max pipeline runs per calendar day (budget to avoid runaway runs). */
  maxPipelineRunsPerDay: z.number().step(1).min(1).max(100).default(12),
  /** Max LLM extraction attempts per calendar day (quota counted by model attempts, not written outputs). */
  maxModelAttemptsPerDay: z.number().step(1).min(1).max(1000).default(24),
  /** Also run the pre-compact drain on `compaction/start` when true (default off). */
  precompactAuto: z.boolean().default(false),

  // ── Phase 3: LLM extraction (ctx.llm) ─────────────────────────────────────
  // Tunes the LLM call that refines a literal snapshot into a {raw_memory,
  // rollout_summary, slug} summary. Extraction consumes quota: it runs only
  // inside pipelinePhase1 for the TRIGGER session (one call per run), gated by
  // maxPipelineRunsPerDay — never at startup and never per-turn. If the LLM
  // service is unavailable or the call fails, phase 1 falls back to the literal
  // snapshot, preserving phase-2 behavior exactly.
  /** Registered provider route for extraction; empty = harness default provider (agentDefaultModel). */
  extractProvider: z.string().default(''),
  /** Provider model id for extraction; empty = harness default model. */
  extractModel: z.string().default(''),
  /** Reasoning effort for extraction (adapter vocab, e.g. off/low/high/max); empty = model default. */
  extractReasoningEffort: z.string().default('low'),
  /** Coarse input-token cap for the transcript fed to the LLM (chars ≈ tokens × 4); longer input is truncated. */
  maxExtractTokens: z.number().step(500).min(500).max(200000).default(8000),
  /** Reserved for a later consolidation pass; not wired this iteration. */
  consolidationProvider: z.string().default(''),
  /** Reserved for a later consolidation pass; not wired this iteration. */
  consolidationModel: z.string().default(''),
})

// ── Settings-page config form (single source of truth for the client form) ──
// Each editable config field described for the settings page. The client renders
// this list generically (select / number / toggle / text); the host uses it to
// validate + persist runtime config updates. Fields NOT listed here (memoryRoot,
// the reserved consolidation* placeholders) are intentionally read-only.
const CONFIG_FIELDS = [
  {
    key: 'autoTrigger',
    label: '自动触发模式（autoTrigger）',
    type: 'select',
    options: ['sessionEnd', 'off'],
    hint: 'sessionEnd = 会话结束时自动跑管线；off = 关闭自动触发（手动工具仍可用）',
  },
  { key: 'precompactAuto', label: '压缩前自动（precompactAuto）', type: 'toggle', hint: 'true = 在上下文压缩（compaction/start）时也跑一次前置整理，防压缩丢信息；false = 只靠你手动调 memory_precompact。默认 false。' },
  { key: 'minIdleHours', label: '最小空闲小时（minIdleHours）', type: 'number', hint: '候选会话至少要闲置这么多小时才被自动提炼（防提炼正在活跃的会话）。默认 6。' },
  { key: 'maxDraftAgeDays', label: '草稿最大天数（maxDraftAgeDays）', type: 'number', hint: '草稿超过这么多天就不再参与自动整合（太旧内容降权）。默认 10。' },
  { key: 'maxExtractPerTrigger', label: '每次触发最大提取（maxExtractPerTrigger）', type: 'number', hint: '一次管线触发最多提炼多少个会话草稿（节流省配额）。默认 2。' },
  { key: 'maxPipelineRunsPerDay', label: '每日管线运行上限（maxPipelineRunsPerDay）', type: 'number', hint: '每天最多自动跑多少次记忆管线（防自动 LLM 提炼吃光配额）。默认 12。' },
  { key: 'summaryTokens', label: '摘要 token 预算（summaryTokens）', type: 'number', hint: '注入 system prompt 的 memory_summary.md 最大 token 数。越大注入总纲越多、记忆更好用，但占更多上下文。默认 4000，最大 12000。' },
  { key: 'maxQuickSteps', label: '快速记忆步数（maxQuickSteps）', type: 'number', hint: '快速记忆通道 quick memory pass 的搜索步数预算，越小越省。默认 5，≤12。' },
  { key: 'recallLimit', label: '回忆最大条目（recallLimit）', type: 'number', hint: 'memory_recall 一次返回的最大条目数。默认 10，≤50。' },
  { key: 'injectLimit', label: '注入最大条目（injectLimit）', type: 'number', hint: '每次 system prompt 注入的最大记忆条目数（长期 entries）。默认 8，≤30。' },
  { key: 'extractProvider', label: '提取 Provider（extractProvider）', type: 'text', hint: 'LLM 提炼草稿用的 provider。留空 = 用 settings 里 agent-default-model 的 provider。' },
  { key: 'extractModel', label: '提取模型（extractModel）', type: 'text', hint: 'LLM 提炼草稿用的模型。留空 = 用 agent-default-model 的模型。' },
  {
    key: 'extractReasoningEffort',
    label: '推理强度（extractReasoningEffort）',
    type: 'select',
    options: ['', 'off', 'low', 'high', 'max'],
    hint: '提炼时的模型推理强度。留空 = 模型默认；off 不推理。默认 low（省）。若模型拒绝该值会自动去掉重试。',
  },
  { key: 'maxExtractTokens', label: '提取输入 token 上限（maxExtractTokens）', type: 'number', hint: '传给 LLM 提炼的最大输入 token（超长会话先截断）。默认 8000。' },
]
/** Config fields the settings page may change at runtime (subset of the schema). */
const OVERLAYABLE_KEYS = new Set(CONFIG_FIELDS.map((f) => f.key))

const recordSchema = zod.object({
  content: zod.string(),
  tags: zod.array(zod.string()).default([]),
  createdAt: zod.string(),
  updatedAt: zod.string(),
  source: zod.string().default('tool'),
  sessionId: zod.string().optional(),
})

const spec = defineDomain({
  name: 'dsh_rollout',
  version: 1,
  tables: {
    entries: { valueSchema: recordSchema },
  },
})

const nowIso = () => new Date().toISOString()
const makeId = () =>
  'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

/** 分级退避（秒），用于 stage-1 作业 failed_retryable 的 available_at。 */
export function stage1BackoffSeconds(attempt) {
  const a = Math.max(1, attempt || 1)
  return Math.min(3600, 60 * Math.pow(2, Math.min(a - 1, 6)))
}

/**
 * 阶段 A：稳定的来源水印（内容指纹）。对一段会话文本做 SHA-256 取前缀。
 * 内容不变 watermark 不变（去重成立），内容变化则变化（新活动触发新作业）。
 * 不用 pipeline 的 lastActivityAt（会被 upsert active 刷新，不能作文本指纹）。
 * 纯函数可单测。
 */
export function contentWatermark(input) {
  const s = String(input || '')
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
}

/**
 * 阶段 A：租约过期回收。把 `running` 且租约已过期的 stage-1 作业收回 `pending`
 * （进程中断/重启后的恢复边界）。纯函数，便于单测。返回回收数量。
 */
export function reclaimStage1Jobs(state, now = Date.now()) {
  let reclaimed = 0
  for (const key of Object.keys((state && state.jobs) || {})) {
    const j = state.jobs[key]
    if (j && j.status === 'running' && (!j.lease_expires_at || new Date(j.lease_expires_at).getTime() < now)) {
      j.status = 'pending'
      j.lease_owner = ''
      j.lease_expires_at = ''
      reclaimed++
    }
  }
  return reclaimed
}

/**
 * 阶段 A：去重入队一个 stage-1 作业（`session_id + source_watermark` 唯一）。
 * 相同来源版本重复触发时合并（不建无限重复作业）。纯函数，可单测。
 * 返回 `{ queued, key, job }`。
 */
export function mergeStage1Job(state, sessionId, watermark, now = new Date()) {
  if (!state) state = { jobs: {} }
  if (!state.jobs) state.jobs = {}
  const key = `${sessionId}::${watermark}`
  if (state.jobs[key]) return { queued: false, key, job: state.jobs[key] }
  const job = {
    id: 'j-' + now.getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    session_id: String(sessionId),
    source_watermark: String(watermark),
    status: 'pending',
    attempt_count: 0,
    max_attempts: 3,
    available_at: now.toISOString(),
    lease_owner: '',
    lease_expires_at: '',
    last_error_code: '',
    last_error_message: '',
    effective_provider: '',
    effective_model: '',
    effective_reasoning_effort: '',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    completed_at: '',
  }
  state.jobs[key] = job
  return { queued: true, key, job }
}

/**
 * 阶段 A：启动/重启恢复。读 `.stage1-state.json`（缺失/损坏则取空），对其中
 * `running` 且租约过期的作业执行 `reclaimStage1Jobs`（过期→pending），再写回。
 * 返回回收数。纯函数（只依赖路径 + fs），便于单测——正是「DSH 重启后作业能
 * 继续」的持久化恢复边界。
 */
export function stage1Recover(persistPath, now = Date.now()) {
  let state
  try {
    const text = fs.readFileSync(persistPath, 'utf8')
    state = JSON.parse(text)
    if (!state || typeof state !== 'object' || !state.jobs) state = { jobs: {} }
  } catch {
    state = { jobs: {} }
  }
  const n = reclaimStage1Jobs(state, now)
  try {
    fs.mkdirSync(path.dirname(persistPath), { recursive: true })
    fs.writeFileSync(persistPath, JSON.stringify(state, null, 2))
  } catch {
    // best-effort; recovery is best exercised in the isolated test with a real tmp path.
  }
  return n
}

/**
 * 阶段 A：领取一个 `pending` 且 `available_at <= now` 的 stage-1 作业（取最早创建），
 * 置为 `running` + 写租约。返回被领取的作业，或 `null`（没有可领取的）。
 * 纯函数——drain 的「在 withWrite 内领取一步」的可测核心。
 */
export function claimStage1Job(state, now, leaseMs, owner) {
  if (!state || !state.jobs) return null
  let pick = null
  for (const j of Object.values(state.jobs)) {
    if (j && j.status === 'pending' && (!j.available_at || new Date(j.available_at).getTime() <= now)) {
      if (!pick || String(j.created_at) < String(pick.created_at)) pick = j
    }
  }
  if (!pick) return null
  pick.status = 'running'
  pick.lease_owner = owner
  pick.lease_expires_at = new Date(now + leaseMs).toISOString()
  pick.updated_at = new Date(now).toISOString()
  return pick
}

/**
 * 阶段 A：「事件只入队」的存储侧实现。读 `.stage1-state.json`（缺失/损坏取空），
 * 用 `mergeStage1Job` 去重入队（session_id + source_watermark），再写回。
 * 供事件回调（session/disposed 等）调用——只落盘入队，不跑模型。纯函数（只依赖
 * 路径 + fs），可单测。返回 `{ queued, key, job }`。
 */
export function enqueueStage1JobFile(persistPath, sessionId, watermark, now = new Date()) {
  let state
  try {
    const text = fs.readFileSync(persistPath, 'utf8')
    state = JSON.parse(text)
    if (!state || typeof state !== 'object' || !state.jobs) state = { jobs: {} }
  } catch {
    state = { jobs: {} }
  }
  const r = mergeStage1Job(state, sessionId, watermark, now)
  try {
    fs.mkdirSync(path.dirname(persistPath), { recursive: true })
    fs.writeFileSync(persistPath, JSON.stringify(state, null, 2))
  } catch {
    // best-effort; exercised with a real tmp path in the isolated test.
  }
  return r
}

/**
 * 阶段 A：drain「提交一步」的纯逻辑。按 outcome 推进 job 状态：
 *  - succeeded_with_output：写 outputs + completed_at（opts.output 为产物对象）
 *  - succeeded_no_output：completed_at（成功 no-op，无产物）
 *  - failed_retryable：attempt_count+1，available_at 按分级退避（供下次领取）
 *  - failed_terminal：completed_at（不再重试）
 * 返回 { status, job }。纯函数可单测。
 */
export function stage1FinishJob(state, job, outcome, opts = {}, now = new Date()) {
  job.status = outcome
  job.updated_at = now.toISOString()
  if (outcome === 'failed_retryable') {
    job.attempt_count = (job.attempt_count || 0) + 1
    job.available_at = new Date(now.getTime() + stage1BackoffSeconds(job.attempt_count) * 1000).toISOString()
    job.last_error_code = opts.error_code || ''
    job.last_error_message = opts.error_message || ''
  } else if (outcome === 'succeeded_with_output') {
    job.completed_at = now.toISOString()
    if (opts.output && !state.outputs) state.outputs = {}
    if (opts.output) {
      state.outputs[job.id] = {
        session_id: job.session_id,
        source_watermark: job.source_watermark,
        rollout_summary: String(opts.output.rollout_summary || ''),
        raw_memory_or_evidence_excerpt: String(opts.output.raw_memory || ''),
        rollout_slug: String(opts.output.slug || ''),
        keywords: String(opts.output.keywords || ''),
        content_hash: String(opts.output.content_hash || ''),
        generated_at: now.toISOString(),
        effective_provider: String(opts.output.provider || ''),
        effective_model: String(opts.output.model || ''),
        selected_for_phase2: false,
      }
    }
  } else if (outcome === 'succeeded_no_output' || outcome === 'failed_terminal') {
    job.completed_at = now.toISOString()
  }
  return { status: outcome, job }
}

/** Normalize a value to a short, filesystem-safe slug (lowercase, dashes). */
const safeSlug = (s) =>
  String(s || 'note')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'note'

/**
 * Redact common secret patterns to a `[REDACTED]` placeholder. Conservative by
 * design: prefer masking a suspicious string over leaking a real credential.
 * The placeholder keeps the surrounding label/context (e.g. `PASSWORD=`) but
 * never the secret value. Applied at the security boundaries: (1) before the
 * transcript is sent to the LLM, (2) after the model output is parsed, and
 * (3) again immediately before writing to a draft file or the entries table.
 * Exported so the isolated redaction test can exercise it directly.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text

  // (1) Private-key blocks (SSH / OpenSSH / PGP / RSA / DSA / EC). Mask whole block.
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED]',
  )

  // (2) Auth / API-key headers. Mask the credential value (quoted, `Bearer <tok>`,
  //     or a bare token) while keeping the label and any following text intact.
  out = out.replace(
    /((?:authorization|x-api-key|api[-_]?key|apikey)\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|`([^`]*)`|Bearer\s+\S+|[^\s,;]+)/gi,
    (_m, label) => label + '[REDACTED]',
  )

  // (3) Common credential key=value / key: value / key = "value" (quoted or not).
  out = out.replace(
    /((?:password|passwd|pwd|token|access[_-]?token|secret|access[_-]?key|client[_-]?secret|session[_-]?id|api[_-]?key|auth)\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s,;]+))/gi,
    (_m, label) => label + '[REDACTED]',
  )

  // (4) Literal angle-bracket placeholders (docs/example strings).
  out = out.replace(
    /<(password|passwd|pwd|token|api[_-]?key|secret|access[_-]?token|bearer|auth)\s*>/gi,
    '[REDACTED]',
  )

  // (5) Well-known credential prefixes (OpenAI/Anthropic, Stripe, GitHub, Slack,
  //     Google, GitLab, AWS).
  out = out.replace(
    /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{6,}|sk_live_[A-Za-z0-9_-]{6,}|sk_test_[A-Za-z0-9_-]{6,}|rk_live_[A-Za-z0-9_-]{6,}|pk_live_[A-Za-z0-9_-]{6,}|pk_test_[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|xox[abpors]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIDA[0-9A-Z]{16})\b/g,
    '[REDACTED]',
  )

  // (6) "Bearer <token>".
  out = out.replace(/\bBearer\s+(\S+)/g, (_m) => 'Bearer [REDACTED]')

  // (7) JWT (three base64url segments).
  out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')

  // (8) Long base64/base64url runs that look like high-entropy tokens.
  out = out.replace(
    /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{40,}(?![A-Za-z0-9+/_=-])/g,
    (m) => (looksLikeToken(m) ? '[REDACTED]' : m),
  )

  return out
}

/**
 * Heuristic for the "long base64" rule: a run qualifies only if it has length
 * >= 40, contains a digit, and has an entropy signal (mixed case or a base64
 * special char). Pure lowercase hex hashes (commit shas, uuids, ids) are left
 * alone to avoid false positives on ordinary text.
 */
function looksLikeToken(s) {
  if (s.length < 40) return false
  if (!/[0-9]/.test(s)) return false
  const hasUpper = /[A-Z]/.test(s)
  const hasSpecial = /[+/_=-]/.test(s)
  return hasUpper || hasSpecial
}

/**
 * Estimate the caller session id / cwd from the tool run context.
 * DSH tool `execute(args, exec)` gives `exec.agent.session`, whose header
 * carries `cwd` (and usually the session id). Access defensively so a missing
 * id degrades to '' rather than throwing.
 */
const sessionIdOf = (exec) => {
  const s = exec?.agent?.session
  return s?.id || s?.header?.id || s?.header?.session_id || ''
}
const cwdOf = (exec) => {
  const s = exec?.agent?.session
  return s?.header?.cwd || exec?.cwd || ''
}

export async function apply(ctx, config) {
  const domain = await ctx.storageDomain.open(spec)
  ctx.effect(
    () => async () => {
      await domain.close()
    },
    'dsh-rollout.domainClose',
  )
  const table = domain.table('entries')

  // ── memory filesystem root & helpers ─────────────────────────────────────
  // Derive the DSH home the same way @deepseek-ai/dsh-home-paths does:
  // `$DSH_HOME` wins, otherwise `~/.dsh`. `config.memoryRoot` overrides the
  // whole memory root if set.
  const dsHome = () => {
    const env = process.env.DSH_HOME
    const home = env && env.trim() ? path.resolve(env) : path.join(os.homedir(), '.dsh')
    return home
  }
  const memoryRoot = () =>
    config.memoryRoot && config.memoryRoot.trim()
      ? path.resolve(config.memoryRoot)
      : path.join(dsHome(), 'memories')
  const dirs = () => ({
    root: memoryRoot(),
    summaries: path.join(memoryRoot(), 'rollout_summaries'),
    notes: path.join(memoryRoot(), 'extensions', 'ad_hoc', 'notes'),
  })
  const readText = (p) => {
    try {
      return fs.readFileSync(p, 'utf8')
    } catch {
      return ''
    }
  }
  const writeText = (p, s) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, s, 'utf8')
  }
  const exists = (p) => fs.existsSync(p)
  const listFiles = (dir) => {
    try {
      return fs.readdirSync(dir).filter((n) => !n.startsWith('.'))
    } catch {
      return []
    }
  }
  function ensureLayout() {
    const d = dirs()
    for (const p of [d.root, d.summaries, d.notes]) fs.mkdirSync(p, { recursive: true })
  }

  // ── runtime config overlay (settings page → dsh-rollout.settings.json) ────
  // The plugin config is resolved from cordis.patch.yml at boot. The settings
  // page edits it at runtime via /dsh-rollout/config, and the changed fields are
  // persisted to a sibling settings file so they survive a restart. This file
  // lives at <ds_home>/dsh-rollout.settings.json (NOT inside memories/, so an
  // export/import never carries it) and is merged into the live `config` at
  // startup, taking precedence over patch.yml so the settings page stays the
  // user-facing source of truth for these fields.
  const settingsPath = () => path.join(dsHome(), 'dsh-rollout.settings.json')
  const readSettings = () => {
    try {
      const o = JSON.parse(readText(settingsPath()))
      return o && typeof o === 'object' ? o : {}
    } catch {
      return {}
    }
  }
  const saveSettings = (obj) => writeText(settingsPath(), JSON.stringify(obj, null, 2))

  /** Keep only the runtime-editable config fields from a raw object. */
  const pickEditable = (obj) => {
    const out = {}
    if (!obj || typeof obj !== 'object') return out
    for (const key of OVERLAYABLE_KEYS) {
      if (key in obj && obj[key] !== undefined) out[key] = obj[key]
    }
    return out
  }

  /** Merge the persisted overlay into the live config (validate, never throw). */
  function applyConfigOverlay() {
    const overlay = readSettings()
    if (!Object.keys(overlay).length) return
    try {
      // Config.parse fills defaults + validates; an invalid overlay leaves the
      // resolved (patch.yml) config untouched.
      const merged = Config({ ...config, ...pickEditable(overlay) })
      Object.assign(config, merged)
    } catch {
      // ignore: keep the boot-time resolved config
    }
  }

  // Apply any runtime-saved config override (settings page) before the plugin
  // reads `config`, so the settings page's saved values are live for this boot.
  // (Called after the settings helpers are defined so there is no TDZ.)
  applyConfigOverlay()

  // ── long-term entries (storage domain) ───────────────────────────────────
  function allEntries() {
    const out = []
    for (const [key, value] of table.entries()) {
      out.push({
        id: key,
        content: String(value.content),
        tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
        createdAt: String(value.createdAt || ''),
        updatedAt: String(value.updatedAt || ''),
        source: String(value.source || 'tool'),
        sessionId: String(value.sessionId || ''),
      })
    }
    return out
  }

  /** Relevance score: tag matches weigh double, content matches single. */
  function scoreEntry(entry, terms) {
    let score = 0
    const content = entry.content.toLowerCase()
    const tags = entry.tags.map((t) => t.toLowerCase())
    for (const term of terms) {
      if (tags.some((t) => t.indexOf(term) !== -1)) score += 2
      if (content.indexOf(term) !== -1) score += 1
    }
    return score
  }

  // ── parse a rollout_summaries/<file>.md into a metadata + body record ────
  function parseDraft(fullPath) {
    const txt = readText(fullPath)
    if (!txt) return null
    const meta = {}
    for (const line of txt.split('\n')) {
      const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim())
      if (m) meta[m[1]] = m[2]
    }
    const bodyIdx = txt.indexOf('## 会话草稿')
    return {
      file: path.basename(fullPath),
      sessionId: meta.session_id || '',
      cwd: meta.cwd || '',
      updatedAt: meta.updated_at || '',
      title: (txt.match(/^# 会话草稿\s*(.*)$/m) || [])[1] || path.basename(fullPath),
      keywords: (meta.keywords || '').split(',').map((s) => s.trim()).filter(Boolean).join(','),
      body: bodyIdx >= 0 ? txt.slice(bodyIdx) : txt,
    }
  }

  function writeSessionDraft(sessionId, cwd, title, body) {
    ensureLayout()
    const d = dirs()
    const file = path.join(d.summaries, `${safeSlug(sessionId || 'unknown')}.md`)
    const header = [
      `session_id: ${sessionId || 'unknown'}`,
      `updated_at: ${nowIso()}`,
      `cwd: ${cwd || ''}`,
      '',
      `# 会话草稿 ${redactSecrets(title || '')}`.trimEnd(),
      '',
    ].join('\n')
    writeText(file, header + redactSecrets(String(body || '').trim()) + '\n')
    return path.relative(d.root, file)
  }

  function ensureDraft(sessionId, cwd) {
    ensureLayout()
    const d = dirs()
    const file = path.join(d.summaries, `${safeSlug(sessionId || 'unknown')}.md`)
    if (!exists(file)) {
      writeSessionDraft(sessionId, cwd, '', '')
    }
    return path.relative(d.root, file)
  }

  /**
   * Write an LLM-refined draft file for one session. The filename stays keyed by
   * sessionId (one-session-one-draft invariant); the model's `slug` is carried as
   * a header field for grep-ability rather than as the filename. Body = the
   * refined `rollout_summary`, followed by a `## 原始字面快照` appendix carrying
   * the verbatim `raw_memory` so nothing is lost (raw is already in the session
   * log; the appendix is for traceability only).
   */
  function writeExtractedDraft(sessionId, cwd, extraction) {
    ensureLayout()
    const d = dirs()
    const file = path.join(d.summaries, `${safeSlug(sessionId || 'unknown')}.md`)
    // D3: redact every field that reaches disk — the model output and the literal
    // fallback may both carry a secret the model echoed (or the transcript held).
    const slug = redactSecrets(String(extraction.slug || ''))
    const keywords = redactSecrets(String(extraction.keywords || ''))
    const title = redactSecrets(String(extraction.title || ''))
    const header = [
      `session_id: ${sessionId || 'unknown'}`,
      `updated_at: ${nowIso()}`,
      `cwd: ${cwd || ''}`,
      ...(slug ? [`slug: ${slug}`] : []),
      ...(keywords ? [`keywords: ${keywords}`] : []),
      '',
      `# 会话草稿 ${title}`.trimEnd(),
      '',
    ].join('\n')
    const summary = redactSecrets(String(extraction.rollout_summary || '').trim())
    const raw = redactSecrets(String(extraction.raw_memory || '').trim())
    let body = summary
    if (raw && raw !== summary) body += '\n\n## 原始字面快照\n' + raw
    writeText(file, header + body + '\n')
    return path.relative(d.root, file)
  }

  /** Regenerate MEMORY.md registry from drafts + long-term entries. */
  function writeRegistry() {
    const d = dirs()
    const lines = []
    lines.push('# MEMORY.md')
    lines.push('')
    lines.push('DeepSeek Harness memory registry. Grouped by task family. Grep-friendly. 首层按 cwd 分组，长期记忆在文末。')
    lines.push('')

    const byCwd = new Map()
    for (const f of listFiles(d.summaries).sort()) {
      const m = parseDraft(path.join(d.summaries, f))
      if (!m) continue
      const cwd = m.cwd || '(unknown)'
      if (!byCwd.has(cwd)) byCwd.set(cwd, [])
      byCwd.get(cwd).push(m)
    }
    for (const [cwd, items] of byCwd) {
      lines.push(`# Task Group: ${cwd}`)
      lines.push('scope: 该工作区各会话的草稿与长期记忆。')
      lines.push(`applies_to: cwd=${cwd}; reuse_rule=check`)
      lines.push('')
      items.forEach((it, i) => {
        lines.push(`## Task ${i + 1}: ${it.title}`)
        lines.push('### rollout_summary_files')
        lines.push(
          `- rollout_summaries/${it.file} (cwd=${it.cwd}, updated_at=${it.updatedAt}, session_id=${it.sessionId})`,
        )
        lines.push('### keywords')
        lines.push('- ' + (it.keywords || 'draft'))
        lines.push('')
      })
    }

    const entries = allEntries()
    if (entries.length) {
      lines.push('# Long-term memories')
      lines.push('')
      for (const e of entries) {
        lines.push(
          `- [${e.tags.join(',')}] ${redactSecrets(e.content)} (session=${e.sessionId || '-'}, updated=${e.updatedAt})`,
        )
      }
      lines.push('')
    }
    writeText(path.join(d.root, 'MEMORY.md'), lines.join('\n'))
  }

  /** Regenerate memory_summary.md (must start with a bare `v1` line). */
  function writeSummary() {
    const d = dirs()
    const entries = allEntries()
    const lines = []
    lines.push('v1')
    lines.push('')
    lines.push('## User Profile')
    lines.push('- DSH 跨会话用户记忆总纲。由整合 pass 从会话草稿与长期记忆自动生成。')
    lines.push('')
    lines.push('## User preferences')
    const prefs = entries.filter((e) => (e.tags || []).some((t) => /pref|user|偏好/i.test(t)))
    if (prefs.length) for (const e of prefs) lines.push(`- ${redactSecrets(e.content)}`)
    else lines.push('- （暂未沉淀明确用户偏好）')
    lines.push('')
    lines.push("## What's in Memory")
    const drafts = listFiles(d.summaries).sort()
    if (drafts.length) {
      lines.push('### 会话草稿')
      for (const f of drafts.slice(-50)) {
        const m = parseDraft(path.join(d.summaries, f))
        lines.push(`#### ${(m.updatedAt || '').slice(0, 10) || 'draft'}`)
        lines.push(`- ${m.cwd || '?'}: ${m.title} (session=${m.sessionId || '-'})`)
      }
    }
    lines.push('### 长期记忆条目')
    lines.push(`- ${entries.length} 条长期记忆（memory_recall / MEMORY.md 可查）`)
    lines.push('')
    writeText(path.join(d.root, 'memory_summary.md'), lines.join('\n'))
  }

  /**
   * Fingerprint the memory inputs (draft files + long-term entry ids/sessions/
   * timestamps). A stable fingerprint means the integration pass has nothing new
   * to do; it can skip regeneration (and save tokens).
   */
  function memoryFingerprint() {
    const d = dirs()
    const h = crypto.createHash('sha256')
    for (const file of listFiles(d.summaries).sort()) {
      const full = path.join(d.summaries, file)
      let mtime = 0
      let size = 0
      try {
        const st = fs.statSync(full)
        mtime = st.mtimeMs
        size = st.size
      } catch {}
      h.update(file + '\n' + mtime + '\n' + size + '\n')
    }
    for (const e of allEntries()) {
      h.update('entry:' + (e.sessionId || '') + ':' + e.id + ':' + e.updatedAt + '\n')
    }
    return h.digest('hex')
  }

  /**
   * Integration pass. Idempotent: if nothing changed since the last successful
   * run (watermark), skip; otherwise regenerate MEMORY.md + memory_summary.md and
   * advance the watermark (never retreat).
   */
  function integrate() {
    ensureLayout()
    const fp = memoryFingerprint()
    const wmPath = path.join(memoryRoot(), '.watermark')
    const prev = readText(wmPath).trim()
    if (prev === fp) {
      return { changed: false, skipped: true, watermark: fp }
    }
    writeRegistry()
    writeSummary()
    writeText(wmPath, fp)
    return { changed: true, skipped: false, watermark: fp }
  }

  // ── Phase 2: auto-trigger pipeline state (.pipeline-state.json) ───────────
  // A tiny JSON bookkeeping file under the memory root that tracks, per
  // session, when it was last active and last summarized, plus global
  // counters (last phase-2 run, runs today). This is what makes the pipeline
  // idempotent + rate-limited without any LLM call.
  const pipelineStatePath = () => path.join(memoryRoot(), '.pipeline-state.json')

  /** Default/empty pipeline state shape. */
  function emptyPipelineState() {
    return {
      sessions: {}, // sessionId -> { sessionId, lastActivityAt, summarizedAt, lastExtractStatus }
      global: {
        lastPhase2At: '',
        runsToday: 0,
        runDay: '', // YYYY-MM-DD; resets runsToday when the day flips.
        modelAttemptsToday: 0, // actual LLM extraction attempts today (quota gate).
      },
    }
  }

  /** Load `.pipeline-state.json`, falling back to defaults on missing/corrupt. */
  function loadPipelineState() {
    try {
      const parsed = JSON.parse(readText(pipelineStatePath()))
      if (!parsed || typeof parsed !== 'object') return emptyPipelineState()
      const sessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
      const g = parsed.global && typeof parsed.global === 'object' ? parsed.global : {}
      return {
        sessions,
        global: {
          lastPhase2At: typeof g.lastPhase2At === 'string' ? g.lastPhase2At : '',
          runsToday: Number.isFinite(g.runsToday) ? Number(g.runsToday) : 0,
          runDay: typeof g.runDay === 'string' ? g.runDay : '',
          modelAttemptsToday: Number.isFinite(g.modelAttemptsToday) ? Number(g.modelAttemptsToday) : 0,
        },
      }
    } catch {
      return emptyPipelineState()
    }
  }

  /** Persist pipeline state (atomic-ish: write temp + rename). */
  function savePipelineState(state) {
    const target = pipelineStatePath()
    const tmp = `${target}.tmp`
    try {
      writeText(tmp, JSON.stringify(state, null, 2))
      fs.renameSync(tmp, target)
    } catch {
      // Best-effort; a transient write failure must not break the pipeline.
    }
  }

  const dayKey = (d = new Date()) => d.toISOString().slice(0, 10)
  const hoursSince = (iso) => {
    if (!iso) return Number.POSITIVE_INFINITY
    const t = new Date(iso).getTime()
    if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
    return (Date.now() - t) / 36e5
  }
  const daysSince = (iso) => hoursSince(iso) / 24

  /**
   * Record a session's activity, mark it summarized, and/or record the outcome of
   * the last extraction attempt. `status` ∈ 'succeeded_with_output' |
   * 'succeeded_no_output' | 'failed'. Only a terminal success/no-op advances
   * summarizedAt; a 'failed' attempt leaves it untouched so the session can be
   * retried on a later pipeline run.
   */
  function upsertPipelineSession(state, sessionId, { active = false, summarized = false, status } = {}) {
    const rec = state.sessions[sessionId] || {
      sessionId,
      lastActivityAt: '',
      summarizedAt: '',
      lastExtractStatus: '',
    }
    if (active) rec.lastActivityAt = nowIso()
    if (summarized) rec.summarizedAt = nowIso()
    if (status !== undefined) rec.lastExtractStatus = status
    state.sessions[sessionId] = rec
    return rec
  }

  /**
   * Whether a session has new activity since its last summary. Used to stop the
   * secondary-candidate loop from re-drafting an idle session that has not changed:
   * if `summarizedAt >= lastActivityAt` there is nothing new since the last draft,
   * so the existing draft must NOT be rewritten (that re-write used to wrap the old
   * draft into the new one, growing the file every pipeline run — the nesting bug).
   */
  function hasNewActivitySinceSummary(rec) {
    const last = rec && rec.lastActivityAt
    const summed = rec && rec.summarizedAt
    if (!summed) return true // never summarized → no prior draft to nest → safe to (re)build
    if (!last) return false // summarized but no recorded activity → nothing new
    return summed < last
  }

  /**
   * Serialize a derived Message[] into a plain-text literal snapshot WITHOUT any
   * LLM call. Shared by the live-object path and the persistence path, so both
   * produce an identical body (role + text blocks only; no reasoning/tool raw).
   * Phase 3 feeds this snapshot to ctx.llm as the extraction input, using it
   * verbatim as the fallback when the LLM call fails.
   */
  function messagesToDraftBody(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return ''
    const lines = []
    for (const m of messages) {
      const role = String((m && m.role) || 'user')
      const blocks = Array.isArray(m && m.content) ? m.content : []
      const text = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ')
        .trim()
      if (!text) continue
      // D1: redact the transcript body as soon as it is serialized, so a secret
      // never reaches the LLM or the literal-snapshot fallback.
      lines.push(`- [${role}] ${redactSecrets(text)}`)
    }
    return lines.join('\n')
  }

  // ── Phase 3: LLM extraction of a literal snapshot into {raw_memory, rollout_summary, slug} ──
  // System prompt distilled from Codex's stage_one_system.md: high-signal filter,
  // no-op first, user preferences highest. Output is strict JSON.
  const EXTRACT_SYSTEM_PROMPT = [
    'You are a memory-extraction step for a cross-session memory vault.',
    'Given a role-tagged literal conversation transcript, produce a compact, high-signal summary as STRICT JSON only.',
    'Do NOT invent facts. Do NOT write prose or commentary outside the JSON.',
    '',
    'Output EXACTLY one JSON object with these fields:',
    '- "rollout_summary": a tight durable summary of what this session established (facts, decisions, user preferences, concrete outcomes). Favor durable knowledge over transient chatter. A few sentences maximum; write in the transcript language.',
    '- "raw_memory": the most durable verbatim source lines you summarized from, quoted as-is, truncated to roughly a paragraph — for traceability. Empty string if nothing durable.',
    '- "slug": a short lowercase-dash filename slug (e.g. "phase3-llm-extract").',
    '- "keywords": 3-8 comma-separated retrieval keywords.',
    '- "title": a short human-readable draft title.',
    '',
    'Priorities:',
    '1. No-op first: if the transcript has nothing durable (greetings, trivial one-liners, generic chatter), return a JSON object with EMPTY strings for "rollout_summary" and "raw_memory" rather than inventing content.',
    '2. User preferences and explicit decisions rank highest.',
    '3. Never fabricate; only summarize what is actually present.',
    '',
    'Return ONLY the JSON object. No markdown fences, no leading/trailing prose.',
  ].join('\n')

  /** Coarse input-token guard: cap the transcript by chars (≈ tokens × 4). */
  function truncateTranscript(raw, maxTokens) {
    const cap = Math.max(200, (maxTokens || 8000) * 4)
    if (!raw || raw.length <= cap) return raw || ''
    return raw.slice(0, cap) + '\n...(transcript truncated)'
  }

  /** Best-effort parse of the model's JSON, tolerating stray fences/prose. Never throws. */
  function parseExtractionJson(text) {
    if (!text) return null
    let t = text.trim()
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const tryParse = (s) => {
      try {
        const o = JSON.parse(s)
        return o && typeof o === 'object' ? o : null
      } catch {
        return null
      }
    }
    let obj = tryParse(t)
    if (obj) return obj
    const start = t.indexOf('{')
    if (start >= 0) {
      let depth = 0
      for (let i = start; i < t.length; i++) {
        const c = t[i]
        if (c === '{') depth++
        else if (c === '}') {
          depth--
          if (depth === 0) {
            obj = tryParse(t.slice(start, i + 1))
            if (obj) return obj
          }
        }
      }
    }
    return null
  }

  /** Detect a model rejection of the chosen reasoning effort, so we can retry without it. */
  function isReasoningEffortError(err) {
    const msg = String((err && err.message) || err || '')
    return /reasoning.?effort|UNSUPPORTED_REASONING_EFFORT/i.test(msg)
  }

  /** Consume a chunk stream into the concatenated model text; throw on error/abort finish. */
  async function collectStreamText(stream) {
    let text = ''
    for await (const chunk of stream) {
      if (!chunk) continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
      } else if (chunk.type === 'finish') {
        const kind = chunk.reason && chunk.reason.kind
        if (kind === 'stop' || kind === 'max-tokens') break
        const fm = (chunk.reason && chunk.reason.failure && chunk.reason.failure.message) || kind
        throw new Error('llm extraction aborted: ' + (fm || 'unknown finish'))
      }
    }
    return text.trim()
  }

  /**
   * Refine a literal transcript into {raw_memory, rollout_summary, slug} via
   * ctx.llm. Fully defensive: returns null on ANY failure (LLM unavailable,
   * unrouteable provider/model, streaming error, unparseable output) so the
   * caller falls back to the literal snapshot. Never throws.
   *
   * Provider/model resolution: config override wins, else the harness default
   * (agentDefaultModel.currentSelection). If neither yields a route, returns null
   * (no LLM for that route) rather than guessing. This is how dsh-rollout "leaves
   * the provider empty to use the user's configured default" — the default is
   * read here, because ctx.llm.stream itself requires a registered provider and
   * does NOT substitute one.
   */
  async function extractWithLlm(raw) {
    const prompt = String(raw || '').trim()
    if (!prompt) return null
    const llmSvc = typeof ctx.get === 'function' ? ctx.get('llm', false) : undefined
    if (!llmSvc || typeof llmSvc.stream !== 'function') return null
    const defaultSel =
      typeof ctx.get === 'function' ? ctx.get('agentDefaultModel', false) : undefined
    const sel =
      defaultSel && typeof defaultSel.currentSelection === 'function'
        ? defaultSel.currentSelection()
        : undefined
    const provider = (config.extractProvider && config.extractProvider.trim()) || (sel && sel.provider) || ''
    const model = (config.extractModel && config.extractModel.trim()) || (sel && sel.model) || ''
    if (!provider || !model) return null
    const reasoningEffort = (config.extractReasoningEffort && config.extractReasoningEffort.trim()) || ''
    // D1: redact the transcript just before it is handed to the provider (the
    // transcript is already redacted at serialization; this is defense-in-depth).
    const inputText = redactSecrets(truncateTranscript(prompt, config.maxExtractTokens || 8000))

    const buildOptions = (effort) => ({
      provider,
      model,
      purpose: 'compaction',
      system: EXTRACT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: inputText }], source: { kind: 'user' } }],
      ...(effort ? { reasoningEffort: effort } : {}),
    })

    let text
    try {
      text = await collectStreamText(llmSvc.stream(buildOptions(reasoningEffort)))
    } catch (err) {
      // A rejected reasoning effort is recoverable: retry once without it.
      if (!reasoningEffort || !isReasoningEffortError(err)) return null
      try {
        text = await collectStreamText(llmSvc.stream(buildOptions('')))
      } catch {
        return null
      }
    }
    if (!text) return null

    const parsed = parseExtractionJson(text)
    if (!parsed) return null
    // D2: redact the model output before it is returned (and later written to disk).
    return {
      rollout_summary: redactSecrets(String(parsed.rollout_summary || '').trim()),
      raw_memory: redactSecrets(String(parsed.raw_memory || '').trim()),
      slug: safeSlug(parsed.slug || 'note'),
      keywords: Array.isArray(parsed.keywords)
        ? redactSecrets(parsed.keywords.map(String).join(','))
        : redactSecrets(String(parsed.keywords || '')),
      title: redactSecrets(String(parsed.title || '').trim()),
    }
  }

  /**
   * Live-object message path (fallback). Reads messages from the live Session.
   * At session/disposed this is unreliable and commonly yields nothing — prefer
   * the persistence path below (sessionMessagesByPersistence).
   */
  function sessionMessagesToDraftBody(session) {
    let messages = []
    try {
      if (session && typeof session.deriveMessages === 'function') {
        messages = session.deriveMessages()
      }
    } catch {
      messages = []
    }
    return messagesToDraftBody(messages)
  }

  /**
   * Persistence message path (preferred). Reads a session's messages by id from
   * the DSH durable session log (Codex reads its rollout jsonl the same way) and
   * reconstructs a detached Session, so it works even after the session has been
   * disposed. Never uses `sessionPersistence.load` (which requires a closed
   * turn); uses `sessionQuery.readSession` (live-or-persisted, and waits for the
   * dispose-time write drain internally).
   *
   * `sessionQuery` is resolved lazily with strict=false so an uninstalled query
   * plugin yields `undefined` → we return `null` to signal the caller to fall
   * back to the live-object path. Returns `{ messages, cwd }` on success (cwd
   * from the persisted header), `{ messages: [], cwd }` when the persisted log
   * is corrupt/unreadable (degrade to empty, never throw), or `null` when the
   * query plugin is absent.
   */
  async function sessionMessagesByPersistence(sessionId) {
    const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery', false) : undefined
    if (!query || typeof query.readSession !== 'function') return null
    try {
      const { session: header, events } = await query.readSession(sessionId)
      const s = Session.create(sessionId, events, header)
      return { messages: s.deriveMessages(), cwd: header && header.cwd }
    } catch {
      return { messages: [], cwd: undefined }
    }
  }

  /** Resolve the session's cwd for draft writing, guarded. */
  function sessionCwdOf(session) {
    try {
      return (session && session.header && session.header.cwd) || cwdOf({ agent: { session } }) || ''
    } catch {
      return ''
    }
  }

  /**
   * Run LLM extraction on a transcript and classify the outcome — never degrade a
   * failure or a no-signal session into a raw transcript written as memory.
   * Returns `{ status, extraction }` where status is one of:
   *   - 'succeeded_with_output': a non-empty summary was produced (extraction is
   *     the redacted {rollout_summary, raw_memory, slug, keywords, title}).
   *   - 'succeeded_no_output': no durable signal (empty/very short transcript, or
   *     the model returned an empty summary) — a successful no-op, nothing to write.
   *   - 'failed': the LLM call failed/unparseable — nothing is written and the
   *     session stays pending for a later retry.
   * A memory product requires a non-empty summary, so raw_memory alone is never
   * written as a summary.
   */
  async function extractWithOutcome(raw) {
    const trimmed = String(raw || '').trim()
    if (!trimmed) return { status: 'succeeded_no_output', extraction: null }
    if (trimmed.length < 60) return { status: 'succeeded_no_output', extraction: null }
    const extraction = await extractWithLlm(raw)
    if (!extraction) return { status: 'failed', extraction: null }
    const summary = String(extraction.rollout_summary || '').trim()
    return { status: summary ? 'succeeded_with_output' : 'succeeded_no_output', extraction }
  }

  // ── Phase 2: two-phase pipeline skeleton (no LLM) ─────────────────────────
  let pipelineLock = false
  let writeBusy = false
  let pendingPipeline = []
  /**
   * Global write-maintenance lock (GPT §12.1): every path that MUTATES shared
   * memory state (entries table, memory file tree, derived artifacts) holds this
   * exclusively so an import cannot race another writer. Busy → REJECT (throw a
   * conflict error), matching the import-single-flight semantics. Reads (recall,
   * injection, overview/export/status) don't mutate state, so they never lock.
   * `opts.importConflict` marks the conflict so the import route returns 409.
   */
  async function withWrite(fn, opts = {}) {
    if (writeBusy) {
      const e = new Error(
        opts.conflictMessage || '[dsh-rollout] another write is in progress — retry shortly',
      )
      if (opts.importConflict) e.importConflict = true
      throw e
    }
    writeBusy = true
    try {
      return await fn()
    } finally {
      writeBusy = false
    }
  }
  /** Synchronous variant for call sites that can't await (e.g. sync pipelinePhase2). */
  function withWriteSync(fn, opts = {}) {
    if (writeBusy) {
      const e = new Error(
        opts.conflictMessage || '[dsh-rollout] another write is in progress — retry shortly',
      )
      if (opts.importConflict) e.importConflict = true
      throw e
    }
    writeBusy = true
    try {
      return fn()
    } finally {
      writeBusy = false
    }
  }

  /**
   * Phase 1 — candidate selection + draft write (no LLM). Given a trigger
   * snapshot (the session that caused the trigger, plus already-known session
   * ids), it collects candidate sessionIds and writes a literal draft for each
   * (throttled by maxExtractPerTrigger). Returns { candidates, drafted }.
   */
  async function pipelinePhase1(session) {
    const state = loadPipelineState()
    const candidates = []
    const seen = new Set()
    const sid = session && session.id ? String(session.id) : ''

    // Primary candidate: the triggering session itself (if it has an id).
    if (sid && !seen.has(sid)) {
      // Always draft the triggering session; idle/age guards below apply to
      // secondary candidates to avoid re-drafting every disposed session.
      candidates.push({ sessionId: sid, from: 'trigger' })
      seen.add(sid)
      upsertPipelineSession(state, sid, { active: true })
    }

    // Secondary candidates: already-known sessions that are old enough (idle)
    // and whose draft is not stale — throttled by maxExtractPerTrigger.
    const maxExtract = Math.max(1, config.maxExtractPerTrigger || 2)
    const minIdle = config.minIdleHours || 6
    for (const [key, rec] of Object.entries(state.sessions)) {
      if (seen.has(key)) continue
      // maxExtractPerTrigger bounds the TOTAL candidates (trigger + secondaries).
      // The triggering session is always pushed as the first candidate, so stop
      // before adding another once that budget is already spent — otherwise
      // maxExtractPerTrigger=1 can still yield 2 candidates and exceed the quota.
      if (candidates.length >= maxExtract) break
      const idle = hoursSince(rec && rec.lastActivityAt)
      // Staleness is judged by the session's OWN recency (last activity), NOT the
      // age of its previous summary. Using summarizedAt here wrongly vetoes a
      // session that was summarized long ago but has new activity today — its new
      // content would be missed. A session whose last activity is itself old is
      // genuinely dormant, so skip it.
      const draftAge = daysSince(rec && rec.lastActivityAt)
      const stale = config.maxDraftAgeDays ? draftAge > config.maxDraftAgeDays : false
      // P0-3: skip idle sessions that have no new activity since the last summary —
      // re-drafting them would wrap the existing draft into the new one (nesting).
      if (idle >= minIdle && !stale && hasNewActivitySinceSummary(rec)) {
        candidates.push({ sessionId: key, from: 'secondary' })
        seen.add(key)
      }
    }

    // Draft each collected candidate. Phase 3: every candidate (trigger AND
    // secondary) goes through `extractWithOutcome` — the outcome is classified and
    // NEVER degrades a failure or a no-signal session into a raw transcript written
    // as memory: with_output writes a redacted summary, no_output is a successful
    // no-op (nothing written), failed writes nothing and stays pending for retry.
    // A secondary with no readable content stays pending (P0-3), so it can be
    // re-read once the raw log becomes available.
    let drafted = 0
    for (const c of candidates) {
      let raw = ''
      let cwd = ''
      if (c.from === 'trigger' && session) {
        // Preferred: read the session's messages from the DSH durable log by id
        // (works even after disposal). Fall back to the live-object path only
        // when the query plugin is absent.
        const persisted = sid ? await sessionMessagesByPersistence(sid) : null
        if (persisted !== null) {
          raw = messagesToDraftBody(persisted.messages)
          cwd = persisted.cwd || sessionCwdOf(session)
        } else {
          raw = sessionMessagesToDraftBody(session)
          cwd = sessionCwdOf(session)
        }
      } else {
        // P0-3: secondary candidates must be rebuilt from the PERSISTED RAW session
        // events, never from the existing draft markdown — re-using the draft as the
        // input is exactly what caused the nested-draft growth. If the raw log is
        // unavailable or has no decodable text, we leave the existing draft untouched
        // (no rewrite → no nesting) and do not advance summarizedAt, so a later run
        // can retry once the raw log becomes readable.
        if (c.sessionId) {
          const persisted = await sessionMessagesByPersistence(c.sessionId)
          if (persisted !== null && Array.isArray(persisted.messages) && persisted.messages.length) {
            raw = messagesToDraftBody(persisted.messages)
            cwd = persisted.cwd || ''
          }
        }
      }

      const isTrigger = c.from === 'trigger'

      // A secondary candidate with no readable content stays pending (P0-3 retry).
      if (!isTrigger && !raw) continue

      // Every candidate with content runs the LLM extraction and is classified.
      // There is NO literal path that writes the raw transcript as a summary — a
      // missing/unusable LLM yields 'failed' (nothing written), never dirty memory.
      // Quota gate: count actual MODEL attempts, not written outputs (GPT §12.3).
      // A no-output/empty transcript never reaches the model, so it doesn't burn
      // quota; a real attempt does, even if it fails or unparses.
      const willAttempt = raw.trim().length >= 60
      if (willAttempt) {
        const day = dayKey()
        if (state.global.runDay !== day) {
          state.global.runDay = day
          state.global.modelAttemptsToday = 0
        }
        const cap = Math.max(1, config.maxModelAttemptsPerDay || 24)
        if ((state.global.modelAttemptsToday || 0) >= cap) {
          // Budget exhausted for today: stop distilling further candidates.
          break
        }
        // Count the attempt BEFORE the call — every attempt burns quota, even if
        // it later fails, no-outputs, or unparses (GPT §12.3).
        state.global.modelAttemptsToday = (state.global.modelAttemptsToday || 0) + 1
      }
      const out = await extractWithOutcome(raw)
      const status = out.status
      const extraction = out.extraction

      if (status === 'succeeded_with_output' && extraction) {
        writeExtractedDraft(c.sessionId, cwd, extraction)
        drafted++
      }

      // Terminal success/no-op advances summarizedAt; a failure does NOT, so the
      // session stays pending for a later retry.
      if (status === 'succeeded_with_output' || status === 'succeeded_no_output') {
        upsertPipelineSession(state, c.sessionId, { summarized: true, status })
      } else {
        upsertPipelineSession(state, c.sessionId, { status }) // 'failed' → pending
      }
    }

    savePipelineState(state)
    return { candidates, drafted }
  }

  /**
   * Phase 2 — the existing idempotent integration pass (fingerprint + watermark).
   * No LLM. Tracks the global "last phase-2 run" marker in pipeline state.
   */
  function pipelinePhase2() {
    const state = loadPipelineState()
    const day = dayKey()
    if (state.global.runDay !== day) {
      state.global.runDay = day
      state.global.runsToday = 0
    }
    const result = withWriteSync(() => integrate())
    if (result.changed) {
      state.global.lastPhase2At = nowIso()
      state.global.runsToday += 1
    }
    savePipelineState(state)
    return { changed: result.changed, skipped: result.skipped, runsToday: state.global.runsToday }
  }

  /**
   * Run the two-phase pipeline. Single-flight lock guards against concurrent
   * reentry (e.g. dispose + event both firing). Phase 1 refines the trigger
   * session via ctx.llm (bounded: one call per run, never at startup) and falls
   * back to the literal snapshot on any LLM failure; phase 2 is the existing
   * idempotent, no-LLM integration pass.
   */
  // ── stage-1 persistent job storage (apply-scoped) ─────────────────────────
  const stage1StatePath = () => path.join(memoryRoot(), '.stage1-state.json')
  const loadStage1State = () => {
    try {
      const p = JSON.parse(readText(stage1StatePath()))
      if (!p || typeof p !== 'object' || !p.jobs) return { jobs: {}, outputs: {}, global: {} }
      return { jobs: p.jobs, outputs: p.outputs || {}, global: p.global || {} }
    } catch {
      return { jobs: {}, outputs: {}, global: {} }
    }
  }
  const saveStage1State = (state) => {
    try { writeText(stage1StatePath(), JSON.stringify(state, null, 2)) } catch {}
  }

  /**
   * 阶段 A：drain 消费 .stage1-state.json 里到期(pending, available_at<=now)的作业。
   * 领取→锁外提炼（读持久会话 + LLM）→提交（stage1FinishJob）。整体用 withWrite 互斥
   * （阶段 A 过渡：先保证不并发破坏；后续可优化为「领取/提交各自 withWrite、提炼锁外」）。
   */
  async function drainStage1Jobs() {
    const owner = 'dsh-rollout-drain'
    const leaseMs = 60000
    let processed = 0
    for (;;) {
      // Claim inside the write lock (brief), so a concurrent writer is not blocked
      // during the (potentially slow) model distillation.
      let claimed
      claimed = await withWrite(() => {
        const state = loadStage1State()
        const job = claimStage1Job(state, Date.now(), leaseMs, owner)
        if (job) saveStage1State(state)
        return job
      })
      if (!claimed) break
      // Lock-free distillation: read persistent session + LLM extraction.
      let status = 'failed'
      let extraction = null
      let errMsg = ''
      try {
        let raw = ''
        const persisted = claimed.session_id ? await sessionMessagesByPersistence(claimed.session_id) : null
        if (persisted && Array.isArray(persisted.messages) && persisted.messages.length) {
          raw = messagesToDraftBody(persisted.messages)
        }
        const out = await extractWithOutcome(raw)
        status = out.status
        extraction = out.extraction
      } catch (err) {
        errMsg = String((err && err.message) || err)
      }
      // Submit inside the write lock (brief).
      await withWrite(() => {
        const state = loadStage1State()
        const key = `${claimed.session_id}::${claimed.source_watermark}`
        const job = state.jobs[key] || claimed
        const now = new Date()
        if (status === 'succeeded_with_output' && extraction) {
          stage1FinishJob(state, job, 'succeeded_with_output', { output: extraction }, now)
        } else if (status === 'succeeded_no_output') {
          stage1FinishJob(state, job, 'succeeded_no_output', {}, now)
        } else {
          stage1FinishJob(state, job, 'failed_retryable', { error_message: errMsg }, now)
        }
        saveStage1State(state)
      })
      processed++
    }
    return processed
  }

  const stage1DrainTool = defineTool({
    name: 'memory__stage1_drain',
    description: '调试/内部：手动触发一次 stage-1 作业 drain（消费 .stage1-state.json 到期的 pending 作业并提炼提交）。不改变现有自动管线。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { processed: { type: 'integer', required: true } } } },
    async execute() {
      const processed = await drainStage1Jobs()
      return { processed }
    },
  })

  async function runPipeline(trigger, session) {
    if (config.autoTrigger === 'off') {
      return { ran: false, reason: 'autoTrigger=off', trigger }
    }
    if (pipelineLock) {
      // Don't drop the trigger: merge it into a pending set so it is re-run once
      // the current pipeline completes. Dedupe by session id so a session that
      // fires sessionEnd + preCompact while we're busy only runs once.
      const key = session && session.id ? String(session.id) : `trigger:${trigger}`
      const dup = pendingPipeline.some((p) => {
        const pk = p.session && p.session.id ? String(p.session.id) : `trigger:${p.trigger}`
        return pk === key
      })
      if (!dup) pendingPipeline.push({ trigger, session })
      return {
        ran: false,
        reason: 'locked',
        queued: true,
        trigger,
        pending: pendingPipeline.length,
      }
    }
    pipelineLock = true
    try {
      // Daily budget guard.
      const state = loadPipelineState()
      const day = dayKey()
      if (state.global.runDay !== day) {
        state.global.runDay = day
        state.global.runsToday = 0
      }
      const maxRuns = config.maxPipelineRunsPerDay || 12
      if (state.global.runsToday >= maxRuns) {
        return { ran: false, reason: 'daily-budget-exhausted', trigger }
      }

      const phase1 = await pipelinePhase1(session)
      const phase2 = pipelinePhase2()
      return {
        ran: true,
        trigger,
        phase1,
        phase2,
        at: nowIso(),
      }
    } finally {
      pipelineLock = false
      // Drain the queue: re-run the next merged trigger in the background. Each
      // completed run drains the one after it, so locked triggers are never
      // silently dropped. Fire-and-forget (never await, so we don't chain-block
      // this caller) and contain failures like kickPipeline already does.
      const next = pendingPipeline.shift()
      if (next) {
        runPipeline(next.trigger, next.session).catch((err) => {
          try {
            console.error('[dsh-rollout] pipeline error:', err)
          } catch {}
        })
      }
    }
  }

  /**
   * Synchronously captured, then fire-and-forget scheduled, pipeline kick.
   * The event callback MUST stay synchronous (snapshot only — no long tasks,
   * no cross-fiber work), so we schedule the actual (async) work on
   * setImmediate and contain failures so the host never breaks.
   */
  function kickPipeline(trigger, session) {
    setImmediate(() => {
      runPipeline(trigger, session || null).catch((err) => {
        // Log-and-contain; the pipeline must never break the host.
        try {
          console.error('[dsh-rollout] pipeline error:', err)
        } catch {}
      })
    })
  }

  /** Read the injected memory summary (bounded to summaryTokens). */
  function readMemorySummary() {
    const s = readText(path.join(memoryRoot(), 'memory_summary.md'))
    if (!s) return ''
    const maxChars = (config.summaryTokens || 4000) * 4
    return s.length > maxChars ? s.slice(0, maxChars) + '\n...(截断)' : s
  }

  // ── injection: 总纲 + 决策边界 + quick pass (NOT a flat recent-entries stream)
  ctx.systemPrompt.section({
    name: 'dsh-rollout',
    order: 90,
    text: () => {
      const summary = readMemorySummary()
      if (!summary) return ''
      const maxSteps = config.maxQuickSteps || 5
      return [
        '## 记忆总纲',
        summary,
        '',
        '## 何时用记忆（决策边界）',
        '- 跳过：当前时间/日期、简单翻译/改写、一行 shell、琐碎格式化、明显自包含。',
        '- 默认用：提及 workspace/文件/历史、要先前上下文/一致性/决策、任务模糊、非琐碎且与总纲相关。',
        '- 不确定：快速走一遍。',
        '',
        `## 快速记忆通道（quick memory pass, ${maxSteps}步）`,
        '1. 扫记忆总纲提取相关关键词。 2. 用关键词搜 MEMORY.md。 3. 仅当 MEMORY.md 直接指向草稿时，才打开最相关的 1-2 个 rollout_summaries/ 文件。 4. 缺精确证据再按 rollout_path 搜。 5. 无命中即停，正常干活。',
        '',
        `## quick-pass 预算：≤ ${maxSteps} 步，避免全扫。`,
        '',
        '## 写记忆纪律（最重要）',
        '- 只有用户显式要求才更新记忆。',
        '- 不直接改记忆文件，只写 extensions/ad_hoc/notes/<ts>-<slug>.md 临时 note。',
      ].join('\n')
    },
  })

  // ── model tools ──────────────────────────────────────────────────────────

  const rememberTool = defineTool({
    name: 'memory_remember',
    description:
      "仅在用户显式要求时，把一条稳定事实/偏好/决策写入长期记忆库（dsh_rollout.entries），并记录来源会话(sessionId)以便溯源。不要自动记录流水；用户没要求就别写。",
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'The fact or note to remember, written as a standalone sentence.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional retrieval tags, e.g. ["project:foo", "user"].',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          sessionId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Remembered (id ${value.id}, session ${value.sessionId}); vault now holds ${value.count} entries.`,
        },
      ],
    },
    async execute(args, exec) {
      // D3: redact before the entry is written to the permanent table.
      const content = redactSecrets(String(args.content || '').trim())
      if (!content) throw new Error('memory_remember: content must be a non-empty string')
      const id = makeId()
      const sid = sessionIdOf(exec)
      await table.put(id, {
        content,
        tags: (Array.isArray(args.tags) ? args.tags.map(String) : []).map(redactSecrets),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source: 'tool',
        ...(sid ? { sessionId: sid } : {}),
      })
      return { id, count: table.size, sessionId: sid }
    },
  })

  /**
   * Build Codex-compatible `path:start-end|note=[...]` citation entries for a set
   * of recalled long-term memories. Codex's citations.rs parses a real file path
   * and a line range; the old `sessionId:index` form had neither, so it could not
   * be parsed and pointed nowhere.
   *
   * Each entry points at the real file that actually holds it:
   *   - primary: the long-term memory's own line in MEMORY.md (the registry line
   *     writeRegistry wrote for this entry); a single line span `N-N`.
   *   - fallback: the session's rollout draft `rollout_summaries/<session>.md`,
   *     citing its whole body `1-N`, when the entry is not yet materialized.
   */
  function memoryCitationEntries(entries) {
    const regLines = readText(path.join(memoryRoot(), 'MEMORY.md')).split(/\r?\n/)
    const memo = (p, s, e) => `${p}:${s}-${e}|note=[recalled from memory]`
    return entries.map((e) => {
      if (regLines.length) {
        const idx = regLines.findIndex((l) => e.content && l.includes(e.content))
        if (idx >= 0) return memo('MEMORY.md', idx + 1, idx + 1)
      }
      if (e.sessionId) {
        const slug = safeSlug(e.sessionId)
        const draftPath = path.join(memoryRoot(), 'rollout_summaries', `${slug}.md`)
        if (exists(draftPath)) {
          const n = Math.max(1, readText(draftPath).split(/\r?\n/).length)
          return memo(`rollout_summaries/${slug}.md`, 1, n)
        }
      }
      // No verifiable file+line evidence: do NOT fabricate a "MEMORY.md:1-1"
      // placeholder that implies the registry line holds the memory. Mark it
      // explicitly unverified so the model doesn't treat it as attested evidence.
      return 'unverified:0-0|note=[no verifiable file+line source; not attested]'
    })
  }

  const recallTool = defineTool({
    name: 'memory_recall',
    description:
      'Search the long-term memory vault and return matching entries. Call when the user references earlier work, stated preferences, or decisions that may predate this session. Results are memory-derived — they may be stale.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What to look for: keywords or a phrase.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum entries to return (default from deployment config).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                content: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' } },
                createdAt: { type: 'string', required: true },
                sessionId: { type: 'string', required: true },
              },
            },
          },
          count: { type: 'integer', required: true },
          maybeStale: { type: 'boolean', required: true },
          citation: { type: 'string', required: true },
        },
      },
      render: (_args, value) =>
        value.entries.length
          ? [
              {
                type: 'text',
                text:
                  (value.maybeStale ? '(来自记忆，可能过时；如需请提供刷新)\n' : '') +
                  value.entries
                    .map(
                      (e) =>
                        '- ' +
                        (e.tags && e.tags.length ? `[${e.tags.join(', ')}] ` : '') +
                        e.content +
                        (e.sessionId ? ` (session ${e.sessionId})` : ''),
                    )
                    .join('\n') +
                  (value.citation ? '\n\n' + value.citation : ''),
              },
            ]
          : [{ type: 'text', text: 'No matching memory entries.' }],
    },
    async execute(args) {
      const query = String(args.query || '').trim()
      const limit = Math.min(
        Math.max(Number(args.limit) || config.recallLimit, 1),
        config.recallLimit,
      )
      if (!query) throw new Error('memory_recall: query must be a non-empty string')
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
      const scored = allEntries().map((e) => ({ e, s: scoreEntry(e, terms) }))
      scored.sort((a, b) => b.s - a.s || String(b.e.updatedAt).localeCompare(String(a.e.updatedAt)))
      const top = scored.filter((x) => x.s > 0).slice(0, limit).map((x) => x.e)
      const entries = top.map((e) => ({
        id: e.id,
        content: e.content,
        tags: e.tags,
        createdAt: e.createdAt,
        sessionId: e.sessionId || '',
      }))
      const maybeStale = entries.length > 0
      let citation = ''
      if (entries.length) {
        const notes = memoryCitationEntries(entries)
        const ids = entries.map((e) => e.sessionId).filter(Boolean).slice(0, 5).join('\n')
        citation =
          '<oai-mem-citation>\n<citation_entries>\n' +
          notes.join('\n') +
          '\n</citation_entries>\n<rollout_ids>\n' +
          ids +
          '\n</rollout_ids>\n</oai-mem-citation>'
      }
      return { entries, count: entries.length, maybeStale, citation }
    },
  })

  const forgetTool = defineTool({
    name: 'memory_forget',
    description:
      'Delete entries from the long-term memory vault by exact id, or every entry carrying a given tag. Only when the user says a stored fact is wrong, obsolete, or should not be remembered.',
    parameters: {
      id: { type: 'string', description: 'Exact entry id to delete (returned by memory_recall).' },
      tag: { type: 'string', description: 'Delete every entry carrying this tag.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { deleted: { type: 'integer', required: true } },
      },
      render: (_args, value) => [
        { type: 'text', text: `Deleted ${value.deleted} memory entr${value.deleted === 1 ? 'y' : 'ies'}.` },
      ],
    },
    async execute(args) {
      let deleted = 0
      if (typeof args.id === 'string' && args.id) {
        if (await table.delete(args.id)) deleted = 1
      } else if (typeof args.tag === 'string' && args.tag) {
        const tag = args.tag
        for (const [key, value] of Array.from(table.entries())) {
          if (Array.isArray(value.tags) && value.tags.some((t) => String(t) === tag)) {
            if (await table.delete(key)) deleted++
          }
        }
      } else {
        throw new Error('memory_forget: provide either id or tag')
      }
      return { deleted }
    },
  })

  const draftTool = defineTool({
    name: 'memory_draft',
    description:
      '把当前会话的精炼摘要写入本会话的短期草稿（rollout_summaries/<sessionId>.md），草稿级别可迭代，供后续整合进长期记忆。仅当用户显式要求记录会话时调用。',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: '本会话值得沉淀的精炼摘要/结论/教训，语句化。',
      },
      title: { type: 'string', description: '可选短标题。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          updatedAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `草稿已写入 ${value.file}（session ${value.sessionId}, ${value.updatedAt}）` },
      ],
    },
    async execute(args, exec) {
      const body = String(args.content || '').trim()
      if (!body) throw new Error('memory_draft: content 不能为空')
      const sid = sessionIdOf(exec) || 'unknown'
      const cwd = cwdOf(exec)
      const file = writeSessionDraft(sid, cwd, args.title, body)
      return { file, sessionId: sid, updatedAt: nowIso() }
    },
  })

  const noteTool = defineTool({
    name: 'memory_note',
    description:
      '写一条临时记忆更新 note（extensions/ad_hoc/notes/<ts>-<slug>.md）。仅在用户显式要求记住/遗忘/更新记忆时调用；不直接改记忆文件，由后续整合统一处理。',
    parameters: {
      slug: {
        type: 'string',
        required: true,
        description: 'Short slug (lowercase alphanumeric + dashes).',
      },
      content: {
        type: 'string',
        required: true,
        description: 'The memory change to record (add / delete / update).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { file: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `note 已写入 ${value.file}` }],
    },
    async execute(args, exec) {
      ensureLayout()
      const ts = nowIso().replace(/[:.]/g, '-').slice(0, 19)
      const slug = safeSlug(args.slug)
      // D3: redact before the note is written to disk.
      const content = redactSecrets(String(args.content || '').trim())
      if (!content) throw new Error('memory_note: content 不能为空')
      const file = path.join(dirs().notes, `${ts}-${slug}.md`)
      const header = [
        `session_id: ${sessionIdOf(exec) || ''}`,
        `cwd: ${cwdOf(exec) || ''}`,
        `created_at: ${nowIso()}`,
        '',
      ].join('\n')
      writeText(file, header + content + '\n')
      return { file: path.relative(memoryRoot(), file) }
    },
  })

  const integrateTool = defineTool({
    name: 'memory_integrate',
    description:
      '触发记忆整合 pass：无变化则跳过；有变化则重新生成 MEMORY.md 注册表与 memory_summary.md 总纲（幂等水印，不后退）。一般在会话收尾/后台运行时调用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          changed: { type: 'boolean', required: true },
          skipped: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.skipped
            ? '整合跳过（无变化）'
            : value.changed
              ? '整合完成（已更新 MEMORY.md / memory_summary.md）'
              : '整合无变化',
        },
      ],
    },
    async execute() {
      const r = withWriteSync(() => integrate())
      return { changed: r.changed, skipped: r.skipped }
    },
  })

  const precompactTool = defineTool({
    name: 'memory_precompact',
    description:
      '压缩前/会话关键时主动调用，防信息因上下文压缩丢失。把当前会话的关键要点写入本会话草稿（rollout_summaries/<sessionId>.md）并立即触发一次全局记忆整合（integrate），让关键信息在压缩前落盘。参数 content 为 agent 提炼的要点。',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'Agent 提炼的当前会话关键要点（语句化）。',
      },
      title: { type: 'string', description: '可选短标题。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          changed: { type: 'boolean', required: true },
          skipped: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `压缩前草稿已写入 ${value.file}（session ${value.sessionId}）；整合${value.skipped ? '跳过（无变化）' : value.changed ? '完成' : '无变化'}。`,
        },
      ],
    },
    async execute(args, exec) {
      const body = String(args.content || '').trim()
      if (!body) throw new Error('memory_precompact: content 不能为空')
      const sid = sessionIdOf(exec) || 'unknown'
      const cwd = cwdOf(exec)
      const file = writeSessionDraft(sid, cwd, args.title, body)
      const r = withWriteSync(() => integrate())
      // Stamp pipeline state so the session shows as summoned in the auto pipeline.
      const st = loadPipelineState()
      upsertPipelineSession(st, sid, { active: true, summarized: true })
      savePipelineState(st)
      return { file, sessionId: sid, changed: r.changed, skipped: r.skipped }
    },
  })

  ctx.tools.register(rememberTool)
  ctx.tools.register(recallTool)
  ctx.tools.register(forgetTool)
  ctx.tools.register(draftTool)
  ctx.tools.register(noteTool)
  ctx.tools.register(integrateTool)
  ctx.tools.register(precompactTool)
  ctx.tools.register(stage1DrainTool)

  // Seed the memory layout + integration on startup so the base files exist.
  integrate()

  // ── Phase 2: auto-trigger event listeners (cordis ctx.on) ─────────────────
  // Reference pattern: dsh-pet subscribes to `session/disposed` + `session/event`
  // via cordis ctx.on. We do the same, but ONLY snapshots inside the handler
  // (no long tasks, no cross-fiber work) and schedule the async pipeline via
  // kickPipeline. All disposers are collected and torn down through ctx.effect.
  const eventDisposers = [
    // Main trigger hook: the session is being disposed (ended). 阶段 A · 接线③: the
    // event handler is SHORT — it only enqueues a persistent stage-1 job (event-only,
    // no model call) and schedules drainStage1Jobs via setImmediate. watermark =
    // content fingerprint of the session (dedupe + new-activity signal).
    ctx.on('session/disposed', (session) => {
      if (config.autoTrigger === 'off') return
      const sid = session && session.id ? String(session.id) : ''
      if (sid) {
        try {
          const msgs = session && typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
          const raw = messagesToDraftBody(msgs)
          enqueueStage1JobFile(path.join(memoryRoot(), '.stage1-state.json'), sid, contentWatermark(raw))
        } catch (err) {
          try { console.error('[dsh-rollout] session/disposed enqueue error:', err) } catch {}
        }
      }
      // 阶段 A · 接线③：disposer 彻底只入队（事件回调短小，不跑模型），随后 setImmediate
      // 调度 drainStage1Jobs 消费到期 pending 作业（领取→锁外提炼→提交）。不再直接
      // kickPipeline('sessionEnd', session)——runPipeline/kickPipeline 保留但不由此调用。
      setImmediate(() => {
        drainStage1Jobs().catch((err) => {
          try { console.error('[dsh-rollout] stage-1 drain error:', err) } catch {}
        })
      })
    }),
    // Per-turn + compaction-start observation.
    ctx.on('session/event', (session, event) => {
      const type = event && event.type
      try {
        // Track activity so candidate idle-time is accurate (no full pipeline run).
        if (type === 'turn/end') {
          const sid = session && session.id ? String(session.id) : ''
          if (sid && config.autoTrigger !== 'off') {
            const st = loadPipelineState()
            upsertPipelineSession(st, sid, { active: true })
            savePipelineState(st)
          }
          return
        }
        // Compaction is about to start: the exact context-loss window memory_precompact
        // exists for. Only drain when precompactAuto is on (default off).
        if (type === 'compaction/start' && config.precompactAuto && config.autoTrigger !== 'off') {
          kickPipeline('preCompact', session)
        }
      } catch (err) {
        try {
          console.error('[dsh-rollout] session/event handler error:', err)
        } catch {}
      }
    }),
  ]
  ctx.effect(
    () => () => {
      for (const dispose of eventDisposers) dispose()
    },
    'dsh-rollout.eventsDispose',
  )

  // ── browser management page (HTTP JSON over the harness web server) ──────
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    const sortedEntries = () =>
      allEntries().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))

    const sendJson = (res, status, body) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    }

    const readBody = (req) =>
      new Promise((resolve, reject) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => resolve(chunks.map((c) => (typeof c === 'string' ? c : String(c))).join('')))
        req.on('error', reject)
      })

    const route = {
      kind: 'exact',
      path: '/dsh-rollout/entries',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, { entries: sortedEntries() })
            return
          }
          if (req.method === 'POST') {
            const raw = await readBody(req)
            let payload = {}
            try {
              payload = raw ? JSON.parse(raw) : {}
            } catch {
              sendJson(res, 400, { error: 'invalid JSON body' })
              return
            }
            if (payload.action === 'delete') {
              const id = typeof payload.id === 'string' ? payload.id : ''
              sendJson(res, 200, { deleted: id ? await withWrite(() => table.delete(id)) : false })
              return
            }
            if (payload.action === 'add') {
              const text = typeof payload.content === 'string' ? payload.content.trim() : ''
              if (!text) {
                sendJson(res, 400, { added: false, error: 'content required' })
                return
              }
              const id = makeId()
              await withWrite(() => table.put(id, {
                content: redactSecrets(text),
                tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
                createdAt: nowIso(),
                updatedAt: nowIso(),
                source: 'ui',
                ...(typeof payload.sessionId === 'string' && payload.sessionId
                  ? { sessionId: payload.sessionId }
                  : {}),
              }))
              sendJson(res, 200, { added: true, id, count: table.size })
              return
            }
            sendJson(res, 400, { error: 'unknown action' })
            return
          }
          sendJson(res, 405, { error: 'method not allowed' })
        } catch (err) {
          sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    }

    const overviewRoute = {
      kind: 'exact',
      path: '/dsh-rollout/overview',
      handler: async (req, res) => {
        try {
          const d = dirs()
          const summary = readMemorySummary()
          const registry = readText(path.join(d.root, 'MEMORY.md'))
          const drafts = listFiles(d.summaries)
            .sort()
            .map((f) => ({ file: f, ...parseDraft(path.join(d.summaries, f)) }))
          const notes = listFiles(d.notes).sort()
          sendJson(res, 200, {
            root: memoryRoot(),
            summary,
            registry,
            drafts,
            notes,
            entries: sortedEntries(),
          })
        } catch (err) {
          sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    }

    // ── /dsh-rollout/config — read + update the plugin config at runtime ─────
    const configDefaults = () => {
      try {
        return Config({})
      } catch {
        return {}
      }
    }
    const currentConfigView = () => {
      const defaults = configDefaults()
      const view = {}
      for (const f of CONFIG_FIELDS) {
        view[f.key] = config[f.key] !== undefined ? config[f.key] : defaults[f.key]
      }
      return view
    }

    const configRoute = {
      kind: 'exact',
      path: '/dsh-rollout/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, {
              config: currentConfigView(),
              defaults: configDefaults(),
              fields: CONFIG_FIELDS,
              root: memoryRoot(),
            })
            return
          }
          if (req.method === 'POST' || req.method === 'PUT') {
            const raw = await readBody(req)
            let body = {}
            try {
              body = raw ? JSON.parse(raw) : {}
            } catch {
              sendJson(res, 400, { saved: false, error: 'invalid JSON body' })
              return
            }
            const patch = pickEditable(body)
            if (!Object.keys(patch).length) {
              sendJson(res, 400, { saved: false, error: 'no editable config fields' })
              return
            }
            // Validate + fill defaults; an invalid value rejects without touching config.
            let merged
            try {
              merged = Config({ ...config, ...patch })
            } catch (err) {
              sendJson(res, 400, { saved: false, error: String((err && err.message) || err) })
              return
            }
            Object.assign(config, merged)
            saveSettings({ ...readSettings(), ...patch })
            sendJson(res, 200, {
              saved: true,
              config: currentConfigView(),
              defaults: configDefaults(),
              fields: CONFIG_FIELDS,
              root: memoryRoot(),
            })
            return
          }
          sendJson(res, 405, { error: 'method not allowed' })
        } catch (err) {
          sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    }

    // ── /dsh-rollout/export — package the whole memories/ tree for backup ────
    function walkFiles(dir) {
      const out = []
      let items = []
      try {
        items = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return out
      }
      for (const it of items) {
        const full = path.join(dir, it.name)
        if (it.isDirectory()) out.push(...walkFiles(full))
        else if (it.isFile()) {
          out.push({
            path: path.relative(memoryRoot(), full).replace(/\\/g, '/'),
            full,
          })
        }
      }
      return out
    }

    function buildExportBundle() {
      const files = walkFiles(memoryRoot()).map((f) => ({
        path: f.path,
        content: fs.readFileSync(f.full).toString('base64'),
      }))
      return {
        format: 'dsh-rollout-memory-backup',
        version: 1,
        exportedAt: nowIso(),
        root: 'memories',
        fileCount: files.length,
        files,
        entries: allEntries(),
      }
    }

    const exportRoute = {
      kind: 'exact',
      path: '/dsh-rollout/export',
      handler: (req, res) => {
        try {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          const bundle = buildExportBundle()
          const stamp = nowIso().replace(/[:.]/g, '-').slice(0, 19)
          const body = JSON.stringify(bundle, null, 2)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Content-Disposition', `attachment; filename="dsh-rollout-memories-${stamp}.json"`)
          res.end(body)
        } catch (err) {
          sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    }

    // ── /dsh-rollout/import — restore a backup (back up existing first) ──────
    /** Normalize a bundle-relative path, rejecting traversal/absolute variants. */
    function safeRelPath(p) {
      const norm = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '')
      const parts = norm.split('/').filter(Boolean)
      const clean = []
      for (const part of parts) {
        if (part === '.') continue
        if (part === '..') throw new Error('invalid path: traversal')
        clean.push(part)
      }
      return clean.join(path.sep)
    }

    async function importBundle(rawText) {
      // Global import mutex: only one destructive import runs at a time. The
      // import route has no other guard, so two concurrent imports could share
      // the same tmp/backup dirs (the old names were timestamp-only, to the
      // second) and delete each other's in-flight state. Imports are destructive
      // and have no natural ordering, so the second caller is REJECTED with a
      // retryable conflict rather than queued — "another import in progress,
      // retry shortly" is the safe semantics.
      // Global write-maintenance lock: import is a writer, so it acquires the
      // shared write lock (not just import↔import). A concurrent writer (UI add,
      // tool write, Phase 2, another import) is REJECTED — never run concurrently
      // and corrupt each other. Import conflicts surface as HTTP 409.
      return withWrite(() => importBundleUnlocked(rawText), {
        importConflict: true,
        conflictMessage: '[dsh-rollout] another import is already in progress — retry shortly',
      })
    }

    async function importBundleUnlocked(rawText) {
      // Hard limits (defense-in-depth): reject oversized/overly-many payloads
      // before any parsing or unpacking. Keep the live tree untouched.
      const MAX_BUNDLE_BYTES = 50 * 1024 * 1024
      const MAX_FILE_COUNT = 2000
      const MAX_ENTRY_COUNT = 10000
      const MAX_FILE_BYTES = 10 * 1024 * 1024
      const MAX_TOTAL_BYTES = 50 * 1024 * 1024
      if (rawText.length > MAX_BUNDLE_BYTES) {
        throw new Error('invalid bundle: payload exceeds ' + MAX_BUNDLE_BYTES + ' bytes')
      }
      let bundle
      try {
        bundle = JSON.parse(rawText)
      } catch {
        throw new Error('invalid bundle: not valid JSON')
      }
      if (!bundle || typeof bundle !== 'object' || bundle.format !== 'dsh-rollout-memory-backup') {
        throw new Error('invalid bundle: not a dsh-rollout memory export')
      }

      const root = memoryRoot()
      // Per-import UUID so tmp/backup dirs can never collide with a concurrent or
      // leftover run (the old timestamp-only stamp could collide within the same
      // second, which is exactly the concurrent-mutual-deletion race we avoid).
      const uid =
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const tmpRoot = path.join(dsHome(), `memories-import-tmp-${uid}`)
      const backupDir = path.join(dsHome(), `memories-backup-${uid}`)
      const backupEntriesFile = path.join(backupDir, 'entries.json')
      const backupFilesDir = path.join(backupDir, 'files')

      // Put a raw entry object back into the table, normalizing against the schema.
      const putEntryRecord = async (id, item) =>
        table.put(id, {
          content: redactSecrets(String(item.content)),
          tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : nowIso(),
          updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : nowIso(),
          source: typeof item.source === 'string' ? item.source : 'ui',
          ...(typeof item.sessionId === 'string' && item.sessionId ? { sessionId: item.sessionId } : {}),
        })

      /** Restore the files tree + entries table from the pre-import backup. */
      const restoreBackup = async () => {
        if (exists(root)) fs.rmSync(root, { recursive: true, force: true })
        if (exists(backupFilesDir)) {
          fs.mkdirSync(root, { recursive: true })
          fs.cpSync(backupFilesDir, root, { recursive: true })
        }
        for (const key of Array.from(table.keys())) await table.delete(key)
        let saved = []
        try {
          saved = JSON.parse(readText(backupEntriesFile))
        } catch {
          saved = []
        }
        if (Array.isArray(saved)) {
          for (const e of saved) await putEntryRecord(e.id, e)
        }
      }

      try {
        // 1) FULL validation + unpack into a TEMP dir, BEFORE touching any live
        //    state: verify the bundle format, every file path (via safeRelPath, which
        //    rejects traversal/absolute), reject duplicate paths, and validate every
        //    entry schema (content non-empty). Any failure here throws before the
        //    switch, so the live memories tree + entries table are left untouched.
        const fileEntries = []
        const seenPaths = new Set()
        const files = Array.isArray(bundle.files) ? bundle.files : []
        if (files.length > MAX_FILE_COUNT) {
          throw new Error('invalid bundle: too many files (' + files.length + ' > ' + MAX_FILE_COUNT + ')')
        }
        let totalBytes = 0
        for (const f of files) {
          if (!f || typeof f.path !== 'string' || !f.path) {
            throw new Error('invalid bundle: file entry missing path')
          }
          const rel = safeRelPath(f.path)
          if (!rel) throw new Error('invalid bundle: file entry has empty path')
          const key = rel.replace(/\\/g, '/')
          if (seenPaths.has(key)) throw new Error('invalid bundle: duplicate path ' + key)
          seenPaths.add(key)
          const raw = String(f.content || '')
          const compact = raw.replace(/\s+/g, '')
          if (raw && !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
            throw new Error('invalid bundle: file ' + key + ' has invalid base64 content')
          }
          const decoded = Buffer.from(compact, 'base64')
          if (raw && decoded.length === 0) {
            throw new Error('invalid bundle: file ' + key + ' has invalid base64 content')
          }
          if (decoded.length > MAX_FILE_BYTES) {
            throw new Error('invalid bundle: file ' + key + ' exceeds max size')
          }
          totalBytes += decoded.length
          if (totalBytes > MAX_TOTAL_BYTES) {
            throw new Error('invalid bundle: decoded total exceeds max size')
          }
          fileEntries.push({ rel, content: decoded })
        }

        const validatedEntries = []
        const seenIds = new Set()
        const entries = Array.isArray(bundle.entries) ? bundle.entries : []
        if (entries.length > MAX_ENTRY_COUNT) {
          throw new Error('invalid bundle: too many entries (' + entries.length + ' > ' + MAX_ENTRY_COUNT + ')')
        }
        for (const item of entries) {
          if (!item || typeof item.content !== 'string' || !item.content.trim()) {
            throw new Error('invalid bundle: entry missing non-empty content')
          }
          const id = typeof item.id === 'string' && item.id ? item.id : makeId()
          if (seenIds.has(id)) throw new Error('invalid bundle: duplicate entry id ' + id)
          seenIds.add(id)
          validatedEntries.push({ id, item })
        }

        // Unpack the validated file set into the temp dir (raw bytes, validated paths).
        if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true })
        for (const fe of fileEntries) {
          const target = path.join(tmpRoot, fe.rel)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, fe.content)
        }

        // 2) Back up the FULL current state — the file tree AND the entries table —
        //    so a failed switch can be rolled back completely (the old code only
        //    copied memories/, which could not recover the dsh_rollout entries table).
        if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true })
        fs.mkdirSync(backupDir, { recursive: true })
        if (exists(root)) fs.cpSync(root, backupFilesDir, { recursive: true })
        fs.writeFileSync(backupEntriesFile, JSON.stringify(allEntries(), null, 2))

        // 3) Best-effort transactional replace — NOT a filesystem-atomic rename
        //    (the configured memoryRoot may live on a different volume than
        //    dsHome(), so rename-to-swap is not reliably same-volume). We clear
        //    the old tree, copy the temp tree in, then restore the entries table.
        //    On ANY failure roll back to the pre-import state. The import mutex +
        //    per-import UUID above prevent concurrent imports from corrupting each
        //    other's state.
        try {
          if (exists(root)) fs.rmSync(root, { recursive: true, force: true })
          fs.mkdirSync(root, { recursive: true })
          fs.cpSync(tmpRoot, root, { recursive: true })
          for (const key of Array.from(table.keys())) await table.delete(key)
          for (const { id, item } of validatedEntries) await putEntryRecord(id, item)
          // 4) Regenerate consistency artifacts. If this fails, the import transaction
          //    is STILL a failure ("switch succeeded but integration failed") — roll
          //    everything back so the live tree + derived artifacts stay consistent
          //    with the prior validated version.
          integrate()
        } catch (err) {
          try {
            await restoreBackup()
          } catch (rollbackErr) {
            try {
              console.error('[dsh-rollout] import rollback failed:', rollbackErr)
            } catch {}
            // The rollback itself failed: the client MUST know — with the backup
            // path — that the memory tree is in an uncertain state and a human
            // restore is required. Never let this degrade into a plain error that
            // implies the original state is still safe.
            const manual =
              'import failed AND automatic rollback ALSO failed. The memory tree is in an ' +
              'uncertain state — manual recovery is REQUIRED. Restore the file tree from ' +
              `"${backupFilesDir}" and the long-term entries table from "${backupEntriesFile}". ` +
              `Import error: ${err && err.message}. Rollback error: ${rollbackErr && rollbackErr.message}.`
            const f = new Error('[dsh-rollout] ' + manual)
            f.rollbackFailed = true
            f.backupPath = backupDir
            f.rollbackError = rollbackErr
            throw f
          }
          // Rollback succeeded: the pre-import state was restored. Surface it as a
          // retryable failure WITHOUT implying the original state was lost.
          const retryable = new Error(
            '[dsh-rollout] import failed, but the previous memory was restored (nothing lost; you can retry). ' +
              `Import error: ${err && err.message}.`,
          )
          retryable.rollbackFailed = false
          throw retryable
        }

        return {
          ok: true,
          rollbackFailed: false,
          fileCount: fileEntries.length,
          entryCount: validatedEntries.length,
          backup: path.basename(backupDir),
        }
      } finally {
        // Always clean up the temp import dir, regardless of success/failure.
        try {
          if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true })
        } catch {}
      }
    }

    const importRoute = {
      kind: 'exact',
      path: '/dsh-rollout/import',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          const raw = await readBody(req)
          if (!raw) {
            sendJson(res, 400, { ok: false, error: 'empty body' })
            return
          }
          const result = await importBundle(raw)
          sendJson(res, 200, result)
        } catch (err) {
          const rollbackFailed = !!(err && err.rollbackFailed)
          const body = { ok: false, rollbackFailed }
          if (rollbackFailed && err && err.backupPath) body.backupPath = err.backupPath
          body.error = String((err && err.message) || err)
          const conflict = !!(err && err.importConflict)
          sendJson(res, conflict ? 409 : 400, body)
        }
      },
    }

    const disposeRoute = webServer.register(route)
    const disposeOverview = webServer.register(overviewRoute)
    const disposeConfig = webServer.register(configRoute)
    const disposeExport = webServer.register(exportRoute)
    const disposeImport = webServer.register(importRoute)
    ctx.effect(() => () => {
      disposeRoute()
      disposeOverview()
      disposeConfig()
      disposeExport()
      disposeImport()
    }, 'dsh-rollout.routeDispose')
  }
}
