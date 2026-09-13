// dsh-memory_rollout — Codex-adapted cross-session memory vault for DeepSeek Harness (Host half).
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
// 'dsh_rollout' while the npm package is 'dsh-memory_rollout'.
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

export const name = 'dsh-memory_rollout'

// Required services this plugin uses via direct props (ctx.tools / ctx.systemPrompt).
// webServer is read lazily with ctx.get('webServer') so it needs no inject entry.
// P0-R2-3：`sessionQuery` 是 Stage 1 自动生成读取会话的唯一来源，声明为必需服务——
// 缺失时插件无法加载/自动生成（启动即明确失败/禁用生成），绝不再把「能力缺失」伪装成
// empty_source 静默成功；overview 的 capabilities 亦显示该能力是否可用。
export const inject = ['storageDomain', 'tools', 'systemPrompt', 'sessionQuery']

/** Optional deployment tuning. */
export const Config = z.object({
  /** Maximum entries surfaced in the recall tool result. */
  recallLimit: z.number().step(1).min(1).max(50).default(10),
  /** M1：是否向模型提供记忆（注入 + recall）。false = 不注入、不召回（无记忆生成的运行时开关）。 */
  useMemories: z.boolean().default(true),
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
  /** M2 唯一公开自动生成开关：是否让会话贡献未来记忆（自动 Phase 1）。false = 会话结束/压缩时不自动入队提炼；显式 memory_precompact / memory_remember 等工具仍可用。与 useMemories（使用旧记忆）独立。 */
  generateMemories: z.boolean().default(true),
  /** [兼容保留，非公开 UI] 旧版 autoTrigger。仅用于一次性迁移：存在旧设置且 autoTrigger==='off' 且 generateMemories 未显式设置时，映射为 generateMemories=false。不建议直接使用；若显式设置且生成开关未设则回退此值。 */
  autoTrigger: z.string().pattern(/^(sessionEnd|off)$/).default('sessionEnd'),
  /** Max LLM extraction attempts per calendar day (quota counted by model attempts, not written outputs). */
  maxModelAttemptsPerDay: z.number().step(1).min(1).max(1000).default(24),
  /** [兼容保留，非公开 UI] 旧版 precompactAuto。M2：compaction/start 是活跃会话压缩事件，不再作为自动持久记忆入口（退役自动 Phase 1 入队）；保留仅兼容旧配置。显式 memory_precompact 始终可用。 */
  precompactAuto: z.boolean().default(false),

  // ── Phase 3: LLM extraction (ctx.llm) ─────────────────────────────────────
  // Tunes the LLM call that refines a literal snapshot into a {raw_memory,
  // rollout_summary, slug} summary. Extraction consumes quota: it runs only
  // inside the stage-1 drain for an enqueued session job, gated by
  // maxModelAttemptsPerDay — never at startup and never per-turn. If the LLM
  // service is unavailable or the call fails, the job is marked failed and
  // stays pending for a later retry (no dirty memory written).
  /** Registered provider route for extraction; empty = harness default provider (agentDefaultModel). */
  extractProvider: z.string().default(''),
  /** Provider model id for extraction; empty = harness default model. */
  extractModel: z.string().default(''),
  /** Reasoning effort for extraction (adapter vocab, e.g. off/low/high/max); empty = model default. */
  extractReasoningEffort: z.string().default('low'),
  /** Coarse input-token cap for the transcript fed to the LLM (chars ≈ tokens × 4); longer input is truncated. */
  maxExtractTokens: z.number().step(500).min(500).max(200000).default(8000),
  /** Provider route for the Phase 2 consolidation (cross-session integrate) LLM; empty = harness default (agentDefaultModel). */
  consolidationProvider: z.string().default(''),
  /** Provider model id for the Phase 2 consolidation LLM; empty = harness default model. */
  consolidationModel: z.string().default(''),
  /** Reasoning effort for the consolidation LLM (adapter vocab, e.g. off/low/high/max); empty = model default. */
  consolidationReasoningEffort: z.string().default(''),
  /** t164（R1 §6.2）：**可选诊断**开关，默认关。开 = 每批额外跑「疑似丢旧结论」启发式检查（仅提示、不阻断、不持久化）；关 = 完全不跑。 */
  phase2Diagnostics: z.boolean().default(false),
  /**
   * t187：① **受限执行者**开关（默认开）。开 = 整合批在模型调用前先按 codex 形态建一个「受限会话」
   * （插件自建会话：`meta.cwd` = 记忆根、`setup` 里 restrict 到最小工具集并 deny `subagent`、
   * 会话沙箱 `workspace-write`、审批 `never`）。宿主没有 `agents` 服务或建会话失败 ⇒ 只记 warn 并
   * **继续**走既有单次 JSON 路径（批的成败不受影响）。**第一验收项（`meta.cwd` 被真实宿主接受）
   * 未过时可临时置 false 关掉。**
   */
  consolidationExecutor: z.boolean().default(true),
  /**
   * t189（②·门槛一）：**一次启动最多处理多少个来源**（stage-1 提炼）。抄 codex
   * `max_rollouts_per_startup = 2`（镜像 `codex-rs/config/src/types.rs` L50/L317-319，范围 1–128）。
   * 只约束"启动那一趟"的 drain；其余来源由后续非启动趟次/事件继续处理（不丢）。
   */
  maxSourcesPerStartup: z.number().step(1).min(1).max(128).default(2),
  /**
   * t189（②·门槛二）：**当日额度剩余低于此百分比时，不启动新的整合**（自动路径）。抄 codex
   * `min_rate_limit_remaining_percent = 25`（镜像 `codex-rs/config/src/types.rs` L53/L322-324）。
   * 语义与 codex 一致：`已用% ≤ 100 − 阈值` 才开工 ⇒ 剩余 ≥ 阈值（**恰好等于阈值 ⇒ 放行**）。
   * 只拦自动路径；显式 `memory__phase2_integrate` 不受此门限制。
   */
  minRemainingQuotaPercent: z.number().min(0).max(100).default(25),
  /**
   * t195（④ 照 codex）：记忆条目的**资格窗口** —— 「上次使用」超过这么多天即**失去资格**（不再只是降权）。
   * 抄 codex `max_unused_days`，默认 **30**（镜像 `codex-rs/config/src/types.rs` L55 / L313-314 / L360）。
   * codex 语义（镜像 `codex-rs/state/src/runtime/memories.rs` L439-446、L473-477）：用过 ⇒ `last_usage`
   * 在窗口内；**从未用过** ⇒ 看来源新鲜度（本地对应 `updatedAt`）是否在窗口内。
   */
  maxUnusedDays: z.number().step(1).min(0).max(3650).default(30),
})

// ── Settings-page config form (single source of truth for the client form) ──
// Each editable config field described for the settings page. The client renders
// this list generically (select / number / toggle / text); the host uses it to
// validate + persist runtime config updates. Fields NOT listed here (memoryRoot)
// are intentionally read-only.
const CONFIG_FIELDS = [
  {
    key: 'generateMemories',
    label: '生成新记忆（generateMemories）',
    type: 'toggle',
    hint: 'M2：是否让会话贡献未来记忆（自动 Phase 1）。true = 会话结束后自动入队提炼；false = 不自动生成（手动 memory_precompact / memory_remember 仍可用）。与「使用记忆 useMemories」独立。默认 true。',
  },
  { key: 'useMemories', label: '使用记忆（useMemories）', type: 'toggle', hint: 'M1：是否向模型提供记忆（注入 + recall）。默认 true；关闭后不注入、不召回（生成仍可独立开关）。' },
  { key: 'summaryTokens', label: '摘要 token 预算（summaryTokens）', type: 'number', hint: '注入 system prompt 的 memory_summary.md 最大 token 数。越大注入总纲越多、记忆更好用，但占更多上下文。默认 4000，最大 12000。' },
  { key: 'maxQuickSteps', label: '快速记忆步数（maxQuickSteps）', type: 'number', hint: '快速记忆通道 quick memory pass 的搜索步数预算，越小越省。默认 5，≤12。' },
  { key: 'recallLimit', label: '回忆最大条目（recallLimit）', type: 'number', hint: 'memory_recall 一次返回的最大条目数。默认 10，≤50。' },
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
  { key: 'consolidationProvider', label: '整合 Provider（consolidationProvider）', type: 'text', hint: 'Phase 2 全局整合（跨会话）用的 provider。留空 = 用 settings 里 agent-default-model 的 provider。' },
  { key: 'consolidationModel', label: '整合模型（consolidationModel）', type: 'text', hint: 'Phase 2 全局整合用的模型。留空 = 用 agent-default-model 的模型。' },
  {
    key: 'consolidationReasoningEffort',
    label: '整合推理强度（consolidationReasoningEffort）',
    type: 'select',
    options: ['', 'off', 'low', 'high', 'max'],
    hint: '强调整合时的模型推理强度。留空 = 模型默认；off 不推理。若模型拒绝该值会自动去掉重试。',
  },
  {
    key: 'phase2Diagnostics',
    label: '整合诊断（phase2Diagnostics，可选）',
    type: 'toggle',
    hint: 't164：**可选诊断**，默认关。开启后每批额外跑一次「疑似丢旧结论」的启发式检查，把结果放进返回体 diagnostics 并 console.warn。它只看文本变化，区分不了「合理归并/来源退出/语义改写/真丢失」，**不是闸门、不阻断发布、也不写进作业记录**；压缩批整类豁免。关掉即完全不跑。',
  },
  {
    key: 'maxUnusedDays',
    label: '条目资格窗口（maxUnusedDays）',
    type: 'number',
    hint: 't195：**上次使用超过这么多天的条目即失去资格**（不再召回），抄 codex `max_unused_days`（默认 30）。从未用过的条目按其更新时间判断是否仍在窗口内（对齐 codex「从未用过但来源仍新鲜 ⇒ 保留」）。范围 0–3650；0 = 只有刚用过的才具资格（最严）。',
  },
  {
    key: 'consolidationExecutor',
    label: '受限执行者（consolidationExecutor）',
    type: 'toggle',
    hint: 't187：**默认开**。整合批在模型调用前先建一个「受限会话」：cwd = 记忆根（写边界随之落在记忆根）、工具 restrict 到最小集并 deny subagent、会话沙箱 workspace-write、审批 never —— 即 codex 的整合执行体形态（插件自建会话，不是子代理工具）。宿主无 agents 服务或建会话失败只记 warn、**不影响批**；**第一验收项（meta.cwd 被真实宿主接受）需重启后实测，未过时可置 false 关掉**。',
  },
  {
    key: 'maxSourcesPerStartup',
    label: '启动来源上限（maxSourcesPerStartup）',
    type: 'number',
    hint: 't189：**一次启动最多处理多少个来源**（stage-1 提炼）。默认 2（抄 codex `max_rollouts_per_startup`）。只约束启动那一趟 drain，剩下的来源由后续趟次/事件继续处理，不会丢。范围 1–128。',
  },
  {
    key: 'minRemainingQuotaPercent',
    label: '整合额度门（minRemainingQuotaPercent）',
    type: 'number',
    hint: 't189：**当日额度剩余低于此百分比时，暂不启动新的整合**（自动路径）。默认 25（抄 codex `min_rate_limit_remaining_percent`）。剩余恰好等于阈值时**放行**；显式 memory__phase2_integrate 不受此门限制。范围 0–100。',
  },
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
  // 阶段 C（§10.1）：status：active | superseded | forgotten（P1-4 生命周期谓词）；superseded_by 记录
  // 替代其事实的条目 id（可追替代事实）。二者都由生命周期写操作设置，普通 remember 默认 active/''。
  status: zod.string().default('active'),
  superseded_by: zod.string().default(''),
  // t195（④ 照 codex）：**使用计数 + 上次使用时间**。对齐 codex 的 `stage1_outputs.usage_count` /
  //   `last_usage`（镜像 `codex-rs/state/src/runtime/memories.rs` L75-76 累加点、L479-481 排序键）。
  //   **向后兼容（高风险点）**：旧条目没有这两个字段 ⇒ 由下面的 `.default(...)` 在**读时**补默认
  //   （0 / '' = 从未使用），**不重写任何既有真实数据**；只有真的发生一次"使用累加"才写回这两个字段。
  usage_count: zod.number().int().min(0).default(0),
  last_usage: zod.string().default(''),
})

// ── Stage 1 持久作业表（第三轮返工第 2 步）─────────────────────────────────────
// 状态字串沿用 Phase A 既有语义（保持阶段 1/2 业务逻辑与既有测试断言不动）：
//   pending → running → succeeded_with_output | succeeded_no_output | failed_retryable → failed_terminal
// 设计稿中的 retry_wait 对应「failed_retryable（available_at 到期的等待状态）」，
// succeeded 对应 succeeded_with_output、no_output 对应 succeeded_no_output。
// valueSchema 用 .passthrough()：旧 .stage1-state.json 迁移来的记录含额外字段
// （last_error_code / effective_model / completed_at 等），读盘时不被 zod 剥掉。
const stage1JobSchema = zod.object({
  id: zod.string(),
  session_id: zod.string(),
  source_watermark: zod.string(),
  status: zod.enum([
    'pending',
    'running',
    'failed_retryable',
    'failed_terminal',
    'succeeded_with_output',
    'succeeded_no_output',
  ]),
  attempt_count: zod.number().int().min(0),
  max_attempts: zod.number().int().min(1),
  available_at: zod.string(),
  lease_owner: zod.string().default(''),
  lease_expires_at: zod.string().default(''),
  last_error: zod.string().default(''),
  created_at: zod.string(),
  updated_at: zod.string(),
  completed_at: zod.string().default(''),
  // 旧文件记录里的扩展字段（脱敏/提示词/解析逻辑不变，仅需读写兼容）。
  last_error_code: zod.string().default(''),
  last_error_message: zod.string().default(''),
  effective_provider: zod.string().default(''),
  effective_model: zod.string().default(''),
  effective_reasoning_effort: zod.string().default(''),
}).passthrough()

// P1 归档协议：seen-index（轻量去重索引）。stage1_jobs 归档后，同内容再 dispose 仍需去重，
// 靠 stage1_seen（key=session::watermark，value={session_id, source_watermark, created_at}）保留
// 「已提炼过」的事实，使 stage1_jobs 可以安全归档而不破坏去重语义。
const stage1SeenSchema = zod.object({
  session_id: zod.string(),
  source_watermark: zod.string(),
  created_at: zod.string(),
}).passthrough()

const stage1OutputSchema = zod.object({
  // 沿用既有的 stage-1 产物形状（Phase 2 selectPhase2Inputs / buildConsolidationPrompt
  // 直接消费这些字段），只是把存储从 .stage1-state.json 挪到表。
  session_id: zod.string(),
  source_watermark: zod.string(),
  rollout_summary: zod.string().default(''),
  raw_memory_or_evidence_excerpt: zod.string().default(''),
  rollout_slug: zod.string().default(''),
  keywords: zod.string().default(''),
  content_hash: zod.string().default(''),
  generated_at: zod.string(),
  effective_provider: zod.string().default(''),
  effective_model: zod.string().default(''),
  selected_for_phase2: zod.boolean().default(false),
  // 设计稿产物字段，逐步接入（Phase 2 批次/版本化在第 3 步接入）。
  job_id: zod.string().default(''),
  outcome: zod.string().default(''),
  phase2_batch_id: zod.string().default(''),
  // t170：终态失败批的绑定释放计数 + 「显式放弃」登记（见 reconcilePhase2Bindings）。
  // 原实现刻意**不解绑** failed_terminal 批（防"terminal→解绑→新建批"无限烧 LLM），
  // 代价是这些来源**永久卡死且无人登记**。现在改为「有界释放」：每次释放 +1，
  // 达 MAX_PHASE2_RELEASES 后置 abandoned=true（不再重选、可见、可查）。
  phase2_release_count: zod.number().int().min(0).default(0),
  phase2_abandoned: zod.boolean().default(false),
  phase2_abandoned_reason: zod.string().default(''),
}).passthrough()

// 跨日模型预算 + Phase 2 水位/错误（原 .stage1-state.json.global）。单条记录，key='meta'。
const stage1MetaSchema = zod.object({
  runDay: zod.string().default(''),
  modelAttemptsToday: zod.number().int().min(0).default(0),
  lastSuccessWatermark: zod.string().default(''),
  lastPhase2At: zod.string().default(''),
  phase2_last_error: zod.string().default(''),
}).passthrough()

// ── t80：记忆总纲尺寸闸门（三层）——模块级常量与纯助手 ────────────────────────
// 与 readMemorySummary() 的注入闸门同尺（chars ≈ tokens × 4）；生成上限按同一把尺子派生，
// 消除「文件 222KB / 注入 16K」的错配（见 t77 生成机制排查 / t79 Codex 借鉴）。
const SUMMARY_CHARS_PER_TOKEN = 4
const SUMMARY_BUDGET_RATIO = 0.9
const REGISTRY_BUDGET_RATIO = 1.5
const PROMPT_MAX_INPUTS = 20
const PROMPT_PER_INPUT_CHARS = 600
// S0-2 起**退役**：当前权威文件不再按字符预算截断（改为「整篇读入 + 增量编辑 + 超硬顶 fail-closed」）。
// 这两个常量保留仅为历史/兼容引用，**不再作用于 current 文件**。
const PROMPT_CURRENT_SUMMARY_CHARS = 12000
const PROMPT_CURRENT_REGISTRY_CHARS = 6000
const TRUNCATION_MARK = '\n…（截断）'
// S0-2（2026-09-13）：**当前权威文件不再截断**。旧路径把"当前总纲/注册表"按 12,000/6,000 截断后交给
// 模型做**全文替换**——模型看不到的尾部结论会被静默丢掉（注册表侧实测已越线）。现在：整篇读入 +
// 增量编辑（见 buildConsolidationPrompt 的 INCREMENTAL MERGE 段）；只有整篇超过下面这条**硬顶**时
// 才 fail-closed（明确失败，绝不静默砍尾）。
const PROMPT_CURRENT_HARD_MAX_CHARS = 200000

/** 上限参数化（t80 选项2）：由 summaryTokens 派生 memory_summary 字符上限。纯函数，可单测。 */
export function summaryCapFromTokens(tokens) {
  const t = Number(tokens) > 0 ? Number(tokens) : 4000
  return Math.max(2000, Math.floor(t * SUMMARY_CHARS_PER_TOKEN * SUMMARY_BUDGET_RATIO))
}

/** 上限参数化：registry（MEMORY.md）字符上限。纯函数，可单测。 */
export function registryCapFromTokens(tokens) {
  const t = Number(tokens) > 0 ? Number(tokens) : 4000
  return Math.max(4000, Math.floor(t * SUMMARY_CHARS_PER_TOKEN * REGISTRY_BUDGET_RATIO))
}

/** 代码点安全截断（避免切断代理对），带显式截断标记。纯函数，可单测。 */
export function clampChars(s, max) {
  const t = String(s ?? '')
  const lim = Number(max)
  if (!(lim > 0)) return t
  const cp = Array.from(t)
  return cp.length <= lim ? t : cp.slice(0, lim).join('') + TRUNCATION_MARK
}

/**
 * L1 输入限量（t80）：按预算裁剪喂给整合模型的输入。纯函数，可单测。
 * 返回 { inputs, currentSummary, currentRegistry, droppedInputs }。
 */
export function clampPromptInputs(inputs, currentSummary, currentRegistry, caps = {}) {
  const maxIn = Number(caps.maxInputs) > 0 ? Number(caps.maxInputs) : PROMPT_MAX_INPUTS
  const perIn = Number(caps.perInputChars) > 0 ? Number(caps.perInputChars) : PROMPT_PER_INPUT_CHARS
  const list = Array.isArray(inputs) ? inputs : []
  let clampedInputs = 0
  let incrementalCharsCut = 0
  const kept = list.slice(0, maxIn).map((it) => {
    const before = String((it && it.rollout_summary) ?? '')
    const after = clampChars(it && it.rollout_summary, perIn)
    if (after !== before) {
      clampedInputs++
      incrementalCharsCut += Math.max(0, Array.from(before).length - Array.from(after).length)
    }
    return { ...it, rollout_summary: after }
  })
  // S0-2：**当前权威文件整篇原样传入，不再截断**（截断 = 静默丢结论）。`caps.currentSummaryChars` /
  // `caps.currentRegistryChars` 仍可传入，但**不再作用于 current 文件**（保留参数仅为签名兼容）。
  const rawSummary = String(currentSummary ?? '')
  const rawRegistry = String(currentRegistry ?? '')
  return {
    inputs: kept,
    currentSummary: rawSummary,
    currentRegistry: rawRegistry,
    droppedInputs: Math.max(0, list.length - kept.length),
    // 可观测（S0-2）：本批增量输入里被截断的条数 / 被砍掉的字符总量 / 每条上限；当前权威文件截断恒为 false。
    clampedInputs,
    incrementalCharsCut,
    perInputLimit: perIn,
    truncatedCurrent: { summary: false, registry: false },
    currentChars: { summary: Array.from(rawSummary).length, registry: Array.from(rawRegistry).length },
  }
}

/**
 * S0-2：当前权威文件是否超出**硬顶**（超了就必须**明确失败**，绝不截断）。
 * 返回 ''（未超）或 `summary(123>200000)` 这类诊断串。纯函数，可单测。
 */
export function currentTooLargeDiagnostic(summary, registry, hardMax = PROMPT_CURRENT_HARD_MAX_CHARS) {
  const cap = Number(hardMax) > 0 ? Number(hardMax) : PROMPT_CURRENT_HARD_MAX_CHARS
  const s = Array.from(String(summary ?? '')).length
  const r = Array.from(String(registry ?? '')).length
  const bad = []
  if (s > cap) bad.push(`summary(${s}>${cap})`)
  if (r > cap) bad.push(`registry(${r}>${cap})`)
  return bad.join(',')
}

/**
 * t164（R1 §6.3）：**完整请求预算**——整批请求（当前两文件之和 + 全部 memory_changes + 增量输入
 * + 提示词骨架 + 输出预留）的字符硬顶。与 `PROMPT_CURRENT_HARD_MAX_CHARS` 的分工：
 *   前者 = **单文件**组件级早退（便宜的快检）；本条 = **整个请求**的预算。
 * 超预算 ⇒ **明确失败**（fail-closed）：绝不静默截断，也不靠放大硬顶蒙过去。单位：码点。
 */
export const REQUEST_HARD_MAX_CHARS = 200000

// ─────────────────────────────────────────────────────────────────────────────
// t187：① 受限执行者（codex 形态）与相位 2 作业租约（照 codex 基准）
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 相位 2 作业租约 **3600s**（照 codex 基准：镜像 `codex-rs/memories/write/src/lib.rs`
 * L84 `JOB_LEASE_SECONDS = 3_600`）。放长理由：整合执行体要跑多轮工具调用，60s 太紧；
 * 代价如实登记：崩溃后"租约到期才被接管"的等待从 ≤60s 变成 ≤3600s（存活期由心跳续租）。
 */
export const PHASE2_LEASE_MS = 3600000
/** 租约心跳 **20s**（不变）：3600s ÷ 20s = 180 拍，单拍丢失无害（幂等续租）。 */
export const HEARTBEAT_INTERVAL_MS = 20000
/** 受限执行者的沙箱模式：写边界 = 该会话的 cwd（`dsh-sandbox-policy` 的 resolve 语义）。 */
export const CONSOLIDATION_SANDBOX_MODE = 'workspace-write'
/** 受限执行者的审批策略 `never`（不弹审批；越界走 fail-closed 而不是等人）。 */
export const CONSOLIDATION_APPROVAL_POLICY = 'never'
/** 最小工具集：只留"读写记忆根"所需的文件类工具（不含 shell / 网络 / 委派 / 会话类工具）。 */
export const CONSOLIDATION_TOOL_ALLOW = ['read', 'write', 'edit', 'glob', 'grep']
/** 显式拒绝：整合执行体不得再派子代理（禁递归委派）。 */
export const CONSOLIDATION_TOOL_DENY = ['subagent']
/**
 * **残余面（如实登记，不掩饰）**：DSH 沙箱**没有网络维度**（`dsh-sandbox`：“Network and process
 * visibility are outside this vocabulary”）⇒「无网」只能靠上面的工具白名单实现，**不是硬边界**：
 * 白名单里没有 shell，但这不是内核级禁网。此条为已知残差，不声称已解决。
 */
export const CONSOLIDATION_NETWORK_RESIDUAL =
  'network-not-sandboxable: DSH sandbox has no network dimension; no-network is enforced by the tool allow-list only (not a kernel boundary)'

// ─────────────────────────────────────────────────────────────────────────────
// t189：② 两道启动门槛（抄 codex）—— 纯函数，供启动趟与整合入口调用
//   codex 依据（本地镜像 `_ref-codex\`，commit a592c38c16cdd7623dacc9168926ebccedfb67d3）：
//     - `codex-rs/config/src/types.rs` L50 `DEFAULT_MEMORIES_MAX_ROLLOUTS_PER_STARTUP = 2`
//       / L317-319「Maximum number of rollout candidates processed per pass」
//     - 同文件 L53 `DEFAULT_MEMORIES_MIN_RATE_LIMIT_REMAINING_PERCENT = 25` / L322-324「Minimum
//       remaining percentage required in Codex rate-limit windows before memory startup runs」
//     - 两道门在启动顺序里的位置：`codex-rs/memories/write/src/start.rs` L75-86（**先 prune，再判额度**）
// ─────────────────────────────────────────────────────────────────────────────
/** 默认启动来源上限（= codex `DEFAULT_MEMORIES_MAX_ROLLOUTS_PER_STARTUP`）。 */
export const DEFAULT_MAX_SOURCES_PER_STARTUP = 2
/** 默认"额度剩余不得低于"百分比（= codex `DEFAULT_MEMORIES_MIN_RATE_LIMIT_REMAINING_PERCENT`）。 */
export const DEFAULT_MIN_REMAINING_QUOTA_PERCENT = 25
/**
 * 启动来源上限到顶后，下一趟 drain 的**最小间隔**（ms）。抄 codex 的"下次启动窗口再继续"意图：
 * 不立刻补跑（否则上限形同虚设），而是留出间隔再继续把剩余来源做完。
 */
export const STARTUP_SOURCE_SPACING_MS = 30000

/**
 * 启动**额度门**：当日额度剩余是否够开工。
 * 语义与 codex 对齐 —— `已用% ≤ 100 − 阈值` 才放行，即 **剩余 ≥ 阈值放行（恰好等于阈值也放行）**；
 * 浮点比较加 1e-9 容差，保证"恰好 25%"不被误判成不通过。
 * @param opts.attemptsToday 当日已用模型尝试数（本地取 `stage1_meta.modelAttemptsToday`，跨日由调用方归零）。
 * @param opts.maxAttemptsPerDay 当日上限（本地 `config.maxModelAttemptsPerDay`，默认 24）。
 * @param opts.minRemainingPercent 阈值（本地 `config.minRemainingQuotaPercent`，默认 25）。
 * @returns `{ allowed, reason, used, cap, remainingPercent, thresholdPercent }`（纯函数，可单测）。
 */
export function bootQuotaPlan({ attemptsToday = 0, maxAttemptsPerDay = 24, minRemainingPercent = DEFAULT_MIN_REMAINING_QUOTA_PERCENT } = {}) {
  const rawCap = Math.floor(Number(maxAttemptsPerDay))
  const cap = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : 24
  const rawUsed = Math.floor(Number(attemptsToday))
  const used = Number.isFinite(rawUsed) && rawUsed > 0 ? Math.min(rawUsed, cap) : 0
  const rawThreshold = Number(minRemainingPercent)
  const thresholdPercent = Number.isFinite(rawThreshold)
    ? Math.max(0, Math.min(100, rawThreshold))
    : DEFAULT_MIN_REMAINING_QUOTA_PERCENT
  const remainingPercent = ((cap - used) / cap) * 100
  const allowed = remainingPercent + 1e-9 >= thresholdPercent
  return { allowed, reason: allowed ? '' : 'quota-below-threshold', used, cap, remainingPercent, thresholdPercent }
}

/**
 * 该会话是不是"根会话"（t189 对齐 codex `start.rs` L33-38：子/派生会话不作为记忆提炼来源）。
 * 判据取会话头里**已经存在**的血缘字段：`parentSession` / `origin === 'subagent'` / `delegationDepth > 0`。
 * **未知血缘 ⇒ 视为根会话（保守）**：读不到血缘就停掉记忆生成，代价大于收益 —— 此点如实登记。
 * @param header 会话头（或任何带这三个字段的记录）。
 * @returns `true` = 允许作为提炼来源；`false` = 确定性非根会话，跳过。
 */
export function isRootSessionHeader(header) {
  if (!header || typeof header !== 'object') return true
  if (header.parentSession) return false
  if (header.origin === 'subagent') return false
  const depth = Number(header.delegationDepth)
  if (Number.isFinite(depth) && depth > 0) return false
  return true
}

/** t164：单一变化条目渲染进提示词的固定开销（`--- change N: kind (priority=…) ---` + 空行）估计。 */
const CHANGE_RENDER_OVERHEAD_CHARS = 60

/**
 * t164：预估「本批完整请求」的字符构成与总量。纯函数，可单测。
 * parts = { currentSummaryChars, currentRegistryChars, changesChars, inputsChars, promptChars, outputsReserveChars }
 * `scaffoldChars` = promptChars 减去已知部分后的余量（即固定提示词骨架/规则文本），下限 0。
 */
export function estimateRequestChars(parts = {}) {
  const n = (v) => (Number(v) > 0 ? Math.floor(Number(v)) : 0)
  const currentSummaryChars = n(parts.currentSummaryChars)
  const currentRegistryChars = n(parts.currentRegistryChars)
  const changesChars = n(parts.changesChars)
  const inputsChars = n(parts.inputsChars)
  const promptChars = n(parts.promptChars)
  const outputsReserveChars = n(parts.outputsReserveChars)
  const accounted = currentSummaryChars + currentRegistryChars + changesChars + inputsChars
  const scaffoldChars = Math.max(0, promptChars - accounted)
  return {
    currentSummaryChars,
    currentRegistryChars,
    changesChars,
    inputsChars,
    scaffoldChars,
    outputsReserveChars,
    currentFilesChars: currentSummaryChars + currentRegistryChars,
    promptChars,
    totalChars: promptChars + outputsReserveChars,
  }
}

/** t164：请求是否超预算。返回 ''（未超）或可读诊断串（各分量摊开）。纯函数，可单测。 */
export function requestTooLargeDiagnostic(estimate, budget = REQUEST_HARD_MAX_CHARS) {
  const cap = Number(budget) > 0 ? Math.floor(Number(budget)) : REQUEST_HARD_MAX_CHARS
  const e = estimate && typeof estimate === 'object' ? estimate : {}
  const total = Number(e.totalChars) || 0
  if (total <= cap) return ''
  return `total=${total}>${cap} (currentFiles=${Number(e.currentFilesChars) || 0}, changes=${Number(e.changesChars) || 0}, inputs=${Number(e.inputsChars) || 0}, scaffold=${Number(e.scaffoldChars) || 0}, outputsReserve=${Number(e.outputsReserveChars) || 0})`
}

/**
 * t164（R1 §5.3）：**旧超限批**的切分——把冻结集切成「本批合法保留」与「延后重领」两段。
 * 只用于 `pending` / `retry_wait` 批：这两态还没跑过 LLM，改冻结集是安全的。
 * `prepared` / `published` **不得**盲切（已发布阶段按原有发布记录恢复，未见来源由提交侧守卫放开）。
 * 纯函数，可单测。
 */
export function splitBatchIdsByBudget(ids, maxInputs = PROMPT_MAX_INPUTS) {
  const list = Array.isArray(ids) ? ids : []
  const max = Number(maxInputs) > 0 ? Math.floor(Number(maxInputs)) : PROMPT_MAX_INPUTS
  return { kept: list.slice(0, max), deferred: list.slice(max) }
}

/** t178：`withWrite` 是**非队列**锁（busy ⇒ 直接抛 `another write is in progress`）——把"抢锁失败"
 * 识别出来，以便调用方**短退避重试**（而不是把一次调度 pass 丢掉并记成 error）。纯函数，可单测。 */
export function isWriteConflictError(err) {
  const msg = String((err && err.message) || err || '')
  return msg.includes('another write is in progress')
}

/** t178：写锁竞争的重试节奏与上界（有界退避；成功即清零）。 */
const WRITE_CONFLICT_RETRY_MS = 200
const MAX_WRITE_CONFLICT_RETRIES = 5

/** t164（R1 §5.2）：**立即可处理**的残余来源判定——未被消费、也没被任何批绑定。
 * 只有「没有活跃非终态批」时才算「立即可处理」（否则那是**未来退避**那一档，归并到期时间管线）。
 * t172：追加第 4 参 `failedTerminalBatchIds`（**failed_terminal 批 id 集合，活跃表 + 归档表都要放进来**）——
 *   绑在这种批上的未消费输出，下一轮 reconcile 就会被释放 ⇒ 也必须算"立即可处理"；否则
 *   「批已归档」这一档会因为没有其它调度事件而**永远等不到 reconcile**（重启也照样卡）。
 * 纯函数（表由调用方传入 entries），可单测。 */
export function hasImmediatelyProcessableWork(outputEntries, changeEntries, hasActiveBatch, failedTerminalBatchIds = null) {
  return immediatelyProcessableKind(outputEntries, changeEntries, hasActiveBatch, failedTerminalBatchIds) !== ''
}

/** t172：与上面同判据，但返回**触发来源**（'' | 'unbound' | 'failed-bound'），供唤醒理由观测。纯函数，可单测。 */
export function immediatelyProcessableKind(outputEntries, changeEntries, hasActiveBatch, failedTerminalBatchIds = null) {
  if (hasActiveBatch) return ''
  const failedIds = failedTerminalBatchIds && typeof failedTerminalBatchIds.has === 'function' ? failedTerminalBatchIds : null
  for (const [, o] of outputEntries || []) {
    if (!o || typeof o !== 'object') continue
    if (o.selected_for_phase2 === true) continue
    if (o.phase2_abandoned === true) continue // t170：已放弃的来源不算"可处理"，否则会造成立即唤醒空转
    if (o.phase2_batch_id) {
      // t172：绑在 failed_terminal 批（活跃或归档）上的未消费输出 ⇒ 下一轮 reconcile 会释放它。
      if (failedIds && failedIds.has(o.phase2_batch_id)) return 'failed-bound'
      continue
    }
    return 'unbound'
  }
  for (const [, c] of changeEntries || []) {
    if (!c || typeof c !== 'object') continue
    if (c.status !== 'pending') continue
    if (c.phase2_abandoned === true) continue // t175：变更侧同样排除已放弃的（对称 t170 产物侧）
    if (c.phase2_batch_id) {
      // t175：**变更侧也要 failed-bound 档** —— 否则只修释放不修唤醒 ⇒ 与 t172 同一个教训（等不到 reconcile）。
      if (failedIds && failedIds.has(c.phase2_batch_id)) return 'failed-bound'
      continue
    }
    return 'unbound'
  }
  return ''
}

/**
 * S0-2：**截断可观测报告**——把一批的截断事实整理成可写进作业结果的结构。
 * 回答三问：① 是否发生截断；② 截断字符数（逐文件 / 逐块）；③ 截断的是哪些文件。
 * 当前权威文件恒不截断（超硬顶走 fail-closed），故 `currentFilesTruncated` 现恒为空数组；
 * 截断只可能发生在**增量输入**上（每条上限 `perInputLimit`）。纯函数，可单测。
 */
export function truncationReportOf(clad) {
  const c = clad && typeof clad === 'object' ? clad : {}
  const currentChars = c.currentChars && typeof c.currentChars === 'object' ? c.currentChars : { summary: 0, registry: 0 }
  const currentFilesTruncated = []
  if (c.truncatedCurrent && c.truncatedCurrent.summary) currentFilesTruncated.push('memory_summary.md')
  if (c.truncatedCurrent && c.truncatedCurrent.registry) currentFilesTruncated.push('MEMORY.md')
  const count = Number(c.clampedInputs) > 0 ? Number(c.clampedInputs) : 0
  const charsCut = Number(c.incrementalCharsCut) > 0 ? Number(c.incrementalCharsCut) : 0
  return {
    // ① 是否发生截断：当前权威文件被截 或 有增量输入被截
    truncated: currentFilesTruncated.length > 0 || count > 0,
    // ③ 截断的是哪些文件：当前权威文件（恒空）+ 被截的增量输入条数（非文件，按 id 逐条计）
    currentFilesTruncated,
    // ② 截断字符数
    currentCharsCut: 0,
    currentChars: { summary: Number(currentChars.summary) || 0, registry: Number(currentChars.registry) || 0 },
    incrementalInputs: { count, charsCut, perInputLimit: Number(c.perInputLimit) || 0 },
    droppedInputs: Number(c.droppedInputs) > 0 ? Number(c.droppedInputs) : 0,
  }
}

/** S0-2：结论行归一化（去列表标记 / 去加粗 / 空白折叠 / 小写）。纯函数，可单测。 */
export function normalizeConclusionLine(line) {
  return String(line ?? '')
    .replace(/^\s*[-*•]\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * t164（R1 §6.2）：**可选诊断**——「疑似丢了旧结论」的启发式提示（**不是闸门、不是判据**）。
 * 逐行取旧权威文件里「像结论」的行（非标题、归一化后 ≥12 字符），看它在新文件里还有没有落点：
 * 归一化完整子串命中，或 token 覆盖率 ≥ 0.8（容忍轻度改写）；被 exclusion 命中的行豁免。
 *
 * **能力边界（必须照此理解，别当硬判据）**：
 *  - 它只看**文本变化**，无法区分「合理归并」「来源退出/被遗忘」「语义改写」与「真丢失」；
 *    覆盖率阈值是**手感值**，不是可证明的判据（故不再调阈值、也不升级为"禁止删除"的硬闸门）。
 *  - 压缩批（mode=compress）按设计暂停「keep everything」，**整类豁免**本诊断。
 *  - 默认**关闭**（`config.phase2Diagnostics=false`）：只有显式打开才运行、才告警、才进返回结果。
 *  - **未持久化**：结果不写进 `phase2_jobs`，只在返回体 `diagnostics` 里 + `console.warn`；
 *    想事后审计就得自己接住返回值（自动路径不会留痕）。
 * 返回疑似被丢掉的行（去重、截断到 80 字符）；空数组 = 本次诊断没发现可疑项（**不等于"没丢"**）。
 * 纯函数，可单测。
 */
export function diagnosePossibleConclusionLoss(oldSummary, oldRegistry, newSummary, newRegistry, excludedNormalized = []) {
  const newNorm = normalizeConclusionLine(newSummary) + '\n' + normalizeConclusionLine(newRegistry)
  const newTokens = new Set(tokenizeContent(newNorm))
  const newLines = String(newSummary ?? '').split(/\r?\n/).map(normalizeConclusionLine)
    .concat(String(newRegistry ?? '').split(/\r?\n/).map(normalizeConclusionLine))
    .filter((l) => l.length >= 12)
  const dropped = []
  const seen = new Set()
  for (const src of [oldSummary, oldRegistry]) {
    for (const raw of String(src ?? '').split(/\r?\n/)) {
      const line = normalizeConclusionLine(raw)
      if (line.length < 12) continue
      if (line.startsWith('#')) continue
      if (newNorm.includes(line)) continue
      if (excludedNormalized.some((ex) => ex && (line.includes(ex) || ex.includes(line)))) continue
      const toks = tokenizeContent(line)
      if (toks.length) {
        // 逐条新行比对，取最高覆盖率（避免"词散落在不同行"造成假阳性）。
        let best = 0
        for (const nl of newLines) {
          if (!nl) continue
          const set = new Set(tokenizeContent(nl))
          let hit = 0
          for (const t of toks) if (set.has(t)) hit++
          if (hit / toks.length > best) best = hit / toks.length
        }
        if (best >= 0.8) continue
      }
      const key = line.slice(0, 80)
      if (seen.has(key)) continue
      seen.add(key)
      dropped.push(String(raw).trim().slice(0, 80))
    }
  }
  return dropped
}

// ── Phase 2 持久批次表（第三轮返工第 3 步）──────────────────────────────────
// phase2_jobs：不可变批次（R3）。input_ids 冻结一批未消费 stage1_outputs 的 id，
// 只 commit 一次（幂等重放，不重复消费）。状态机：
//   pending → running → prepared(staging已写) → published(current切换) → committed
//   running/prepared 失败或中断 → retry_wait（attempt+1 + 退避 available_at）→ available_at 到期 → pending
//   attempt>=max_attempts → failed_terminal
const phase2JobSchema = zod.object({
  id: zod.string(),
  status: zod.enum([
    'pending',
    'running',
    'retry_wait',
    'prepared',
    'published',
    'committed',
    'failed_terminal',
  ]),
  input_ids: zod.array(zod.string()).default([]),
  // R5/P1-2：本批冻结的 memory_changes id（统一变更流）。与 input_ids（stage1_outputs）
  // 并列——本批提交时把这两个集合都标 consumed + phase2_batch_id，二者缺一不可。
  change_ids: zod.array(zod.string()).default([]),
  // t80：批次模式。'compress' = 纯压缩批（无新输入，只把已超限的权威总纲压进尺寸上限）。
  // **只由显式入口创建**（memory_integrate{compress:true}）；调度器与自动路径永不创建。
  // 带 default → 旧记录读回即 'normal'（向后兼容）。
  mode: zod.enum(['normal', 'compress']).default('normal'),
  lease_owner: zod.string().default(''),
  lease_expires_at: zod.string().default(''),
  attempt_count: zod.number().int().min(0).default(0),
  max_attempts: zod.number().int().min(1).default(3),
  available_at: zod.string().default(''),
  staging_version: zod.string().default(''),
  last_error: zod.string().default(''),
  created_at: zod.string(),
  updated_at: zod.string(),
}).passthrough()

// publish_versions：版本化发布（R4）。id = <ts>-<uid>（本实现直接用 phase2_jobs.id 作版本号，
// 保证同批只发布一个版本、重放不重复切换）。summary/registry/manifest 是相对 memoryRoot 的路径；
// status staging|published。current.json 单指针指向当前已发布版本，读取方只读 current。
const publishVersionSchema = zod.object({
  id: zod.string(),
  summary_file: zod.string().default(''),
  registry_file: zod.string().default(''),
  manifest_file: zod.string().default(''),
  status: zod.enum(['staging', 'published']).default('staging'),
  created_at: zod.string(),
}).passthrough()

// ── 统一变更流（R5 / P1-2 / 设计 §1 §9）─────────────────────────────────────
// memory_changes：所有手动记忆/备注/草稿/遗忘/取代/导入入口先写一条 change（kind 区分），
// 由 phase2Integrate 统一解释并反映到权威 memory_summary.md / MEMORY.md（Stage1 自动提取
// 产物独立由 stage1_outputs 承载，不写本表 —— 避免 Phase2 双消费）。
// valueSchema 用 .passthrough()：payload/source_ref 由各入口按 kind 自由填充。
// priority：forget 最高（墓碑强语义——内容即使新增也绝不进权威摘要/召回），
// supersede/import 次之，remember/note 常规；历史 draft 记录仍可被 Phase2 消费。
const memoryChangeSchema = zod.object({
  id: zod.string(),
  kind: zod.enum(['remember', 'note', 'draft', 'forget', 'supersede', 'import']),
  payload: zod.record(zod.string(), zod.unknown()).default({}),
  source_ref: zod.string().default(''),
  status: zod.enum(['pending', 'consumed']).default('pending'),
  phase2_batch_id: zod.string().default(''),
  // t175：与 `stage1_outputs` **同套字段名**（同一语义、同一套上界/登记；不另立词汇，
  // 便于 `unbindOrphan` 那种"双表通用"的写法与统一排查）。含义见 reconcilePhase2Bindings。
  phase2_release_count: zod.number().int().min(0).default(0),
  phase2_abandoned: zod.boolean().default(false),
  phase2_abandoned_reason: zod.string().default(''),
  priority: zod.number().default(10),
  created_at: zod.string(),
  updated_at: zod.string(),
}).passthrough()

const spec = defineDomain({
  name: 'dsh_rollout',
  version: 1,
  tables: {
    entries: { valueSchema: recordSchema },
    stage1_jobs: { valueSchema: stage1JobSchema },
    stage1_outputs: { valueSchema: stage1OutputSchema },
    stage1_meta: { valueSchema: stage1MetaSchema },
    stage1_seen: { valueSchema: stage1SeenSchema },
    phase2_jobs: { valueSchema: phase2JobSchema },
    publish_versions: { valueSchema: publishVersionSchema },
    memory_changes: { valueSchema: memoryChangeSchema },
    // P1 归档协议（性能与减法审计 §六）：把终态/已消费且不再被读取路径需要的记录
    // 复制到归档表（不硬删、可恢复），活跃表因此不再随历史线性增长。
    stage1_jobs_archive: { valueSchema: stage1JobSchema },
    stage1_outputs_archive: { valueSchema: stage1OutputSchema },
    phase2_jobs_archive: { valueSchema: phase2JobSchema },
    changes_archive: { valueSchema: memoryChangeSchema },
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
 * 阶段 B：从 stage-1 outputs 里选出「尚未被成功整合消费」的产物，作为 Phase 2
 * 整合的增量输入（§7.4：不无差别整库扫描）。用每个产物自带的 `selected_for_phase2`
 * 标记（stage1FinishJob 置 false，phase2Integrate 成功后置 true）作为「已消费」的
 * 持久信号 —— 它比单一 `lastSuccessWatermark` 基线可靠：基线是内容哈希、无大小序，
 * 只推进为最新输入的水印时会把「比它旧但不同」的产物再次选出来（重复整合）或漏掉
 * 更早未整合的产物。`lastSuccessWatermark` 参数保留仅为 API/签名兼容，不再驱动选择。
 * 纯函数可单测。
 */
export function selectPhase2Inputs(outputs, lastSuccessWatermark) {
  if (!outputs || typeof outputs !== 'object') return []
  return Object.values(outputs).filter((o) => {
    if (!o || typeof o !== 'object') return false
    return !o.selected_for_phase2
  })
}

/**
 * 阶段 B：校验整合模型产物的结构与秘密（§7.5 第 5/8 步）。要求：
 *  - memory_summary 非空字符串，且首行必须是裸 `v1` 版本标记（总纲版本契约）；
 *  - registry 非空字符串；
 *  - 无未脱敏秘密（redactSecrets 对已脱敏内容幂等；若改写说明有未脱敏原始秘密）；
 *  - registry 内对 `rollout_summaries/<slug>.md` 的引用必须是安全相对路径（无 `..`
 *    穿越、非绝对路径/盘符）——防止模型产出越界引用照样发布（M3）。
 * 返回 `{ ok, errors }`。纯函数可单测。
 */
export function validatePhase2Output(output, opts = {}) {
  const errors = []
  if (!output || typeof output !== 'object') errors.push('output missing')
  else {
    if (typeof output.memory_summary !== 'string' || !output.memory_summary.trim()) {
      errors.push('memory_summary missing/empty')
    } else {
      // M3：总纲版本契约 —— 首个非空行必须是裸 `v1`，拒绝 `# v1`/缺失。
      const first = (output.memory_summary.split('\n').find((l) => l.trim() !== '') || '').trim()
      if (first !== 'v1') errors.push('memory_summary must start with a bare "v1" line')
      // t80 L3：尺寸闸门（按代码点计数，避免代理对误判）。超限 → 不发布、保留上一版。
      const maxS = Number(opts.maxSummaryChars) || 0
      const sLen = Array.from(output.memory_summary).length
      if (maxS > 0 && sLen > maxS) {
        errors.push(`memory_summary too long: ${sLen} > ${maxS} chars`)
      }
    }
    if (typeof output.registry !== 'string' || !output.registry.trim()) {
      errors.push('registry missing/empty')
    } else {
      // t80 L3：registry 尺寸闸门。
      const maxR = Number(opts.maxRegistryChars) || 0
      const rLen = Array.from(output.registry).length
      if (maxR > 0 && rLen > maxR) {
        errors.push(`registry too long: ${rLen} > ${maxR} chars`)
      }
      // M3：registry 里的 rollout_summaries 引用必须是安全相对路径。捕获「包含
      // rollout_summaries/ 的整段路径令牌」，据此判定上越界（.. 穿越 / 绝对路径 / 盘符）。
      const refRe = /[^()\s,"']*rollout_summaries\/[^\s),]+\.md/g
      let m
      while ((m = refRe.exec(output.registry)) !== null) {
        const ref = String(m[0]).trim()
        if (ref.includes('..') || ref.includes('\\') || /^[/~]/.test(ref) || /^[A-Za-z]:/.test(ref)) {
          errors.push('registry unsafe reference: ' + m[0])
        }
      }
    }
    for (const k of ['memory_summary', 'registry']) {
      const v = output[k]
      if (typeof v === 'string' && v) {
        const r = redactSecrets(v)
        if (r !== v) errors.push(`unredacted secret in ${k}`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

const DAY_MS = 86400000

/**
 * 阶段 C：记忆新鲜度（§10.1）。基于 entry 的 status 与更新时间判定。
 * 返回 fresh | aging | stale | superseded | forgotten。纯函数可单测。
 */
export function freshnessOf(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return 'stale'
  if (entry.status === 'forgotten') return 'forgotten'
  if (entry.status === 'superseded') return 'superseded'
  const last = entry.updatedAt || ''
  const t = last ? new Date(last).getTime() : Number.POSITIVE_INFINITY
  const days = Number.isFinite(t) ? (now - t) / DAY_MS : Number.POSITIVE_INFINITY
  if (days > 30) return 'stale'
  if (days > 7) return 'aging'
  return 'fresh'
}

/**
 * 阶段 C：召回排序分（§10.4）。
 * **t195（④）契约改向**：**撤销 freshness 软降权** —— 分数 = 相关性；生命周期改用 `entryEligible()`
 * **硬淘汰**（30 天未用即失格），对齐 codex「过期即失格 + 按 usage_count 排序」。
 * `o.freshness` 入参保留仅为兼容旧调用点，**不再参与计算**。
 */
export function scoreMemory(_entry, o = {}) {
  return Number(o.relevance) || 0
}

/**
 * 阶段 C：把 freshnessOf() 的定性结果映射为 scoreMemory 用的 1/0.5/0 权重。
 * **t195 起已废弃（@deprecated）**：召回排序不再用新鲜度权重（改为 `entryEligible()` 硬资格 +
 * `usage_count` 降序）。保留导出只为不破坏既有 import；**不再参与资格判定，也不再参与打分**。
 */
export function freshnessWeight(entry, now = Date.now()) {
  const f = freshnessOf(entry, now)
  return f === 'fresh' ? 1 : f === 'aging' ? 0.5 : 0
}

// ─────────────────────────────────────────────────────────────────────────────
// t195：④ 生命周期资格与使用计数（**照 codex**）
//   依据（本地镜像 `_ref-codex\`，commit a592c38c16cdd7623dacc9168926ebccedfb67d3）：
//     - `codex-rs/state/src/runtime/memories.rs` L439-446 文档：current selection keeps rows whose
//       `last_usage` is within `max_unused_days`，**or** whose `source_updated_at` is within that window
//       **when the memory has never been used**；eligible rows ranked by `usage_count DESC,
//       COALESCE(last_usage, source_updated_at) DESC, source_updated_at DESC, thread_id DESC`
//     - 同文件 L459 `cutoff = now − Duration::days(max_unused_days.max(0))`
//     - 同文件 L473-477 WHERE：`(last_usage IS NOT NULL AND last_usage >= cutoff) OR
//       (last_usage IS NULL AND source_updated_at >= cutoff)`
//     - 同文件 L70-80：使用累加 `usage_count = COALESCE(usage_count,0)+1, last_usage = now`
//     - `codex-rs/config/src/types.rs` L55 `DEFAULT_MEMORIES_MAX_UNUSED_DAYS = 30`
// ─────────────────────────────────────────────────────────────────────────────
/** codex `max_unused_days` 的默认值（镜像 `config/src/types.rs` L55）。 */
export const DEFAULT_MAX_UNUSED_DAYS = 30

/** 使用计数：缺字段/非法 ⇒ 0（旧条目天然兼容，等价 codex 的 `COALESCE(usage_count, 0)`）。 */
export function usageCountOf(entry) {
  const n = Number(entry && entry.usage_count)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 上次使用时间（ms）；'' / 缺字段 / 不可解析 ⇒ `null`（= 从未使用，等价 codex 的 `last_usage IS NULL`）。 */
export function lastUsageOf(entry) {
  const s = entry && entry.last_usage
  if (!s) return null
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * t195（④ 照 codex）：条目**是否仍具资格**（硬淘汰 —— 不是降权）。
 * `eligible = (用过 && last_usage ≥ cutoff) || (从未用过 && updatedAt ≥ cutoff)`（本地把 codex 的
 * `source_updated_at` 对应为条目 `updatedAt`）；`cutoff = now − maxUnusedDays 天`。
 * 本地既有的两个硬谓词仍更高优先：`forgotten` 永不具资格；`superseded` 默认不具资格
 * （审计模式 `opts.includeSuperseded === true` 才放行，且仍受窗口约束）。
 * @param entry 条目（可含 `usage_count` / `last_usage` / `updatedAt` / `status`）。
 * @param now 参照时刻（ms）。
 * @param maxUnusedDays 窗口天数（默认 30 = codex 默认；负数按 0 处理，对齐 `max_unused_days.max(0)`）。
 * @param opts.includeSuperseded 审计模式：允许被替代条目参与（默认 false）。
 * @returns boolean
 */
export function entryEligible(entry, now = Date.now(), maxUnusedDays = DEFAULT_MAX_UNUSED_DAYS, opts = {}) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.status === 'forgotten') return false
  if (entry.status === 'superseded' && opts.includeSuperseded !== true) return false
  const raw = Number(maxUnusedDays)
  const days = Number.isFinite(raw) ? Math.max(0, raw) : DEFAULT_MAX_UNUSED_DAYS
  const cutoff = now - days * DAY_MS
  const lastUsed = lastUsageOf(entry)
  const baseline = lastUsed == null ? new Date(entry.updatedAt || '').getTime() : lastUsed
  // **兼容边界的自决（唯一一处有意偏差，已登记）**：时间戳缺失/不可解析 ⇒ 按**具资格**处理。
  //   codex 的 SQL 对不可比较的行会排除（它的数据模型里 `source_updated_at` 必有）；本地 schema 虽要求
  //   `updatedAt`，但历史/导入数据可能缺 ⇒ 两种失败模式的代价不对称：**误淘汰 = 静默丢记忆（重）**，
  //   误保留 = 可能召回一条旧记忆（轻）。窗口判定只作用于**可读时间戳**。
  if (!Number.isFinite(baseline)) return true
  return baseline >= cutoff
}

/**
 * 阶段 C：分词（去停用词 + 去短词），用于内容关联度判定。纯函数可单测。
 * 停用词（英文高频虚词）+ 长度 < 3 的短词不会被当作「特征词」，避免 'the/is/to'
 * 这类词造成两段无关内容被误判相关。
 */
export function tokenizeContent(input) {
  const STOP = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'with',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these',
    'those', 'it', 'its', 'from', 'by', 'as', 'you', 'your', 'do', 'does', 'did',
    'not', 'no', 'yes', 'we', 'our', 'us', 'i', 'me', 'my', 'he', 'she', 'his',
    'her', 'they', 'them', 'their', 'a', 'an', 'the',
  ])
  return String(input || '')
    .toLowerCase()
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
}

/** 阶段 C：内容归一化（小写 + 折叠空白），用于「同内容去重」的水印/比对。纯函数。 */
export function normalizeContent(input) {
  return String(input || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * 阶段 C：两段内容的 Jaccard 词重叠度（0..1）。归一化后按特征词集合计算
 * |A∩B| / |A∪B|。用于 remember 的自动取代判定（内容高度重合/同主题）。纯函数。
 */
export function contentOverlapRatio(a, b) {
  const A = new Set(tokenizeContent(a))
  const B = new Set(tokenizeContent(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/** 阶段 C：remember 自动取代的「高度重合」阈值（词重叠 Jaccard）。 */
export const AUTO_SUPERSEDE_OVERLAP = 0.75

/**
 * 阶段 C（P1-5）：校验一个引用 `{path,startLine,endLine,citeSpan}` 是否「真指向内存库
 * 里一个确含该记忆内容的具体行段」，而非伪造占位。读取真实文件：
 *   - 路径必须位于 memoryRoot 之下（拒绝绝对路径 / 盘符 / `..` 穿越）；
 *   - startLine/endLine 必须是有效行号（endLine 传 0 表示「到文件末尾」）；
 *   - citeSpan 必须在行段内出现；或 opts.content 提供的记忆内容必须是行段的**规范化完整子串**
 *     （不再「至少一个特征词共用」放行——同主题词但不同事实/否定/主体的错误引用必须拒绝）。
 * 无证据 → `{ ok:false, reason }`，绝不被当成已证实引用。纯函数可单测。
 */
export function validateSourceRef(sourceRef, memoryRoot, opts = {}) {
  if (!sourceRef || typeof sourceRef !== 'object') return { ok: false, reason: 'no-source' }
  const rel = String(sourceRef.path || '')
  if (!rel) return { ok: false, reason: 'no-path' }
  const root = String(memoryRoot || '')
  // 拒绝绝对路径 / 盘符 / 反斜杠穿越 —— 引用必须是对 memory root 的相对路径。
  const unsafe =
    path.isAbsolute(rel) ||
    /^[A-Za-z]:/.test(rel) ||
    rel.includes('\\') ||
    rel.split(/[\\/]+/).some((s) => s === '..')
  if (unsafe) return { ok: false, reason: 'unsafe-path' }
  const resolved = root ? path.resolve(root, rel) : path.resolve(rel)
  if (root && resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { ok: false, reason: 'unsafe-path' }
  }
  let file = ''
  try {
    file = fs.readFileSync(resolved, 'utf8')
  } catch {
    return { ok: false, reason: 'missing' }
  }
  const lines = file.split(/\r?\n/)
  const lineCount = lines.length
  const start = Number(sourceRef.startLine)
  const endRaw = Number(sourceRef.endLine)
  if (!Number.isInteger(start) || !Number.isInteger(endRaw) || start < 1 || start > lineCount) {
    return { ok: false, reason: 'line-range' }
  }
  if (endRaw !== 0 && endRaw < start) return { ok: false, reason: 'line-range' }
  const spanEnd = endRaw === 0 ? lineCount : Math.min(endRaw, lineCount)
  const span = lines.slice(start - 1, spanEnd).join('\n').toLowerCase()
  const cite = String(sourceRef.citeSpan || '').toLowerCase().trim()
  const content = String(opts.content || '').toLowerCase().trim()
  if (cite) {
    if (span.includes(cite)) return { ok: true, lineCount, spanEnd }
    return { ok: false, reason: 'cite-span-not-found' }
  }
  if (content) {
    // P0-R2-2：不再「只要共享一个 ASCII 特征词」就放行。同主题词但事实关系不同/否定相反/
    // 主体不同的 entry（如证据「pnpm build failed」→ 记忆「user prefers pnpm」）此前会被
    // 误判为已验证引用。这里只接受规范化后的**完整子串**（明确绑定）；不能证明就回退
    // unverified —— 宁可少给引用，也不要给错误引用。
    if (span.includes(content)) return { ok: true, lineCount, spanEnd }
    return { ok: false, reason: 'unrelated' }
  }
  return { ok: true, lineCount, spanEnd }
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
  const t = new Date(now).getTime()
  for (const j of Object.values(state.jobs)) {
    if (!j) continue
    // 领取条件（§2/§3 时间驱动）：pending（available_at<=now）或到期的 retry_wait
    // （retry_wait 语义=设计稿的 failed_retryable+available_at 到期，此时可再领取）。
    const duePending = j.status === 'pending' && (!j.available_at || new Date(j.available_at).getTime() <= t)
    const dueRetry = j.status === 'failed_retryable' && j.available_at && new Date(j.available_at).getTime() <= t
    if (duePending || dueRetry) {
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
 *  - failed_retryable：attempt_count+1，available_at 按分级退避（供下次领取）；
 *    若 attempt_count 达到 max_attempts（兜底 3）则降级为 failed_terminal（completed_at，不再重试）
 *  - failed_terminal：completed_at（不再重试）
 * 返回 { status, job }。纯函数可单测。
 */
export function stage1FinishJob(state, job, outcome, opts = {}, now = new Date()) {
  job.status = outcome
  job.updated_at = now.toISOString()
  if (outcome === 'failed_retryable') {
    job.attempt_count = (job.attempt_count || 0) + 1
    job.last_error_code = opts.error_code || ''
    job.last_error_message = opts.error_message || ''
    // max_attempts 兜底到 3（mergeStage1Job 产出 3；外界/旧 job 可能缺该字段）。
    // 达到上限则降级为 failed_terminal：completed_at，不再重试——避免失败会话每
    // 3600s 无限重试、永不 terminal、浪费配额（H2 修复）。
    const maxAttempts = job.max_attempts || 3
    if (job.attempt_count >= maxAttempts) {
      job.status = 'failed_terminal'
      job.completed_at = now.toISOString()
    } else {
      job.available_at = new Date(now.getTime() + stage1BackoffSeconds(job.attempt_count) * 1000).toISOString()
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// t187：① 受限执行者（codex 形态）—— 整合执行体的落点
//
// 背景（t185/t186 实测）：codex 的整合执行体是一个**沙箱会话**（`cwd` = 记忆根、写根 = 记忆根、
// 无网、审批 never、禁递归委派）。DSH 侧的等价物**不是模型面的 `subagent` 工具** ——
// `SubagentStartRequest` 没有 `cwd` 字段（子代理会话恒继承父 workspace）；而是**插件自建会话**：
// `ctx.agents.create({ sessionId, meta: { cwd }, setup })`。`meta.cwd` 是会话创建字段，且
// `dsh-sandbox-policy` 明确「a session cwd is its workspace-write boundary」，`dsh-fs-sandbox`
// 在该边界上强制拒绝越界写。
// 本批落的是**接口层**（会话创建 + 策略应用 + 门禁与降级），模型调用真正搬进该会话属下一批；
// **「meta.cwd 被真实宿主接受」= 第一验收项，需重启后实测，本批不得视为已通过**。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 受限执行者的**纯规格**（不触任何服务，可单测）。
 * @param memoryRoot 记忆根（`<DSH_HOME>/memories` 或配置项 `memoryRoot`）。
 * @returns `{ cwd, sandboxMode, approvalPolicy, toolFilter }`；`cwd` 即会话创建字段 `meta.cwd`。
 * @throws 记忆根为空 / 解析后非绝对路径（**不拿 process.cwd() 兜底**：那会把写边界悄悄挪到启动目录）。
 */
export function consolidationExecutorSpec(memoryRoot) {
  const raw = String(memoryRoot == null ? '' : memoryRoot).trim()
  if (!raw) throw new Error('consolidationExecutorSpec: memoryRoot is required')
  const cwd = path.resolve(raw)
  if (!path.isAbsolute(cwd)) throw new Error(`consolidationExecutorSpec: cwd must be absolute, got "${cwd}"`)
  return {
    cwd,
    sandboxMode: CONSOLIDATION_SANDBOX_MODE,
    approvalPolicy: CONSOLIDATION_APPROVAL_POLICY,
    toolFilter: { allow: [...CONSOLIDATION_TOOL_ALLOW], deny: [...CONSOLIDATION_TOOL_DENY] },
  }
}

/** 取可选服务：宿主没组装就返回 undefined（与本文件其它地方的 `ctx.get(x, false)` 同款用法）。 */
function optionalService(ctx, name) {
  if (!ctx || typeof ctx.get !== 'function') return undefined
  try { return ctx.get(name, false) } catch { return undefined }
}

/** 从 `agents.create` 的返回体里尽力解析会话（不同 provider 形状可能不同，故逐层兜底）。 */
function sessionOfHandle(handle) {
  if (!handle || typeof handle !== 'object') return undefined
  return handle.session || (handle.agent && handle.agent.session) || (handle.child && handle.child.session) || undefined
}

/**
 * 把受限执行者的会话策略落到该会话上：沙箱 `workspace-write` + 审批 `never`。
 * 优先走服务写入路径（`ctx.sandboxPolicy.setMode` / `ctx.approval.setPolicy`）；服务不可用时
 * **直接 append 同名会话事件**（那正是这两个服务内部做的事），并记录用了哪条路。
 * 不抛：失败只进 `notes`，让调用方按"策略没应用上"处理。
 */
export function applyExecutorSessionPolicies({ ctx, handle, spec }) {
  const out = { sandboxMode: null, approvalPolicy: null, routes: [], notes: [] }
  const session = sessionOfHandle(handle)
  if (!session || typeof session.append !== 'function') { out.notes.push('session-unresolved'); return out }
  const sandboxSvc = optionalService(ctx, 'sandboxPolicy')
  try {
    if (sandboxSvc && typeof sandboxSvc.setMode === 'function') {
      sandboxSvc.setMode(session, spec.sandboxMode)
      out.routes.push('sandboxPolicy.setMode')
    } else {
      session.append('sandbox/mode', { mode: spec.sandboxMode })
      out.routes.push('session.append(sandbox/mode)')
    }
    out.sandboxMode = spec.sandboxMode
  } catch (err) {
    out.notes.push('sandbox-mode-failed: ' + (err && err.message ? err.message : String(err)))
  }
  const approvalSvc = optionalService(ctx, 'approval')
  const agent = handle && handle.agent ? handle.agent : undefined
  try {
    if (approvalSvc && typeof approvalSvc.setPolicy === 'function' && agent) {
      approvalSvc.setPolicy(agent, spec.approvalPolicy)
      out.routes.push('approval.setPolicy')
    } else {
      session.append('approval/policy', { policy: spec.approvalPolicy })
      out.routes.push('session.append(approval/policy)')
    }
    out.approvalPolicy = spec.approvalPolicy
  } catch (err) {
    out.notes.push('approval-policy-failed: ' + (err && err.message ? err.message : String(err)))
  }
  return out
}

/**
 * 建一个**受限执行者会话**（整合执行体）。
 * **绝不抛**：宿主没有 `agents` 服务、或建会话/定策略失败，都返回 `{ok:false, reason}` 让调用方
 * 继续走既有路径（批的成败不因此改变）。`setup` 在子会话"创建窗口"里执行，故 `restrict()` 生效于
 * 该会话发布之前（该会话的工具面里不存在 `subagent` 等被拒工具）。
 * @param opts.ctx 宿主上下文（取 `agents`/`approval`/`sandboxPolicy` 三个可选服务）。
 * @param opts.memoryRoot 记忆根（会解析成绝对路径当 `meta.cwd`）。
 * @param opts.sessionId 该会话 id（调用方给，便于日志与幂等排查）。
 */
export async function startConsolidationExecutor({ ctx, memoryRoot: root, sessionId } = {}) {
  const spec = consolidationExecutorSpec(root)
  const agents = optionalService(ctx, 'agents')
  if (!agents || typeof agents.create !== 'function') {
    return { ok: false, reason: 'agents-service-unavailable', spec, handle: null, restricted: false, restrictCalls: 0, applied: null }
  }
  let restricted = false
  let restrictCalls = 0
  let restrictError = null
  const handle = await agents.create({
    sessionId,
    meta: { cwd: spec.cwd },
    setup: (childCtx) => {
      const tools = childCtx && childCtx.tools
      if (!tools || typeof tools.restrict !== 'function') return
      try {
        tools.restrict(spec.toolFilter)
        restricted = true
      } catch (err) {
        restrictError = err && err.message ? err.message : String(err)
      }
      restrictCalls += 1
    },
  })
  const applied = applyExecutorSessionPolicies({ ctx, handle, spec })
  return { ok: true, reason: '', spec, handle, restricted, restrictCalls, restrictError, applied }
}

export async function apply(ctx, config) {
  const domain = await ctx.storageDomain.open(spec)
  ctx.effect(
    () => async () => {
      await domain.close()
    },
    'dsh-memory_rollout.domainClose',
  )
  const table = domain.table('entries')

  // ── Stage 1 持久作业表（表驱动，取代 .stage1-state.json）───────────────────
  // 存储域不支持跨 key/跨表原子事务（README L35），因此所有状态迁移包 withWrite
  // 保证单进程串行；单条记录字段级用 storage-domain 的 update(key,fn)（唯一真原子读改写）。
  const stage1JobsTable = domain.table('stage1_jobs')
  const stage1OutputsTable = domain.table('stage1_outputs')
  const stage1MetaTable = domain.table('stage1_meta')
  const phase2JobsTable = domain.table('phase2_jobs')
  const publishVersionsTable = domain.table('publish_versions')
  const memoryChangesTable = domain.table('memory_changes')
  // P1 归档协议：归档表（不硬删、可恢复，活跃表因此变轻）。
  const stage1JobsArchiveTable = domain.table('stage1_jobs_archive')
  const stage1OutputsArchiveTable = domain.table('stage1_outputs_archive')
  const phase2JobsArchiveTable = domain.table('phase2_jobs_archive')
  const changesArchiveTable = domain.table('changes_archive')
  const stage1SeenTable = domain.table('stage1_seen')
  const STAGE1_META_KEY = 'meta'
  const stage1JobKey = (sessionId, watermark) => `${String(sessionId)}::${String(watermark)}`
  const stage1OutputKey = (jobId) => String(jobId)
  // 本次 apply 的唯一 boot id（§5 重启恢复：worker owner 含 boot_id，启动时回收旧进程的 running）。
  const bootId = 'boot-' + Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36)
  // P0-R2-3：Stage 1 自动生成读取会话的能力标志（sessionQuery 声明为必需 inject）。启动时快照一次，
  // 供 overview `capabilities` 暴露「能力是否可用」，用于识别「部署缺 sessionQuery」而非「会话真空」。
  const hasSessionQuery = (() => {
    const q = typeof ctx.get === 'function' ? ctx.get('sessionQuery', false) : undefined
    return !!(q && typeof q.readSession === 'function')
  })()
  const readStage1Meta = () => {
    const m = stage1MetaTable.get(STAGE1_META_KEY)
    // GPT P0-7：返回浅拷贝，防止调用方「读→字段改→writeStage1Meta」原地改到存储对象
    // （后端 put 失败时内存旧值已被改掉，与磁盘分叉）。
    return m && typeof m === 'object'
      ? { ...m }
      : { runDay: '', modelAttemptsToday: 0, lastSuccessWatermark: '', lastPhase2At: '', phase2_last_error: '' }
  }
  const writeStage1Meta = (patch) => {
    const cur = readStage1Meta()
    return stage1MetaTable.put(STAGE1_META_KEY, { ...cur, ...patch })
  }
  // ── 统一变更流（R5 / P1-2 / §9）：所有手动记忆入口写 memory_changes ───────────
  // priority：forget 最高（墓碑强语义，内容即使新增也绝不进权威摘要/召回），supersede/import
  // 次之（取代关系/导入内容随批进权威），remember/note 常规。Phase2 按 priority 加权
  // （forget 最高优先）构件提示词与排除规则。
  const CHANGE_PRIORITY = { forget: 100, supersede: 90, import: 80, remember: 10, note: 10 }
  const defaultChangePriority = (kind) => (kind in CHANGE_PRIORITY ? CHANGE_PRIORITY[kind] : 10)
  /**
   * 写一条 memory_changes 变更记录。调用方必须已持有 withWrite（本函数不锁，防嵌套死锁）。
   * payload 由各入口按 kind 填充必要内容/目标 id；source_ref 用于来源追溯（note/draft/import）。
   * 返回 change id。
   */
  async function writeChangeRecord(kind, payload, opts = {}) {
    const now = nowIso()
    const id = makeId()
    await memoryChangesTable.put(id, {
      id,
      kind,
      payload: payload ?? {},
      source_ref: opts.source_ref ?? '',
      status: 'pending',
      phase2_batch_id: '',
      priority: opts.priority ?? defaultChangePriority(kind),
      created_at: now,
      updated_at: now,
    })
    // P0-R2-1：让「成功产生 pending change」成为 Phase 2 唤醒的唯一边界。所有 memory_changes
    // 生产入口（remember/forget/supersede/note/import/UI add/reconcile outbox）都经本函数，
    // 因此这里统一请求 Phase 2，不必再逐入口散落补调用。requestPhase2Integrate 只置位 +
    // setImmediate 异步调度（绝不内嵌 withWrite），故在 withWrite 内调用安全，不会嵌套写锁。
    requestPhase2Integrate()
    return id
  }

  // ── memory filesystem root & helpers ─────────────────────────────────────
  // Derive the DSH home the same way @deepseek-ai/dsh-home-paths does:
  // `$DSH_HOME` wins, otherwise `~/.dsh`. `config.memoryRoot` overrides the
  // whole memory root if set.
  // Snapshot the DSH home ONCE per apply. `dsHome()`/`memoryRoot()` are read inside
  // deferred closures (e.g. the startup `setImmediate(drainStage1Jobs)` and the
  // `session/disposed` handler), and in a single plugin boot DSH_HOME is fixed. A
  // live `process.env.DSH_HOME` read in such a deferred closure would otherwise pick
  // up whatever the env has become by the time it runs — a latent cross-apply leak
  // (tests run several applys in one process, each with a different DSH_HOME).
  const dsHome = (() => {
    const env = process.env.DSH_HOME
    const home = env && env.trim() ? path.resolve(env) : path.join(os.homedir(), '.dsh')
    return () => home
  })()
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
  // 统计文件「实际行数」（与 validateSourceRef 的 file.split(/\r?\n/) 对齐）：
  // 末尾单个换行产生的空元素不算一行。供 append-only 证据文件计算新块起始偏移。
  const countFileLines = (text) => {
    if (!text) return 0
    const parts = text.split(/\r?\n/)
    if (parts.length > 1 && parts[parts.length - 1] === '') return parts.length - 1
    return parts.length
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

  // ── runtime config overlay (settings page → dsh-memory_rollout.settings.json) ────
  // The plugin config is resolved from cordis.patch.yml at boot. The settings
  // page edits it at runtime via /dsh-memory_rollout/config, and the changed fields are
  // persisted to a sibling settings file so they survive a restart. This file
  // lives at <ds_home>/dsh-memory_rollout.settings.json (NOT inside memories/, so an
  // export/import never carries it) and is merged into the live `config` at
  // startup, taking precedence over patch.yml so the settings page stays the
  // user-facing source of truth for these fields.
  const settingsPath = () => path.join(dsHome(), 'dsh-memory_rollout.settings.json')
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

  // ── M2：旧 autoTrigger 一次性兼容迁移 ─────────────────────────────────────
  // 旧版用 autoTrigger='off' 关闭自动生成。M2 起唯一公开开关是 generateMemories。
  // 规则：仅当「旧设置显式写入 autoTrigger==='off' 且 generateMemories 未被显式设置」时，
  // 才把 config.generateMemories 置为 false；否则维持 schema 默认（true）。
  // generateMemories 显式设置时以它为准（新字段优先）。
  function migrateLegacyAutoTrigger() {
    // 已由用户/设置页显式设置过生成开关 → 尊重新字段，不做迁移。
    if (pickEditable(readSettings()).generateMemories !== undefined) return
    // 旧设置里显式关闭自动触发 → 关生成。
    if (readSettings().autoTrigger === 'off') {
      config.generateMemories = false
    } else if (config.autoTrigger === 'off') {
      // 兼容：旧 patch.yml 里 autoTrigger='off'（无设置页记录）也关生成。
      config.generateMemories = false
    }
  }
  migrateLegacyAutoTrigger()


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
        // 阶段 C：生命周期字段，旧记录缺失时补默认值。
        status: String(value.status || 'active'),
        superseded_by: String(value.superseded_by || ''),
        // t195（④ 照 codex）：使用计数与上次使用时间（旧记录缺失 ⇒ 0 / '' = 从未使用，天然兼容）。
        usage_count: usageCountOf(value),
        last_usage: String(value.last_usage || ''),
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

  /** 阶段 C：读一条 entry 的原始存储记录（含生命周期字段，未补默认）。找不到返回 null。 */
  function findEntryValue(id) {
    return table.get(id) || null
  }

  /**
   * 阶段 C（§10.3 / P1-4）：把一条 entry 置为墓碑（status='forgotten'）。逻辑删除而非
   * 物理删除：条目保留在表里（可溯源），但从召回/注入/读取路径被排除。返回是否更新成功。
   * 调用方负责包 withWrite；内部不加锁（防嵌套死锁）。
   */
  async function forgetRecord(id) {
    const value = table.get(id)
    if (!value) return false
    await table.put(id, { ...value, status: 'forgotten', updatedAt: nowIso() })
    // R5 / P1-2：遗忘墓碑入统一变更流（forget 最高优先），Phase2 据此排除旧内容。
    // 放低层函数里，使 memory_forget 工具与 UI 删除路由都能产生变更。
    await writeChangeRecord('forget', { entryId: String(id) })
    return true
  }

  /**
   * 阶段 C（§10.2 / P1-4）：把 targetId 标记为被 replacementId 取代
   * （status='superseded', superseded_by=replacementId），并刷新 updatedAt。
   * 返回是否更新成功。调用方负责包 withWrite；内部不加锁。
   */
  async function supersedeRecord(targetId, replacementId) {
    const value = table.get(targetId)
    if (!value) return false
    await table.put(targetId, {
      ...value,
      status: 'superseded',
      superseded_by: String(replacementId || ''),
      updatedAt: nowIso(),
    })
    // R5：取代关系也入统一变更流，供 Phase2 排除旧事实并记录替代链。
    await writeChangeRecord('supersede', {
      targetId: String(targetId),
      replacementId: String(replacementId || ''),
    })
    return true
  }

  /**
   * GPT P1-1 outbox 恢复：`forget`/`supersede` 是「先改 entry、后写 change」的两个跨 key 写入，
   * 中途崩溃会留下「entry 已灭但 Phase 2 不知道」的半状态。本扫描对每个 forgotten/superseded
   * 条目，若 memory_changes 里没有任何 change 引用它（任意状态），则补写一条 pending change，
   * 让 Phase 2 忽略其内容。幂等（只补缺失，不重复）。返回补写数。
   */
  async function reconcileChangeOutbox() {
    const missing = []
    const referencedIds = new Set()
    for (const [, c] of memoryChangesTable.entries()) {
      if (!c || typeof c.payload !== 'object') continue
      if (c.payload.entryId) referencedIds.add(c.payload.entryId)
      if (c.payload.targetId) referencedIds.add(c.payload.targetId)
    }
    for (const [id, e] of Array.from(table.entries())) {
      if (!e || (e.status !== 'forgotten' && e.status !== 'superseded')) continue
      if (referencedIds.has(id)) continue
      missing.push({
        kind: e.status === 'forgotten' ? 'forget' : 'supersede',
        payload: e.status === 'forgotten'
          ? { entryId: String(id) }
          : { targetId: String(id), replacementId: String(e.superseded_by || '') },
      })
    }
    if (!missing.length) return 0
    return withWrite(async () => {
      let n = 0
      for (const w of missing) {
        const id = w.payload.entryId || w.payload.targetId
        if (referencedIds.has(id)) continue
        await writeChangeRecord(w.kind, w.payload)
        referencedIds.add(id)
        n++
      }
      return n
    })
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

  /**
   * 计算一个会话的「证据草稿」文件内容 + 其摘要块在文件中的 `source_ref`。
   * 与 `writeExtractedDraft` 共用同一格式（one-session-one-draft invariant）：
   *   头部 session_id/updated_at/cwd/slug/keywords + `# 会话草稿 <title>`，
   *   body = 精炼 `rollout_summary`，随后 `## 原始字面快照` 附录承载逐字 `raw_memory`。
   * 返回 `{ relPath, content, sourceRef }` —— `sourceRef` 精确指向摘要块所在行范围，
   * `citeSpan` 即该段文本，供 `validateSourceRef` 可核查（P1-1 证据层）。
   * 纯内容构建（不读盘/不写盘），供 stage-1 提炼成功路径复用。
   * `opts.existingLineCount`（可选）：同一会话已有证据文件的「实际行数」。append-only 实现
   * 下，新块追加在旧行之后；sourceRef 的 startLine/endLine 需按「整文件」绝对行号写出，
   * 故用该偏移纠正，使每个 output 的 source_ref 精确指向其对应块（旧行不被改动）。
   */
  function buildEvidenceContent(sessionId, cwd, extraction, opts = {}) {
    // D3: redact every field that reaches disk — the model output and the literal
    // fallback may both carry a secret the model echoed (or the transcript held).
    const slug = redactSecrets(String(extraction.slug || ''))
    const keywords = redactSecrets(String(extraction.keywords || ''))
    const title = redactSecrets(String(extraction.title || ''))
    const summary = redactSecrets(String(extraction.rollout_summary || '').trim())
    const raw = redactSecrets(String(extraction.raw_memory || '').trim())

    const lines = []
    lines.push(`session_id: ${sessionId || 'unknown'}`)
    lines.push(`updated_at: ${nowIso()}`)
    lines.push(`cwd: ${cwd || ''}`)
    if (slug) lines.push(`slug: ${slug}`)
    if (keywords) lines.push(`keywords: ${keywords}`)
    lines.push('')
    lines.push(`# 会话草稿 ${title}`.trimEnd())
    lines.push('')
    // 记录摘要块在「本块内容」内的起止行（1-based）。append-only 时需再加已有的
    // existingLineCount 与块间分隔行（追加前旧行 + 一个空分隔行）得到整文件绝对行号。
    const existingLineCount = Number(opts.existingLineCount || 0)
    const startOffset = existingLineCount > 0 ? existingLineCount + 1 : 0
    const summaryStart = startOffset + lines.length + 1
    if (summary) for (const ln of summary.split('\n')) lines.push(ln)
    const summaryEnd = summary ? startOffset + lines.length : summaryStart - 1
    if (raw && raw !== summary) {
      lines.push('')
      lines.push('## 原始字面快照')
      for (const ln of raw.split('\n')) lines.push(ln)
    }
    const content = lines.join('\n') + '\n'
    const relPath = `rollout_summaries/${safeSlug(sessionId || 'unknown')}.md`
    let sourceRef = null
    if (summary && summaryStart >= 1 && summaryEnd >= summaryStart) {
      sourceRef = {
        path: relPath,
        startLine: summaryStart,
        endLine: summaryEnd,
        citeSpan: summary,
        sessionId: String(sessionId || ''),
      }
    }
    return { relPath, content, sourceRef }
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
    const { relPath, content } = buildEvidenceContent(sessionId, cwd, extraction)
    writeText(path.join(d.root, relPath), content)
    return relPath
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

    // 读取路径排除：forgotten（墓碑，绝不再出现）与 superseded（默认不返回旧事实）。
    const entries = allEntries().filter((e) => e.status !== 'forgotten' && e.status !== 'superseded')
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
    // 读取路径排除：forgotten（墓碑）与 superseded（旧事实）不进入注入总纲。
    const entries = allEntries().filter((e) => e.status !== 'forgotten' && e.status !== 'superseded')
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
    // ── H3b overwrite guard ────────────────────────────────────────────────
    // Once Phase 2 successfully publishes a consolidated (LLM-authored) pair,
    // memory_summary.md + MEMORY.md hold authoritative content that a
    // deterministic rebuild from drafts+entries would CLOBBER. So a later
    // integrate() pass must NOT regenerate those files: detect the authority
    // marker (.phase2-authoritative, written on every successful phase2
    // publish) and, provided the pair is intact, skip (record-only the
    // watermark so we don't re-enter this branch). Bootstrap (files missing)
    // and repair (a broken/dir path, which must throw EISDIR so the import
    // transaction can roll back) still go through the writers.
    const summaryPath = path.join(memoryRoot(), 'memory_summary.md')
    const registryPath = path.join(memoryRoot(), 'MEMORY.md')
    const broken = (p) => {
      try { return exists(p) && !fs.statSync(p).isFile() } catch { return false }
    }
    const filesOk =
      exists(summaryPath) && exists(registryPath) &&
      !broken(summaryPath) && !broken(registryPath)
    const authorityPath = path.join(memoryRoot(), '.phase2-authoritative')
    if (filesOk && readText(authorityPath).trim()) {
      writeText(wmPath, fp)
      return { changed: false, skipped: true, watermark: fp }
    }
    writeRegistry()
    writeSummary()
    writeText(wmPath, fp)
    return { changed: true, skipped: false, watermark: fp }
  }

  /**
   * 「当日」键：**本机时区**的 YYYY-MM-DD —— 以**本地 00:00** 为日界。
   * t121：此前是 `d.toISOString().slice(0, 10)`（**UTC 日**），东八区实际在北京时间 08:00 换日，
   * 与「每日预算」的直觉不符。改用本地 getFullYear/getMonth/getDate 手工拼接（补零），
   * **不新增持久字段**；旧 `runDay` 值只是字符串，不等即触发一次重置（见 CHANGELOG 的"首日一次性额外重置"）。
   */
  const dayKey = (d = new Date()) => {
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const da = String(d.getDate()).padStart(2, '0')
    return `${y}-${mo}-${da}`
  }

  /**
   * Serialize a derived Message[] into a plain-text literal snapshot WITHOUT any
   * LLM call. Shared by the live-object path and the persistence path, so both
   * produce an identical body (role + text blocks only; no reasoning/tool raw).
   * Phase 3 feeds this snapshot to ctx.llm as the extraction input, using it
   * verbatim as the fallback when the LLM call fails.
   *
   * M2 隐私闭环：source-aware 过滤。以 `m.source.kind` 为准——
   *   - 保留 `user`（真人输入）与 `model`（助手最终说明），捕捉真实用户决定与完成结果；
   *   - 排除 `plugin`（注入上下文：AGENTS/skill/recall/cron 等，避免把注入再记为事实）；
   *   - 排除 `tool`（工具结果正文：隐私 + 噪声，外部工具是否整会话跳过另由 events 判定）；
   *   - `kind` 缺失（旧消息/非标准构造）时保守按 role 保留 user/assistant 文本。
   * 不把 tool arguments、tool results 或完整 source JSON 拼进 prompt。
   */
  function messagesToDraftBody(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return ''
    const lines = []
    for (const m of messages) {
      const role = String((m && m.role) || 'user')
      const sourceKind = m && m.source && typeof m.source.kind === 'string' ? m.source.kind : ''
      // M2：来源过滤。plugin / tool 正文不进提炼输入（见上注释）。
      if (sourceKind === 'plugin' || sourceKind === 'tool') continue
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
   * (no LLM for that route) rather than guessing. This is how dsh-memory_rollout "leaves
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
   * Persistence message path (preferred). Reads a session's messages by id from
   * the DSH durable session log (Codex reads its rollout jsonl the same way) and
   * reconstructs a detached Session, so it works even after the session has been
   * disposed. Never uses `sessionPersistence.load` (which requires a closed
   * turn); uses `sessionQuery.readSession` (live-or-persisted, and waits for the
   * dispose-time write drain internally).
   *
   * `sessionQuery` is resolved lazily with strict=false so an uninstalled query
   * plugin yields `undefined` → we return `null` to signal the caller to fall
   * back to the live-object path. Returns `{ events, messages, cwd }` on success
   * (cwd from the persisted header), `{ events: [], messages: [], cwd }` when the
   * persisted log is corrupt/unreadable (degrade to empty, never throw), or
   * `null` when the query plugin is absent.
   */
  async function sessionMessagesByPersistence(sessionId) {
    const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery', false) : undefined
    if (!query || typeof query.readSession !== 'function') return null
    let header
    let events
    try {
      const r = await query.readSession(sessionId)
      header = r && r.session
      events = (r && r.events) || []
      const s = Session.create(sessionId, events, header)
      // M2：把 events 一并返回，供资格判定在不重建消息的情况下扫描 tool/call 来源。
      // t189：一并返回会话头（`header`），供「只对根会话生成」判定血缘（parentSession/origin/delegationDepth）。
      return { events, messages: s.deriveMessages(), cwd: header && header.cwd, header: header || null, sourceStatus: 'ok' }
    } catch {
      // M2：即使消息无法重建（corrupt/unreadable），也保留已读到的 events 给资格判定，
      // 避免外部上下文会话在消息重建失败时因 events 被清空而漏判。
      // P0 source-missing 分离：标记 sourceStatus='unavailable'（读源抛错/损坏），供
      // stage-1 drain 区分「源不可用（retryable）」与「真空源 no-op」，绝不返回成功 no-output。
      return { events: events || [], messages: [], cwd: header && header.cwd, header: header || null, sourceStatus: 'unavailable' }
    }
  }

  // ── M2：生成资格判定（纯函数，供 Stage 1 drain 在 LLM 前调用）──────────────
  // 「已知外部工具」初始集：harness 内置的 web 模型工具（@deepseek-ai/dsh-tool-web
  // 注册 web_search / web_fetch，DeepSeek 后端提供搜索结果）。只对「已证实」的外部
  // 工具整会话跳过自动生成，不靠文本猜测；本地工具（pwsh/read/grep 等）不作外部，
  // 避免误杀真实用户决定。MCP 当前未安装（无生产者），不纳入名单。
  const EXTERNAL_CONTEXT_TOOLS = new Set(['web_search', 'web_fetch'])
  // 内部 skip reason 词汇，用于区分「外部上下文」与其它 no-op（可追溯，不进 Phase 2）。
  const ELIGIBILITY_SKIP_REASON = { externalContext: 'external_context' }
  /**
   * M2 生成资格判定。在「任何模型调用、预算扣减、草稿写入」之前调用。
   * 依据持久 events 里的 `tool/call.name` 判断会话是否使用了已证实的外部上下文。
   * 返回 { eligible: boolean, skipReason?: string }：
   *   - 命中外部工具 → { eligible: false, skipReason: 'external_context' }；
   *   - 其余 → { eligible: true }（过短/无内容/纯闲聊交给 <60 chars 与 LLM no-op 兜底，
   *     不在此处做第二套分类器）。
   * 纯函数：不读存储、不调用模型、不依赖本 apply 的闭包写状态，便于单测。
   */
  function assessEligibility(events) {
    const list = Array.isArray(events) ? events : []
    for (const ev of list) {
      if (ev && ev.type === 'tool/call' && ev.data && typeof ev.data.name === 'string') {
        if (EXTERNAL_CONTEXT_TOOLS.has(ev.data.name)) {
          return { eligible: false, skipReason: ELIGIBILITY_SKIP_REASON.externalContext }
        }
      }
    }
    return { eligible: true }
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
    if (!trimmed) return { status: 'succeeded_no_output', extraction: null, reason: 'empty_source' }
    if (trimmed.length < 60) return { status: 'succeeded_no_output', extraction: null, reason: 'short_content' }
    const extraction = await extractWithLlm(raw)
    if (!extraction) return { status: 'failed', extraction: null }
    const summary = String(extraction.rollout_summary || '').trim()
    return summary
      ? { status: 'succeeded_with_output', extraction }
      : { status: 'succeeded_no_output', extraction, reason: 'model_empty' }
  }

  // ── Global write-maintenance lock (GPT §12.1) ───────────────────────────
  let writeBusy = false
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
        opts.conflictMessage || '[dsh-memory_rollout] another write is in progress — retry shortly',
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
  /** Synchronous variant for call sites that can't await (e.g. sync integrate). */
  function withWriteSync(fn, opts = {}) {
    if (writeBusy) {
      const e = new Error(
        opts.conflictMessage || '[dsh-memory_rollout] another write is in progress — retry shortly',
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

  // ── lease heartbeat (GPT P0-5：长模型调用期间续租，防被另一 worker 回收) ──
  // 单进程内让超长 LLM 调用期间刷新 lease_expires_at，保住所有权；跨进程为 best-effort。
  // t187：HEARTBEAT_INTERVAL_MS 已提升到模块作用域（导出，便于测试）；值仍是 20s，语义不变。
  function startHeartbeat(intervalMs, refresh) {
    const hb = setInterval(() => { refresh().catch(() => {}) }, intervalMs)
    if (hb && hb.unref) hb.unref()
    return hb
  }
  function stopHeartbeat(hb) {
    if (hb) clearInterval(hb)
  }

  // ── stage-1 persistent job storage (apply-scoped, table-backed) ────────────
  // 旧实现读写 <memoryRoot>/.stage1-state.json；现在读写 dsh_rollout 的
  // stage1_jobs / stage1_outputs / stage1_meta 三张表。state 对象形状保持
  // { jobs, outputs, global } 不变，供 phase2Integrate / selectPhase2Inputs 等在
  // 迁移后零改动消费（只改持久层）。
  const oldStage1StatePath = () => path.join(memoryRoot(), '.stage1-state.json')
  /** 读表抽取全部 job 键（用于领选/回收扫描）。 */
  const allStage1Jobs = () => {
    const m = {}
    for (const [k, v] of stage1JobsTable.entries()) m[k] = v
    return m
  }

  /**
   * 阶段 A：drain 消费表里到期(pending, available_at<=now 或 failed_retryable+available_at<=now)
   * 的作业。领取→锁外提炼（读持久会话 + LLM）→提交（stage1FinishJob）。每次循环先回收过期租约；
   * 无立即可运行作业时设置定时唤醒（到最早 available_at/lease_expires_at，§3 时间驱动）。
   */
  const STAGE1_LEASE_MS = 60000

  /**
   * §5 启动/每次 drain 前回收过期租约：`running` 且（租约过期 或 lease_owner 不是当前 boot）
   * → pending。withWrite 内逐条 `update(key,fn)`（唯一真原子读改写）。返回回收数。
   */
  async function recoverStage1Jobs(nowMs) {
    return withWrite(async () => {
      const toReclaim = []
      for (const [k, v] of stage1JobsTable.entries()) {
        if (!v || v.status !== 'running') continue
        const expired = !v.lease_expires_at || new Date(v.lease_expires_at).getTime() < nowMs
        const foreign = v.lease_owner && v.lease_owner !== bootId
        if (expired || foreign) toReclaim.push(k)
      }
      let reclaimed = 0
      for (const k of toReclaim) {
        await stage1JobsTable.update(k, (cur) => ({
          ...cur,
          status: 'pending',
          lease_owner: '',
          lease_expires_at: '',
          lease_token: '',
          updated_at: new Date(nowMs).toISOString(),
        }))
        reclaimed++
      }
      return reclaimed
    })
  }

  /**
   * GPT P0-3 恢复扫描：`succeeded_with_output` 的作业必须对应一条 stage1_outputs 产物
   * （key=job.id）。若出现「终态成功但缺 output」的跨 key 半提交（旧顺序遗留或崩溃窗口），
   * 重置回 pending 重做（重新提炼，output 幂等覆盖），确保不丢 Phase 2 输入。
   * 返回修复数。
   */
  async function reconcileStage1OutputInvariant(nowMs) {
    return withWrite(async () => {
      let fixed = 0
      for (const [k, v] of stage1JobsTable.entries()) {
        if (!v || v.status !== 'succeeded_with_output') continue
        if (stage1OutputsTable.get(v.id)) continue
        // 缺产物：作业已终态但 output 未落盘 → 重置 pending 重新提炼（幂等）。
        await stage1JobsTable.update(k, (cur) => ({
          ...cur,
          status: 'pending',
          lease_owner: '',
          lease_expires_at: '',
          lease_token: '',
          attempt_count: 0,
          completed_at: '',
          updated_at: new Date(nowMs).toISOString(),
        }))
        fixed++
      }
      return fixed
    })
  }

  /** 在 withWrite 内领取一个 pending 或到期的 failed_retryable，置 running+租约（owner 含 boot_id）。 */
  async function claimNextStage1Job(nowMs) {
    return withWrite(async () => {
      const jobs = {}
      for (const [k, v] of stage1JobsTable.entries()) jobs[k] = { ...v }
      const pick = claimStage1Job({ jobs }, nowMs, STAGE1_LEASE_MS, bootId)
      if (!pick) return null
      const key = stage1JobKey(pick.session_id, pick.source_watermark)
      // 用 update(key,fn) 在写链槽位原子置 running + 租约 + 一次性 ownership token。
      const token = makeId()
      await stage1JobsTable.update(key, (cur) => ({
        ...cur,
        status: 'running',
        lease_owner: bootId,
        lease_token: token,
        lease_expires_at: new Date(nowMs + STAGE1_LEASE_MS).toISOString(),
        updated_at: new Date(nowMs).toISOString(),
      }))
      return { ...pick, lease_token: token }
    })
  }

  /** GPT P0-5：长模型调用期间续租。仅当 job 仍属当前 bootId + token 才刷新过期时间。 */
  async function renewStage1Lease(key, token) {
    await withWrite(async () => {
      const j = stage1JobsTable.get(key)
      if (!j || j.lease_owner !== bootId || j.lease_token !== token) return
      await stage1JobsTable.update(key, (cur) => ({
        ...cur,
        lease_expires_at: new Date(Date.now() + STAGE1_LEASE_MS).toISOString(),
        updated_at: new Date().toISOString(),
      }))
    })
  }

  /**
   * 在 withWrite 内提交一步：用 `update(key,fn)` 推进 job（成功/退避/降级 terminal），
   * 若有产物再把 output put 进 stage1_outputs（key=job_id）。跨「一条 job + 一条 output」
   * 不是单记录原子（存储域不支持跨 key 事务），但整段在 withWrite 串行 + 幂等重放收敛。
   * `succeeded_with_output` 时额外产出逐会话证据文件 `rollout_summaries/<sessionId>.md`
   * 并把 `source_ref` 写入 output 记录（P1-1 证据层），使引用可被 validateSourceRef 核查。
   * `skipReason`（可选）：M2 生成资格判定的内部 skip 说明（如 external_context），在
   * succeeded_no_output 时写入 job 的 `last_skip_reason`（passthrough 允许额外字段），
   * 供本地诊断追溯「为什么这个会话没生成记忆」；不含正文、不进 Phase 2。
   * 返回 { status, job, wroteOutput }。
   */
  async function submitStage1Job(claimed, status, extraction, errMsg, now, cwd, skipReason) {
    return withWrite(async () => {
      const key = stage1JobKey(claimed.session_id, claimed.source_watermark)
      // GPT P0-5：提交前校验仍拥有租约 + ownership token（防止被另一个 worker 索取/回收后
      // 旧 worker 仍写权威状态）。token 不匹配 → 丢弃结果，不写终态/产物（下一轮重做，幂等）。
      const curJob = stage1JobsTable.get(key)
      const owned = !!curJob && curJob.status === 'running' && curJob.lease_owner === bootId &&
        (!claimed.lease_token || curJob.lease_token === claimed.lease_token)
      if (!owned) {
        return { status: 'ownership-lost', job: curJob, wroteOutput: false }
      }
      const sid = curJob.session_id
      const jid = curJob.id
      let wroteOutput = false
      // GPT P0-3：先持久产物（evidence + output），最后才推进 job 终态，消除
      // 「job 已终态但 output 未落盘」的跨 key 半提交窗口；中途崩溃时 job 仍为 running
      // （租约过期被重做，output 幂等覆盖，不丢 Phase 2 输入）。
      if (status === 'succeeded_with_output' && extraction) {
        // P1-1：成功提炼时自动产出逐会话证据文件（内容非空），并据此写出可核查的 source_ref。
        // P0 证据文件不可变定址：同一会话多次 watermark 时不覆盖旧行——先读现有文件行数，
        // 新块追加在旧行之后，旧 output 的 source_ref（指向旧行段）在被追加后仍可验证。
        const evPath = path.join(memoryRoot(), `rollout_summaries/${safeSlug(sid || 'unknown')}.md`)
        const existingText = readText(evPath)
        const existingLineCount = countFileLines(existingText)
        const evidence = buildEvidenceContent(sid, cwd || '', extraction, { existingLineCount })
        let sourceRef = evidence && evidence.sourceRef
        if (evidence && evidence.content) {
          try {
            const sep = existingLineCount > 0 ? '\n' : ''
            writeText(evPath, existingText + sep + evidence.content)
          } catch (e) {
            // best-effort：证据文件写入失败不阻断作业提交；source_ref 仍记录预期位置，
            // 引用生成侧 validateSourceRef 会因文件缺失回退 unverified（安全）。
            try { console.error('[dsh-memory_rollout] evidence file write failed:', (e && e.message) || e) } catch {}
            sourceRef = sourceRef ? { ...sourceRef } : null
          }
        }
        await stage1OutputsTable.put(stage1OutputKey(jid), {
          job_id: jid,
          session_id: sid,
          source_watermark: curJob.source_watermark,
          rollout_summary: String(extraction.rollout_summary || ''),
          raw_memory_or_evidence_excerpt: String(extraction.raw_memory || ''),
          rollout_slug: String(extraction.slug || ''),
          keywords: String(extraction.keywords || ''),
          content_hash: String(extraction.content_hash || ''),
          generated_at: now.toISOString(),
          effective_provider: String(extraction.provider || ''),
          effective_model: String(extraction.model || ''),
          selected_for_phase2: false,
          // P1-1：证据引用 { path, startLine, endLine, citeSpan, sessionId }。schema 已 .passthrough。
          source_ref: sourceRef,
          // t78：审计留痕——本产物是否由显式 force 绕过 external_context 资格判定而产生。
          forced: curJob.forced === true,
          force_reason: curJob.forced === true ? String(curJob.force_reason || 'user_requested') : '',
        })
        wroteOutput = true
      }
      const patch = (cur) => {
        if (status === 'succeeded_with_output' && extraction) {
          return { status: 'succeeded_with_output', completed_at: now.toISOString() }
        }
        if (status === 'succeeded_no_output') {
          const base = { status: 'succeeded_no_output', completed_at: now.toISOString() }
          // M2：外部上下文/资格跳过时记录内部 skip reason（只本地诊断，不进 Phase 2）。
          if (skipReason) base.last_skip_reason = skipReason
          return base
        }
        // failed / failed_retryable：attempt+1，形成 retry_wait（failed_retryable + available_at 退避）。
        const attempt = (cur.attempt_count || 0) + 1
        const maxAttempts = cur.max_attempts || 3
        const base = {
          last_error: errMsg || '',
          last_error_code: '',
          last_error_message: errMsg || '',
        }
        if (attempt >= maxAttempts) {
          return { status: 'failed_terminal', attempt_count: attempt, ...base, completed_at: now.toISOString() }
        }
        return {
          status: 'failed_retryable',
          attempt_count: attempt,
          ...base,
          available_at: new Date(now.getTime() + stage1BackoffSeconds(attempt) * 1000).toISOString(),
        }
      }
      const job = await stage1JobsTable.update(key, (cur) => ({
        ...cur,
        ...patch(cur),
        updated_at: now.toISOString(),
      }))
      // P1 seen-index：成功终态（有/无产物）都记「已提炼过」，供 stage1_jobs 归档后仍去重。
      if (job.status === 'succeeded_with_output' || job.status === 'succeeded_no_output') {
        await stage1SeenTable.put(key, {
          session_id: sid,
          source_watermark: curJob.source_watermark,
          created_at: now.toISOString(),
        })
      }
      return { status: job.status, job, wroteOutput }
    })
  }

  /** §3 时间驱动：计算表里最早的下一次唤醒时间（到期的 pending/retry_wait 或 running 租约过期）。 */
  function nextStage1WakeAt(nowMs) {
    let next = Infinity
    for (const [, v] of stage1JobsTable.entries()) {
      if (!v) continue
      const av = v.available_at ? new Date(v.available_at).getTime() : 0
      const le = v.lease_expires_at ? new Date(v.lease_expires_at).getTime() : 0
      let t = 0
      if ((v.status === 'pending' || v.status === 'failed_retryable') && av > nowMs) t = av
      else if (v.status === 'running' && le > nowMs) t = le
      if (t && t < next) next = t
    }
    return Number.isFinite(next) ? next : null
  }

  /** 是否存在「本应处理」的到期作业（不考虑预算门）。用于预算耗尽时决定是否安排跨日唤醒。 */
  function hasDueStage1Job(nowMs = Date.now()) {
    const t = new Date(nowMs).getTime()
    for (const [, v] of stage1JobsTable.entries()) {
      if (!v) continue
      const duePending = v.status === 'pending' && (!v.available_at || new Date(v.available_at).getTime() <= t)
      const dueRetry = v.status === 'failed_retryable' && v.available_at && new Date(v.available_at).getTime() <= t
      if (duePending || dueRetry) return true
    }
    return false
  }

  /**
   * 下一个**本地**日边界（预算窗口起点）—— 与 `dayKey()` **同一套日界语义**（本地 00:00）。
   * t132：此前用 `d.setUTCHours(24, 0, 0, 0)`（**UTC 午夜**）。预算门 `dayKey()` 已本地化后，
   * 二者口径不一致：新预算日从本地 00:00 起算，唤醒点却仍在 **UTC 午夜**（东八区＝本地 08:00）
   * ⇒ 新预算日开始后最多 8 小时（UTC−5 约 19h）没有跨日唤醒，预算耗尽时作业要干等。
   */
  function nextDayBoundaryMs(nowMs) {
    const d = new Date(nowMs)
    d.setHours(24, 0, 0, 0)
    return d.getTime()
  }

  let stage1Busy = false
  let stage1RerunRequested = false
  /**
   * t189（②·门槛一）：**启动趟的来源上限**（抄 codex `max_rollouts_per_startup = 2`）。
   * 【t191 收口（t190 发现②，选 A：让启动上限成为**每次启动的真约束**）】预算现在是**可继承的预算对象**
   * `{ remaining }`，而不是"只影响一趟"的一次性数字：
   *   - `scheduleStage1Drain(budget)` 把它绑在某一趟上；事件/唤醒/显式工具不传 ⇒ 不设限；
   *   - **busy-rerun 补跑趟继承"在飞那一趟"的预算对象**（同一对象、剩余量继续算）⇒ 补跑趟**不再绕过上限**；
   *   - `scheduleStage1Drain` 早退（已有排程）时**把预算合并**进已排程那趟，不再静默丢掉上限；
   *   - 预算耗尽 ⇒ 仍走 `STARTUP_SOURCE_SPACING_MS` 的间隔唤醒 ⇒ **30s 间隔照旧生效**。
   */
  let stage1CurrentBudget = null // 在飞趟次的启动预算（供补跑趟继承）
  let stage1RerunBudget = null // 补跑趟要继承的预算对象
  let stage1ScheduledBudget = null // 已排程但尚未跑那趟的预算（早退时合并用）
  const normalizeStage1Budget = (b) =>
    // t191：**耗尽的预算（remaining === 0）也是一个预算** —— 它必须继续传递，好让补跑趟"到顶即止"；
    //   只有"根本没给预算"（null/undefined/形状不对）才算不设限。
    b && typeof b === 'object' && Number.isFinite(b.remaining) && b.remaining >= 0 ? b : null
  async function drainStage1Jobs(opts = {}) {
    if (stage1Busy) {
      // P0 busy rerun latch：忙时被再次请求 → 记录「忙完后补跑」，绝不丢触发。
      stage1RerunRequested = true
      // t191（选 A）：补跑趟继承**在飞那一趟**的启动预算（请求方自带预算则以请求方为准）；
      //   取"更紧"的那个（remaining 更小），避免用宽预算覆盖已被消耗的紧预算。
      const incoming = normalizeStage1Budget(opts.budget)
      const inherited = incoming || stage1CurrentBudget
      if (inherited && (!stage1RerunBudget || inherited.remaining < stage1RerunBudget.remaining)) stage1RerunBudget = inherited
      return 0
    }
    stage1Busy = true
    const startupBudget = normalizeStage1Budget(opts.budget)
    stage1CurrentBudget = startupBudget
    try {
      const cap = Math.max(1, config.maxModelAttemptsPerDay || 24)
      // 每次 drain 先回收过期租约 + 修复「终态成功缺 output」的一半提交（§5 时间驱动）。
      await recoverStage1Jobs(Date.now())
      await reconcileStage1OutputInvariant(Date.now())
      let processed = 0
      let anyOutput = false
      let budgetExhausted = false
      let startupCapReached = false
      for (;;) {
        // 预算门：withWrite 内「跨日归零 + 读取当日已用」。达上限停止领取。
        const budget = await withWrite(async () => {
          const m = readStage1Meta()
          const dk = dayKey()
          if (m.runDay !== dk) {
            m.runDay = dk
            m.modelAttemptsToday = 0
            await writeStage1Meta(m)
          }
          return m.modelAttemptsToday
        })
        if (budget >= cap) { budgetExhausted = true; break }
        // t189（②·门槛一）/t191：启动来源预算 —— **先扫清死数据（上面的 recover/reconcile），再判要不要继续开工**；
        //   到顶即止，剩余来源交给后续趟次/事件。预算是**跨趟共享的对象** ⇒ 补跑趟也吃同一额度。
        if (startupBudget && startupBudget.remaining <= 0) {
          startupCapReached = true
          try {
            console.info('[dsh-memory_rollout] startup source budget exhausted; remaining sources continue on later passes (>=30s spacing)')
          } catch {}
          break
        }
        // 领取（brief lock）。
        const claimed = await claimNextStage1Job(Date.now())
        if (!claimed) break
        // t191：领取即扣减启动预算（对象共享 ⇒ 补跑趟看到的是扣减后的剩余量）。
        if (startupBudget) startupBudget.remaining -= 1
        // 锁外提炼：读持久会话 + LLM。
        let status = 'failed'
        let extraction = null
        let errMsg = ''
        let cwd = ''
        let skipReason = ''
        let sourceUnavailable = false
        try {
          let raw = ''
          let persisted = null
          if (claimed.session_id) persisted = await sessionMessagesByPersistence(claimed.session_id)
          // P0 source-missing 与 no-output 分离：
          //  - persisted === null：sessionQuery 服务缺失（部署能力缺陷，非该会话源缺失）。
          //    P0-R2-3：不再标成 empty_source（那会让「插件读不了会话」伪装成「会话真的空」）——
          //    改为能力缺失专属原因 source_capability_missing，overview 以 capabilities.stage1SourceRead:false
          //    暴露；因 sessionQuery 已声明为必需 inject，实跑不会走到此（防御性兜底保留 no-op 防死循环）。
          //  - persisted.sourceStatus === 'unavailable'：读源抛错/损坏（会话已删/服务不可用）——
          //    绝不返回成功 no-output，标记 retryable（可恢复时重试、达到 max 后 terminal）。
          //  - 其余：真空源/短内容 → raw 交 extractWithOutcome 归因 no-output（empty/short/model_empty）。
          if (persisted === null) {
            skipReason = 'source_capability_missing'
          } else if (persisted && persisted.sourceStatus === 'unavailable') {
            sourceUnavailable = true
            status = 'failed_retryable'
            errMsg = `[dsh-memory_rollout] stage1 source unavailable: ${claimed.session_id}`
            skipReason = 'source_unavailable'
          } else {
            if (persisted && Array.isArray(persisted.messages) && persisted.messages.length) {
              raw = messagesToDraftBody(persisted.messages)
              cwd = persisted.cwd || ''
            }
          }
          // M2：生成资格判定 —— 在任何模型调用、预算扣减、草稿写入之前。
          // 命中已证实的外部工具（web_search/web_fetch）→ 整会话跳过自动生成，不烧配额、不产出。
          if (!sourceUnavailable && persisted) {
            if (claimed.forced === true) {
              // t78：显式 force（仅 memory_precompact 可设，自动路径永不设）→ 绕过 external_context
              // 资格跳过，按正常流程提炼；留痕可审计（job 记录含 forced / force_reason）。
              try {
                console.warn('[dsh-memory_rollout] stage1 FORCED bypass of external_context eligibility: job=' + claimed.id + ' session=' + claimed.session_id + ' reason=' + (claimed.force_reason || ''))
              } catch {}
            } else {
              const elig = assessEligibility(persisted.events)
              if (elig && elig.eligible === false) {
                status = 'succeeded_no_output'
                skipReason = `external_context:${elig.skipReason || 'ineligible'}`
                errMsg = `[dsh-memory_rollout] skip ${skipReason}`
                // 外部上下文：不调用模型、不烧配额、不产出 output（提交时按 no-output 处理）。
              }
            }
          }
          // 真模型尝试（>=60 chars）才烧配额；短/无回绝不烧（与 extractWithOutcome 的 gate 一致）。
          // 外部上下文已判不合格 → raw 不受理，也不烧配额；源不可用 → 不烧（等重试）。
          if (!sourceUnavailable && status !== 'succeeded_no_output' && raw.trim().length >= 60) {
            await withWrite(async () => {
              const m = readStage1Meta()
              if (m.runDay !== dayKey()) {
                m.runDay = dayKey()
                m.modelAttemptsToday = 0
              }
              m.modelAttemptsToday += 1
              await writeStage1Meta(m)
            })
          }
          // GPT P0-5：长模型调用期间心跳续租。
          const key = stage1JobKey(claimed.session_id, claimed.source_watermark)
          const hb = startHeartbeat(HEARTBEAT_INTERVAL_MS, () => renewStage1Lease(key, claimed.lease_token))
          try {
            // 外部上下文不合格时直接走 no-output，跳过 LLM；源不可用时已置 retryable，不走 LLM。
            const out = status === 'succeeded_no_output'
              ? { status: 'succeeded_no_output', extraction: null, reason: skipReason || 'external_context' }
              : sourceUnavailable
                ? { status: 'failed_retryable', extraction: null, reason: 'source_unavailable' }
                : await extractWithOutcome(raw)
            status = out.status
            extraction = out.extraction
            if (status === 'succeeded_no_output' && !skipReason && out.reason) skipReason = out.reason
          } finally {
            stopHeartbeat(hb)
          }
        } catch (err) {
          errMsg = String((err && err.message) || err)
          // 读源抛错（非 plugin-absent）绝不能伪装成成功 no-op：标记 source_unavailable 可重试。
          if (!sourceUnavailable && status === 'failed' && /source|readSession|session/i.test(errMsg)) {
            status = 'failed_retryable'
            sourceUnavailable = true
            skipReason = 'source_unavailable'
          }
        }
        // 提交（brief lock）。
        const submitted = await submitStage1Job(claimed, status, extraction, errMsg, new Date(), cwd, skipReason)
        if (submitted.wroteOutput) anyOutput = true
        processed++
      }
      // H3：drain 产出新增量输出后自动触发一次真 Phase 2 整合（best-effort，失败不抛）。
      if (anyOutput) {
        try { await phase2Integrate() } catch {}
      }
      // §3/§5：无立即可运行作业 → 设一次定时唤醒（时间驱动，不靠事件）。用最早到期唤醒。
      let wakeAt = nextStage1WakeAt(Date.now())
      // GPT P0-6：预算耗尽且仍有「本应处理」的到期作业 → 安排到下一预算窗口开始的唤醒。
      if (wakeAt == null && budgetExhausted && hasDueStage1Job()) {
        wakeAt = nextDayBoundaryMs(Date.now())
      }
      // t189（②·门槛一）：启动来源上限到顶 ⇒ 下一趟**至少隔 STARTUP_SOURCE_SPACING_MS**（不立刻补跑，
      //   否则上限形同虚设）；剩余来源在那之后继续处理，不丢。
      if (startupCapReached) {
        const spaced = Date.now() + STARTUP_SOURCE_SPACING_MS
        wakeAt = wakeAt == null ? spaced : Math.max(wakeAt, spaced)
      }
      scheduleStage1Wake(wakeAt)
      return processed
    } finally {
      stage1Busy = false
      stage1CurrentBudget = null
      // P0 busy rerun latch：忙时被请求过→释放后立即再 drain 一次（清标记，防死循环）。
      // t191（选 A）：补跑趟**继承**本次在飞趟次的剩余预算（同一预算对象）⇒ 启动上限不再被补跑趟绕过；
      //   预算耗尽时该补跑趟立刻到顶、由 spacing 唤醒接管（30s 间隔照旧生效）。
      if (stage1RerunRequested) {
        stage1RerunRequested = false
        const inherit = stage1RerunBudget
        stage1RerunBudget = null
        scheduleStage1Drain(inherit)
      }
    }
  }

  // ── 阶段 A 调度唤醒（§3：单在途 + 时间驱动，非只靠事件）──────────────────
  let stage1DrainScheduled = false
  let stage1WakeTimer = null
  /**
   * t178：跑一次「调度 pass」，并把**写锁竞争**当成**可重试**（短退避 + 有界）。
   * 为什么必须重试、不能只降噪：`withWrite` 是非队列锁（busy ⇒ 直接抛），而这些 pass 由
   * `setImmediate` / 定时器调度、**catch 里只 log、不重新武装**。真实存储的写是异步慢写 ⇒ 锁会跨越
   * macrotask ⇒ 启动期多条写路径（stage1 drain / phase2 auto / phase2 wake）会同时撞上"被 await 的
   * 启动 reconcile"。实测：落败者**整次 pass 丢掉**，且没有别的触发时工作被**无限期拖延**
   * （复现里出现 0/3 消费、0 次 LLM）⇒ 这是"会漏处理"，不是纯噪音。
   * 有界性：同一 pass 连续退避重试至多 `MAX_WRITE_CONFLICT_RETRIES` 次，**成功即清零**；
   *          超限仍失败 ⇒ 按原样记 error（不再无限重试，交回常规唤醒/事件路径）。
   * 日志：竞争不再记 error（降为 warn，并写明"第几次/何时重试"）；其它错误照旧 error。
   */
  const writeConflictRetriesByKey = {}
  const runScheduledPass = (label, key, run) => {
    Promise.resolve()
      .then(() => run())
      .then(() => { delete writeConflictRetriesByKey[key] })
      .catch((err) => {
        const n = writeConflictRetriesByKey[key] || 0
        if (isWriteConflictError(err) && n < MAX_WRITE_CONFLICT_RETRIES) {
          writeConflictRetriesByKey[key] = n + 1
          try {
            console.warn(`[dsh-memory_rollout] ${label}: write lock busy — retry ${n + 1}/${MAX_WRITE_CONFLICT_RETRIES} in ${WRITE_CONFLICT_RETRY_MS}ms`)
          } catch { /* ignore */ }
          setTimeout(() => { runScheduledPass(label, key, run) }, WRITE_CONFLICT_RETRY_MS)
          return
        }
        delete writeConflictRetriesByKey[key]
        try { console.error(`[dsh-memory_rollout] ${label}:`, err) } catch { /* ignore */ }
      })
  }
  function scheduleStage1Drain(budget = null) {
    const normalized = normalizeStage1Budget(budget)
    if (stage1DrainScheduled) {
      // t191：已有排程 ⇒ 不新增一趟，但**把预算合并**进已排程那趟（取更紧的）——
      //   否则启动上限会被"早退"静默丢掉（t190 发现② 的同族面）。
      stage1ScheduledBudget =
        normalized && (!stage1ScheduledBudget || normalized.remaining < stage1ScheduledBudget.remaining)
          ? normalized
          : stage1ScheduledBudget
      return
    }
    stage1DrainScheduled = true
    stage1ScheduledBudget = normalized
    setImmediate(() => {
      stage1DrainScheduled = false
      const passBudget = stage1ScheduledBudget
      stage1ScheduledBudget = null
      // t189/t191：来源预算**只随这一趟**（启动块传入、或补跑趟继承）；其它调度者不传 ⇒ 不设限。
      runScheduledPass('stage-1 drain error', 'stage1', () => drainStage1Jobs({ budget: passBudget }))
    })
  }
  function scheduleStage1Wake(nextAt) {
    if (stage1WakeTimer) clearTimeout(stage1WakeTimer)
    stage1WakeTimer = null
    if (nextAt == null) return
    // 退避最长 1h、预算跨日最长 24h，均低于 Node 的 setTimeout 上限；直接睡到到期，
    // 不再每 60 秒空转扫描整张作业表。
    const delay = Math.max(0, nextAt - Date.now())
    stage1WakeTimer = setTimeout(() => {
      stage1WakeTimer = null
      // t180：与**同一次 drain 的另一个入口** `scheduleStage1Drain`（L2503）对齐——它也是"调度回调里起写"，
      // 同样必须走 `runScheduledPass`（写锁竞争 ⇒ 短退避重试 + 降噪）；否则两个入口待遇不同：
      // 一个会重试，一个会把整次丢掉、只记一条 error。
      runScheduledPass('stage-1 wake drain error', 'stage1-wake', () => drainStage1Jobs())
    }, delay)
  }

  /**
   * §4 事件入队（不丢）。GPT P0-2：入队必须是「持久事实」——事件返回前该会话记忆作业已落盘。
   * 入队只写独立 key（session::watermark，幂等去重），不读改写共享键，故不用 withWrite 布尔锁
   * （该锁只用于多 key 读改写串行；被其挡住会丢弃事件）。storage-domain per-key put 是原子的，
   * 并发重复 put 同 key 只会以最后一份为准，不产生双份或孤儿。真存储故障（非锁忙）才向上抛，
   * 由事件处理器明确记录，绝不静默丢。
   */
  async function enqueueStage1JobIntoTable(sessionId, watermark, opts = {}) {
    const key = stage1JobKey(sessionId, watermark)
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    let lastErr
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const existing = stage1JobsTable.get(key)
        if (existing) {
          // GPT 审查修正（P0-2 残留）：同一 contentWatermark 曾被 drain 用尽 max_attempts
          // 置为 failed_terminal 后，再次 dispose（新的重试事件）应重置回 pending 重新提炼，
          // 而不是被「已入队」永久挡掉，导致该内容丢失进记忆管线。
          if (existing.status === 'failed_terminal') {
            const now2 = new Date()
            const reset = await stage1JobsTable.update(key, (cur) => ({
              ...cur,
              status: 'pending',
              attempt_count: 0,
              available_at: now2.toISOString(),
              lease_owner: '',
              lease_expires_at: '',
              lease_token: '',
              last_error: '',
              last_error_message: '',
              completed_at: '',
              updated_at: now2.toISOString(),
              ...(opts.forced === true
                ? { forced: true, force_reason: String(opts.forceReason || 'user_requested'), forced_at: now2.toISOString() }
                : {}),
            }))
            return { queued: true, reset: true, key, job: reset }
          }
          // t78：显式 force（只有 memory_precompact 传得到）——把审计标记落到已存在作业；若该作业已按
          // 外部上下文以 succeeded_no_output 终态，则重置为 pending，使其按 force 重新提炼
          // （否则同 watermark 会被「已提炼过」永久挡掉，force 形同无效）。
          if (opts.forced === true) {
            const nowF = new Date()
            const patched = await stage1JobsTable.update(key, (cur) => ({
              ...cur,
              forced: true,
              force_reason: String(opts.forceReason || 'user_requested'),
              forced_at: nowF.toISOString(),
              updated_at: nowF.toISOString(),
              ...(cur.status === 'succeeded_no_output'
                ? {
                    status: 'pending',
                    attempt_count: 0,
                    available_at: nowF.toISOString(),
                    lease_owner: '',
                    lease_expires_at: '',
                    lease_token: '',
                    last_skip_reason: '',
                    completed_at: '',
                  }
                : {}),
            }))
            const requeued = !!(patched && patched.status === 'pending')
            return { queued: requeued, forced: true, requeued, key, job: patched }
          }
          return { queued: false, key, job: existing }
        }
        // P1 seen-index：若 stage1_jobs 该 key 已被归档（job 不在活跃表），但 seen-index 仍记
        // 「已提炼过」→ 去重（同内容再 dispose 不重复提炼），保证归档不破坏去重语义。
        if (stage1SeenTable.get(key)) return { queued: false, key, job: null, seen: true }
        const now = new Date()
        const job = {
          id: 'j-' + now.getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
          session_id: String(sessionId),
          source_watermark: String(watermark),
          status: 'pending',
          attempt_count: 0,
          max_attempts: (opts.maxAttempts && opts.maxAttempts) || 3,
          available_at: now.toISOString(),
          lease_owner: '',
          lease_expires_at: '',
          lease_token: '',
          last_error: '',
          last_error_code: '',
          last_error_message: '',
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
          completed_at: '',
          // t78：审计留痕——仅显式 force 入队时写入（自动路径不传 opts.forced，记录里不会出现该字段）。
          ...(opts.forced === true
            ? { forced: true, force_reason: String(opts.forceReason || 'user_requested'), forced_at: now.toISOString() }
            : {}),
        }
        await stage1JobsTable.put(key, job)
        return { queued: true, key, job }
      } catch (err) {
        lastErr = err
        await wait(50 * (attempt + 1))
      }
    }
    // 真存储故障（非锁忙）：明确抛错、由事件处理器记录，绝不静默丢会话记忆作业。
    throw new Error('[dsh-memory_rollout] enqueue failed after retries: ' + String((lastErr && lastErr.message) || lastErr))
  }

  // ── 阶段 B（真 Phase 2 全局整合）：consolidation LLM 跨会话整合 + 校验 + 发布 ──
  // §7：Phase 2 用一块整合模型，把 stage-1 的「增量」产物（selectPhase2Inputs 选出）
  // 与当前 memory_summary.md / MEMORY.md 合并，产出一份新的 memory_summary + registry，
  // 校验通过才发布（写盘）并把最后成功基线推进为「最新输入」的 source_watermark。
  // 依赖（apply 作用域内已有）：collectStreamText / parseExtractionJson /
  // isReasoningEffortError / redactSecrets / nowIso
  // / selectPhase2Inputs / validatePhase2Output / withWrite / readText / writeText.
  const CONSOLIDATION_SYSTEM_PROMPT = [
    'You are the consolidation step for a cross-session memory vault (Phase 2 of a two-phase pipeline).',
    'Given the CURRENT memory summary + registry plus NEW incremental session summaries, produce an updated, consolidated summary and registry as STRICT JSON only.',
    'Do NOT invent facts. Do NOT write prose or commentary outside the JSON.',
    'Merge the incremental inputs into the existing memory, deduplicate repeated facts, and reflect the most durable cross-session state. Preserve the structure/style of the current files.',
    '',
    'Output EXACTLY one JSON object with these fields:',
    '- "memory_summary": the updated memory_summary.md BODY. It must START with a bare "v1" line, then the rest of the 总纲. Write in the language of the inputs.',
    '- "registry": the updated MEMORY.md registry content.',
    '',
    'Rules:',
    '1. Keep everything already present unless a new input supersedes it.',
    '2. Never fabricate; only consolidate what is actually present in the inputs.',
    '3. Return ONLY the JSON object. No markdown fences, no leading/trailing prose.',
    // ── t80 L2：尺寸限长 + 分层披露（静态规则；具体数值由用户消息里的 SIZE BUDGET 每批注入）──
    '4. HARD SIZE BUDGET: the "memory_summary" you return MUST fit the character budget stated in the user message. When the current summary already exceeds that budget, you MUST compact: merge same-topic entries, drop superseded/obsolete/transient detail, and demote detail into pointers. Fitting the budget takes priority over rule 1.',
    '5. NEVER copy the registry verbatim into memory_summary. The registry (MEMORY.md) is a separate artifact; memory_summary must remain an INDEX of conclusions, not a duplicate of the registry.',
    '6. Progressive disclosure: each memory_summary entry MUST be a single line of at most ~120 characters stating the conclusion, followed by a pointer to its detail file (memories/rollout_summaries/<sessionId>.md). Detail text belongs in those detail files, which stay on disk and remain searchable — do not inline it.',
    '7. Every line must carry durable information: no filler, no duplicated facts, no restating the registry, no restating the profile/preferences sections already present.',
    // ── t83：普通批同款禁令，与安全门对齐（redactSecrets 键名白名单 L814 + 长 token 启发式 L838-841
    // + looksLikeToken L852-858）。普通批把 registry 全文喂给模型，而真实 MEMORY.md 含 `session_id:` ×18；
    // 模型照抄即被 validatePhase2Output（L456）判 unredacted secret → 整批被拒（潜在静默整合失败）。
    // t82 只在压缩模式规避，这里补上普通批。**安全门本身一个字不改。**
    '8. ABSOLUTELY FORBIDDEN — never write metadata as `key: value` or `key=value`. In particular never emit any of: session_id, token, api_key, secret, auth, password, access_token, client_secret. A safety scanner treats such keyed pairs as leaked secrets and REJECTS the entire batch.',
    '9. ABSOLUTELY FORBIDDEN — never attach a label or key to a session id either. Forms like `session_id: <id>` AND `session=<id>` are BOTH rejected by the same scanner (the latter because a `session=` prefix followed by a long id forms a long high-entropy run). Do NOT reproduce the keyed metadata that appears in the registry input.',
    '10. If you must reference a session, write the bare id or a short id ALONE with no key, label, or `=` next to it — or simply omit the citation. When in doubt, omit it.',
    '11. Keep every existing `[REDACTED]` marker EXACTLY as it is; never un-redact, re-derive, or re-word a redacted value.',
  ].join('\n')

  /** 从本批变更记录汇总「必须从权威版本排除」的内容（forget 墓碑 + superseded 旧事实）。 */
  function forbiddenContentsFromChanges(changes) {
    const out = []
    const seen = new Set()
    const push = (c) => {
      const s = String(c || '').trim()
      if (s && !seen.has(s)) { seen.add(s); out.push(s) }
    }
    for (const ch of changes || []) {
      if (!ch || !ch.kind) continue
      const p = ch.payload || {}
      if (ch.kind === 'forget') {
        const e = findEntryValue(p.entryId)
        if (e && e.content) push(e.content)
      } else if (ch.kind === 'supersede') {
        const e = findEntryValue(p.targetId)
        if (e && e.content) push(e.content)
      }
    }
    return out
  }

  /** 把一条 memory_changes 记录渲染成一段可读的提示词描述。 */
  function describeChange(ch) {
    const p = ch && ch.payload ? ch.payload : {}
    switch (ch.kind) {
      case 'remember': return `kind=remember: ${p.content || ''}`
      case 'note': return `kind=note: ${p.content || ''}`
      case 'draft': return `kind=draft: ${p.content || ''}`
      case 'forget': return `kind=forget: entry ${p.entryId || ''} MUST BE EXCLUDED`
      case 'supersede': return `kind=supersede: entry ${p.targetId || ''} replaced by ${p.replacementId || ''}`
      case 'import': return `kind=import: ${p.note || 'imported bundle'} (entries=${p.entryCount ?? ''}, files=${p.fileCount ?? ''})`
      default: return `kind=${ch.kind}`
    }
  }

  /**
   * Assemble the consolidation prompt from incremental inputs + current files + manual changes.
   * t80：L1 输入限量（clampPromptInputs）+ 动态 SIZE BUDGET / PROGRESSIVE DISCLOSURE /
   * COMPRESSION MODE 文本块——数值随 config.summaryTokens 变，使上限参数化真正生效。
   */
  function buildConsolidationPrompt(inputs, currentSummary, currentRegistry, changes, opts = {}) {
    const lines = []
    const clad = clampPromptInputs(inputs, currentSummary, currentRegistry, {
      maxInputs: PROMPT_MAX_INPUTS,
      perInputChars: PROMPT_PER_INPUT_CHARS,
      // S0-2：current 文件**不再按字符预算截断**（整篇传入）；整篇超硬顶由调用方 fail-closed。
    })
    lines.push('You are consolidating cross-session memory. The CURRENT summary/registry below are the BASE you are EDITING — the program passes them to you IN FULL (no truncation on its side), so input completeness is guaranteed by the caller. Read them, then the new incremental session summaries, and produce the updated files by INCREMENTAL EDIT.')
    lines.push('')
    lines.push('## INCREMENTAL MERGE (YOUR RESPONSIBILITY — the program cannot check this for you)')
    lines.push('- Treat the CURRENT files below as the base you are EDITING — NOT as a draft to rewrite from scratch.')
    lines.push('- Every durable conclusion already present in the CURRENT files MUST still be present in your output (verbatim or a faithful restatement), UNLESS an EXCLUSION section below removes it. Never silently drop one.')
    lines.push('- Be aware of what the program can and cannot see: it guarantees it handed you the COMPLETE current files, but it cannot judge whether your merge lost meaning — it has no way to tell a legitimate merge/rewrite from a real loss. So a silent drop is a correctness bug on your side that no downstream check is guaranteed to catch.')
    lines.push('- Add the new facts from the incremental summaries; merge duplicates; keep the newest statement of any superseded fact.')
    lines.push('- Output the COMPLETE updated files (full replacement text), not a diff.')
    lines.push('')
    lines.push('## SIZE BUDGET (HARD — a post-check rejects an over-budget result and publishes nothing)')
    lines.push(`- memory_summary (the "memory_summary" JSON field) MUST be at most ${summaryCapChars()} characters.`)
    lines.push(`- registry (the "registry" JSON field) MUST be at most ${registryCapChars()} characters.`)
    lines.push('- Detail must NOT be inlined; keep detail in the per-session files and point to them.')
    lines.push('')
    lines.push('## PROGRESSIVE DISCLOSURE (MANDATORY)')
    lines.push('- memory_summary is an INDEX: one line per durable conclusion, at most ~120 characters.')
    lines.push('- Each line SHOULD end with a pointer to its detail file: memories/rollout_summaries/<sessionId>.md')
    lines.push('- Do NOT copy the registry into memory_summary; do NOT repeat the same fact twice.')
    lines.push('')
    lines.push('## CURRENT memory_summary.md')
    lines.push(clad.currentSummary || '(empty)')
    lines.push('')
    lines.push('## CURRENT MEMORY.md')
    lines.push(clad.currentRegistry || '(empty)')
    lines.push('')
    if (clad.droppedInputs > 0) {
      lines.push(`(note: ${clad.droppedInputs} additional incremental input(s) were withheld to fit the prompt budget; they stay on disk and a later batch will pick them up.)`)
      lines.push('')
    }
    // S0-2：**截断可观测**——本批若有增量输入被截断，在提示词里明写出来（当前权威文件恒不截断）。
    if (clad.clampedInputs > 0) {
      lines.push(`(note: ${clad.clampedInputs} incremental input(s) were truncated to ${PROMPT_PER_INPUT_CHARS} chars each; the full text stays on disk in rollout_summaries/.)`)
      lines.push('')
    }
    lines.push('## NEW INCREMENTAL SESSION SUMMARIES')
    clad.inputs.forEach((it, i) => {
      lines.push(`--- input ${i + 1}: source_watermark=${it.source_watermark} session=${it.session_id} ---`)
      if (it.rollout_slug) lines.push(`slug: ${it.rollout_slug}`)
      if (it.keywords) lines.push(`keywords: ${it.keywords}`)
      lines.push(`summary: ${it.rollout_summary || ''}`)
      lines.push('')
    })
    // R5：统一变更流（手动记忆/备注/草稿/遗忘/取代/导入）。forget 墓碑最高优先。
    if (changes && changes.length) {
      lines.push('## NEW MEMORY CHANGES (MANUAL STREAM)')
      changes.forEach((ch, i) => {
        lines.push(`--- change ${i + 1}: ${ch.kind} (priority=${ch.priority}, id=${ch.id}) ---`)
        lines.push(describeChange(ch))
        lines.push('')
      })
      const excluded = forbiddenContentsFromChanges(changes)
      if (excluded.length) {
        lines.push('## FORGET / SUPERSEDE EXCLUSIONS (HIGHEST PRIORITY — MUST NOT APPEAR)')
        lines.push('The following content has been forgotten or superseded. It MUST NOT appear in memory_summary or registry. Exclude it entirely, even if a NEW input echoes it.')
        excluded.forEach((c, i) => { lines.push(`- EXCLUDE ${i + 1}: ${c}`) })
        lines.push('')
      }
    }
    // t80：纯压缩批（mode==='compress'）——显式触发。此事总纲已超限，规则 1「keep everything」对本批暂停。
    if (opts && opts.compress === true) {
      lines.push('## COMPRESSION MODE (OVERRIDE — HIGHEST PRIORITY)')
      lines.push(`The current memory_summary EXCEEDS its hard budget (${summaryCapChars()} characters). Rule 1 ("keep everything already present") is SUSPENDED for this run:`)
      lines.push('- Keep every durable FACT, but rewrite each one as a single ≤120-character conclusion line plus a pointer to its detail file.')
      lines.push('- Merge duplicates and same-topic entries aggressively; keep the newest statement of any superseded fact only.')
      lines.push('- Drop transient detail, one-off chatter, and anything already covered by MEMORY.md.')
      lines.push('- The registry MUST NOT be duplicated into memory_summary.')
      // t82：与安全门对齐（redactSecrets 的 `key: value` 键名白名单 L814 + 长 token 启发式 L838-841）。
      // 压缩要重写全文，模型若把既有内容规范化成 `session_id: …`（键名白名单）或 `(session=<完整uuid>)`
      // （`session=` 与 36 位 uuid 连成长度 ≥40 的 run，含数字与 `=` → looksLikeToken 判真）都会命中，
      // 被 validatePhase2Output（L456）判为 unredacted secret 而整批被拒（真实案例：p2-mtwnex4u-513mae）。
      lines.push('- **ABSOLUTELY FORBIDDEN — never write metadata as `key: value` or `key=value`.** In particular never emit any of: session_id, token, api_key, secret, auth, password, access_token, client_secret. A safety scanner treats such keyed pairs as leaked secrets and REJECTS the entire batch.')
      lines.push('- **ABSOLUTELY FORBIDDEN — never attach a label or key to a session id either.** Forms like `session_id: <id>` AND `session=<id>` are BOTH rejected by the same scanner. Do NOT reproduce the keyed metadata that appears in the registry input.')
      lines.push('- If you must reference a session, write the bare id or a short id ALONE with no key, label, or `=` next to it — or simply omit the citation. When in doubt, omit it.')
      lines.push('- Keep every existing `[REDACTED]` marker EXACTLY as it is; never un-redact, re-derive, or re-word a redacted value.')
      lines.push(`- Target: memory_summary ≤ ${summaryCapChars()} characters, registry ≤ ${registryCapChars()} characters.`)
      lines.push('')
    }
    // S0-2：把本批的**截断事实**交回调用方（写进作业结果），使「是否截断 / 截断字符数 / 截断文件」
    // 在批结果里可观测 —— 而不是只有模型能在提示词里看到。
    if (opts && opts.truncationOut && typeof opts.truncationOut === 'object') {
      try { opts.truncationOut.report = truncationReportOf(clad) } catch { /* 可观测性失败不得影响整合 */ }
    }
    return lines.join('\n')
  }

  /**
   * Consolidate the incremental inputs + current files via the consolidation LLM.
   * Mirrors extractWithLlm's routing (config override wins, else agentDefaultModel)
   * but returns the RAW parsed {memory_summary, registry} — do NOT redact here, so
   * an unredacted secret survives to the validatePhase2Output gate and blocks publish.
   * Returns null on ANY failure (unavailable / unrouteable / streaming error /
   * unparseable) so the caller can record 'llm-unavailable' without publishing.
   */
  async function consolidateWithLlm(prompt) {
    const p = String(prompt || '').trim()
    if (!p) return null
    const llmSvc = typeof ctx.get === 'function' ? ctx.get('llm', false) : undefined
    if (!llmSvc || typeof llmSvc.stream !== 'function') return null
    const defaultSel =
      typeof ctx.get === 'function' ? ctx.get('agentDefaultModel', false) : undefined
    const sel =
      defaultSel && typeof defaultSel.currentSelection === 'function'
        ? defaultSel.currentSelection()
        : undefined
    const provider =
      (config.consolidationProvider && config.consolidationProvider.trim()) ||
      (sel && sel.provider) ||
      ''
    const model =
      (config.consolidationModel && config.consolidationModel.trim()) ||
      (sel && sel.model) ||
      ''
    if (!provider || !model) return null
    const reasoningEffort =
      (config.consolidationReasoningEffort && config.consolidationReasoningEffort.trim()) || ''
    // D1: redact the prompt just before it reaches the provider (defense-in-depth;
    // the incremental inputs were already redacted when serialized).
    const inputText = redactSecrets(p)

    const buildOptions = (effort) => ({
      provider,
      model,
      purpose: 'compaction',
      system: CONSOLIDATION_SYSTEM_PROMPT,
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
    return {
      memory_summary: String(parsed.memory_summary || '').trim(),
      registry: String(parsed.registry || '').trim(),
    }
  }

  /** Pick the "newest" input (max generated_at; tie-break by watermark string). */
  function pickNewestInput(inputs) {
    if (!inputs || !inputs.length) return null
    return inputs.reduce((best, it) => {
      if (!best) return it
      const bT = new Date(String(best.generated_at || '')).getTime() || 0
      const iT = new Date(String(it.generated_at || '')).getTime() || 0
      if (iT > bT) return it
      if (iT === bT) return String(it.source_watermark) > String(best.source_watermark) ? it : best
      return best
    }, null)
  }

  /**
   * 阶段 B（R4）：原子成对写入两个目标文件。每份先写到同目录 `.tmp` 再 `renameSync`
   * 覆盖最终文件；任一步失败就清理两个 tmp、把旧版完整保留并抛错（调用方决定是否重试 /
   * 是否推进水位）。比「直接写最终文件」强：第二个文件写失败时不会留下「总纲新版、注册表旧版」
   * 的半状态（M2 / §5.3 per-file atomic + 两文件先备后切）。目标路径参数化，供版本目录与
   * 根稳定入口镜像共用。语义与原 atomicWritePair 一致。
   */
  function atomicWritePair(summaryPath, registryPath, summary, registry) {
    const sTmp = summaryPath + '.tmp'
    const rTmp = registryPath + '.tmp'
    try {
      writeText(sTmp, summary)
      writeText(rTmp, registry)
      fs.renameSync(sTmp, summaryPath)
      fs.renameSync(rTmp, registryPath)
    } catch (e) {
      for (const f of [sTmp, rTmp]) {
        try { fs.rmSync(f, { force: true, recursive: true }) } catch {}
      }
      throw e
    }
  }

  // t187：PHASE2_LEASE_MS 已提升到模块作用域（导出，便于测试）：**60s → 3600s**，照 codex
  // `JOB_LEASE_SECONDS = 3_600`（镜像 codex-rs/memories/write/src/lib.rs L84）。心跳 20s 不变。
  /**
   * t170：同一条来源「从 failed_terminal 批释放 → 重新被选 → 再失败」的**次数上界**。
   * 为什么必须有：Phase 2 没有每日预算门，若只解绑不加界，"输入含机密 ⇒ 产出含机密 ⇒ 校验失败 ⇒
   * 批进 failed_terminal ⇒ 解绑 ⇒ 重选"会**无限振荡**烧 LLM（原实现正是为了防这个才不解绑）。
   * 达上界 ⇒ 该来源置 `phase2_abandoned=true` **显式登记**（可见、可查、不静默丢弃），此后不再重选。
   */
  const MAX_PHASE2_RELEASES = 3

  /** 分级退避（秒），用于 phase2_jobs 失败重试的 available_at。 */
  function phase2BackoffSeconds(attempt) {
    const a = Math.max(1, attempt || 1)
    return Math.min(3600, 30 * Math.pow(2, Math.min(a - 1, 6)))
  }

  const makePhase2BatchId = () =>
    'p2-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

  const sha256OfText = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex')

  // ── t80：尺寸上限（apply 作用域薄封装；纯逻辑在模块级 summaryCapFromTokens / registryCapFromTokens）──
  /** memory_summary 字符上限，由 config.summaryTokens 派生（默认 4000 → 14,400）。 */
  const summaryCapChars = () => summaryCapFromTokens(config.summaryTokens || 4000)
  /** registry（MEMORY.md）字符上限（默认 4000 → 24,000）。 */
  const registryCapChars = () => registryCapFromTokens(config.summaryTokens || 4000)
  /** t164：可选诊断开关（默认关）——关掉即完全不跑诊断，连告警都不产生。 */
  const phase2DiagnosticsEnabled = () => config.phase2Diagnostics === true
  /** t164：**输出预留**——给模型输出留的空间 = 两个目标文件上限之和（参与完整请求预算）。 */
  const outputsReserveChars = () => summaryCapChars() + registryCapChars()
  /** 当前权威总纲是否已超上限。**只读判定**（不写任何文件、不动 entries）。 */
  const currentSummaryOverCap = () => {
    try { return readText(resolveCurrentFiles().summaryPath).length > summaryCapChars() } catch { return false }
  }
  /** S0-2：当前权威**注册表**是否已超上限。**只读判定**——与总纲同等待遇（且可观测）。 */
  const currentRegistryOverCap = () => {
    try { return readText(resolveCurrentFiles().registryPath).length > registryCapChars() } catch { return false }
  }
  /** S0-2：当前哪一份（或两份）权威文件超上限；'' = 都未超。用于显式 compress 入口的等价门。 */
  const currentOverCapWhich = () => {
    const s = currentSummaryOverCap()
    const r = currentRegistryOverCap()
    if (s && r) return 'summary+registry'
    if (s) return 'summary'
    if (r) return 'registry'
    return ''
  }

  /**
   * t80：创建一个「纯压缩批」（mode='compress'，input_ids/change_ids 均为空）。
   * **设计约束（用户拍板方向）**：本函数**只由显式入口调用**（`memory_integrate {compress:true}`）；
   * 调度器（claimNextPhase2Job）与自动路径（session/disposed）**永不创建** compress 批——
   * 因为压缩会暂停「keep everything」并改写权威总纲，是本管线里唯一可能丢内容的操作，必须有人为触发意图。
   * 单飞：已有活跃非终态批 → 拒绝（返回 enqueued:false）。
   * 不新增任何写记忆内容的路径：仍走 processPhase2Batch → validatePhase2Output → publishPhase2Version。
   */
  async function enqueueCompressBatch(reason) {
    // S0-2：总纲**或**注册表超上限皆可触发（与总纲同等待遇）；仍**只由显式入口**调用。
    const overWhich = currentOverCapWhich()
    if (!overWhich) return { enqueued: false, reason: 'not-over-cap' }
    for (const [, j] of phase2JobsTable.entries()) {
      if (!j) continue
      if (j.status === 'pending' || j.status === 'running' || j.status === 'retry_wait' ||
          j.status === 'prepared' || j.status === 'published') {
        return { enqueued: false, reason: 'busy' }
      }
    }
    const batchId = makePhase2BatchId()
    const iso = new Date().toISOString()
    const job = {
      id: batchId,
      status: 'pending',
      mode: 'compress',
      input_ids: [],
      change_ids: [],
      lease_owner: '',
      lease_token: '',
      lease_expires_at: '',
      attempt_count: 0,
      max_attempts: 3,
      available_at: '',
      staging_version: '',
      last_error: '',
      created_at: iso,
      updated_at: iso,
      compress_reason: String(reason || 'explicit'),
    }
    await phase2JobsTable.put(batchId, job)
    schedulePhase2Wake(Date.now())
    return { enqueued: true, batchId }
  }

  /**
   * P1-2 forget 强语义：把任何 status=forgotten/superseded 的条目内容收集成「必须排除」清单。
   * 覆盖所有历史遗忘/取代（不只本批），保证被遗忘内容即使近期被新增内容召回，也绝不进权威摘要。
   * 返回非空 str 数组（长度为阈值以上，避免误删短令牌）。
   */
  function forbiddenPhrasesAll() {
    const out = []
    const seen = new Set()
    for (const e of allEntries()) {
      if (e.status === 'forgotten' || e.status === 'superseded') {
        const c = String(e.content || '').trim()
        if (c.length >= 5 && !seen.has(c)) { seen.add(c); out.push(c) }
      }
    }
    return out
  }

  /** 把文本中的每个 forbidden 短语整体剥离（跨行折叠），并清理多余空行。返回清理后的字符串。 */
  function stripForbidden(text, phrases) {
    let s = String(text || '')
    for (const ph of phrases || []) {
      if (!ph || ph.length < 5) continue
      s = s.split(ph).join('')
    }
    return s
      .split('\n')
      .map((l) => l.replace(/\s+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
  }

  /** 版本目录是否可用：manifest + summary/registry 都在，且 manifest 带校验和时一致（P0-7）。 */
  function versionIsUsable(verDir, manifestPath, summaryPath, registryPath) {
    try {
      if (!exists(manifestPath) || !fs.statSync(manifestPath).isFile()) return false
      if (!exists(summaryPath) || !fs.statSync(summaryPath).isFile()) return false
      if (!exists(registryPath) || !fs.statSync(registryPath).isFile()) return false
      const manifest = JSON.parse(readText(manifestPath))
      if (!manifest || typeof manifest !== 'object') return false
      const s = readText(summaryPath)
      const r = readText(registryPath)
      if (manifest.summary_sha256 && manifest.summary_sha256 !== sha256OfText(s)) return false
      if (manifest.registry_sha256 && manifest.registry_sha256 !== sha256OfText(r)) return false
      return true
    } catch {
      return false
    }
  }

  /** 在 publish_versions 里找上一个「已发布且可用」的版本（保留 ≥1 旧版用于回退，P0-7）。 */
  function previousUsableVersion(currentVersion) {
    const candidates = []
    for (const [id, pv] of publishVersionsTable.entries()) {
      if (!pv) continue
      if (pv.status !== 'published') continue
      if (id === currentVersion) continue
      candidates.push({ id, created_at: String(pv.created_at || '') })
    }
    candidates.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    for (const c of candidates) {
      const vd = path.join(memoryRoot(), 'versions', c.id)
      const m = path.join(vd, 'manifest.json')
      const s = path.join(vd, 'memory_summary.md')
      const r = path.join(vd, 'MEMORY.md')
      if (versionIsUsable(vd, m, s, r)) return c.id
    }
    return null
  }

  /**
   * 解析读取方应读的当前版本文件（R4 / P0-7）。
   * 优先 current.json 指向的版本（校验 manifest+三文件）；坏则回退上一可用版本；
   * 无 current.json / 全部坏 → 回退根目录稳定入口（bootstrap / 旧版无版本管理）。
   * 返回 { versionId, summaryPath, registryPath, manifestPath }。
   */
  function resolveCurrentFiles() {
    const root = memoryRoot()
    const rootSummary = path.join(root, 'memory_summary.md')
    const rootRegistry = path.join(root, 'MEMORY.md')
    let version = ''
    try {
      const cur = JSON.parse(readText(path.join(root, 'current.json')))
      version = cur && cur.version ? String(cur.version) : ''
    } catch {}
    if (version) {
      const vd = path.join(root, 'versions', version)
      const s = path.join(vd, 'memory_summary.md')
      const r = path.join(vd, 'MEMORY.md')
      const m = path.join(vd, 'manifest.json')
      if (versionIsUsable(vd, m, s, r)) {
        return { versionId: version, summaryPath: s, registryPath: r, manifestPath: m }
      }
      const fb = previousUsableVersion(version)
      if (fb) {
        const fvd = path.join(root, 'versions', fb)
        return {
          versionId: fb,
          summaryPath: path.join(fvd, 'memory_summary.md'),
          registryPath: path.join(fvd, 'MEMORY.md'),
          manifestPath: path.join(fvd, 'manifest.json'),
        }
      }
    }
    return { versionId: '', summaryPath: rootSummary, registryPath: rootRegistry, manifestPath: '' }
  }

  /**
   * 提交（幂等）：把一批 input_ids 标为已消费（phase2_batch_id + selected_for_phase2），
   * 推进 lastSuccessWatermark 到该批最新输入、清 phase2_last_error、置 phase2_jobs=committed、
   * 写 .phase2-authoritative。已 committed 则跳过（重放不重复消费，P0-8/R3）。
   */
  async function commitPhase2Batch(batch, nowMs, opts = {}) {
    if (!batch || !batch.id) return { committed: false }
    return withWrite(async () => {
      const id = batch.id
      const curJob = phase2JobsTable.get(id)
      if (curJob && curJob.status === 'committed') return { committed: false }
      // GPT P0-5：活路径（opts.token 存在）提交前必须仍持有所有权（lease_owner + token）；
      // 恢复路径（published→commit，token 缺省）不要求，因为它只是补终态不重跑。
      if (opts.token) {
        const owned = !!curJob && curJob.lease_owner === bootId && curJob.lease_token === opts.token &&
          (curJob.status === 'running' || curJob.status === 'prepared' || curJob.status === 'published')
        if (!owned) return { committed: false, ownershipLost: true }
      }
      const now = new Date(nowMs)
      const inputIds = Array.isArray(batch.input_ids) ? batch.input_ids : []
      // t164（R1 §5.3）：**提交侧守卫**。模型最多只可能看到前 PROMPT_MAX_INPUTS 条（提示词按同一条
      // 预算切），所以"标已消费"只允许发生在前 PROMPT_MAX_INPUTS 条上。超出的部分**只可能来自上限
      // 引入前冻结的旧批**（含 prepared/published —— 那些批不得盲切，按原有发布记录恢复）⇒ 这里
      // **不标消费、改为放开绑定**，留给下一批重新处理。正常批（≤ max）此守卫恒为无操作。
      const consumeIds = inputIds.slice(0, PROMPT_MAX_INPUTS)
      const deferredIds = inputIds.slice(PROMPT_MAX_INPUTS)
      const objs = inputIds.map((oid) => stage1OutputsTable.get(oid)).filter(Boolean)
      const newest = pickNewestInput(objs)
      for (const oid of consumeIds) {
        const o = stage1OutputsTable.get(oid)
        if (!o) continue
        await stage1OutputsTable.update(oid, (curO) => ({
          ...curO,
          phase2_batch_id: id,
          selected_for_phase2: true,
        }))
      }
      for (const oid of deferredIds) {
        const o = stage1OutputsTable.get(oid)
        if (!o) continue
        if (o.selected_for_phase2 === true) continue // 已消费的不回头
        await stage1OutputsTable.update(oid, (curO) => ({ ...curO, phase2_batch_id: '' }))
        try {
          console.warn(`[dsh-memory_rollout] commit guard: released un-seen input ${oid} of oversized batch ${id} (not marked consumed; will be re-processed)`)
        } catch { /* ignore */ }
      }
      // R5：同一批冻结的 memory_changes 标 consumed + phase2_batch_id（幂等，重放不重复消费）。
      const changeIds = Array.isArray(batch.change_ids) ? batch.change_ids : []
      for (const cid of changeIds) {
        const c = memoryChangesTable.get(cid)
        if (!c) continue
        await memoryChangesTable.update(cid, (curC) => ({
          ...curC,
          status: 'consumed',
          phase2_batch_id: id,
        }))
      }
      const m = readStage1Meta()
      if (newest && String(newest.source_watermark)) m.lastSuccessWatermark = String(newest.source_watermark)
      m.lastPhase2At = now.toISOString()
      m.phase2_last_error = ''
      await writeStage1Meta(m)
      await phase2JobsTable.update(id, (curJ) => ({
        ...curJ,
        status: 'committed',
        updated_at: now.toISOString(),
      }))
      // H3b：已发布产物为权威（LLM 整合）版本，后续确定性 integrate() 不得覆盖。
      try { writeText(path.join(memoryRoot(), '.phase2-authoritative'), id) } catch {}
      return { committed: true, watermarks: [newest && newest.source_watermark].filter(Boolean) }
    })
  }

  /** 失败任意阶段：attempt+1 + 退避 available_at 进 retry_wait；达 max → failed_terminal。 */
  async function failPhase2Batch(batch, errMsg, nowMs, errors) {
    const now = new Date(nowMs)
    const attempt = (batch.attempt_count || 0) + 1
    const maxAttempts = batch.max_attempts || 3
    const terminal = attempt >= maxAttempts
    await withWrite(async () => {
      const m = readStage1Meta()
      m.phase2_last_error = errMsg
      await writeStage1Meta(m)
      await phase2JobsTable.update(batch.id, (cur) => ({
        ...cur,
        attempt_count: attempt,
        last_error: errMsg,
        updated_at: now.toISOString(),
        ...(terminal
          ? { status: 'failed_terminal' }
          : { status: 'retry_wait', available_at: new Date(nowMs + phase2BackoffSeconds(attempt) * 1000).toISOString() }),
      }))
    })
    return { ran: true, ok: false, errors: errors || [errMsg], batchId: batch.id }
  }

  // ── Phase 2 所有权/心跳/孤儿绑定恢复（GPT P0-1 / P0-4 / P0-5）───────────────
  let phase2Busy = false
  // P0 统一 requestPhase2Integrate：任何新 Stage1 output / pending memory_change 都请求它。
  // busy 时记录 rerun latch、忙完补跑；空闲时经 setImmediate 异步调度 phase2Integrate。
  // 绝不同步调用（remember/UI-add 都在 withWrite 内，nest withWrite 会死锁）。
  let phase2RerunRequested = false
  let phase2AutoScheduled = false
  let phase2AutoTimer = null
  /** 是否存在 phase2Integrate「本应处理」的工作（非终态批 / 未消费 output / 未绑定 pending change）。 */
  function hasPendingPhase2Work() {
    for (const [, j] of phase2JobsTable.entries()) {
      if (j && j.status !== 'committed' && j.status !== 'failed_terminal') return true
    }
    for (const [, o] of stage1OutputsTable.entries()) {
      if (o && o.selected_for_phase2 !== true && !o.phase2_batch_id) return true
    }
    for (const [, c] of memoryChangesTable.entries()) {
      if (c && c.status === 'pending' && !c.phase2_batch_id) return true
    }
    return false
  }
  function requestPhase2Integrate() {
    phase2RerunRequested = true
    if (phase2Busy) return // 忙完由 phase2Integrate 的 finally 补跑
    if (phase2AutoScheduled) return
    phase2AutoScheduled = true
    phase2AutoTimer = setImmediate(() => {
      phase2AutoScheduled = false
      phase2AutoTimer = null
      if (!phase2RerunRequested) return
      phase2RerunRequested = false
      // t178：同样走"写锁竞争可重试"的调度包装（原先这里只 log，落败即整次丢掉）。
      runScheduledPass('phase-2 auto integrate error', 'phase2-auto', () => phase2Integrate())
    })
    if (phase2AutoTimer && phase2AutoTimer.unref) phase2AutoTimer.unref()
  }
  /** 长模型调用期间续租：job 仍属当前 bootId + token 才刷新过期时间。 */
  async function renewPhase2Lease(batchId, token) {
    await withWrite(async () => {
      const j = phase2JobsTable.get(batchId)
      if (!j || j.lease_owner !== bootId || j.lease_token !== token) return
      await phase2JobsTable.update(batchId, (cur) => ({
        ...cur,
        lease_expires_at: new Date(Date.now() + PHASE2_LEASE_MS).toISOString(),
        updated_at: new Date().toISOString(),
      }))
    })
  }
  /** 是否仍拥有「会改权威基线」的阶段 2 所有权（lease_owner + token + 非终态）。 */
  async function phase2Owned(batchId, token) {
    return withWrite(async () => {
      const j = phase2JobsTable.get(batchId)
      return !!j && j.lease_owner === bootId && j.lease_token === token &&
        (j.status === 'running' || j.status === 'prepared' || j.status === 'published')
    })
  }
  /**
   * GPT P0-4 恢复：解除「指向不存在批次」的 input/change 绑定，允许重新选择；同时把
   * running/prepared/published 批的 input_ids 里未绑定的记录补绑（幂等），消除跨 key 半提交孤儿。
   * 注意（本轮对抗式审查修正）：**不再解绑指向 failed_terminal 批次的 input/change**——
   * failed_terminal 是「真实存在、已用尽 max_attempts」的终态批，其 inputs 视为「已尽力、
   * 放弃自动重试」（与 Stage1 的 failed_terminal 收尾语义一致）。若解绑会让 claimNextPhase2Job
   * 把同批 inputs 重选为 attempt_count=0 的新批；而 Phase 2 consolidation 无每日预算门，
   * 在模型持续不可达/校验失败时会无限「terminal→解绑→新建批」循环烧 LLM。故只解绑真孤儿
   * （目标批不存在）。如需人工重试终态失败批，应手动重置该批次。
   */
  async function reconcilePhase2Bindings(nowMs) {
    return withWrite(async () => {
      let fixed = 0
      let abandoned = 0
      let releasedArchived = 0
      let abandonedArchived = 0
      // t175：变更侧计数（与产物侧并列，便于在告警里一眼看出是哪一侧释放/放弃的）。
      let releasedChanges = 0
      let releasedChangesArchived = 0
      let abandonedChanges = 0
      let abandonedChangesArchived = 0
      const unbindOrphan = async (table, key, rec) => {
        if (!rec || !rec.phase2_batch_id) return
        // P1 归档协议：按 batch id 直接核对活跃表/归档表（不预扫 archive，避免全扫与 Set.set 错误）。
        const j = phase2JobsTable.get(rec.phase2_batch_id)
        const archived = phase2JobsArchiveTable.get(rec.phase2_batch_id)
        // 只把「指向不存在的批」当孤儿；活跃批存在、或已归档批存在 → 有效，不解绑（防无限重试/重复消费）。
        // t172：注意——`archived` 非空时这里**不释放**，那是指"批仍可查"，**不等于"无须处理"**。
        // 归档的 failed_terminal 批由紧随其后的 `releaseBoundFromFailedBatch` 统一处理（它**同时查活跃表与归档表**，
        // 且 t175 起**产物与变更各跑一遍**），因此"批已归档"这一档不会成为静默死角。
        // 因此"批已归档"这一档不会成为静默死角。
        const orphan = !j && !archived
        if (orphan) {
          await table.update(key, (cur) => ({ ...cur, phase2_batch_id: '' }))
          fixed++
        }
      }
      for (const [oid, o] of stage1OutputsTable.entries()) {
        if (o && typeof o === 'object') await unbindOrphan(stage1OutputsTable, oid, o)
      }
      for (const [cid, c] of memoryChangesTable.entries()) {
        if (c && typeof c === 'object') await unbindOrphan(memoryChangesTable, cid, c)
      }
      // t170：**终态失败批的绑定释放（有界）**。
      // 背景：原实现刻意不解绑 failed_terminal（见上方注释：怕"terminal→解绑→新建批"无限烧 LLM）。
      // 但那样带来一个更糟的后果——这些来源**永久卡死且无人登记**（既不再被选，也没有任何痕迹），
      // 属静默不消费。现在改成"**有界释放**"，同时把原风险用**次数上界**消掉：
      //   · 批为 `failed_terminal` 且输出**未消费**（`selected_for_phase2 !== true`）⇒ 释放绑定，可被重选；
      //   · 每条输出记 `phase2_release_count`；达 MAX_PHASE2_RELEASES 后**显式登记为放弃**
      //     （`phase2_abandoned=true` + reason + 可见计数 + console.warn），此后**不再重选** ⇒ 不会无限振荡。
      // `committed` 批**不释放**（其输入本就已标消费）；`running`/`prepared`/`published` **不动**；
      // 原 orphan（批不存在）释放逻辑**保留**（在它前面先跑，两者互不冲突）。
      const releaseBoundFromFailedBatch = async (table, key, rec, isConsumed, kind) => {
        if (!rec || typeof rec !== 'object') return
        if (!rec.phase2_batch_id) return
        if (isConsumed(rec)) return              // 已消费的不回头（committed 批的输入走这里被挡住）
        if (rec.phase2_abandoned === true) return // 已登记放弃的，不再处理
        // t172：**活跃表 + 归档表都要查**。原先只查活跃表 ⇒ 批一旦归档就 `!j` 直接 return，
        // 于是"归档的 failed_terminal 批"成了两条释放路径都跳过的**静默死角**（实测 5 例真实卡死）。
        const live = phase2JobsTable.get(rec.phase2_batch_id)
        const archived = phase2JobsArchiveTable.get(rec.phase2_batch_id)
        const j = live || archived
        if (!j || j.status !== 'failed_terminal') return // 只处理终态失败批（活跃或归档）
        const fromArchive = !live && !!archived
        const n = Number(rec.phase2_release_count) || 0
        const isChange = kind === 'change'
        if (n + 1 > MAX_PHASE2_RELEASES) {
          await table.update(key, (cur) => ({
            ...cur,
            phase2_batch_id: '',
            phase2_abandoned: true,
            phase2_abandoned_reason: `phase2 retries exhausted: released ${n} time(s) from failed_terminal batches`,
          }))
          if (isChange) { abandonedChanges++; if (fromArchive) abandonedChangesArchived++ }
          else { abandoned++; if (fromArchive) abandonedArchived++ }
          return
        }
        await table.update(key, (cur) => ({
          ...cur,
          phase2_batch_id: '',
          phase2_release_count: n + 1,
        }))
        if (isChange) { releasedChanges++; if (fromArchive) releasedChangesArchived++ }
        else { fixed++; if (fromArchive) releasedArchived++ }
      }
      for (const [oid, o] of stage1OutputsTable.entries()) {
        await releaseBoundFromFailedBatch(stage1OutputsTable, oid, o, (r) => r.selected_for_phase2 === true, 'output')
      }
      // t175：**变更侧也要跑一遍** —— 原先这里只遍历产物 ⇒ `memory_changes` 绑在失败批上同样永不释放
      // （而 `unbindOrphan` 是双表通用的，所以缺的正是"变更侧那次调用"）。口径与产物侧完全对齐：
      // 双表（活跃 + 归档）、同套上界与 abandoned 登记。
      for (const [cid, c] of memoryChangesTable.entries()) {
        await releaseBoundFromFailedBatch(memoryChangesTable, cid, c, (r) => r.status === 'consumed', 'change')
      }
      if (fixed || abandoned || releasedChanges || abandonedChanges) {
        try {
          console.warn(`[dsh-memory_rollout] reconcile: released ${fixed} unconsumed input(s) + ${releasedChanges} unconsumed change(s) from failed_terminal batches (re-selectable; archived: ${releasedArchived} input(s) + ${releasedChangesArchived} change(s)); marked ${abandoned} input(s) + ${abandonedChanges} change(s) as abandoned after ${MAX_PHASE2_RELEASES} releases (explicit, not silently dropped; archived: ${abandonedArchived} + ${abandonedChangesArchived})`)
        } catch { /* ignore */ }
      }
      // 补绑：存在的 running/prepared/published 批若还有未绑定的 input/change，幂等补打（P0-4）。
      for (const [id, j] of phase2JobsTable.entries()) {
        if (!j || !(j.status === 'running' || j.status === 'prepared' || j.status === 'published')) continue
        for (const oid of (Array.isArray(j.input_ids) ? j.input_ids : [])) {
          const o = stage1OutputsTable.get(oid)
          if (o && !o.phase2_batch_id) {
            await stage1OutputsTable.update(oid, (curO) => ({ ...curO, phase2_batch_id: id }))
          }
        }
        for (const cid of (Array.isArray(j.change_ids) ? j.change_ids : [])) {
          const c = memoryChangesTable.get(cid)
          if (c && !c.phase2_batch_id) {
            await memoryChangesTable.update(cid, (curC) => ({ ...curC, phase2_batch_id: id }))
          }
        }
      }
      // t164（R1 §5.3）：**升级期检测** —— 是否存在超限的**非终态**旧批（上限引入前冻结的）。
      // 只报不切（切的动作分别在领取侧对 pending/retry_wait、在提交侧对未见来源各做一次）。
      for (const [id, j] of phase2JobsTable.entries()) {
        if (!j) continue
        if (j.status === 'committed' || j.status === 'failed_terminal') continue
        const n = Array.isArray(j.input_ids) ? j.input_ids.length : 0
        if (n > PROMPT_MAX_INPUTS) {
          try {
            console.warn(`[dsh-memory_rollout] legacy oversized phase2 batch detected: ${id} input_ids=${n} > max=${PROMPT_MAX_INPUTS} status=${j.status} (pending/retry_wait will be split at claim; prepared/published keep their published record and only release un-seen inputs at commit)`)
          } catch { /* ignore */ }
        }
      }
      return fixed
    })
  }

  /**
   * 重启/每次调度前恢复（§5 / P0-8）：
   *  - published 未 committed：幂等补提交（不重跑 LLM）。
   *  - running/prepared 租约过期或非本进程：收起重做（retry_wait + 退避）。
   * 返回 { committedIds, reclaimedIds }。
   */
  async function recoverPhase2Jobs(nowMs) {
    const committedIds = []
    const reclaimedIds = []
    for (const [id, job] of phase2JobsTable.entries()) {
      if (!job) continue
      if (job.status === 'published') {
        const r = await commitPhase2Batch(job, nowMs)
        if (r.committed) committedIds.push(id)
      } else if (job.status === 'running' || job.status === 'prepared') {
        const expired = !job.lease_expires_at || new Date(job.lease_expires_at).getTime() < nowMs
        const foreign = job.lease_owner && job.lease_owner !== bootId
        if (expired || foreign) {
          await phase2JobsTable.update(id, (cur) => ({
            ...cur,
            attempt_count: (cur.attempt_count || 0) + 1,
            status: 'retry_wait',
            available_at: new Date(nowMs + phase2BackoffSeconds((cur.attempt_count || 0) + 1) * 1000).toISOString(),
            updated_at: new Date(nowMs).toISOString(),
          }))
          reclaimedIds.push(id)
        }
      }
    }
    return { committedIds, reclaimedIds }
  }

  /**
   * 领取（withWrite）：优先处理到期的 pending/retry_wait 批；否则从未消费 stage1_outputs
   * 冻结一批 input_ids 新建 phase2_jobs(running)（不可变批次 R3），并把该批 outputs 标上
   * phase2_batch_id 防重复领取。
   * GPT P0-1：任意时刻只允许一个「会改权威基线」的 owner——已有非终态（running/prepared/
   * published 未 committed）批时不新建并行批（返回 { busy }），新输出保持 pending。
   * GPT P0-5：领取即赋一次性 lease_token，供提交/发布前校验所有权。
   * GPT P0-4：先建批次记录再绑定 input/change，避免「input 已绑定但批次不存在」的孤儿。
   * 返回 { job } | { busy } | null。
   */
  async function claimNextPhase2Job(nowMs) {
    return withWrite(async () => {
      let hasActive = false
      for (const [, job] of phase2JobsTable.entries()) {
        if (!job) continue
        if (job.status === 'running' || job.status === 'prepared') { hasActive = true; break }
      }
      // 优先领取到期的 pending/retry_wait（已有批的重试）。
      for (const [id, job] of phase2JobsTable.entries()) {
        if (!job) continue
        const duePending = job.status === 'pending' && (!job.available_at || new Date(job.available_at).getTime() <= nowMs)
        const dueRetry = job.status === 'retry_wait' && job.available_at && new Date(job.available_at).getTime() <= nowMs
        if (duePending || dueRetry) {
          const token = makeId()
          await phase2JobsTable.update(id, (cur) => ({
            ...cur,
            status: 'running',
            lease_owner: bootId,
            lease_token: token,
            lease_expires_at: new Date(nowMs + PHASE2_LEASE_MS).toISOString(),
            updated_at: new Date(nowMs).toISOString(),
          }))
          // t164（R1 §5.3）：**旧超限批兼容**。新批上限引入**之前**冻结的批可能 > PROMPT_MAX_INPUTS 条，
          // 而提示词只喂前 PROMPT_MAX_INPUTS 条（clampPromptInputs 的那条预算），提交却按整批标消费
          // ⇒ 第 N+1 条起「未见即消费」。「恢复时不新增 ID」并不能证明数量合法 —— 旧批本来就是超限形成的。
          // 此处只对 **pending/retry_wait**（尚未跑过 LLM，改冻结集安全）做**截批**：保留前
          // PROMPT_MAX_INPUTS 条，其余**解绑 + 保持未消费**，留给下一批；并留 legacy_split 痕迹。
          // `prepared`/`published` **不在此列**（不得盲切：按原有发布记录恢复，未见来源由提交侧守卫放开）。
          const legacySplit = splitBatchIdsByBudget(job.input_ids)
          const claimIds = legacySplit.kept
          if (legacySplit.deferred.length) {
            try {
              console.warn(`[dsh-memory_rollout] legacy oversized phase2 batch ${id}: input_ids=${Array.isArray(job.input_ids) ? job.input_ids.length : 0} > ${PROMPT_MAX_INPUTS} (status=${job.status}) — keeping first ${claimIds.length}, deferring ${legacySplit.deferred.length} to a later batch`)
            } catch { /* ignore */ }
            await phase2JobsTable.update(id, (cur) => ({
              ...cur,
              input_ids: claimIds,
              legacy_split: {
                from: Array.isArray(cur.input_ids) ? cur.input_ids.length : 0,
                deferred: legacySplit.deferred.length,
                at: new Date(nowMs).toISOString(),
              },
            }))
            for (const oid of legacySplit.deferred) {
              const o = stage1OutputsTable.get(oid)
              if (o && o.selected_for_phase2 !== true) {
                await stage1OutputsTable.update(oid, (curO) => ({ ...curO, phase2_batch_id: '' }))
              }
            }
          }
          // 该批 input_ids 的 outputs 标上 phase2_batch_id（幂等），防止被另一批重选造成重复消费。
          for (const oid of claimIds) {
            if (!stage1OutputsTable.get(oid)) continue
            await stage1OutputsTable.update(oid, (curO) => ({
              ...curO,
              phase2_batch_id: id,
            }))
          }
          // R5：同样把该批冻结的 memory_changes 标上 phase2_batch_id（幂等）。
          for (const cid of (Array.isArray(job.change_ids) ? job.change_ids : [])) {
            if (!memoryChangesTable.get(cid)) continue
            await memoryChangesTable.update(cid, (curC) => ({
              ...curC,
              phase2_batch_id: id,
            }))
          }
          return { job: { ...job, id, input_ids: claimIds, status: 'running', lease_owner: bootId, lease_token: token, lease_expires_at: new Date(nowMs + PHASE2_LEASE_MS).toISOString() } }
        }
      }
      // 无到期批可领：若已有活跃非终态批，返回 busy（不新建并行批）。
      if (hasActive) return { busy: true }
      // t144（S0-1）：**冻结点就按提示词预算切批**。
      // 此前把**全部**未消费 outputs 冻进本批，而提示词只喂 `clampPromptInputs` 的前
      // PROMPT_MAX_INPUTS 条 ⇒ 第 N+1 条起**从未进过模型**，却被 `commitPhase2Batch` 按
      // `batch.input_ids` **全量**标为已消费 = **静默丢来源**。
      // 现在：本批只冻结 ≤ PROMPT_MAX_INPUTS 条，其余**保持未消费**、由下一批领取。
      // （提示词侧的 `clampPromptInputs` 仍是纯函数兜底；正常批从此不再产生 droppedInputs。）
      // 另：`memory_changes` **不参与**该预算裁剪（`buildConsolidationPrompt` 对 changes 是全量
      // 渲染，见 L2462 `changes.forEach`），故其消费标记本就与「实际处理」同口径，无需一并切批。
      const MAX_INPUTS_PER_BATCH = PROMPT_MAX_INPUTS
      const unconsumed = []
      for (const [oid, o] of stage1OutputsTable.entries()) {
        if (unconsumed.length >= MAX_INPUTS_PER_BATCH) break
        if (!o || typeof o !== 'object') continue
        if (o.selected_for_phase2 === true) continue
        if (o.phase2_abandoned === true) continue // t170：失效放弃的来源不再重选（显式登记过）
        if (o.phase2_batch_id) continue
        unconsumed.push(oid)
      }
      // R5：未消费的统一变更流（手动记忆/备注/草稿/遗忘/取代/导入）也纳入本批冻结。
      const pendingChanges = []
      for (const [cid, ch] of memoryChangesTable.entries()) {
        if (!ch || typeof ch !== 'object') continue
        if (ch.status !== 'pending' || ch.phase2_batch_id) continue
        if (ch.phase2_abandoned === true) continue // t175：被显式放弃的变更不再重选（否则与 abandoned 语义矛盾）
        pendingChanges.push(cid)
      }
      if (!unconsumed.length && !pendingChanges.length) return null
      // GPT P0-4：先建批次 intent（phase2_jobs 记录），再绑定 input/change。
      const batchId = makePhase2BatchId()
      const token = makeId()
      const createdAt = new Date(nowMs).toISOString()
      const job = {
        id: batchId,
        status: 'running',
        input_ids: unconsumed,
        change_ids: pendingChanges,
        lease_owner: bootId,
        lease_token: token,
        lease_expires_at: new Date(nowMs + PHASE2_LEASE_MS).toISOString(),
        attempt_count: 0,
        max_attempts: 3,
        available_at: '',
        staging_version: '',
        last_error: '',
        created_at: createdAt,
        updated_at: createdAt,
      }
      await phase2JobsTable.put(batchId, job)
      for (const oid of unconsumed) {
        await stage1OutputsTable.update(oid, (curO) => ({
          ...curO,
          phase2_batch_id: batchId,
        }))
      }
      for (const cid of pendingChanges) {
        await memoryChangesTable.update(cid, (curC) => ({
          ...curC,
          phase2_batch_id: batchId,
        }))
      }
      return { job }
    })
  }

  /**
   * 版本化发布（R4）：写 versions/<batchId>/{memory_summary.md, MEMORY.md, manifest.json}（staging），
   * 记录 publish_versions(staging)，原子切换 current.json 指针（published）。任一步失败抛错 →
   * 调用方 failPhase2Batch（旧版保留，读取方仍见旧版）。成功后再 best-effort 镜像到根稳定入口。
   */
  async function publishPhase2Version(batchId, summary, registry) {
    const root = memoryRoot()
    const verDir = path.join(root, 'versions', batchId)
    fs.mkdirSync(verDir, { recursive: true })
    const summaryPath = path.join(verDir, 'memory_summary.md')
    const registryPath = path.join(verDir, 'MEMORY.md')
    const manifestPath = path.join(verDir, 'manifest.json')
    // 1) 两文件原子成对 + 校验信息（manifest 含 sha256，供读取方校验一致性）。
    atomicWritePair(summaryPath, registryPath, summary, registry)
    const manifest = {
      version: batchId,
      summary_file: 'memory_summary.md',
      registry_file: 'MEMORY.md',
      manifest_file: 'manifest.json',
      summary_sha256: sha256OfText(summary),
      registry_sha256: sha256OfText(registry),
      phase2_authoritative: true,
      created_at: nowIso(),
    }
    writeText(manifestPath, JSON.stringify(manifest, null, 2))
    const rel = (p) => path.relative(root, p).replace(/\\/g, '/')
    await publishVersionsTable.put(batchId, {
      id: batchId,
      summary_file: rel(summaryPath),
      registry_file: rel(registryPath),
      manifest_file: rel(manifestPath),
      status: 'staging',
      created_at: nowIso(),
    })
    // 进入 prepared：staging 已写好、current 未切换（崩溃恢复可据此「重做」而非「补提交」）。
    await phase2JobsTable.update(batchId, (cur) => ({
      ...cur,
      status: 'prepared',
      staging_version: batchId,
      updated_at: nowIso(),
    }))
    // 2) 原子切换 current.json（published）。切换失败 → 抛错，读取方仍见旧版（P0-7）。
    const currentPath = path.join(root, 'current.json')
    const tmp = currentPath + '.tmp'
    writeText(tmp, JSON.stringify({ version: batchId }))
    try {
      fs.renameSync(tmp, currentPath)
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }) } catch {}
      throw e
    }
    await publishVersionsTable.update(batchId, (cur) => ({
      ...cur,
      status: 'published',
    }))
    // 进入 published：current 已切换、消费记录未提交（崩溃恢复「已 published 未 committed」→ 幂等补提交）。
    await phase2JobsTable.update(batchId, (cur) => ({
      ...cur,
      status: 'published',
    }))
    // 3) best-effort 镜像到根稳定入口（legacy 外读方透明；权威读取走 current.json → 版本目录）。
    try {
      atomicWritePair(path.join(root, 'memory_summary.md'), path.join(root, 'MEMORY.md'), summary, registry)
    } catch {}
  }

  /** 锁外读固定 input_ids + 当前版本 → buildConsolidationPrompt → consolidateWithLlm → 校验 → 发布 → 提交。 */
  async function processPhase2Batch(batch) {
    const nowMs = Date.now()
    const inputIds = Array.isArray(batch.input_ids) ? batch.input_ids : []
    const changeIds = Array.isArray(batch.change_ids) ? batch.change_ids : []
    const fixedInputs = inputIds.map((oid) => stage1OutputsTable.get(oid)).filter(Boolean)
    const fixedChanges = changeIds.map((cid) => memoryChangesTable.get(cid)).filter(Boolean)
    // t80：纯压缩批（mode==='compress'）**无新输入是正常的**——它的目的就是把已超限的权威总纲压回上限。
    // 故此处对 compress 批豁免 'no-inputs' 失败（普通批（含 t78 的 forced 批）行为逐字不变）。
    const isCompressBatch = batch && batch.mode === 'compress'
    if (!fixedInputs.length && !fixedChanges.length && !isCompressBatch) {
      return failPhase2Batch(batch, 'no-inputs', nowMs)
    }
    const cur = resolveCurrentFiles()
    const curSummaryText = readText(cur.summaryPath)
    const curRegistryText = readText(cur.registryPath)
    // S0-2：当前权威文件**整篇读入、不截断**；整篇超出硬顶 → **明确失败**（fail-closed），绝不静默砍尾。
    const tooLarge = currentTooLargeDiagnostic(curSummaryText, curRegistryText)
    if (tooLarge) {
      const msg = `current-version-too-large: ${tooLarge}`
      return failPhase2Batch(batch, msg, nowMs, [msg])
    }
    // S0-2：截断可观测 —— 由提示词构建侧回填本批的截断事实（是否截断 / 截断字符数 / 截断文件）。
    const truncationOut = {}
    const prompt = buildConsolidationPrompt(
      fixedInputs,
      curSummaryText,
      curRegistryText,
      fixedChanges,
      { compress: isCompressBatch, truncationOut },
    )
    const truncation = truncationOut.report || truncationReportOf({})
    // t164（R1 §6.3）：**完整请求预算** —— 覆盖「两份旧文件之和 + 全部 memory_changes + 增量输入
    // + 提示词骨架 + 输出预留」。单文件上限只是组件级早退，管不住"两份都合法但加起来超了"。
    // 超预算 ⇒ **明确失败**（fail-closed）：既不静默截断，也不靠放大硬顶蒙过去。
    const requestEstimate = estimateRequestChars({
      currentSummaryChars: Array.from(curSummaryText).length,
      currentRegistryChars: Array.from(curRegistryText).length,
      changesChars: fixedChanges.reduce((n, ch) => n + describeChange(ch).length + CHANGE_RENDER_OVERHEAD_CHARS, 0),
      inputsChars: fixedInputs.reduce((n, it) => n + String((it && it.rollout_summary) || '').length + 120, 0),
      promptChars: Array.from(prompt).length,
      outputsReserveChars: outputsReserveChars(),
    })
    const requestOverBudget = requestTooLargeDiagnostic(requestEstimate)
    if (requestOverBudget) {
      const msg = `request-too-large: ${requestOverBudget}`
      return failPhase2Batch(batch, msg, nowMs, [msg])
    }
    // t187：① 受限执行者 —— 模型调用前先按 codex 形态建"受限会话"（**插件自建会话**，不是子代理工具）：
    //   `meta.cwd` = 记忆根 ⇒ 写边界随之落在记忆根；`setup` 里 restrict 到最小工具集并 deny `subagent`；
    //   会话沙箱 `workspace-write` + 审批 `never`。
    //   **失败/宿主无 agents 服务 ⇒ 只记 warn，本批照旧**（既有单次 JSON 路径）；关掉走配置
    //   `consolidationExecutor: false`。第一验收项「meta.cwd 被真实宿主接受」需重启后实测，本批不视作已通过。
    let executor = null
    if (config.consolidationExecutor !== false) {
      try {
        executor = await startConsolidationExecutor({ ctx, memoryRoot: memoryRoot(), sessionId: `p2-exec-${batch.id}` })
        if (executor.ok) {
          const ap = executor.applied || {}
          console.info(
            `[dsh-memory_rollout] consolidation executor: cwd=${executor.spec.cwd} sandbox=${ap.sandboxMode || '-'} approval=${ap.approvalPolicy || '-'} restricted=${executor.restricted} route=[${(ap.routes || []).join(',')}]`,
          )
        } else {
          console.warn(`[dsh-memory_rollout] consolidation executor unavailable (${executor.reason}); keeping the in-process single-shot path`)
        }
      } catch (err) {
        // 安全阀：执行者建不起来绝不拖垮批（例如 sessionId 形状或 meta.cwd 被宿主拒绝）。
        console.warn('[dsh-memory_rollout] consolidation executor start failed:', err && err.message ? err.message : err)
      }
    }
    // 慢速模型调用在写锁外执行（M4）+ GPT P0-5：长调用期间心跳续租。
    const hb = startHeartbeat(HEARTBEAT_INTERVAL_MS, () => renewPhase2Lease(batch.id, batch.lease_token))
    let result
    try {
      result = await consolidateWithLlm(prompt)
    } finally {
      stopHeartbeat(hb)
    }
    if (!result) {
      return failPhase2Batch(batch, 'llm-unavailable', nowMs)
    }
    const validation = validatePhase2Output(result, {
      maxSummaryChars: summaryCapChars(),
      maxRegistryChars: registryCapChars(),
    })
    if (!validation.ok) {
      return failPhase2Batch(batch, validation.errors.join('; '), nowMs, validation.errors)
    }
    // P1-2 forget 强语义：生成后校验「被遗忘/取代内容不在权威版本」，在则强制 strip 并重校验。
    // 覆盖所有历史 forgotten/superseded 条目（不只本批），杜绝被遗忘内容哪怕带同批新词也残留。
    const forbidden = forbiddenPhrasesAll()
    let stripped = false
    if (forbidden.length) {
      const s = stripForbidden(result.memory_summary, forbidden)
      const r = stripForbidden(result.registry, forbidden)
      if (s !== result.memory_summary || r !== result.registry) {
        result = { memory_summary: s, registry: r }
        stripped = true
      }
    }
    if (stripped) {
      // 重校验剥离后的输出（可能因整段被排除而变空 → 不发布）。
      const sanity = validatePhase2Output(result, {
        maxSummaryChars: summaryCapChars(),
        maxRegistryChars: registryCapChars(),
      })
      if (!sanity.ok) {
        const msg = 'sanitize-removed-too-much: ' + sanity.errors.join('; ')
        return failPhase2Batch(batch, msg, nowMs, sanity.errors)
      }
    }
    // t164（R1 §6.2）：**可选诊断**（默认关）。开启时只在返回体 diagnostics 里给启发式提示 +
    // console.warn；**不阻断发布、不写 phase2_jobs**。它区分不了「合理归并/来源退出/语义改写/真丢失」，
    // 故既不当闸门、也不调阈值；压缩批整类豁免（其 keep-everything 规则按设计被人工暂停）。
    // 「无法可靠表达 ⇒ 明确失败」由上面的单文件早退与完整请求预算兜住，不靠本诊断。
    let diagnostics = null
    if (phase2DiagnosticsEnabled() && !isCompressBatch) {
      const excludedNorm = (Array.isArray(forbidden) ? forbidden : [])
        .map(normalizeConclusionLine)
        .filter((x) => x && x.length >= 6)
      const suspected = diagnosePossibleConclusionLoss(
        curSummaryText, curRegistryText, result.memory_summary, result.registry, excludedNorm,
      )
      diagnostics = {
        kind: 'possible-conclusion-loss',
        advisory: true,
        persisted: false,
        suspectedCount: suspected.length,
        suspectedSamples: suspected.slice(0, 3),
        note: 'advisory heuristic only: cannot tell merge/rewrite/exit from real loss; not a gate',
      }
      if (suspected.length) {
        try {
          console.warn(`[dsh-memory_rollout] [diagnostic] possible conclusion loss (advisory, non-blocking): ${suspected.length} line(s): ${suspected.slice(0, 3).join(' | ')}`)
        } catch { /* ignore */ }
      }
    }
    // GPT P0-5：发布前校验仍持有所有权（token）。丢失则不得发布、不得消费。
    if (!(await phase2Owned(batch.id, batch.lease_token))) {
      return { ran: false, ok: false, reason: 'lost-ownership', errors: ['phase2 ownership lost — not published'], batchId: batch.id }
    }
    try {
      // 发布（staging + 切换 current + 根镜像）在写锁内进行，与 import/UI 等写路径串行，
      // 防止并发 import 抹掉正在写的版本目录；model 调用与读取 input 仍在锁外（M4）。
      await withWrite(() => publishPhase2Version(batch.id, result.memory_summary, result.registry))
    } catch (e) {
      const msg = 'publish-failed: ' + String((e && e.message) || e)
      return failPhase2Batch(batch, msg, nowMs, [msg])
    }
    const commitRes = await commitPhase2Batch(batch, nowMs, { token: batch.lease_token })
    return {
      ran: true,
      ok: true,
      watermarks: commitRes.watermarks,
      batchId: batch.id,
      // S0-2：可观测——本批的截断事实（是否截断 / 截断字符数 / 截断文件）。
      truncation,
      // t164（R1 §6.3）：可观测——本批**完整请求预算**的构成与总量（超预算会在此之前明确失败）。
      request: requestEstimate,
      // t164（R1 §6.2）：可选诊断（默认关）。开时才有值；advisory、不阻断、不持久化。
      // t193：**关闭时不再返回这个键**（`diagnostics === null` ⇒ 省略）。理由：声明 schema 是严格对象
      //   （`additionalProperties: false`），把 `null` 塞进对象类型字段会让宿主类型校验失败；
      //   而"缺席"与"诊断关闭"语义等价（消费方只需判断键是否存在）。
      ...(diagnostics ? { diagnostics } : {}),
    }
  }

  /**
   * t164（R1 §5.2）：唤醒计划——把「**立即可处理**」与「**未来退避**」拆开，并给出可观测理由。
   *  - `immediate-unbound-work`：存在**未被消费、也没被任何批绑定**的残余来源，且**没有活跃非终态批**
   *    ⇒ 立即唤醒。**有界性**：每次唤醒都会领到一个 ≥1 条的批并把它消费掉，残余单调减少；
   *   继续条件 = 残余 > 0；退出条件 = 残余 = 0（或已有活跃批）。单飞 `phase2Busy` 吸收重入，
   *    不构成忙循环。（这正是修 S0-1 时留下的缺口：21 条来源跑完第一批后，第 21 条没人再唤醒。）
   *  - `due-batch`：已到期/租约到期的批（P0-9 行为不变）。
   *  - `backoff`：pending/retry_wait 有未来 `available_at`，或 running/prepared/published 租约未到期。
   *  - `none`：既无残余也无到期批。
   */
  function phase2WakePlan(nowMs) {
    let next = Infinity
    let reason = 'none'
    let hasActiveBatch = false
    for (const [, j] of phase2JobsTable.entries()) {
      if (!j) continue
      const av = j.available_at ? new Date(j.available_at).getTime() : 0
      const le = j.lease_expires_at ? new Date(j.lease_expires_at).getTime() : 0
      if (j.status === 'retry_wait' || j.status === 'pending') {
        hasActiveBatch = true
        if (!av || av <= nowMs) { if (nowMs < next) { next = nowMs; reason = 'due-batch' } }
        else if (av < next) { next = av; reason = 'backoff' }
      } else if (j.status === 'running' || j.status === 'prepared' || j.status === 'published') {
        hasActiveBatch = true
        if (!le || le <= nowMs) { if (nowMs < next) { next = nowMs; reason = 'due-batch' } }
        else if (le < next) { next = le; reason = 'backoff' }
      }
    }
    // t172：再把「绑在 failed_terminal 批（**活跃表 + 归档表**）上的未消费输出」也算"立即可处理"。
    // 不这样做的后果是实测过的：归档失败批的未消费输出下一轮 reconcil 就会被释放，但若**没有任何其它
    // 调度事件**（无新会话结束、无 stage1 drain），`phase2WakePlan` 返回 null ⇒ reconcile 永不运行 ⇒
    // **重启也不解除**。把 failed 批 id 交给判据后，会立刻唤醒一次 → reconcile 释放 → 进入正常管线。
    // 有界性：释放后绑定即清空，该来源转入 `unbound` 分支或被标 abandoned ⇒ 不会永久空转。
    const failedIds = new Set()
    for (const [, j] of phase2JobsTable.entries()) if (j && j.status === 'failed_terminal') failedIds.add(j.id)
    for (const [, j] of phase2JobsArchiveTable.entries()) if (j && j.status === 'failed_terminal') failedIds.add(j.id)
    const kind = immediatelyProcessableKind(stage1OutputsTable.entries(), memoryChangesTable.entries(), hasActiveBatch, failedIds)
    if (kind) {
      if (nowMs <= next) { next = nowMs; reason = kind === 'failed-bound' ? 'immediate-failed-bound-work' : 'immediate-unbound-work' }
    }
    return { next: Number.isFinite(next) ? next : null, reason, hasActiveBatch }
  }

  /** §3 时间驱动：表里最早的下一次 phase2 唤醒（t164 起含「残余来源立即可处理」这一档）。 */
  function nextPhase2WakeAt(nowMs) {
    return phase2WakePlan(nowMs).next
  }

  /** t164：算一次唤醒计划并武装定时器，返回该计划（供返回值观测「为什么还要醒」）。 */
  function armPhase2Wake() {
    const plan = phase2WakePlan(Date.now())
    schedulePhase2Wake(plan.next)
    return plan
  }

  let phase2WakeTimer = null
  /** Phase 2 定时唤醒（§3 时间驱动）：到最早到期/available_at 再领一次，无新输出也按退避自动重试。 */
  function schedulePhase2Wake(nextAt) {
    if (phase2WakeTimer) clearTimeout(phase2WakeTimer)
    phase2WakeTimer = null
    if (nextAt == null) return
    const delay = Math.max(0, nextAt - Date.now())
    phase2WakeTimer = setTimeout(() => {
      phase2WakeTimer = null
      // t178：写锁竞争可重试（原先只 log ⇒ 落败的那次 pass 丢掉且不重新武装）。
      runScheduledPass('phase-2 wake drain error', 'phase2-wake', () => phase2Integrate())
    }, delay)
  }

  /**
   * 阶段 B：Phase 2 持久批次调度（R3/R4/P0-6/P0-7/P0-8）。
   * 消费 phase2_jobs（不再一次性读 stage1_outputs）：先恢复（published→committed 幂等补提交、
   * running/prepared 租约过期→重做），再领取一个批次（重试优先，否则从未消费 outputs 冻结新批），
   * 锁外读固定 input_ids → LLM → 校验 → staging → 切换 current → 提交。失败 → retry_wait + 退避，
   * 时间驱动自动再次领取（无新输出也按退避重试）。返回 { ran, ok, reason, errors, watermarks, batchId }。
   */
  async function phase2Integrate(opts = {}) {
    // GPT P0-1：单飞——任意时刻只允许一个 Phase 2 整合在途，防止两个批次并行归并丢更新。
    if (phase2Busy) return { ran: false, reason: 'busy' }
    phase2Busy = true
    try {
      // t189（②·门槛二）：当日额度剩余 < 阈值 ⇒ **不启动新的整合**（只拦自动路径，显式工具不受限）。
      //   顺序对齐 codex：prune/清理先跑（启动块里先做遗留状态归档/迁移/租约回收/半提交修复），
      //   再进这道门 —— 镜像 `start.rs` L75-86（先做不耗 token 的清理，再判额度）。
      //   在途批次（published/running/prepared）不拦：那是"收尾"而不是"开工"。
      if (opts.manual !== true) {
        const inFlight = [...phase2JobsTable.entries()]
          .some(([, j]) => j && (j.status === 'published' || j.status === 'running' || j.status === 'prepared'))
        if (!inFlight) {
          const attemptsToday = await withWrite(async () => {
            const m = readStage1Meta()
            const dk = dayKey()
            if (m.runDay !== dk) {
              m.runDay = dk
              m.modelAttemptsToday = 0
              await writeStage1Meta(m)
            }
            return m.modelAttemptsToday
          })
          const gate = bootQuotaPlan({
            attemptsToday,
            maxAttemptsPerDay: config.maxModelAttemptsPerDay,
            minRemainingPercent: config.minRemainingQuotaPercent,
          })
          if (!gate.allowed) {
            // 抄 codex 的"下一个启动再试"：排到**下一个本地日边界**（新预算窗口）再自动重试，不忙循环。
            try {
              console.info(
                `[dsh-memory_rollout] quota gate: ${gate.used}/${gate.cap} used (${gate.remainingPercent.toFixed(1)}% left < ${gate.thresholdPercent}%) — not starting a new consolidation`,
              )
            } catch {}
            schedulePhase2Wake(nextDayBoundaryMs(Date.now()))
            return { ran: false, ok: false, reason: 'quota-below-threshold', quota: gate }
          }
        }
      }
      const now = Date.now()
      // 0) 修复跨 key 半提交孤儿（P0-4）。
      await reconcilePhase2Bindings(now)
      // 1) 恢复（§5）：published 未 committed → 幂等补提交；running/prepared 租约过期 → 重做。
      const rec = await recoverPhase2Jobs(now)
      if (rec.committedIds.length) {
        const id = rec.committedIds[0]
        const b = phase2JobsTable.get(id)
        const wm = (Array.isArray(b && b.input_ids) ? b.input_ids : [])
          .map((oid) => stage1OutputsTable.get(oid)).filter(Boolean)
          .map((o) => String(o.source_watermark || '')).filter(Boolean)
        // t193：`wake` 是**本进程内的定时器调度状态**（phase2WakePlan 的产物），**不再放进返回体** ——
        //   声明 schema 是严格对象，而该字段对模型无用（render 从不用它）、属内部实现细节。
        //   调度副作用照旧：`armPhase2Wake()` 仍然武装唤醒；"下一次何时醒"仍可从 phase2_jobs 的
        //   `available_at` / `lease_expires_at` 观测（同一事实的另一面）。
        armPhase2Wake()
        return { ran: true, ok: true, watermarks: wm, batchId: id }
      }
      // 2) 领取一个批次（重试优先，否则冻结新批）。已有活跃非终态批 → busy（不新建并行批）。
      const claimedRes = await claimNextPhase2Job(now)
      if (claimedRes && claimedRes.busy) {
        // t193：同上 —— `wake` 不再进返回体（内部调度状态；副作用 armPhase2Wake() 保留）。
        armPhase2Wake()
        return { ran: false, reason: 'busy' }
      }
      if (!claimedRes) {
        armPhase2Wake()
        return { ran: false, reason: 'no-change' }
      }
      // 3) 处理（LLM → 校验 → staging → publish → commit）。
      const result = await processPhase2Batch(claimedRes.job)
      armPhase2Wake()
      return result
    } finally {
      phase2Busy = false
      // P0 busy rerun latch：本批运行期间被再次请求 → 释放后补跑（清标记，防死循环）。
      if (phase2RerunRequested) {
        phase2RerunRequested = false
        requestPhase2Integrate()
      }
    }
  }

  // ── t195（④）：使用计数累加（codex `usage_count` / `last_usage` 的**本地落点**）──────────────
  // 设计（详见报告"使用计数：放哪 / 初值 / 怎么累加 / 怎么不争写锁"一节）：
  //   · 字段放哪：`entries` 表的**每条记录**（`usage_count` / `last_usage`，schema 默认 0 / ''）；
  //   · 初值：读时缺字段 ⇒ 0 / ''（= 从未使用）——**不迁移、不重写**任何既有数据；
  //   · 何时累加：`memory_recall` 把条目**真正交付给模型**时（= 本插件里唯一可观测的"被使用"窗口）；
  //   · 怎么不争写锁：读路径**不等待**这次写 —— `setImmediate` + `runScheduledPass`（t180 纪律：
  //     定时回调里起写必须走它 ⇒ 写锁竞争时有界重试 + 降噪）+ `withWrite` 内逐条 `update`；
  //     同一 id 有 **10 分钟去抖**（`USAGE_BUMP_COOLDOWN_MS`），避免把"曝光"放大成自我强化偏置。
  //   · 偏差（如实）：codex 的 `usage_count` 由**引用解析**驱动（`citations.rs` → thread_ids），
  //     本地没有可观测的引用信号 ⇒ 用"被交付"近似；方向性风险由去抖抑制，且 `usage_count`
  //     **只作排序键、不作资格判据**（资格只看 30 天窗口）。
  const USAGE_BUMP_COOLDOWN_MS = 10 * 60 * 1000
  const usageBumpSeen = new Map()
  function scheduleUsageBump(ids) {
    const nowMs = Date.now()
    const pending = []
    for (const id of Array.isArray(ids) ? ids : []) {
      const key = String(id || '')
      if (!key) continue
      const prev = usageBumpSeen.get(key) || 0
      if (nowMs - prev < USAGE_BUMP_COOLDOWN_MS) continue
      usageBumpSeen.set(key, nowMs)
      pending.push(key)
    }
    if (!pending.length) return 0
    setImmediate(() => {
      runScheduledPass('memory usage bump error', 'usage-bump', async () => {
        await withWrite(async () => {
          for (const id of pending) {
            // 用 get + put（而不是 update）：`put` 是所有存储后端/测试假域都实现的最小接口，
            // 且在写锁内读改写是安全的（单写者）。旧记录缺字段 ⇒ usageCountOf 补 0。
            const cur = table.get(id)
            if (!cur) continue
            await table.put(id, { ...cur, usage_count: usageCountOf(cur) + 1, last_usage: nowIso() })
          }
        })
      })
    })
    return pending.length
  }

  const stage1DrainTool = defineTool({
    name: 'memory__stage1_drain',
    description: '调试/内部：手动触发一次 stage-1 作业 drain（消费表里到期的 pending/failed_retryable 作业并提炼提交）。不改变现有自动管线。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { processed: { type: 'integer', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `stage-1 drain：已处理 ${value.processed} 个作业。` }],
    },
    async execute() {
      const processed = await drainStage1Jobs()
      return { processed }
    },
  })

  const phase2IntegrateTool = defineTool({
    name: 'memory__phase2_integrate',
    description: '调试/内部：手动触发一次 Phase 2 整合调度（消费 phase2_jobs 持久批次：恢复→领取→锁外 LLM→校验→staging→切换 current→提交；失败退避重试）。与阶段 A 的 memory__stage1_drain 一致，供测试/手动触发；不改变现有 auto 管线。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ran: { type: 'boolean' },
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          errors: { type: 'array', items: { type: 'string' } },
          watermarks: { type: 'array', items: { type: 'string' } },
          batchId: { type: 'string' },
          // ── t193：以下字段**本来就返回、却没声明** ⇒ 真机被输出校验层判 invalid
          //    （`"value.wake" is not a declared property (additionalProperties: false)`）。
          //    按 t164 的验收要求，truncation/request/diagnostics 是"本批可观测事实"，**保留并如实声明**；
          //    （`wake` 已从返回体裁掉，见 phase2Integrate 的注释。）
          truncation: {
            type: 'object',
            additionalProperties: false,
            properties: {
              truncated: { type: 'boolean' },
              currentFilesTruncated: { type: 'array', items: { type: 'string' } },
              currentCharsCut: { type: 'integer' },
              currentChars: {
                type: 'object',
                additionalProperties: false,
                properties: { summary: { type: 'integer' }, registry: { type: 'integer' } },
              },
              incrementalInputs: {
                type: 'object',
                additionalProperties: false,
                properties: { count: { type: 'integer' }, charsCut: { type: 'integer' }, perInputLimit: { type: 'integer' } },
              },
              droppedInputs: { type: 'integer' },
            },
          },
          request: {
            type: 'object',
            additionalProperties: false,
            properties: {
              currentSummaryChars: { type: 'integer' },
              currentRegistryChars: { type: 'integer' },
              changesChars: { type: 'integer' },
              inputsChars: { type: 'integer' },
              scaffoldChars: { type: 'integer' },
              outputsReserveChars: { type: 'integer' },
              currentFilesChars: { type: 'integer' },
              promptChars: { type: 'integer' },
              totalChars: { type: 'integer' },
            },
          },
          diagnostics: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string' },
              advisory: { type: 'boolean' },
              persisted: { type: 'boolean' },
              suspectedCount: { type: 'integer' },
              suspectedSamples: { type: 'array', items: { type: 'string' } },
              note: { type: 'string' },
            },
          },
          quota: {
            type: 'object',
            additionalProperties: false,
            properties: {
              allowed: { type: 'boolean' },
              reason: { type: 'string' },
              used: { type: 'integer' },
              cap: { type: 'integer' },
              remainingPercent: { type: 'number' },
              thresholdPercent: { type: 'number' },
            },
          },
        },
      },
      render: (_args, value) => {
        const parts = [`Phase 2 整合：ran=${value.ran} ok=${value.ok}`]
        if (value.reason) parts.push(`原因=${value.reason}`)
        if (value.batchId) parts.push(`批次=${value.batchId}`)
        if (Array.isArray(value.watermarks) && value.watermarks.length) parts.push(`watermarks=${value.watermarks.join(', ')}`)
        if (Array.isArray(value.errors) && value.errors.length) parts.push(`errors=${value.errors.join('; ')}`)
        return [{ type: 'text', text: parts.join('；') + '。' }]
      },
    },
    async execute() {
      // P0：显式手动整合应取代 pending 的自动请求（避免自动触发吞掉手动整合）。
      if (phase2AutoTimer) clearImmediate(phase2AutoTimer)
      phase2AutoTimer = null
      phase2AutoScheduled = false
      phase2RerunRequested = false
      // t189：显式手动整合 **绕过额度门**（`manual: true`）—— 自动路径才受"剩余 < 阈值不开工"限制。
      return phase2Integrate({ manual: true })
    },
  })

  // ── P1 归档协议（性能与减法审计 §六）：历史数据保留/归档 ──────────────────
  // 只归档「终态/已消费且不再被读取路径需要」的记录到归档表（不硬删、可恢复），
  // 活跃表因此不再随历史线性增长。安全边界（设计文档 dsh-memory_rollout-P1归档协议设计-2026-08-29.md）：
  //   - stage1_jobs / stage1_outputs 被 watermark 去重/source_ref 引用依赖 → 需 seen-index/引用索引改造后才可归档；
  //   - phase2_jobs 归档会让 reconcilePhase2Bindings 把它绑定的 input 当孤儿解绑（重复消费）→ 需改 reconcile 才可归档；
  //   - 本步默认 dry-run 统计；实际归档仅限**绝对安全**的 consumed memory_changes（不破坏任何读路径/去重/引用）。
  const STAGE1_TERMINAL = new Set(['succeeded_with_output', 'succeeded_no_output', 'failed_terminal'])
  const PHASE2_TERMINAL = new Set(['committed', 'failed_terminal'])
  async function archiveVault(opts = {}) {
    const dryRun = opts.dryRun !== false
    const now = new Date().toISOString()
    const report = { dryRun, archived: 0, archivedVersions: 0, candidates: { stage1_jobs: 0, stage1_outputs: 0, phase2_jobs: 0, changes: 0, versions: 0 } }
    // 需保留的版本：current + 最近 2 个**可用**（versionIsUsable）非当前 published（按 created_at 降序）。
    // current 直接读 current.json（归档判断不依赖版本目录校验/回退，确定性）；坏版本也不移走（保回退）。
    let cur = ''
    try { cur = JSON.parse(readText(path.join(memoryRoot(), 'current.json'))).version || '' } catch { /* no current.json yet */ }
    const pub = [...publishVersionsTable.entries()]
      .filter(([, p]) => p && p.status === 'published')
      .sort((a, b) => String(b[1].created_at).localeCompare(String(a[1].created_at)))
      .map(([id]) => id)
    const verUsable = (id) => {
      const vd = path.join(memoryRoot(), 'versions', id)
      return versionIsUsable(vd, path.join(vd, 'manifest.json'), path.join(vd, 'memory_summary.md'), path.join(vd, 'MEMORY.md'))
    }
    const kept = new Set([cur])
    for (const id of pub) {
      if (kept.size >= 3) break // current + 2 可用
      if (id === cur) continue
      if (verUsable(id)) kept.add(id)
    }
    return withWrite(async () => {
      // 统计各表终态/已消费数量（dry-run 报告 + 安全评估）。stage1_jobs 仅统计
      // 「终态且无未消费产物」（有未消费产物则还被 phase2 用，不能算归档候选）。
      for (const [, j] of stage1JobsTable.entries()) {
        if (!j || j.status === 'failed_terminal') continue // 暂不归档 failed_terminal（P0-2）
        if (!STAGE1_TERMINAL.has(j.status)) continue
        const out = stage1OutputsTable.get(j.id)
        if (!out || out.selected_for_phase2 === true) report.candidates.stage1_jobs++
      }
      for (const [, o] of stage1OutputsTable.entries()) {
        if (o && o.selected_for_phase2 === true) report.candidates.stage1_outputs++
      }
      for (const [, j] of phase2JobsTable.entries()) {
        if (j && PHASE2_TERMINAL.has(j.status)) report.candidates.phase2_jobs++
      }
      for (const [, c] of memoryChangesTable.entries()) {
        if (c && c.status === 'consumed') report.candidates.changes++
      }
      for (const [id, p] of publishVersionsTable.entries()) {
        if (p && p.status === 'published' && !p.archived && !kept.has(id)) report.candidates.versions++
      }
      if (dryRun) return report
      // 实际归档：只动「终态/已消费且不再被读路径需要」的记录（本步含 stage1/phase2）。
      // ① consumed stage1_outputs → stage1_outputs_archive（保留全字段含 source_ref，供引用核验）。
      for (const [id, o] of stage1OutputsTable.entries()) {
        if (!o || o.selected_for_phase2 !== true) continue
        await stage1OutputsArchiveTable.put(id, { ...o, archived_at: now, archive_reason: 'output_consumed' })
        await stage1OutputsTable.delete(id)
        report.archived++
      }
      // ② 终态 phase2_jobs → phase2_jobs_archive（reconcile 已承认归档批次的绑定有效，见 reconcilePhase2Bindings）。
      for (const [id, j] of phase2JobsTable.entries()) {
        if (!j || !PHASE2_TERMINAL.has(j.status)) continue
        await phase2JobsArchiveTable.put(id, { ...j, archived_at: now, archive_reason: 'phase2_terminal' })
        await phase2JobsTable.delete(id)
        report.archived++
      }
      // ③ 终态 stage1_jobs（且无未消费产物）→ stage1_jobs_archive；先补 seen-index（去重不破）。
      //    P0-2 返修：**暂不归档 failed_terminal**（保留诊断窗口，且消除「归档快照 vs 同 watermark 重入
      //    重置 pending 后无条件 delete」的竞态丢任务路径）。成功终态（有/无产物）才归档。
      for (const [id, j] of stage1JobsTable.entries()) {
        if (!j || j.status === 'failed_terminal') continue // 暂不归档 failed_terminal
        if (!STAGE1_TERMINAL.has(j.status)) continue
        const out = stage1OutputsTable.get(j.id)
        if (out && out.selected_for_phase2 !== true) continue // 有未消费产物 → 还被 phase2 用，不归档
        if (j.status === 'succeeded_with_output' || j.status === 'succeeded_no_output') {
          if (!stage1SeenTable.get(id)) {
            await stage1SeenTable.put(id, { session_id: j.session_id, source_watermark: j.source_watermark, created_at: j.completed_at || j.updated_at || now })
          }
        }
        await stage1JobsArchiveTable.put(id, { ...j, archived_at: now, archive_reason: 'stage1_terminal' })
        await stage1JobsTable.delete(id)
        report.archived++
      }
      // ④ consumed memory_changes → changes_archive（保留全字段，可恢复）。
      for (const [id, c] of memoryChangesTable.entries()) {
        if (!c || c.status !== 'consumed') continue
        await changesArchiveTable.put(id, { ...c, archived_at: now, archive_reason: 'change_consumed' })
        await memoryChangesTable.delete(id)
        report.archived++
      }
      // ⑤ versions 归档：current + 最近 2 之外的版本目录移到 versions-archive/（只移动不删）。
      // publish_versions 用 passthrough 的 `archived` 标记（不改 status 枚举，避免 zod invalid-record）。
      const vroot = path.join(memoryRoot(), 'versions')
      const varchive = path.join(memoryRoot(), 'versions-archive')
      for (const [id, p] of publishVersionsTable.entries()) {
        if (!p || p.status !== 'published' || p.archived || kept.has(id)) continue
        const sdir = path.join(vroot, id)
        const ddir = path.join(varchive, id)
        let moved = false
        try {
          if (fs.existsSync(sdir)) {
            fs.mkdirSync(varchive, { recursive: true })
            fs.renameSync(sdir, ddir)
            moved = true
          } else if (fs.existsSync(ddir)) {
            moved = true // 目标已存在（幂等/上次已迁）
          }
        } catch (e) {
          // P0-4：rename 失败 → 不标 archived，保留未归档状态供下次重试（不谎报成功）。
          try { console.error('[dsh-memory_rollout] version archive move failed (kept unarchived for retry):', e) } catch {}
        }
        if (!moved) continue
        await publishVersionsTable.update(id, (cur) => ({ ...cur, archived: true, archived_at: now }))
        report.archivedVersions++
      }
      return report
    })
  }

  // ── P1 归档协议：恢复入口（restoreVault，默认 dry-run）──────────────────────
  // 把归档表/目录的记录迁回活跃表/目录（只迁回「目标不存在」的记录，冲突不覆盖——可恢复且不丢数据）。
  async function restoreVault(opts = {}) {
    const dryRun = opts.dryRun !== false
    const now = new Date().toISOString()
    const report = { dryRun, restored: 0, restoredVersions: 0, candidates: { stage1_jobs: 0, stage1_outputs: 0, phase2_jobs: 0, changes: 0, versions: 0 } }
    return withWrite(async () => {
      const restoreTable = async (src, dst, label) => {
        for (const [id, rec] of src.entries()) {
          if (!rec) continue
          if (dst.get(id)) {
            // 收敛：目标已有同 key —— 上次恢复已写回 dst 但 src.delete 失败（跨表半提交→重复）。
            // 等价清理：dst 是权威（不覆盖），删除 src 残留副本，收敛到无重复。
            report.candidates[label]++
            if (!dryRun) { await src.delete(id); report.restored++ }
            continue
          }
          report.candidates[label]++
          if (!dryRun) {
            await dst.put(id, { ...rec, restored_at: now })
            await src.delete(id)
            report.restored++
          }
        }
      }
      await restoreTable(stage1JobsArchiveTable, stage1JobsTable, 'stage1_jobs')
      await restoreTable(stage1OutputsArchiveTable, stage1OutputsTable, 'stage1_outputs')
      await restoreTable(phase2JobsArchiveTable, phase2JobsTable, 'phase2_jobs')
      await restoreTable(changesArchiveTable, memoryChangesTable, 'changes')
      // 版本目录：versions-archive/<id> → versions/<id>（若目标不存在）；unmark publish_versions archived。
      const vroot = path.join(memoryRoot(), 'versions')
      const varchive = path.join(memoryRoot(), 'versions-archive')
      for (const [id, p] of publishVersionsTable.entries()) {
        if (!p || p.archived !== true) continue
        const sdir = path.join(varchive, id)
        const ddir = path.join(vroot, id)
        if (!fs.existsSync(sdir)) {
          // 收敛：源目录已不存在（已搬回），但 metadata 仍 archived → 若目标存在则 unmark（幂等收敛）。
          if (fs.existsSync(ddir)) {
            report.candidates.versions++
            if (!dryRun) {
              await publishVersionsTable.update(id, (cur) => ({ ...cur, archived: false, archived_at: '' }))
              report.restoredVersions++
            }
          }
          continue
        }
        if (fs.existsSync(ddir)) continue // 冲突：目标已存在 → 不覆盖
        report.candidates.versions++
        if (!dryRun) {
          try {
            fs.mkdirSync(vroot, { recursive: true })
            fs.renameSync(sdir, ddir)
            await publishVersionsTable.update(id, (cur) => ({ ...cur, archived: false, archived_at: '' }))
            report.restoredVersions++
          } catch (e) {
            try { console.error('[dsh-memory_rollout] version restore move failed:', e) } catch {}
          }
        }
      }
      return report
    })
  }

  const archiveVaultTool = defineTool({
    name: 'memory__archive_vault',
    description:
      '调试/内部：P1 归档协议——默认 dry-run 统计各表可归档量；dryRun=false 时把「终态/已消费且不再被读路径需要」的记录迁移到归档表/目录（不硬删、可恢复）：consumed stage1_outputs、终态 phase2_jobs、终态(非 failed_terminal)且无未消费产物的 stage1_jobs、consumed memory_changes、旧版本目录（保留 current+最近2可用）。stage1 failed_terminal 暂不归档。建议先 dry-run 看量，再决定是否 dryRun=false；不自动/定时归档。',
    parameters: {
      dryRun: { type: 'boolean', default: true, description: 'true=只统计不归档（默认）；false=仅迁移上述「终态/已消费且不再被读路径需要」的记录与旧版本。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dryRun: { type: 'boolean' },
          archived: { type: 'integer' },
          archivedVersions: { type: 'integer' },
          candidates: {
            type: 'object',
            additionalProperties: false,
            properties: {
              stage1_jobs: { type: 'integer' },
              stage1_outputs: { type: 'integer' },
              phase2_jobs: { type: 'integer' },
              changes: { type: 'integer' },
              versions: { type: 'integer' },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `归档${value.dryRun ? '(dry-run)' : ''}：已迁移 ${value.archived} 条记录、${value.archivedVersions} 个版本；候选 jobs=${value.candidates.stage1_jobs} outputs=${value.candidates.stage1_outputs} phase2=${value.candidates.phase2_jobs} changes=${value.candidates.changes} versions=${value.candidates.versions}` },
      ],
    },
    async execute(args) {
      return archiveVault({ dryRun: !args || args.dryRun !== false })
    },
  })

  const restoreVaultTool = defineTool({
    name: 'memory__restore_vault',
    description:
      '调试/内部：P1 归档协议恢复入口——默认 dry-run 统计各归档表/目录可恢复量；dryRun=false 时把归档表/目录记录迁回活跃表/目录（目标键已存在则冲突不覆盖，不丢数据、可恢复）。用于误归档或诊断恢复。',
    parameters: {
      dryRun: { type: 'boolean', default: true, description: 'true=只统计不恢复（默认）；false=仅恢复「目标不存在」的记录/版本目录。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dryRun: { type: 'boolean' },
          restored: { type: 'integer' },
          restoredVersions: { type: 'integer' },
          candidates: {
            type: 'object',
            additionalProperties: false,
            properties: {
              stage1_jobs: { type: 'integer' },
              stage1_outputs: { type: 'integer' },
              phase2_jobs: { type: 'integer' },
              changes: { type: 'integer' },
              versions: { type: 'integer' },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `恢复${value.dryRun ? '(dry-run)' : ''}：可恢复 ${value.restored} 条记录、${value.restoredVersions} 个版本；候选 jobs=${value.candidates.stage1_jobs} outputs=${value.candidates.stage1_outputs} phase2=${value.candidates.phase2_jobs} changes=${value.candidates.changes} versions=${value.candidates.versions}` },
      ],
    },
    async execute(args) {
      return restoreVault({ dryRun: !args || args.dryRun !== false })
    },
  })

  /** Read the injected memory summary (bounded to summaryTokens), via current version (P0-7). */
  function readMemorySummary() {
    const cur = resolveCurrentFiles()
    const s = readText(cur.summaryPath)
    if (!s) return ''
    const maxChars = (config.summaryTokens || 4000) * 4
    return s.length > maxChars ? s.slice(0, maxChars) + '\n...(截断)' : s
  }

  // ── M1：在记忆文件里检索「自动记忆」────────────────────────────────────────
  // recall 原本只搜显式 entries（memory_remember）。自动记忆（Phase1 产物 / Phase2 整合）会进
  // memory_summary.md / MEMORY.md（版本化），但不在 entries。M1 让 recall 也搜当前记忆文件 +
  // 最相关的 1-2 个草稿/证据（rollout_summaries/），使「新会话能想起过去自动形成的偏好/决定/项目
  // 状态」，并给出来源。仅关键词 + 行范围（M1 停止条件：不引入 embedding/向量库/全盘模糊搜索）。
  // M1-R1：所有读取来源（summary/registry/草稿/证据）统一应用 forgotten/superseded 生命周期裁决——
  // 被遗忘/取代的事实即使仍在旧草稿里，也不从 recall 返回（否则用户纠正/遗忘后旧内容仍支配回答）。
  function searchMemoryFiles(terms, limit) {
    const cur = resolveCurrentFiles()
    const out = []
    // M1-R1：被遗忘/取代的事实内容集合（归一化），命中行**规范化完全相等**且仅去除已知纯展示包装
    // （行首列表/标题符、开头 [tags]）才判为同一事实并跳过——绝不按子串，否则会把包含旧字符串的
    // 新否定/修正结论一并删除（违反「旧事实退出默认读取后不能阻止新事实生效」）。宁少过滤、不误删冲突。
    const excluded = new Set()
    for (const e of allEntries()) {
      if (e && (e.status === 'forgotten' || e.status === 'superseded')) {
        const c = normalizeContent(e.content)
        if (c) excluded.add(c)
      }
    }
    const stripPackaging = (text) => {
      let s = String(text || '').trim()
      s = s.replace(/^[-*#>\s]+/, '') // 去行首列表/标题/引用/空白
      s = s.replace(/^\[[^\]]*\]\s*/, '') // 去开头 [tags] 块
      // M1-R3：只锚定去除 writeRegistry() 固定生成的行尾元数据后缀 `(session=…, updated=…)`，
      // 不删任意圆括号内容（避免误伤事实里的括号）。
      s = s.replace(/\s*\(session=[^)]*,\s*updated=[^)]*\)\s*$/, '')
      return s
    }
    const isExcluded = (text) => {
      const c = normalizeContent(stripPackaging(text))
      if (!c) return false
      for (const ex of excluded) {
        if (ex.length >= 5 && c === ex) return true // 规范化完全相等（同一事实）才排除
      }
      return false
    }
    const files = [
      { label: 'memory_summary.md', path: cur.summaryPath },
      { label: 'MEMORY.md', path: cur.registryPath },
    ]
    const scanLines = (text, label) => {
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const t = String(lines[i] || '').trim()
        if (!t || t.length < 6) continue
        if (isExcluded(t)) continue // M1-R1：forgotten/superseded 内容不返回
        const hits = terms.filter((term) => t.toLowerCase().includes(term)).length
        if (hits <= 0) continue
        out.push({ content: t, citation: `${label}:${i + 1}-${i + 1}`, m: hits })
      }
    }
    for (const f of files) {
      if (!f.path) continue
      const text = readText(f.path)
      if (text) scanLines(text, f.label)
    }
    // 最相关的 1-2 个草稿/证据（rollout_summaries/*.md）：M1-R4——先在全体候选里算命中词数，
    // 再按相关度取 top 1-2（不按目录顺序抢跑）。
    const summariesDir = dirs().summaries
    const draftCandidates = []
    for (const name of listFiles(summariesDir)) {
      if (!name.endsWith('.md')) continue
      const text = readText(path.join(summariesDir, name))
      if (!text) continue
      const lines = text.split(/\r?\n/)
      let best = null
      for (let i = 0; i < lines.length; i++) {
        const t = String(lines[i] || '').trim()
        if (!t || t.length < 6) continue
        if (isExcluded(t)) continue
        const hits = terms.filter((term) => t.toLowerCase().includes(term)).length
        if (hits <= 0) continue
        if (!best || hits > best.m) best = { content: t, citation: `rollout_summaries/${name}:${i + 1}-${i + 1}`, m: hits }
      }
      if (best) draftCandidates.push(best)
    }
    draftCandidates.sort((a, b) => b.m - a.m || b.content.length - a.content.length)
    for (const d of draftCandidates.slice(0, 2)) out.push(d)
    out.sort((a, b) => b.m - a.m || b.content.length - a.content.length)
    return out.slice(0, limit)
  }

  // ── injection: 总纲 + 决策边界 + quick pass (NOT a flat recent-entries stream)
  ctx.systemPrompt.section({
    name: 'dsh-memory_rollout',
    order: 90,
    text: () => {
      // M1：useMemories=false → 不注入记忆（生成/使用可独立控制）。
      if (config.useMemories === false) return ''
      const summary = readMemorySummary()
      if (!summary) return ''
      const maxSteps = config.maxQuickSteps || 5
      return [
        '## 记忆总纲',
        '> 记忆仅供辅助回忆。当前用户指令与 AGENTS.md 始终优先于以下记忆；忽略与当前指令冲突的记忆。',
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
      supersedes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of entry ids this new fact REPLACES. Each listed entry is marked status=superseded with superseded_by=new id, so recall stops returning the old fact (audit mode can still trace it).',
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
          merged: { type: 'boolean' },
          supersededCount: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const note = value.merged
          ? ` (merged into existing entry ${value.id}; no duplicate created)`
          : `; superseded ${value.supersededCount || 0} older entr${(value.supersededCount || 0) === 1 ? 'y' : 'ies'}`
        return [
          {
            type: 'text',
            text: `Remembered (id ${value.id}, session ${value.sessionId}); vault now holds ${value.count} entries.${note}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      // D3: redact before the entry is written to the permanent table.
      const content = redactSecrets(String(args.content || '').trim())
      if (!content) throw new Error('memory_remember: content must be a non-empty string')
      const sid = sessionIdOf(exec)
      const supersedes = Array.isArray(args.supersedes)
        ? args.supersedes.map((s) => String(s)).filter(Boolean)
        : []
      // L8：整个写路径包 withWrite（去重判定 + 写入 + 取代互斥，避免并发写插入重复事实）。
      const res = await withWrite(async () => {
        const dedupKey = contentWatermark(normalizeContent(content))
        // §10.2（去重）：新内容与某条现有 active 条目内容归一化水印一致 → 不新增，
        // 刷新 updatedAt 并返回既有 id（不产生重复事实）。仍处理显式 supersedes（若给出）。
        for (const e of allEntries()) {
          if (
            e.status === 'active' &&
            contentWatermark(normalizeContent(e.content)) === dedupKey
          ) {
            const cur = findEntryValue(e.id)
            await table.put(e.id, {
              ...cur,
              updatedAt: nowIso(),
            })
            for (const tid of supersedes) await supersedeRecord(tid, e.id)
            // R5：记住（去重命中）也入流，记录用户重申该事实（Phase2 可据此再加权）。
            await writeChangeRecord('remember', {
              content,
              tags: (Array.isArray(args.tags) ? args.tags.map(String) : []).map(redactSecrets),
              entryId: e.id,
              merged: true,
            })
            return { id: e.id, count: table.size, sessionId: sid, merged: true, supersededCount: supersedes.length }
          }
        }
        // 新增。
        const id = makeId()
        await table.put(id, {
          content,
          tags: (Array.isArray(args.tags) ? args.tags.map(String) : []).map(redactSecrets),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          source: 'tool',
          status: 'active',
          superseded_by: '',
          ...(sid ? { sessionId: sid } : {}),
        })
        // R5：记住入流，payload 带内容 + 标签 + 新生 entry id，供 Phase2 整合进权威版本。
        await writeChangeRecord('remember', {
          content,
          tags: (Array.isArray(args.tags) ? args.tags.map(String) : []).map(redactSecrets),
          entryId: id,
          merged: false,
        })
        // §10.2（自动取代）：新内容与某条现有 active 条目高度重合/同主题（词重叠阈值）→
        // 把旧条目 status=superseded、superseded_by=新 id。
        let autoSuperseded = 0
        for (const e of allEntries()) {
          if (e.id === id || e.status !== 'active') continue
          if (
            contentOverlapRatio(normalizeContent(e.content), normalizeContent(content)) >=
            AUTO_SUPERSEDE_OVERLAP
          ) {
            await supersedeRecord(e.id, id)
            autoSuperseded++
          }
        }
        // §10.2（显式 supersedes）：用户声明的取代，逐条标记。
        for (const tid of supersedes) await supersedeRecord(tid, id)
        return {
          id,
          count: table.size,
          sessionId: sid,
          merged: false,
          supersededCount: autoSuperseded + supersedes.length,
        }
      })
      // P0-R2-1：不再在此单独请求 Phase2 —— writeChangeRecord 已统一唤醒（单一边界）。
      return res
    },
  })

  /**
   * 引用贯通（P1-1）：给定一条召回记忆，去找它「通过 stage1_outputs 拥有的真实 source_ref」。
   * 按 sessionId 关联到该会话的 stage-1 产物，取第一个 **仍可核查** 的 source_ref。
   * 返回：
   *   - { ref }          找到且 validateSourceRef 通过（引用为真实证据）；
   *   - { broken: true } 该会话有 source_ref 但证据文件缺失/行号越界（坏证据 → 回退 unverified）；
   *   - null              无 stage1_outputs / 无 source_ref（回退到 MEMORY.md / 草稿兜底）。
   * stage1_outputs 表 schema 已 .passthrough，entry 记录不含 source_ref 字段，故不会误配。
   */
  function sourceRefForEntry(e) {
    if (!e || !e.sessionId) return null
    let foundBroken = false
    // P1 归档协议：stage1_outputs 归档后，其 source_ref 仍可核验（先查活跃表，再查归档表）。
    const scan = (entries) => {
      for (const [, output] of entries) {
        if (!output || typeof output !== 'object') continue
        if (String(output.session_id || '') !== String(e.sessionId)) continue
        const ref = output.source_ref
        if (!ref || typeof ref !== 'object' || !ref.path || !ref.startLine) continue
        // P0 entry↔source_ref 语义配对：validateSourceRef 的 cite 分支会短路（只要 citeSpan
        // 在文件里就 ok），无法校验「entry.content 是否真在该行段内」。故传 citeless ref +
        // '{ content: e.content }'，强制走 content 分支，使「同 session 的无关 entry」不再误引用
        // stage1 摘要；真坏证据（missing/line-range/unsafe-path）仍回退 unverified。
        const v = validateSourceRef(
          { path: ref.path, startLine: ref.startLine, endLine: ref.endLine, citeSpan: '', sessionId: ref.sessionId },
          memoryRoot(),
          { content: e.content },
        )
        if (v.ok) return { ref }
        if (v.reason === 'missing' || v.reason === 'line-range' || v.reason === 'unsafe-path') foundBroken = true
      }
      return null
    }
    return scan(stage1OutputsTable.entries()) || scan(stage1OutputsArchiveTable.entries()) || (foundBroken ? { broken: true } : null)
  }

  /**
   * Build Codex-compatible `path:start-end|note=[...]` citation entries for a set
   * of recalled long-term memories. Codex's citations.rs parses a real file path
   * and a line range; the old `sessionId:index` form had neither, so it could not
   * be parsed and pointed nowhere.
   *
   * Each entry points at the real file that actually holds it:
   *   - primary-2: a real `source_ref` from stage1_outputs (the per-session evidence
   *     file + precise line range), when this entry was derived from a stage-1
   *     output. This is the most attestable evidence (validated by validateSourceRef).
   *   - primary: the long-term memory's own line in MEMORY.md (the registry line
   *     writeRegistry wrote for this entry); a single line span `N-N`.
   *   - fallback: the session's rollout draft `rollout_summaries/<session>.md`,
   *     citing its whole body `1-N`, when the entry is not yet materialized.
   * Broken evidence (source_ref that no longer validates — file deleted / line out
   * of range) → explicitly `unverified`, NEVER a fabricated or whole-draft cite.
   */
  function memoryCitationEntries(entries) {
    const cur = resolveCurrentFiles()
    const regRel = path.relative(memoryRoot(), cur.registryPath).replace(/\\/g, '/') || 'MEMORY.md'
    const regLines = readText(cur.registryPath).split(/\r?\n/)
    const memo = (p, s, e) => `${p}:${s}-${e}|note=[recalled from memory]`
    const UNVERIFIED = 'unverified:0-0|note=[no verifiable file+line source; not attested]'
    return entries.map((e) => {
      // P1-1：条目通过 stage1_outputs 有真实 source_ref → 用证据文件 + 精确行段。
      const sr = sourceRefForEntry(e)
      if (sr && sr.ref) return memo(sr.ref.path, sr.ref.startLine, sr.ref.endLine)
      if (sr && sr.broken) return UNVERIFIED
      if (regLines.length) {
        const idx = regLines.findIndex((l) => e.content && l.includes(e.content))
        if (idx >= 0) return memo(regRel, idx + 1, idx + 1)
      }
      if (e.sessionId) {
        const slug = safeSlug(e.sessionId)
        const relPath = `rollout_summaries/${slug}.md`
        // P1-5 / P0-R2-2（R2.1 修正）：会话草稿回退**不再**「共享一个特征词」放行。
        // 上一版草稿指针（startLine=1, endLine=0 整段）只要 entry 与草稿共享任一 token 就返回
        // `1-N|note=[recalled from memory]`——但草稿只证明「该会话的记录」，不证明「该草稿支持
        // 这个具体事实」。同关键词不同事实（草稿「pnpm build failed」/ entry「user prefers pnpm」）
        // 会因此伪装成已核验引用，与精确 Stage1 路径已删的单 token 放行同病。这里同样要求
        // **规范化完整子串**：仅当草稿正文确含 entry 的规范化完整内容时才返回草稿行引用，
        // 否则退化为诚实的 unverified（宁可少给引用，也不给错误引用）。
        const draft = validateSourceRef({ path: relPath, startLine: 1, endLine: 0 }, memoryRoot())
        if (draft.ok) {
          const normalSpan = normalizeContent(readText(path.join(memoryRoot(), relPath)))
          const normalContent = normalizeContent(String(e.content || ''))
          if (normalContent && normalSpan.includes(normalContent)) return memo(relPath, 1, draft.spanEnd)
        }
      }
      // 无证据：do NOT fabricate a "MEMORY.md:1-1" placeholder that implies the
      // registry line holds the memory. Mark it explicitly unverified so the model
      // doesn't treat it as attested evidence.
      return UNVERIFIED
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
      includeSuperseded: {
        type: 'boolean',
        description:
          'Audit switch (default false). When true, superseded entries are also returned (with their supersededBy target) so a reviewer can trace the replacement chain. Forgotten entries are NEVER returned, even here.',
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
                status: { type: 'string' },
                supersededBy: { type: 'string' },
              },
            },
          },
          // M1：自动记忆（当前记忆文件里命中关键词的行），不带 entry id —— 仅用于「想起来」，纠正/遗忘走 entries。
          memories: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                citation: { type: 'string', required: true },
              },
            },
          },
          count: { type: 'integer', required: true },
          maybeStale: { type: 'boolean', required: true },
          citation: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const total = (value.entries || []).length + (value.memories || []).length
        if (!total) return [{ type: 'text', text: 'No matching memory entries.' }]
        const lines = [...(value.entries || []).map(
          (e) =>
            '- ' +
            (e.tags && e.tags.length ? `[${e.tags.join(', ')}] ` : '') +
            e.content +
            (e.sessionId ? ` (session ${e.sessionId})` : ''),
        ),
        ...(value.memories || []).map((m) => `- [自动记忆] ${m.content}  (${m.citation})`)]
        return [
          {
            type: 'text',
            text:
              (value.maybeStale ? '(来自记忆，可能过时；如需请提供刷新)\n' : '') +
              lines.join('\n') +
              (value.citation ? '\n\n' + value.citation : ''),
          },
        ]
      },
    },
    async execute(args) {
      const query = String(args.query || '').trim()
      const maxN = config.recallLimit || 10 // 稳健：宿主未补默认时兜底
      const limit = Math.min(Math.max(Number(args.limit) || maxN, 1), maxN)
      if (!query) throw new Error('memory_recall: query must be a non-empty string')
      // M1：useMemories=false → 不召回（生成/使用可独立控制）。
      if (config.useMemories === false) return { entries: [], memories: [], count: 0, maybeStale: false, citation: '' }
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
      // t195（④ 照 codex）：**资格 = 硬淘汰**（不再只是降权）——
      //   依据镜像 `codex-rs/state/src/runtime/memories.rs` L473-477：用过看 `last_usage`、从未用过看
      //   来源新鲜度，二者都要落在 `max_unused_days`（默认 30）窗口内；本地映射见 `entryEligible()`。
      //   本地既有的硬谓词仍最高优先：forgotten 永不返回；superseded 仅审计模式可见（且仍受窗口约束）。
      // **撤销「降权实验」**：`freshnessWeight` 不再参与打分（`scoreMemory` 现在只返回相关性）。
      const includeSuperseded = args.includeSuperseded === true
      const nowMs = Date.now()
      const scored = allEntries()
        .filter((e) => entryEligible(e, nowMs, config.maxUnusedDays, { includeSuperseded }))
        .map((e) => ({ e, s: scoreEntry(e, terms), u: usageCountOf(e) }))
      // 排序照 codex（镜像同文件 L479-482 的同序）：`usage_count DESC` 为首键；
      //   本地召回多一个检索维度（codex 的选择没有 query）⇒ 相关性作**门槛**（s>0）与次级键，
      //   随后按 `COALESCE(last_usage, updatedAt) DESC`、`updatedAt DESC`（codex 的第 2/3 键）。
      scored.sort((a, b) =>
        b.u - a.u ||
        b.s - a.s ||
        (lastUsageOf(b.e) ?? 0) - (lastUsageOf(a.e) ?? 0) ||
        String(b.e.updatedAt).localeCompare(String(a.e.updatedAt)),
      )
      const top = scored.filter((x) => x.s > 0).slice(0, limit).map((x) => x.e)
      // t195：把"本次真正交付给模型"的条目计入使用（codex `usage_count`/`last_usage` 的本地近似）；
      //   读路径**不等待**这次写（详见 scheduleUsageBump 的注释与报告"设计/偏差"一节）。
      scheduleUsageBump(top.map((e) => e.id))
      const entries = top.map((e) => ({
        id: e.id,
        content: e.content,
        tags: e.tags,
        createdAt: e.createdAt,
        sessionId: e.sessionId || '',
        status: e.status || 'active',
        supersededBy: e.superseded_by || '',
      }))
      // M1-R2：去重仅按「归一化后完全相等」，绝不按子串猜测——否则会吞掉否定/修正/冲突事实。
      // 宁可保留少量重复（同一条事实既在 entries 又在记忆文件），也不能隐藏冲突（交给 lifecycle/supersede）。
      const memories = searchMemoryFiles(terms, limit)
        .filter((m) => {
          const mc = normalizeContent(m.content)
          if (!mc) return true
          return !entries.some((e) => normalizeContent(e.content) === mc)
        })
        .slice(0, Math.max(0, limit - entries.length))
        .map((m) => ({ content: m.content, citation: m.citation }))
      const maybeStale = entries.length + memories.length > 0
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
      // M1-R3：count 计入自动记忆（仅自动记忆返回时 count 也应正确）。
      return { entries, memories, count: entries.length + memories.length, maybeStale, citation }
    },
  })

  const forgetTool = defineTool({
    name: 'memory_forget',
    description:
      'Delete entries from the long-term memory vault by exact id. Only when the user says a stored fact is wrong, obsolete, or should not be remembered. Tag-based batch delete is disabled (§10.3) — pass the exact id returned by memory_recall instead.',
    parameters: {
      id: { type: 'string', description: 'Exact entry id to delete (returned by memory_recall).' },
      tag: {
        type: 'string',
        // §10.3：禁止宽泛公共 tag 批量误删。保留该字段仅为 schema 兼容，不再执行批量删除。
        description: 'Deprecated — tag-based batch delete is disabled; pass an exact id.',
      },
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
      // L7：只允许按精确 id 删除；tag 批量删除已禁用（§10.3）。写路径包 withWrite。
      // §10.3 / P1-4：置墓碑（status='forgotten'）而非物理删除 —— 条目保留（可溯源），
      // 但从召回/注入/读取路径被谓词排除。
      let deleted = 0
      const id = typeof args.id === 'string' ? args.id : ''
      if (id) {
        // forgetRecord 内部已写 forget 墓碑变更（R5 / P1-2，forget 最高优先），无需在此重复。
        if (await withWrite(() => forgetRecord(id))) deleted = 1
      } else if (typeof args.tag === 'string' && args.tag) {
        throw new Error(
          'memory_forget: tag-based batch delete is disabled (§10.3); pass an exact id from memory_recall',
        )
      } else {
        throw new Error('memory_forget: provide an exact id')
      }
      return { deleted }
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
      // L8：note 写文件包 withWrite（writeText 内部只做 mkdir+writeFileSync，不加锁，
      // 不嵌套死锁）。ensureLayout 放在锁外即可——它是幂等目录创建。
      // R5：note 内容同时入统一变更流（带 source_ref），随批进权威版本作为来源/证据。
      await withWrite(async () => {
        writeText(file, header + content + '\n')
        await writeChangeRecord('note', { content, slug, file }, { source_ref: path.relative(memoryRoot(), file) })
      })
      return { file: path.relative(memoryRoot(), file) }
    },
  })

  const integrateTool = defineTool({
    name: 'memory_integrate',
    description:
      '触发记忆整合 pass：无变化则跳过；有变化则重新生成 MEMORY.md 注册表与 memory_summary.md 总纲（幂等水印，不后退）。一般在会话收尾/后台运行时调用。可选 compress=true 时改排一个「纯压缩批」，把已超限的记忆总纲压回尺寸上限（无新输入也跑）。',
    parameters: {
      compress: {
        type: 'boolean',
        description:
          '【AI 不得擅自使用；仅当用户明确要求「压缩记忆总纲 / 把总纲压小」时才传 true】默认 false。true = 显式排一个「纯压缩批」（无新输入也跑），把当前已超出尺寸上限的权威 memory_summary 压回上限内。本批会**改写权威总纲**，故必须有人为触发意图；总纲未超限时该批不会创建。false / 不传 = 行为与原来完全一致。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          changed: { type: 'boolean', required: true },
          skipped: { type: 'boolean', required: true },
          enqueued: { type: 'boolean' },
          batchId: { type: 'string' },
          reason: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.enqueued
            ? '已排入「纯压缩记忆总纲」批次（后台执行，完成后自动发布新版本）'
            : value.skipped
              ? '整合跳过（无变化）'
              : value.changed
                ? '整合完成（已更新 MEMORY.md / memory_summary.md）'
                : '整合无变化',
        },
      ],
    },
    async execute(args) {
      // t80：显式压缩入口。不进入 integrate()（那条确定性重建路径已被 .phase2-authoritative 短路），
      // 而是排一个 mode='compress' 的 phase-2 批，走正常的 LLM→校验→版本化发布链路。
      if (args && args.compress === true) {
        try {
          const r = await enqueueCompressBatch('memory_integrate.compress')
          return { changed: false, skipped: !r.enqueued, enqueued: r.enqueued, batchId: r.batchId || '', reason: r.reason || '' }
        } catch (err) {
          try { console.error('[dsh-memory_rollout] memory_integrate compress enqueue error:', err) } catch {}
          return { changed: false, skipped: true, enqueued: false, error: String((err && err.message) || err) }
        }
      }
      try {
        const r = withWriteSync(() => integrate())
        return { changed: r.changed, skipped: r.skipped }
      } catch (err) {
        // 里层整合抛错不泄漏到工具调用（防宿主崩溃）；记录并返回 skipped 语义。
        try { console.error('[dsh-memory_rollout] memory_integrate integrate() error:', err) } catch {}
        return { changed: false, skipped: true, error: String((err && err.message) || err) }
      }
    },
  })

  const precompactTool = defineTool({
    name: 'memory_precompact',
    description:
      '压缩前/会话关键时主动调用，防信息因上下文压缩丢失。把当前会话的关键要点写入本会话草稿（rollout_summaries/<sessionId>.md）并把该会话作为一次 Stage1 作业入新持久队列（enqueueStage1JobIntoTable + scheduleStage1Drain + schedulePhase2Wake），让关键信息在压缩前落盘。参数 content 为 agent 提炼的要点。',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'Agent 提炼的当前会话关键要点（语句化）。',
      },
      title: { type: 'string', description: '可选短标题。' },
      // t78：显式 force 开关（默认关闭）。白名单——只有本显式入口会把 force 传下去；自动路径永不传。
      force: {
        type: 'boolean',
        description:
          '【AI 不得擅自使用；仅当用户明确要求「把这段写进记忆」时才传 true】默认 false。true = 绕过 external_context 生成资格跳过（本会话用过 web_search/web_fetch 时），强制把本会话作为一次 Stage1 作业入队并提炼。绕过后果：外部来源内容可能因此进入长期记忆。不传 / false = 行为与原来完全一致。',
      },
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
          error: { type: 'string' },
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
      // ① 保留「把当前会话关键要点落盘」语义：写本会话草稿（文件层）。
      const file = writeSessionDraft(sid, cwd, args.title, body)
      // ② 触发管线走新队列（R7 / §11.4⑥）：把该会话当作一次 Stage1 入队 + schedule
      //    drain + phase2 wake。raw 优先用会话导出消息；拿不到时退化为 agent 提炼的
      //    body 内容（保证 watermark 稳定、去重可靠）。
      // t78：显式 force（默认 false）。只有本显式入口会把 force 传给入队；自动路径（session/disposed）不传。
      // 纪律：AI 不得擅自使用；仅当用户明确要求把内容写进记忆时才传 true。
      const forceOn = args.force === true
      try {
        const sess = exec && exec.agent && exec.agent.session
        const msgs = sess && typeof sess.deriveMessages === 'function' ? sess.deriveMessages() : []
        const raw = messagesToDraftBody(msgs) || body
        const enq = await enqueueStage1JobIntoTable(
          sid,
          contentWatermark(raw),
          forceOn ? { forced: true, forceReason: 'user_requested' } : {},
        )
        if (forceOn) {
          // 审计留痕：force 生效时在日志打一条明确记录（job 记录的 forced/force_reason 在入队侧落盘）。
          try {
            console.warn('[dsh-memory_rollout] memory_precompact FORCED: bypass external_context eligibility (user-requested memory write). session=' + sid + ' key=' + enq.key)
          } catch {}
        }
        if (!enq.queued && enq.error) {
          try { console.error('[dsh-memory_rollout] memory_precompact enqueue returned unqueued:', enq.error) } catch {}
        }
      } catch (err) {
        try { console.error('[dsh-memory_rollout] memory_precompact enqueue error:', err) } catch {}
      }
      scheduleStage1Drain()
      armPhase2Wake()
      // ③ 确定性重建（受 .phase2-authoritative 保护，不会覆盖 LLM 权威产物，避免双发布），
      //    保留 changed/skipped 返回语义；里层整合抛错不泄漏到工具调用。
      let r
      try {
        r = withWriteSync(() => integrate())
      } catch (err) {
        try { console.error('[dsh-memory_rollout] memory_precompact integrate() error:', err) } catch {}
        r = { changed: false, skipped: true, error: String((err && err.message) || err) }
      }
      return { file, sessionId: sid, changed: r.changed, skipped: r.skipped, ...(r.error ? { error: r.error } : {}) }
    },
  })

  ctx.tools.register(rememberTool)
  ctx.tools.register(recallTool)
  ctx.tools.register(forgetTool)
  ctx.tools.register(noteTool)
  ctx.tools.register(integrateTool)
  ctx.tools.register(precompactTool)
  ctx.tools.register(stage1DrainTool)
  ctx.tools.register(phase2IntegrateTool)
  ctx.tools.register(archiveVaultTool)
  ctx.tools.register(restoreVaultTool)

  // Seed the memory layout + integration on startup so the base files exist.
  integrate()

  // ── 阶段 A · 启动恢复接线：崩溃/重启后回收过期 running→pending，再排程消费 ──
  // DSH 在提炼中崩溃/重启后，表里遗留的过期 `running` 作业必须被回收为 `pending`
  // 并由 drain 消费，否则 `claimStage1Job`（只挑 pending）永远不会领到它们 → 丢任务。
  // 因此 apply() 启动路径：①一次性压平迁移旧 .stage1-state.json（仅当表为空）→
  // ②recover（回收过期 running→pending）→ ③排程一次 drain + 定时唤醒到最早到期。
  // best-effort：fs/io 失败不阻塞插件启动。
  const readLegacyStage1State = () => {
    try {
      const p = JSON.parse(readText(oldStage1StatePath()))
      return p && typeof p === 'object' ? p : {}
    } catch {
      return {}
    }
  }
  const migrateStage1FromFile = async () => {
    try {
      if (!fs.existsSync(oldStage1StatePath())) return 0
      // 只在表为空时做一次性压平迁移（P1-3 迁移窗口）；表已有数据则跳过。
      // P0-3 半迁移缺口修复：跳过也要把旧文件归档为 .bak-legacy-<ts>（不再依赖），
      // 避免下次启动又见「表非空」再跳过、旧文件一直悬空误导；归档只读供审计/回退。
      if (stage1JobsTable.size > 0) {
        const archiveSkipped = oldStage1StatePath() + '.bak-legacy-' + Date.now()
        try { fs.renameSync(oldStage1StatePath(), archiveSkipped) } catch (e2) {
          try { console.error('[dsh-memory_rollout] stage-1 migration: table non-empty, could not archive legacy file (best-effort):', e2) } catch {}
        }
        try { console.error(`[dsh-memory_rollout] stage-1 migration: skipped (stage1_jobs already non-empty), archived legacy file -> ${archiveSkipped}`) } catch {}
        return 0
      }
      const legacy = readLegacyStage1State()
      let n = 0
      await withWrite(async () => {
        for (const [k, job] of Object.entries(legacy.jobs || {})) {
          if (!job || stage1JobsTable.get(k)) continue
          await stage1JobsTable.put(k, job)
          n++
        }
        for (const [k, out] of Object.entries(legacy.outputs || {})) {
          if (!out || stage1OutputsTable.get(k)) continue
          await stage1OutputsTable.put(k, out)
        }
        if (legacy.global && typeof legacy.global === 'object') {
          await writeStage1Meta(legacy.global)
        }
      })
      // 只读归档旧文件（不再依赖），保留 .bak 供审计/回退。
      const archive = oldStage1StatePath() + '.bak-s1table-' + Date.now()
      fs.renameSync(oldStage1StatePath(), archive)
      try { console.error(`[dsh-memory_rollout] stage-1 migration: moved legacy state to the storage-domain tables (${n} jobs), archived old file -> ${archive}`) } catch {}
      return n
    } catch (err) {
      try { console.error('[dsh-memory_rollout] stage-1 migration error:', err) } catch {}
      return 0
    }
  }
  // ── P1-3 / R7：归档旧 .pipeline-state.json（退役旧管线）──────────────────
  // 新队列不再读取逐会话活动水位；旧文件只归档，不把无消费者的数据迁入 stage1_meta。
  const legacyPipelineStatePath = () => path.join(memoryRoot(), '.pipeline-state.json')
  const archiveLegacyPipelineState = () => {
    try {
      if (!fs.existsSync(legacyPipelineStatePath())) return 0
      const archive = legacyPipelineStatePath() + '.bak-pstate-' + Date.now()
      fs.renameSync(legacyPipelineStatePath(), archive)
      try { console.error(`[dsh-memory_rollout] pipeline-state migration: archived retired state -> ${archive}`) } catch {}
      return 1
    } catch (err) {
      try { console.error('[dsh-memory_rollout] pipeline-state migration error:', err) } catch {}
      return 0
    }
  }
  try {
    archiveLegacyPipelineState()
  } catch (err) {
    try { console.error('[dsh-memory_rollout] startup pipeline-state migration error:', err) } catch {}
  }
  try {
    await migrateStage1FromFile()
  } catch (err) {
    try { console.error('[dsh-memory_rollout] startup stage-1 migration error:', err) } catch {}
  }
  try {
    await recoverStage1Jobs(Date.now())
  } catch (err) {
    try { console.error('[dsh-memory_rollout] startup stage-1 recover error:', err) } catch {}
  }
  // GPT P1-1：启动修复 forget/supersede 的 entry↔change 半提交（幂等）。
  try {
    await reconcileChangeOutbox()
  } catch (err) {
    try { console.error('[dsh-memory_rollout] startup change-outbox reconcile error:', err) } catch {}
  }
  // t189（②）**启动顺序对齐 codex**（镜像 `codex-rs/memories/write/src/start.rs` L59-92）：
  //   **先做不耗额度的 prune/清理**（本块上方已依次完成：①遗留状态归档 ②stage-1 迁移 ③过期租约回收
  //   ④change-outbox 半提交修复），**再**进两道门 —— 门一（来源上限）在本趟 drain 内生效，
  //   门二（额度门）在 phase2Integrate 入口生效。顺序改动只影响"什么时候判要不要开工"，不改数据语义。
  // §3/§5：定时唤醒到最早到期（到期的 retry_wait / pending / running 租约），时间驱动。
  const wakeAt = nextStage1WakeAt(Date.now())
  if (wakeAt != null) scheduleStage1Wake(wakeAt)
  // t189（②·门槛一）：把"本次启动最多处理 N 个来源"绑在启动这一趟 drain 上。
  //   t191（t190 发现②，选 A）：预算改为**可继承对象** ⇒ busy-rerun 补跑趟吃同一额度，不再是"只影响这一趟"。
  scheduleStage1Drain({ remaining: Math.max(1, Math.floor(Number(config.maxSourcesPerStartup) || DEFAULT_MAX_SOURCES_PER_STARTUP)) })
  // Phase 2 也是时间驱动：无新输出也按退避自动重试（§3 / P0-6 的第 5 点）。
  armPhase2Wake()
  // GPT P0-4：启动即修复 Phase 2 孤儿绑定（指向不存在/终态失败批次的 input/change）。
  try {
    await reconcilePhase2Bindings(Date.now())
  } catch (err) {
    try { console.error('[dsh-memory_rollout] startup phase-2 binding reconcile error:', err) } catch {}
  }
  // GPT P0-2：启动时若存在「未冻结成批次」的 pending changes/outputs（或已到期 phase2 批），
  // 立即请求一次 Phase 2 整合（否则 nextPhase2WakeAt 只扫 phase2_jobs、忽略未绑定变更，会永久搁置）。
  try {
    if (hasPendingPhase2Work()) requestPhase2Integrate()
  } catch (err) {
    try { console.error('[dsh-memory_rollout] startup phase-2 request error:', err) } catch {}
  }

  // ── Phase 2: auto-trigger event listeners (cordis ctx.on) ─────────────────
  // Reference pattern: dsh-pet subscribes to `session/disposed` + `session/event`
  // via cordis ctx.on. We do the same, but the handlers are SHORT: they snapshot
  // + enqueue into the persistent queue (no full pipeline run, no cross-fiber
  // work) and schedule the async drain via setImmediate. 旧 kickPipeline 已退役。
  // All disposers are collected and torn down through ctx.effect.
  const eventDisposers = [
    // Main trigger hook: the session is being disposed (ended). 阶段 A · 接线③: the
    // event handler is SHORT — it only enqueues a persistent stage-1 job (event-only,
    // no model call) and schedules drainStage1Jobs via setImmediate. watermark =
    // content fingerprint of the session (dedupe + new-activity signal).
    // M2：唯一公开自动生成开关 generateMemories 控制此入口。
    // M3-阻断修复（方案 A）：水印要用「持久正文」计算，而不是 live session.deriveMessages()。
    //   因为 live deriveMessages() 在 dispose 时可能为空（插件注释已承认），若用空正文作水印，
    //   「同一 session 恢复后新增内容」会得到与上次相同的空水印，入队命中旧 job/seen 被当作重复事件，
    //   导致持久日志中的新增决定不再被提炼（灾难性漏记）。因此 dispose 后通过现有 persistence
    //   helper 取得规范 messages，经同一个 source-aware serializer 得到 raw 再算水印；
    //   仍不在事件路径运行模型或 Phase 2。若持久读取不可用（null），回退到 live raw 以保证入队不丢。
    ctx.on('session/disposed', async (session) => {
      if (config.generateMemories === false) return
      const sid = session && session.id ? String(session.id) : ''
      if (sid) {
        try {
          let raw = ''
          let lineageHeader = session && session.header ? session.header : null
          try {
            const persisted = await sessionMessagesByPersistence(sid)
            if (persisted && persisted.header) lineageHeader = persisted.header
            if (persisted && Array.isArray(persisted.messages)) {
              raw = messagesToDraftBody(persisted.messages)
            }
          } catch { /* 持久读取失败则回退 live */ }
          // t189（②）对齐 codex「**只对根会话生成**」（镜像 `start.rs` L33-38：临时会话 / 特性关闭 /
          //   `source.is_non_root_agent()` 一律不跑记忆管道）：确定性非根会话（`parentSession` /
          //   `origin==='subagent'` / `delegationDepth>0`）**不作为提炼来源**，连入队都不做。
          //   血缘未知 ⇒ 视为根会话（保守）：读不到血缘就停掉记忆生成，代价大于收益 —— 如实登记。
          if (!isRootSessionHeader(lineageHeader)) {
            try {
              console.info(`[dsh-memory_rollout] skip non-root session ${sid}: only root sessions generate memories (codex parity)`)
            } catch {}
            return
          }
          if (!raw) {
            const msgs = session && typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
            raw = messagesToDraftBody(msgs)
          }
          // §4 事件只入队（不跑模型）：表驱动 + 锁忙有限重试，绝不静默丢。
          const enq = await enqueueStage1JobIntoTable(sid, contentWatermark(raw))
          if (!enq.queued && enq.error) {
            try { console.error('[dsh-memory_rollout] session/disposed enqueue returned unqueued:', enq.error) } catch {}
          }
        } catch (err) {
          try { console.error('[dsh-memory_rollout] session/disposed enqueue error:', err) } catch {}
        }
      }
      // 阶段 A · 接线③：disposer 彻底只入队（事件回调短小，不跑模型），随后 scheduleStage1Drain
      // 消费到期 pending 作业（领取→锁外提炼→提交）。不再直接 kickPipeline('sessionEnd', session)。
      scheduleStage1Drain()
    }),
    // M2：compaction/start 是「活跃会话」的上下文压缩事件，不是会话结束/闲置边界，
    // 因此**退役为自动持久记忆入口**（不再在 compaction/start 时自动入队）。这满足
    // 「活跃会话不持久」。显式 memory_precompact 工具仍可用（用户主动 checkpoint）。
    // 旧配置 precompactAuto 仅作兼容保留（不再驱动自动 Phase 1）。
    ctx.on('session/event', async (session, event) => {
      // 无操作保留：本插件不再监听 compaction/start 自动入队。仅防御性读取事件类型，
      // 避免空监听；真正需要的自动入队只发生在 session/disposed。
    }),
  ]
  ctx.effect(
    () => () => {
      for (const dispose of eventDisposers) dispose()
      if (stage1WakeTimer) clearTimeout(stage1WakeTimer)
      if (phase2WakeTimer) clearTimeout(phase2WakeTimer)
      stage1WakeTimer = null
      phase2WakeTimer = null
    },
    'dsh-memory_rollout.eventsDispose',
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
      path: '/dsh-memory_rollout/entries',
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
              // 与 memory_forget 一致：墓碑（status='forgotten'）而非物理删除。
              sendJson(res, 200, { deleted: id ? await withWrite(() => forgetRecord(id)) : false })
              return
            }
            if (payload.action === 'add') {
              const text = typeof payload.content === 'string' ? payload.content.trim() : ''
              if (!text) {
                sendJson(res, 400, { added: false, error: 'content required' })
                return
              }
              const id = makeId()
              await withWrite(async () => {
                await table.put(id, {
                  content: redactSecrets(text),
                  tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
                  createdAt: nowIso(),
                  updatedAt: nowIso(),
                  source: 'ui',
                  ...(typeof payload.sessionId === 'string' && payload.sessionId
                    ? { sessionId: payload.sessionId }
                    : {}),
                })
                // R5：UI 加条目也入统一变更流（与 memory_remember 一致），供 Phase2 整合。
                await writeChangeRecord('remember', {
                  content: redactSecrets(text),
                  tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
                  entryId: id,
                  merged: false,
                  source: 'ui',
                })
              })
              // P0-R2-1：不再在此单独请求 Phase2 —— writeChangeRecord 已统一唤醒（单一边界）。
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

    // ── M3：状态汇总（管理页「至少回答」的 6 项）─────────────────────────────
    // ① 记忆是否启用 useMemories ② 生成是否启用 generateMemories
    // ③ 最近成功/失败（stage1_jobs / phase2_jobs 状态 + 最近时间）④ 使用模型
    // ⑤ 来源（当前版本 + entries 数 + 来源分布）⑥ 当前版本。
    // 只读、不锁；遍历阶段表统计（规模小，每次 overview 成本可忽略）。
    function statusView() {
      const cur = resolveCurrentFiles()
      const meta = readStage1Meta()
      const stage1 = {}
      const phase2 = {}
      const provenance = {}
      const noOutputReasons = {}
      for (const [k, v] of stage1JobsTable.entries()) {
        const s = String(v.status || '')
        stage1[s] = (stage1[s] || 0) + 1
        // P0 source-missing / no-output 原因枚举聚合：empty_source / short_content /
        // model_empty / external_context / source_unavailable（经 last_skip_reason / last_error）。
        const r = String(v.last_skip_reason || '')
        if (r) noOutputReasons[r] = (noOutputReasons[r] || 0) + 1
        if (v.status === 'failed_retryable' || v.status === 'failed_terminal') {
          const le = String(v.last_error || '')
          if (/source unavailable/.test(le)) noOutputReasons.source_unavailable = (noOutputReasons.source_unavailable || 0) + 1
        }
      }
      for (const [k, v] of phase2JobsTable.entries()) {
        const s = String(v.status || '')
        phase2[s] = (phase2[s] || 0) + 1
      }
      for (const e of allEntries()) {
        const src = String(e.source || 'tool')
        provenance[src] = (provenance[src] || 0) + 1
      }
      const entries = allEntries()
      const activeEntries = entries.filter((e) => e.status === 'active' || !e.status).length
      const forgotten = entries.filter((e) => e.status === 'forgotten').length
      const superseded = entries.filter((e) => e.status === 'superseded').length
      const lastJob = [...stage1JobsTable.entries()]
        .map(([k, v]) => ({ status: v.status, at: v.completed_at || v.updated_at || v.created_at }))
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0]
      return {
        memoriesEnabled: !!config.useMemories,
        generationEnabled: !!config.generateMemories,
        // P0-R2-3：能力暴露 —— Stage 1 自动生成读取会话是否可用。缺 sessionQuery → false，
        // 提示部署缺陷（而非会话真的空）。
        capabilities: {
          stage1SourceRead: !!hasSessionQuery,
        },
        version: cur.versionId || '',
        model: {
          // 实际生效：config 覆盖优先，否则 harness 默认（agentDefaultModel）。
          extractProvider: (config.extractProvider && config.extractProvider.trim()) || '',
          extractModel: (config.extractModel && config.extractModel.trim()) || '',
          consolidationProvider: (config.consolidationProvider && config.consolidationProvider.trim()) || '',
          consolidationModel: (config.consolidationModel && config.consolidationModel.trim()) || '',
        },
        recent: {
          lastStage1Status: lastJob ? lastJob.status : '',
          lastStage1At: lastJob ? lastJob.at : '',
          lastSuccessWatermark: meta.lastSuccessWatermark || '',
          phase2LastError: meta.phase2_last_error || '',
          modelAttemptsToday: meta.modelAttemptsToday || 0,
        },
        counts: {
          entries: entries.length,
          activeEntries,
          forgotten,
          superseded,
          stage1Jobs: Object.values(stage1).reduce((a, b) => a + b, 0),
          phase2Jobs: Object.values(phase2).reduce((a, b) => a + b, 0),
        },
        stage1Status: stage1,
        phase2Status: phase2,
        provenance,
        noOutputReasons,
      }
    }

    const overviewRoute = {
      kind: 'exact',
      path: '/dsh-memory_rollout/overview',
      handler: async (req, res) => {
        try {
          const d = dirs()
          const summary = readMemorySummary()
          const registry = readText(resolveCurrentFiles().registryPath)
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
            status: statusView(),
          })
        } catch (err) {
          sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    }

    // ── /dsh-memory_rollout/config — read + update the plugin config at runtime ─────
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
      path: '/dsh-memory_rollout/config',
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

    // ── /dsh-memory_rollout/export — package the whole memories/ tree for backup ────
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
        format: 'dsh-memory_rollout-memory-backup',
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
      path: '/dsh-memory_rollout/export',
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
          res.setHeader('Content-Disposition', `attachment; filename="dsh-memory_rollout-memories-${stamp}.json"`)
          res.end(body)
        } catch (err) {
          sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    }

    // ── /dsh-memory_rollout/import — restore a backup (back up existing first) ──────
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
        conflictMessage: '[dsh-memory_rollout] another import is already in progress — retry shortly',
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
      if (!bundle || typeof bundle !== 'object' || bundle.format !== 'dsh-memory_rollout-memory-backup') {
        throw new Error('invalid bundle: not a dsh-memory_rollout memory export')
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
          // R5：导入变更入统一变更流（可重放 + 供 Phase2 把导入内容整合进权威版本）。
          await writeChangeRecord('import', {
            note: 'imported dsh-memory_rollout memory bundle',
            entryCount: validatedEntries.length,
            fileCount: fileEntries.length,
          }, { priority: 80 })
        } catch (err) {
          try {
            await restoreBackup()
          } catch (rollbackErr) {
            try {
              console.error('[dsh-memory_rollout] import rollback failed:', rollbackErr)
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
            const f = new Error('[dsh-memory_rollout] ' + manual)
            f.rollbackFailed = true
            f.backupPath = backupDir
            f.rollbackError = rollbackErr
            throw f
          }
          // Rollback succeeded: the pre-import state was restored. Surface it as a
          // retryable failure WITHOUT implying the original state was lost.
          const retryable = new Error(
            '[dsh-memory_rollout] import failed, but the previous memory was restored (nothing lost; you can retry). ' +
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
      path: '/dsh-memory_rollout/import',
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
    }, 'dsh-memory_rollout.routeDispose')
  }
}
