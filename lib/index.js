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

// ─────────────────────────────────────────────────────────────────────────────
// t219（R2 §3 / §9-B）：**联合数据契约 —— 三层必须分开**
//   R2 原话：「只修 §3 的四处关键语义……不要再复制更多名为「照 Codex」的函数」。
//   ① **作业队列层（调度）**：哪件工作现在能运行、是否已处理 —— 重试/退避/租约/批次/消费进度。
//      本层字段（本地规则，**不是** Codex 的记忆选择规则）：`available_at`、`attempt_count`/`max_attempts`、
//      「未消费优先、按表顺序取 20」、`phase2_batch_id` / `selected_for_phase2`。
//      ⇒ 修订稿 R1 §5.4 曾把这一组误称「固定基准」，**该说法已作废**（更正见 t219 报告 §2）。
//   ② **当前记忆选择集合层（语义）**：哪些来源快照目前应支持自动记忆 —— 稳定来源身份（`session_id`）、
//      源版本（`source_watermark` / 内容指纹）、使用记录（`usage_count` / `last_usage`）、
//      时间窗（`maxUnusedDays`）、数量限制（codex 的 top-N）。
//      ⇒ **`job_id` 只服务调度，不是逻辑来源身份**（源码里 `job_id` / `session_id` / `source_watermark`
//      是三个不同的东西；见 report §3 的 B@1→B@2 示例）。
//   ③ **查询结果层**：本次问题最相关的内容是什么 —— 查询相关性、作用域、资格、证据（citation）。
//   **判断（R2 同判）**：把同一算法放错层，比缺一个参数更严重。新增能力前先问「它属于哪一层」，
//   再决定它能不能读另一层的计数器/字段；**不再新增"名为照 Codex、实则搬错层"的函数**。
//   **未启用的目标能力（本批不实现）**：文件层退出（来源退出后清理失去支持的派生内容）。
//   用户已决定暂缓 ⇒ 明确标为未启用；**不得**把"只做 entries 层的版本"宣称为原生全生命周期完成。
// ─────────────────────────────────────────────────────────────────────────────

// Required services this plugin uses via direct props (ctx.tools / ctx.systemPrompt).
// webServer is read lazily with ctx.get('webServer') so it needs no inject entry.
// P0-R2-3：`sessionQuery` 是 Stage 1 自动生成读取会话的唯一来源，声明为必需服务——
// 缺失时插件无法加载/自动生成（启动即明确失败/禁用生成），绝不再把「能力缺失」伪装成
// empty_source 静默成功；overview 的 capabilities 亦显示该能力是否可用。
export const inject = ['storageDomain', 'tools', 'systemPrompt', 'sessionQuery']

/**
 * T29：静置扫描窗口默认值（对齐 codex，见 `codex-rs/config/src/types.rs` L51-52：
 * `DEFAULT_MEMORIES_MIN_ROLLOUT_IDLE_HOURS = 6`、`DEFAULT_MEMORIES_MAX_ROLLOUT_AGE_DAYS = 10`）。
 * 定义在 `Config` **之前**（schema 默认值在模块求值时即被读取，放后面会 TDZ）。
 */
export const DEFAULT_MIN_ROLLOUT_IDLE_HOURS = 6
export const DEFAULT_MAX_ROLLOUT_AGE_DAYS = 10
/** T29：`memory_ingest_session` / 按钮等待 stage1 草稿落盘的默认上限（10 分钟）。 */
export const DEFAULT_INGEST_AWAIT_DRAFT_MS = 600000

// ── t252（T35）：**承载取值常量**（必须在 `Config` 之前 —— zod schema 在模块求值期就要用它们，
//   放后面会 TDZ；与上面几个 DEFAULT_* 同类）。──────────────────────────────────────────────
/** 后台承载（默认）：插件进程内用宿主已有 `ctx.llm` 单次调用产出候选，**不建任何会话**。 */
export const CONSOLIDATION_CARRIER_PLUGIN = 'plugin-background'
/** 受限会话承载（**显式实验/诊断**）：保留可用；失败仍**显式回落**到后台并把真实路径记进批记录。 */
export const CONSOLIDATION_CARRIER_RESTRICTED = 'restricted-session-experiment'
// t254（T36 · F3）：**实验载体不是安全回退** —— 它带 D-7 残余面（工作区指令注入 + 内建工具面），
//   故一旦跑在实验载体上就**显式告警**（日志 + 批次字段 `executor_carrier_note`）。
//   本轮**不改用户配置、不加设置界面**：旧安装若写过 `consolidationExecutor: true`，会**留在实验载体**，
//   应在配置里显式改成 `'plugin-background'`；CHANGELOG 与方案文档同步写明。
export const CARRIER_EXPERIMENT_WARNING = 'experimental-carrier-not-a-safe-fallback (D-7 residual: workspace-instruction injection + built-in tool surface; set consolidationExecutor: "plugin-background")'

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
  // These tune the `session/disposed` auto-trigger pipeline.（C4：原先并列的 `session/event` **空监听已删**。）
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
  maxExtractTokens: z.number().step(500).min(500).max(200000).default(200000),
  /** Provider route for the Phase 2 consolidation (cross-session integrate) LLM; empty = harness default (agentDefaultModel). */
  consolidationProvider: z.string().default(''),
  /** Provider model id for the Phase 2 consolidation LLM; empty = harness default model. */
  consolidationModel: z.string().default(''),
  /** Reasoning effort for the consolidation LLM (adapter vocab, e.g. off/low/high/max); empty = model default. */
  consolidationReasoningEffort: z.string().default(''),
  /** t164（R1 §6.2）：**可选诊断**开关，默认关。开 = 每批额外跑「疑似丢旧结论」启发式检查（仅提示、不阻断、不持久化）；关 = 完全不跑。 */
  phase2Diagnostics: z.boolean().default(false),
  /**
   * t187 → **t252（T35）**：**承载开关**（默认 `'plugin-background'`）。
   *   · `'plugin-background'`（默认）= 插件进程内用宿主已有 `ctx.llm` **单次调用**产出候选：**不建会话**
   *     ⇒ 不继承普通聊天预设、不产生会话残留、不产生自我摄取面；
   *   · `'restricted-session-experiment'` = 保留的**实验/诊断**路径（插件自建受限会话 + 限制 + 沙箱 + 审批；
   *     失败仍**显式回落后台**并把真实路径记进批记录）。
   *   · **向后兼容旧布尔**：`true` ⇒ 受限会话实验（旧"开"就是"试受限执行者"）；`false` ⇒ 后台（旧"关"
   *     就是"跳过执行者、走进程内"）。归一化见 `consolidationCarrier()`。
   */
  consolidationExecutor: z
    .union([z.boolean(), z.const(CONSOLIDATION_CARRIER_PLUGIN), z.const(CONSOLIDATION_CARRIER_RESTRICTED)])
    .default(CONSOLIDATION_CARRIER_PLUGIN),
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
  /**
   * T29（A 静置扫描）：**静置窗口（小时）** —— 会话日志**最后一次写入**距今超过这么多小时，
   * 才纳入自动摄入（对齐 codex `min_rollout_idle_hours`，默认 6；codex 文档建议 `> 12h`）。
   * 值越大 = 越晚进记忆（延迟大、但更少"边跑边提炼"）；值越小 = 越快进记忆（可能切到仍在写的会话）。
   */
  minRolloutIdleHours: z.number().step(1).min(1).max(720).default(DEFAULT_MIN_ROLLOUT_IDLE_HOURS),
  /**
   * T29（A 静置扫描）：**年龄窗口（天）** —— 静置更久的会话**不再**自动纳入（对齐 codex
   * `max_rollout_age_days`，默认 10）。
   */
  maxRolloutAgeDays: z.number().step(1).min(1).max(3650).default(DEFAULT_MAX_ROLLOUT_AGE_DAYS),
  /**
   * T31（执行者装配）：受限执行者会话挂哪个 **agent preset**。留空 = 走 `agentPresets.resolve(undefined)`
   * （= 部署默认预设，与宿主正规建会话路径同款）；填了则显式点名。
   * 为什么要挂：不挂 preset 时执行者的系统提示/工具面不完整；宿主正规路径 `composeAgent` 一定会挂。
   */
  executorAgentPreset: z.string().default(''),
  /**
   * T31（不再产生会话残留）→ 本批（C2）**保留读取兼容，行为已撤**：失败的**空壳**执行者会话
   * （零会话事件 + 我们的 id + 已 stop）旧行为是"顺手清掉"（调宿主的会话删除工具）。用户裁定
   * 「删除＝可选项」⇒ 插件侧不再驱动删除，该键**不再决定任何删除动作**，只作旧配置兼容读取；
   * 它**也**不是"是否停止任务"的开关（停止路径见 `stopConsolidationExecutor`，不受此键影响）。
   */
  executorEmptySessionCleanup: z.boolean().default(true),
})

// ── Settings-page config form (single source of truth for the client form) ──
// Each editable config field described for the settings page. The client renders
// this list generically (select / number / toggle / text); the host uses it to
// validate + persist runtime config updates. Fields NOT listed here (memoryRoot)
// are intentionally read-only.
// T29：**导出**它，供测试断言"新增配置键在 GUI/覆盖层可写"（`OVERLAYABLE_KEYS` 由本清单派生）。
export const CONFIG_FIELDS = [
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
  { key: 'maxExtractTokens', label: '提取输入 token 上限（maxExtractTokens）', type: 'number', hint: '传给 LLM 提炼的最大输入 token；超长会话仍会先截断（保留开头与结尾，中段省略并留标记）。默认 200000（约 800000 字符上限），越大越贵。' },
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
    label: '整合承载（consolidationExecutor）',
    type: 'select',
    options: ['plugin-background', 'restricted-session-experiment'],
    hint: 'v0.1.26（T35）：**默认 plugin-background** —— 插件进程内用宿主已有模型服务**单次调用**产出候选，**不建任何会话**（因此不继承普通聊天预设、不产生会话残留、不产生"执行者会话被当来源"的面）。`restricted-session-experiment` 是保留的**实验/诊断**路径（插件自建受限会话 + 工具限制 + 沙箱 + 审批；失败仍显式回落后台并把真实路径记进批记录）。旧布尔值兼容：true=受限会话实验，false=后台。回退＝改回本开关。',
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
  {
    key: 'minRolloutIdleHours',
    label: '静置摄取窗口（minRolloutIdleHours，小时）',
    type: 'number',
    hint: 'T29：会话日志**最后一次写入**距今超过这么多小时，才纳入自动摄取（静置扫描，对齐 codex `min_rollout_idle_hours`）。默认 **6**、范围 1–720；值越大 = 进记忆越晚（延迟大、更少"边跑边提炼"），越小 = 越快（可能切到仍在写的会话）。经本页保存即时生效；手改覆盖文件则需重启。',
  },
  {
    key: 'maxRolloutAgeDays',
    label: '摄取年龄窗口（maxRolloutAgeDays，天）',
    type: 'number',
    hint: 'T29：静置更久的会话**不再**自动纳入摄取（对齐 codex `max_rollout_age_days`）。默认 **10**、范围 1–3650。与静置窗口同处、同一机制。',
  },
  {
    key: 'executorAgentPreset',
    label: '执行者预设（executorAgentPreset）',
    type: 'text',
    hint: 'v0.1.23：受限执行者会话挂哪个 agent preset。**留空 = 部署默认预设**（走宿主 `agentPresets.resolve(undefined)`，与正规建会话路径同款）。挂预设才能让执行者的系统提示/工具面完整；不挂是 v0.1.22 那次"受限轮次不出事件"的原因之一。',
  },
  {
    key: 'executorEmptySessionCleanup',
    label: '清理空的执行者会话（executorEmptySessionCleanup）',
    type: 'toggle',
    hint: 'v0.1.23：失败的**空壳**执行者会话（我们自己的 id + 零会话事件 + 已停止）旧行为是顺手清掉。**本批（C2）已撤掉插件侧驱动删除**（用户裁定「删除＝可选项」）⇒ 该键不再触发任何删除，只作旧配置兼容保留；它也不是"是否停止任务"的开关（停止走 `stopConsolidationExecutor`，与该键无关）。',
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
  // t206（S1）+ t208：旧版遗痕字段 `last_used_at` **必须在这里声明**才可能被读到 —— 宿主存储域载入
  //   记录时走 `valueSchema.parse(raw)`（zod 对象默认 **strip 未声明键**）⇒ 只要它不在 schema 里，
  //   该字段就到不了插件，`lastUsageOf`（t198 的 F1）在生产路径**永远收不到它** = 空转。
  //   **读兼容旧字段、写入仍只写 `last_usage`**：唯一会被写回的场合是 `scheduleUsageBump` 的
  //   `{ ...cur }` 展开（把**已存在**的旧值原样带回、不新写不更新）。
  //   t208（`.default('')` → **`.optional()`**）：原始记录里**没有**该键时，写回序列化**不会新增**
  //   `"last_used_at": ""` ⇒ 磁盘上「从未有该字段」与「有字段但空」的区别被保住（t207 独立验证实测过：
  //   写回不含该键、真实旧值仍读得回、投影 `String(x || '')` 仍得空串）。
  last_used_at: zod.string().optional(),
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
  // F1（2026-10-01）：显式入口入队的作业标记（消费阶段"正文已变"时自动作废、显式即时）。
  explicit: zod.boolean().default(false),
  // F1：`source_watermark` 的来源种类（见 drain 侧身份复核的注释块）。
  source_watermark_kind: zod.string().default(''),
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
/** 最小工具集**意图**：只留"读写记忆根"所需的文件类工具（不含 shell / 网络 / 委派 / 会话类工具）。
 *  **t230 重要更正**：这些是 DSH 的**内建**工具名，**不属于** `tools.restrict()` 能约束的
 *  `restrictableNames`（后者只含**插件注册的全局工具**）⇒ 本数组**只作能力意图声明**，
 *  **不再**当成 `restrict({allow})` 的入参（t229 真机报错即由此而来）。 */
export const CONSOLIDATION_TOOL_ALLOW = ['read', 'write', 'edit', 'glob', 'grep']
/** 显式拒绝**意图**：整合执行体不得再派子代理（禁递归委派）。
 *  **t230**：`subagent` 也**不在**可 restrict 的全局名单里（见 `restrictableGlobalTools`）⇒ 实际生效的
 *  deny 由**宿主注册表派生**（并把"想要但不在名单里"的名字**显式上报**，见 `unknownDesired`）。 */
export const CONSOLIDATION_TOOL_DENY = ['subagent']

/**
 * t230：**从宿主真实注册表派生「可限制的全局工具名」**（不再硬编码一套名字）。
 *
 * 契约（**实际加载副本**：`…\.pnpm\@deepseek-ai+dsh-tools@0.1._3c09556…\…\dsh-tools\lib\index.js`
 * = SHA256 `AABA52BF5D0149355407642B3965C06977D1E9143F5C61BC19429ABBE6A11C5D` / 151,784 B）：
 *   · `restrict(filter)` **L2790-2805**：只接受 `this.view(scope).restrictableNames` 里的名字，否则抛
 *     `tools.restrict() names unknown global tool(s) …; known global tools: …`（**抛点在 append 之前** ⇒ 探测无副作用）；
 *   · `view(scope)` **L2854-2880**：`restrictableNames` = **插件注册进各层的全局工具**（scope 自有工具只进
 *     `knownNames`、**不进** `restrictableNames`）；**内建文件工具 read/write/edit/glob/grep 根本不在其中**
 *     ⇒ 它们**无法**用 allow/deny 表达（t229 真机 blocker 的根因）；`run_code` 为保留名（L2800，禁列）。
 *   · `restrict()` 的 scope 由 `scopeOf(this.ctx)` **内部**决定（L2791），不是入参 —— 见下面 ② 权威路径。
 *
 * **t241（评审 R3 修复）**：唯一稳定的 scope 来源是**宿主自己的校验错误**（② 权威路径）。`setup(childCtx)`
 * 给的是上下文而非 Agent，`view(scope)` 需要的是**作用域键**（Agent 对象），二者不可互换（`scopeChainOf`
 * 按作用域键查表，传上下文只会退化成空链 ⇒ 得到"全局视图子集"）。故：① 只在调用方显式给出 scope 时使用，
 * 且必须与 ② 的权威集**完全一致**才采信，否则一律以 ② 为准。
 *
 * @returns `{ names, source, unknownDesired, note }`；`names` 为**从宿主派生**的可限制名单（已剔除保留名），
 *   `unknownDesired` = 我们**想要**约束、但宿主名单里没有的名字（**显式上报，不静默**）。
 */
export function restrictableGlobalTools(tools, scope) {
  const out = { names: [], source: '', unknownDesired: [], note: '' }
  const wanted = [...CONSOLIDATION_TOOL_ALLOW, ...CONSOLIDATION_TOOL_DENY]
  /** 剔除保留名（宿主 L2800 明文禁列）并按宿主口径排序。 */
  const norm = (names) => [...names].map(String).filter((n) => n && n !== 'run_code').sort()
  // ① 视图路径：**用作交叉核对**。`scope` 由调用方显式给出时按该作用域取；真机路径（`setup(childCtx)`）
  //    拿不到作用域键，只能退化成 `view(undefined)` = 全局层子集（`chainLayers(undefined)` 为空链）。
  //    故这里得到的集合**只用于核对**，绝不单独当权威集（见 ② 之后的取用规则）。
  let viewNames = []
  try {
    const v = typeof tools?.view === 'function' ? tools.view(scope) : undefined
    const set = v && v.restrictableNames
    if (set && typeof set[Symbol.iterator] === 'function') viewNames = norm(set)
  } catch { /* 视图取不到就只靠权威探测 */ }
  // ② **权威路径**：一次**注定失败**的探测，让宿主把 `view(scopeOf(tools.ctx)).restrictableNames`
  //    逐字回吐 —— 那正是 `restrict()` 稍后用来校验名字的**同一个集合**（它由 tools 服务自己的
  //    调用上下文决定，**不需要**外部 scope）。抛点在 `layers.effect(…append…)` 之前 ⇒ 探测无副作用。
  let probeNames = []
  try {
    if (typeof tools?.restrict === 'function') tools.restrict({ deny: ['\u0000__probe__'] })
  } catch (err) {
    const m = String((err && err.message) || '').match(/known global tools:\s*([\s\S]+)$/)
    if (m) probeNames = norm(m[1].split(',').map((s) => s.trim()).filter((n) => n && n !== '(none)'))
  }
  if (probeNames.length) {
    // 名字一律取**权威集**（可能比视图集大）：少 deny 一个就漏一个工具，宁可多 deny。
    out.names = probeNames
    out.source = 'restrict-error-known-list'
    // 视图集与权威集**完全一致**时记为视图来源（等价集合，来源可辨即可）。
    if (viewNames.length === probeNames.length && viewNames.every((n) => probeNames.includes(n))) {
      out.source = 'view.restrictableNames'
    }
  } else if (viewNames.length) {
    // 拿不到权威集时，**不**用未获确认的视图子集去 deny（可能是"全局视图子集" ⇒ 会漏 deny 却
    // 自称已限制）。显式标为不可用 ⇒ 外层按「限制未建立」回落，绝不假装 restricted=true。
    out.note = 'view-set-not-authoritative'
  } else {
    out.note = 'restrictable-name-set-unavailable'
  }
  out.unknownDesired = wanted.filter((n) => !out.names.includes(n))
  return out
}
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
 * t210：**提炼侧的额度护栏**（本地**补充设计** —— codex 没有「每日模型尝试次数」这一机制，它用 provider
 *   的 rate-limit 窗口；本地的 `maxModelAttemptsPerDay`（默认 24）与 `modelAttemptsToday` 是本地发明的硬约束）。
 *
 * 要修的缺陷（2026-09-14 真机）：本地额度是**单一池**，而**只有提炼会自增**、整合只读它做门（门二：
 *   剩余 < 阈值不启新整合）。此前的停止条件是「用到 cap 为止」⇒ **一趟提炼（如日界唤醒趟）可以把当天
 *   24 次额度全吃光** ⇒ 门二此后永远拦住整合 ⇒ 总纲/注册表停止更新。实测：01:37 时 `modelAttemptsToday=24`、
 *   提炼 +24 条产出、`lastPhase2At` 仍停在 09-13T03:51:30Z、总纲 mtime 仍 09-13 11:51:48。
 *
 * 语义：**存在「未整合的产物/变更」（= 整合有活干）时，提炼必须为整合留出额度** —— 只在「这一发用掉之后，
 *   剩余次数仍 ≥ 整合门（门二）能放行所需的最小整数剩余」时才允许开工。没有未整合产物时不保留（不损失提炼吞吐）。
 *   `reserve = min(ceil(cap × 阈值% / 100), cap − 1)`：
 *     · 与门二**同阈值**推导 ⇒ 「提炼因护栏停下」时门二必然放行（整数取整后仍 ≥ 阈值）；
 *     · 上限 `cap − 1` 保证至少给提炼留 1 发（`cap = 1` 时不至于把提炼全关掉；此时护栏退化为"不保留"，与旧行为一致）。
 *   **可调**：调大 `minRemainingQuotaPercent` ⇒ 保留更多给整合；置 0 ⇒ 不保留（等效关闭本护栏）。
 *   纯函数，可单测。
 * @returns `{ allowed, reason, used, cap, thresholdPercent, needForGate, reserve, remainingAfterThisOne }`
 */
export function stage1QuotaPlan({
  attemptsToday = 0,
  maxAttemptsPerDay = 24,
  minRemainingPercent = DEFAULT_MIN_REMAINING_QUOTA_PERCENT,
  hasPendingConsolidation = false,
} = {}) {
  const rawCap = Math.floor(Number(maxAttemptsPerDay))
  const cap = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : 24
  const rawUsed = Math.floor(Number(attemptsToday))
  const used = Number.isFinite(rawUsed) && rawUsed > 0 ? Math.min(rawUsed, cap) : 0
  const rawThreshold = Number(minRemainingPercent)
  const thresholdPercent = Number.isFinite(rawThreshold)
    ? Math.max(0, Math.min(100, rawThreshold))
    : DEFAULT_MIN_REMAINING_QUOTA_PERCENT
  const needForGate = Math.ceil((cap * thresholdPercent) / 100)
  const reserve = hasPendingConsolidation ? Math.min(needForGate, Math.max(0, cap - 1)) : 0
  const remainingAfterThisOne = cap - (used + 1)
  const allowed = used < cap && remainingAfterThisOne >= reserve
  return {
    allowed,
    reason: allowed ? '' : used >= cap ? 'daily-cap-reached' : 'reserved-for-consolidation',
    used,
    cap,
    thresholdPercent,
    needForGate,
    reserve,
    remainingAfterThisOne,
  }
}

/**
 * t219（R2 §7）：**四类额度口径必须分开标注**（本地此前只用一句"当日额度门"把它们混着讲）。
 *   R2 原话：「若共享一个本地总预算，就必须两阶段和回落调用都记账；若本地限额只管提炼，
 *   就不要拿它伪装成服务商额度门来阻止整合。」
 *   ⇒ `sharedAccounting:false` 表示**当前没有**做到"两阶段 + 回落都记账"，因此第一项**不得**被
 *     表述成 provider 额度门；`providerRateLimit` 是**未实现**的目标能力。
 *   纯数据（同一份口径供代码注释 / 测试 / 报告引用），不含行为。
 */
export const QUOTA_SEMANTICS = Object.freeze({
  stage1DailyAttempts: {
    label: '每日 Stage1 尝试上限',
    source: 'config.maxModelAttemptsPerDay（默认 24）+ stage1_meta.modelAttemptsToday',
    debitedBy: ['stage-1 提炼（每发 +1）'],
    enforcedAt: ['stage-1 各趟入口（bootQuotaPlan / stage1QuotaPlan）'],
    isProviderQuota: false,
    note: '本地发明：codex 用 provider 的 rate-limit 窗口，没有"每日模型尝试次数"这一机制。',
  },
  stage1PerPassSources: {
    label: '每趟处理上限',
    source: 'config.maxSourcesPerStartup（经 perPassSourceBudget()）',
    debitedBy: ['stage-1 每趟领取的来源数'],
    enforcedAt: ['启动趟 / 唤醒趟（含日界）/ 事件趟；显式 memory__stage1_drain 不设限'],
    isProviderQuota: false,
    note: '对齐 codex 的 per-pass 语义（镜像 config/src/types.rs L317 + memories/write/src/phase1.rs L140）。',
  },
  phase2CallBudget: {
    // F5 口径修订（评审 §五.3）：键名沿用历史（不做无谓改名），但 **label 必须写准** ——
    //   这一项描述的是「**启动门**」，不是「调用预算」：整合的调用既不入本地计数、也没有独立预算。
    label: 'Phase 2 启动门（不是调用预算）',
    source: '（无独立预算：Phase 2 的调用不进本地计数）',
    debitedBy: [],
    enforcedAt: ['门二只**读** Stage 1 的当日计数器 + 保底阈值，判断"能不能启动一批新的整合"；它自己不记账'],
    isProviderQuota: false,
    note: '两件事必须分开表述：① **依 Stage 1 计数决定能否启动整合**（门二，已实现）；② **实际限制整合调用的次数 / 费用**（本地**未实现**——整合调用不计入 Stage 1 计数，也没有自己的计数，唯一上界是每批 max_attempts 次尝试）。因此"保底额度"只能约束 Stage 1 的开销，**不能**约束整合的实际消耗；也不得把本项表述成 provider 额度门。',
  },
  providerRateLimit: {
    label: '真实 provider 限额',
    source: '（未实现）',
    debitedBy: [],
    enforcedAt: [],
    isProviderQuota: true,
    note: '本地未读取服务商限额窗口；此项属**未启用/未实现**的目标能力。',
  },
  sharedAccounting: false,
})

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

/**
 * **t249（T33-一）·内部执行身份**：内部整合执行者的会话**永不作记忆来源**。
 *
 * 为什么需要它（外部裁决 §九.2 / §4.4）：现有根会话判据（`isRootSessionHeader`）只排
 * `parentSession` / `origin==='subagent'` / 正 `delegationDepth`，**不足以**证明"整合执行者被来源扫描排除"；
 * 真机状态库里已出现 `p2-exec-*::…` 的来源作业与 `last_skip_reason=empty_source` 痕迹 ⇒ 风险从"待验证"
 * 升级为"已知会进来源作业"。因此**新增**一条与来源资格正交的判定，并在**新入队**与**队列中已有作业**
 * 两条路上都查（只堵新入口不够）。
 *
 * 身份判据（**可信创建记录优先，名字前缀只作辅助**）：
 *   ① 我们自己的**创建台账**（`stage1_meta.meta.executorSessions`，见 `recordExecutorSession`）⇒ 可信本地记录；
 *   ② 名字前缀 `p2-exec-` —— **辅助**：我们的执行者 id 由构造保证（`p2-exec-<batchId>-<attemptTag>`），
 *      故它覆盖"台账尚未写入/已丢"与"本改动之前创建的旧执行者会话"两种情况。
 *
 * **t250（T34 真机复核的更正）·为何不把 `delegationDepth>0` 单独当内部身份**：真机实测（2026-09-21
 * 22:02:56 boot 扫描）显示 **77 个普通子代理会话**（UUID id、由 subagent 工具创建、带 `delegationDepth>0`）
 * 被误标成"内部执行者"（`internal=87` 里 77 条出自这个原因）。它们本来就由 `isRootSessionHeader` 按
 * **非根会话**跳过 ⇒ 行为没错，但**计数与理由串是错的**（`internal` 被高估、`scanSeen` 被多写）。
 * 因此 `delegationDepth` 只作为**血缘/兜底非根**依据（`startConsolidationExecutor` 仍写它：宿主校验并
 * 持久化；万一前缀与台账都丢了，仍能靠它按非根挡下），**不再**出现在本函数的身份判据里。
 * @returns `''` = 不是内部执行会话；否则返回非空理由串。
 */
export function internalExecutionReason({ header, sessionId, ledger } = {}) {
  const id = String(sessionId || '')
  // ① 我们自己的创建台账（可信记录）
  if (id && ledger && typeof ledger === 'object' && Object.prototype.hasOwnProperty.call(ledger, id)) return 'internal-executor-ledger'
  // ② 辅助：我们构造的执行者 id 前缀（覆盖旧执行者与台账缺失）
  if (/^p2-exec-/.test(id)) return 'internal-executor-name'
  return ''
}

/** 布尔简写。 */
export function isInternalExecutionSession(args) {
  return internalExecutionReason(args) !== ''
}

/**
 * **t251（T34 实测暴露 D-5）·把「扫描到期」并进唤醒时刻**（纯函数，可单测）。
 *
 * 背景（真机实测）：唤醒计时器有**两个**写者 ——
 *   ① `armStage1Wake()`（启动趟后）：`next = min(队列到期, lastScan + 扫描周期)`；
 *   ② **每趟 drain 收尾**：只按 `nextStage1WakeAt()`（**队列到期**）重排 `scheduleStage1Wake(...)`，
 *      而 `scheduleStage1Wake(null)` 会**清掉计时器**。
 * ⇒ 启动趟之后第一趟 drain（队列空）就把①的"扫描到期"覆盖掉，**安静进程里 A 面周期扫描再也不来**。
 * 真机证据：2026-09-21 22:02:47 重启、boot 扫描在 22:02:56，之后 **40 分钟**无 wake 扫描（`scanLastAt` 未变、
 * 状态库自 22:02:56 起零写入）。修法：两个写者共用本函数（把扫描到期并进 `wakeAt`）。
 * @param opts.wakeAt 队列驱动得到的唤醒时刻（可为 null = 无到期作业）
 * @param opts.scanLastAtIso 上次扫描时刻（ISO 串；空/非法 ⇒ 以 now 起算）
 * @param opts.now 当前时刻（ms）
 * @param opts.intervalMs 扫描周期（ms）
 * @returns 合并后的唤醒时刻（ms）
 */
export function nextWakeAtWithScan({ wakeAt, scanLastAtIso, now, intervalMs } = {}) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const iv = Number(intervalMs) > 0 ? Number(intervalMs) : 30 * 60 * 1000
  const last = Number(new Date(scanLastAtIso || 0).getTime()) || 0
  const scanDue = (last > 0 ? last : nowMs) + iv
  const w = wakeAt == null || !Number.isFinite(Number(wakeAt)) ? null : Number(wakeAt)
  return w == null || scanDue < w ? scanDue : w
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
  // t224（F2）：成功提交时把被清掉的批级 `last_error` 转存到这里 ⇒ 「不再误导」且「不丢历史」。
  last_error_history: zod.string().default(''),
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
  // t213：① 的实质 —— **本次整合实际走的路**（不依赖控制台的可观测项；t211 指出那行 console.info 原文取不到）。
  //   `executor_path` ∈ 'restricted-session' | 'in-process-fallback'；回落时 `executor_reason` 必非空
  //   （**不得静默降级**）。`executor_activity` 是会话活动证据（如 `events=12->19 turns=1`）。
  executor_path: zod.string().default(''),
  executor_session_id: zod.string().default(''),
  executor_restricted: zod.boolean().default(false),
  executor_reason: zod.string().default(''),
  executor_activity: zod.string().default(''),
  executor_source: zod.string().default(''),
  // t220（R2 §8）：执行者的**候选工作区**（写边界所在）+ 越界写证据（非空 ⇒ 整批不发布）。
  executor_cwd: zod.string().default(''),
  executor_boundary_violation: zod.string().default(''),
  // t230：受限名单的**派生证据** —— 想要但宿主名单里没有的名字（如内建 read/write/… 与 subagent）显式落记录。
  executor_restrict_unknown: zod.string().default(''),
  executor_restrict_source: zod.string().default(''),
  // t216（D1）：引用可观测 —— 本批实际用到的引用代号 / 基线里解析不出、被标为未验证的引用名。
  reference_codes: zod.string().default(''),
  unverified_references: zod.string().default(''),
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
 *  - **t216（D1）**：若调用方传入 `opts.references`（`buildReferenceMap()` 的产物），额外启用
 *    **引用链**——映射外（虚构）引用 ⇒ 报错不发布；映射内引用做存在性/允许根/链接绕行/行段核对；
 *    且**正文链**在过秘密规则前把这些可信引用片段占位保护（修好的路径不再被遮回）。
 *    不传 `references` ⇒ 行为与 t216 之前逐字相同（向后兼容旧调用点与既有单测）。
 *  - **F2 返修**：若调用方同时传入 `opts.trustedRendered`（本批**渲染前**已逐条核过版本/证据段、
 *    再由 `renderPhase2References` 产出的可信引用串），则引用链改为**只判"是否由可信渲染产生"**，
 *    **不再**按最新版本重新解析（渲染后文本里已无版本身份）。
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
    // ── t216（D1）：**引用链**（结构判据）与**正文链**（秘密规则）分开，两条互不串用 ──
    //   引用链：只对「精确匹配映射」的引用做 映射/存在性/归属/版本 检查；
    //     映射外（虚构）的引用 ⇒ 直接不发布（R2 §5.3：真实存在不算可信，磁盘上有同名文件也不算）。
    //   正文链：把**已识别且可信、且不在凭据字段里**的引用片段先占位保护，再跑 redactSecrets
    //     —— 修好的路径不会再被同一条长串规则遮掉（R2 §5.2 步 5）。
    const refMap = opts.references && typeof opts.references === 'object' ? opts.references : null
    const trustedRendered = opts.trustedRendered instanceof Set
      ? opts.trustedRendered
      : Array.isArray(opts.trustedRendered) ? new Set(opts.trustedRendered) : null
    if (refMap) {
      for (const k of ['memory_summary', 'registry']) {
        const v = output[k]
        if (typeof v !== 'string' || !v) continue
        const ex = extractReferences(v, refMap)
        for (const u of ex.unmapped) errors.push(`unmapped reference in ${k}: ${u.raw}`)
        const seen = new Set()
        for (const t of ex.tokens) {
          const key = `${t.entry.code}:${t.lineRange ? t.lineRange.start + '-' + t.lineRange.end : ''}`
          if (seen.has(key)) continue
          seen.add(key)
          // F2（返修 · 独立复核 §4）：渲染后**版本身份已经不在文本里**（代号被换成了路径 + 行段）。
          //   `opts.trustedRendered`（本批**渲染前**已逐条核过版本/段、再由渲染器产出的可信引用串）存在时，
          //   只判"这条引用是不是可信渲染的产物" —— **绝不**按"最新版本"重新解析（那正是"合法旧引用被拒、
          //   旧版本冒用新段却能发布"的来源）。
          const lr = t.lineRange || (t.entry && t.entry.segment) || null
          const citation = t.entry.publicPath + (lr ? `:${lr.startLine ?? lr.start}-${lr.endLine ?? lr.end}` : '')
          if (trustedRendered) {
            if (!trustedRendered.has(citation)) {
              errors.push(`reference in ${k} was not produced by the trusted render step: ${t.raw}`)
            }
            continue
          }
          const vr = verifyReferenceTarget(t.entry, { memoryRoot: refMap.memoryRoot, lineRange: t.lineRange })
          if (!vr.ok) errors.push(`invalid reference ${t.entry.publicPath} in ${k}: ${vr.reasons.join(', ')}`)
        }
      }
    }
    for (const k of ['memory_summary', 'registry']) {
      const v = output[k]
      if (typeof v === 'string' && v) {
        let gateText = v
        if (refMap) {
          const ex = extractReferences(v, refMap)
          gateText = protectReferences(v, ex.tokens).text
        }
        const r = redactSecrets(gateText)
        if (r !== gateText) errors.push(`unredacted secret in ${k}`)
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
//   **t219（R2 §4）正名：这是「entries 层检索资格策略」**，不是"整条记忆管线的生命周期已完成"。
//   **分层范围差异（必读）**：`entryEligible()` 只过滤 **entries 表**；而
//     · `searchMemoryFiles()` 直接扫 **当前权威文件（memory_summary.md / MEMORY.md）+ 草稿**，
//       **不走**这条资格链；
//     · 总纲注入走的是已发布文本，同样**不走**这条资格链。
//     ⇒ **一条 entries 失格，不保证**同一事实从"文件搜索"与"总纲注入"里消失。
//       这是**分层范围差异**（不是缺陷，也不需要现在越权删文件），但产品表述必须讲清。
//   **文件层退出 = 未启用的目标能力**（用户已决定暂缓）：来源退出后清理"失去支持的派生内容"
//     属第 ② 层的目标能力，**本批不实现**；**不得**把"只做 entries 层的版本"宣称成原生全生命周期完成。
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
//   t198（F1 兼容）：旧字段 `last_used_at`（本插件**曾写、后经 `CHANGELOG` L353 删除**）仍须在**读路径**被认到
//     —— `lastUsageOf` 取 `last_usage` / `last_used_at` **较新者**；真实 `entries` 有 2 条遗痕。
//     写入路径**不变**：仍只写 `last_usage`（不复活已删除字段）。
// ─────────────────────────────────────────────────────────────────────────────
/** codex `max_unused_days` 的默认值（镜像 `config/src/types.rs` L55）。 */
export const DEFAULT_MAX_UNUSED_DAYS = 30

/**
 * 使用计数：缺字段/非法 ⇒ 0（旧条目天然兼容，等价 codex 的 `COALESCE(usage_count, 0)`）。
 *
 * t198（F1）**自决：旧 `usage_count` 保留（不当 0 处理）**，理由：
 *   ① 同名同义 —— 旧机制（`CHANGELOG` L353 删除）写的是"历史召回次数"，本插件现在的本地落点
 *      `scheduleUsageBump` 写的也是"被交付次数"（同一近似口径）⇒ 旧值 1 = "真被用过 1 次"的合法记载，
 *      不是异种单位，无需换尺；
 *   ② 它**只作排序键、从不参与资格判定**（`entryEligible` 完全不读它）⇒ 保留它**不可能**造成误淘汰，
 *      最多让该条目在**均已具资格**的候选里等效于"被用过 1 次"而略微前移；
 *   ③ 视 0 等于抹掉一条真实使用证据，与本次修法（把被忽略的"用过"证据读回来）方向自相矛盾；
 *   ④ 自愈：该条目一旦再被召回交付，`scheduleUsageBump` 会在旧值上继续 +1（单调累加），旧计数自然并入新计数。
 *   排序影响（**t219 更正**，与 comparator 逐字对齐，见召回路径 `scored.sort(...)`）：
 *     **`usage_count` 是首键 ⇒ 它先于查询相关性生效** —— `usage_count=5` 的低相关条目会排在
 *     `usage_count=0` 的高相关条目**之前**。旧注释「仅当相关性与上次使用时间打平才影响排序」
 *     **与实现不符，已作废**（R2 §4 点名要求改掉）。
 *     ⇒ 这是 **DSH 的曝光代理 / 热门优先**排序（每次把候选交付给模型即 +1），
 *       **不是** codex 在 Phase 2 **来源选择**位置的原样移植：codex 那个位置的 `usage_count` 排的是
 *       **来源选择集合**（第 ② 层），而本地这里排的是**查询结果**（第 ③ 层）—— 见文件头「三层分离」。
 */
export function usageCountOf(entry) {
  const n = Number(entry && entry.usage_count)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * 上次使用时间（ms）；'' / 缺字段 / 不可解析 ⇒ `null`（= 从未使用，等价 codex 的 `last_usage IS NULL`）。
 *
 * t198（F1 兼容）：**同时认旧字段 `last_used_at`，取二者中较新者**。该字段本插件**曾写入、后于
 * `CHANGELOG` L353 删除**（"`memory_recall` 改为纯读：删除 `last_used_at` / `usage_count` 写回与按历史
 * 召回次数自我加权"），真实 `entries` 里仍有 2 条遗痕（`usage_count=1` + `last_used_at=2026-08-28T17:12:29`）。
 * 只认 `last_usage` 会把"真实用过"的证据丢掉 ⇒ 该条目退化成"从未用过、只看 `updatedAt`"，直接撞上本地
 * 自定的失败模式纪律（**误淘汰 = 静默丢记忆（重），误保留 = 召回一条旧记忆（轻）**，见 `entryEligible`）。
 * 兼容方向**只会更宽松**：多认一个时间戳候选，永不因它而失格；一侧不可解析时安全忽略、不影响另一侧。
 * **只改读路径，不重写记录**：新写入依旧只写 `last_usage`，不复活已删除的字段。
 */
export function lastUsageOf(entry) {
  if (!entry || typeof entry !== 'object') return null
  let newest = null
  for (const raw of [entry.last_usage, entry.last_used_at]) {
    if (!raw) continue
    const t = new Date(raw).getTime()
    if (Number.isFinite(t) && (newest == null || t > newest)) newest = t
  }
  return newest
}

/**
 * t195（④ 照 codex）：条目**是否仍具资格**（硬淘汰 —— 不是降权）。
 * **t219 正名**：本函数实现的是「**entries 层检索资格策略**」—— 只作用于 `entries` 表；
 * `searchMemoryFiles()`（扫权威文件 + 草稿）与总纲注入**不走**这条链 ⇒ 一条 entries 失格
 * **不保证**同一事实从文件搜索/总纲注入消失（分层范围差异，见上方块注释与 t219 报告 §5）。
 * `eligible = (用过 && last_usage ≥ cutoff) || (从未用过 && updatedAt ≥ cutoff)`（本地把 codex 的
 * `source_updated_at` 对应为条目 `updatedAt`）；`cutoff = now − maxUnusedDays 天`。
 * 本地既有的两个硬谓词仍更高优先：`forgotten` 永不具资格；`superseded` 默认不具资格
 * （审计模式 `opts.includeSuperseded === true` 才放行，且仍受窗口约束）。
 * @param entry 条目（可含 `usage_count` / `last_usage` / `last_used_at` / `updatedAt` / `status`）。
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

// ─────────────────────────────────────────────────────────────────────────────
// t216（D1 修复 · 按 GPT R2 §5.2 的「窄范围 B + 轻量 D」）
//   **D1 是什么**：提示词要求模型写 `memories/rollout_summaries/<sessionId>.md` 这样的指针，而发布
//   闸门要求 `redactSecrets(产物) === 产物`；长串启发式（连续 ≥40 字符 + 含数字 + 含特殊字符）会把
//   这条**合法**指针整段遮掉 ⇒ 合法产物被稳定拒绝（真实数据面：11 条终态失败批）。模型被迫退化去写
//   「不含数字的短名」⇒ 3 条悬空引用。**这是接口契约冲突，不是模型乱写，也不是重试能解决的。**
//   修法（R2 §5.2 五步，逐条对应下面的函数）：
//     ① `buildReferenceMap()`：映射**只由插件既有记录**产生（本批 stage1_outputs + 当前权威基线里已
//        登记、且能用插件记录解析出来的来源）——模型/网页声明不了任何条目。
//     ② `referenceCatalogText()`：模型只拿**代号**（`[[REF1]]`）+ 可读摘要；选哪些来源支持结论由模型决定，
//        程序**不替它推断**支持关系。
//     ③ `extractReferences()`：引用链只做**映射/存在性/归属/版本**检查；正文链仍走秘密规则（两条互不串用）。
//     ④ `renderPhase2References()`：发布器把有效代号**渲染**成真实路径；读工具/注入/两个权威文件/
//        确定性重建共用 `renderReferencePath()` 同一约定。
//     ⑤ `protectReferences()`：过闸门时把**已识别且可信**的引用片段换成占位符再跑秘密规则 ⇒ 修好的
//        路径不会被同一串规则重新遮掉；渲染后的结构字段另按结构判据校验。
//   **安全边界（R2 §5.2/§5.3 明令，逐条落在代码里）**：
//     - 只对**精确匹配映射**的片段做结构识别；「长得像 `rollout_summaries/*.md`」**不**豁免；
//       磁盘上恰有同名文件**也**不算可信（可信只来自插件记录）。
//     - 引用片段若落在**凭据字段**（`session_id=` / `token:` / `Authorization:` / `Cookie:` …）的值位置，
//       **不**享受结构豁免，照常过秘密规则（**不存在 session_id 全局白名单**）。
//     - 基线里解析不出的遗留引用 ⇒ 标 `unverified`（不猜测、不静默丢弃、**不为它造空文件**）。
// ─────────────────────────────────────────────────────────────────────────────

/** 发布/读取共用的引用前缀（相对记忆根之上的那一层）。 */
export const MEMORY_PUBLIC_PREFIX = 'memories'
/** 允许被引用的相对根（相对记忆根）：草稿目录 + 两个权威产物。 */
export const REFERENCE_ALLOWED_RELS = /^(?:rollout_summaries\/[^/]+\.md|MEMORY\.md|memory_summary\.md)$/
/** 引用代号形态：`[[REF3]]`（可带行段 `[[REF3:12-20]]`）。每次调用返回**新**正则，避免 lastIndex 串味。 */
export function referenceCodeRe() { return /\[\[([A-Za-z][A-Za-z0-9_-]*)(?::(\d+)-(\d+))?\]\]/g }
/** 引用路径形态：`[memories/]rollout_summaries/<name>.md[:a-b]`。 */
export function referencePathRe() { return /(?:memories\/)?rollout_summaries\/([A-Za-z0-9._-]+\.md)(?::(\d+)-(\d+))?/g }

/** 行段后缀解析（无效 ⇒ null，不猜）。 */
function refLineRange(a, b) {
  const s = Number(a), e = Number(b)
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null
  if (s < 1 || e < s) return null
  return { start: s, end: e }
}

/** 文件行数（读不到 ⇒ 0）。行数口径与插件既有的 `countFileLines` 一致：末尾单个换行不算多一行。 */
function lineCountOf(abs) {
  try {
    const t = fs.readFileSync(abs, 'utf8')
    if (!t) return 0
    const parts = t.split(/\r?\n/)
    if (parts.length > 1 && parts[parts.length - 1] === '') return parts.length - 1
    return parts.length
  } catch { return 0 }
}

/**
 * 规范化「相对记忆根」的引用路径。**保守**：绝对路径 / 盘符 / `~` / 任何 `..` 段一律判非法（返回 ''）。
 * 允许 `./` 前缀被剥掉、反斜杠归一为 `/`。
 */
export function normalizeRefRelPath(p) {
  let s = String(p == null ? '' : p).trim().replace(/\\/g, '/')
  if (!s) return ''
  if (/^[A-Za-z]:/.test(s) || s.startsWith('/') || s.startsWith('~')) return ''
  const parts = []
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return ''
    parts.push(seg)
  }
  return parts.join('/')
}

/**
 * 把「相对记忆根」的路径渲染为**发布/读取共用**的引用形态（R2 §5.2 步 4：不许各写一套）。
 * `rollout_summaries/x.md` → `memories/rollout_summaries/x.md`；已带前缀则原样。
 */
export function renderReferencePath(rel) {
  const n = normalizeRefRelPath(rel)
  if (!n) return ''
  return n.startsWith(MEMORY_PUBLIC_PREFIX + '/') ? n : `${MEMORY_PUBLIC_PREFIX}/${n}`
}

/**
 * 该引用片段是否落在**凭据字段的值位置**（若是 ⇒ 不享受结构豁免）。
 * 只看紧邻片段左侧的一小段上下文，避免把普通正文误判成凭据字段。
 */
function inCredentialField(text, start) {
  const pre = String(text == null ? '' : text).slice(Math.max(0, Number(start) - 80), Number(start))
  return /(?:password|passwd|pwd|token|access[_-]?token|secret|access[_-]?key|client[_-]?secret|session[_-]?id|api[_-]?key|auth|authorization|x-api-key|apikey|cookie)\s*[:=]\s*(?:Bearer\s+|["'`])?\s*$/i.test(pre)
}

/**
 * ① 建立**可信引用映射**（纯函数；只有插件记录能往里加条目）。
 * @param opts.memoryRoot 记忆根（用于存在性/行段核对；不给则跳过磁盘核对）
 * @param opts.inputs 本批 `stage1_outputs` 记录（session_id / source_watermark / rollout_slug / cwd）
 * @param opts.sources 插件已知的全部来源记录（活跃 + 归档，用于 slug 别名解析与归属判定）
 * @param opts.baselineTexts 当前权威文件正文（用它找出基线里**已登记**的引用，解析得到有效基线）
 * @returns `{ entries, byCode, byPublic, byName, bySession, byAlias, unverified, memoryRoot }`
 */
export function buildReferenceMap(opts = {}) {
  const memoryRoot = String(opts.memoryRoot || '')
  const inputs = (Array.isArray(opts.inputs) ? opts.inputs : []).filter((x) => x && typeof x === 'object')
  const sources = (Array.isArray(opts.sources) ? opts.sources : []).filter((x) => x && typeof x === 'object')
  const baselineTexts = (Array.isArray(opts.baselineTexts) ? opts.baselineTexts : []).filter((t) => typeof t === 'string')

  // slug → session：**只有所有带该 slug 的记录都指向同一个 session** 时才可用于解析（否则标歧义，不猜）。
  const slugSessions = new Map()
  for (const r of sources.concat(inputs)) {
    const slug = String((r && r.rollout_slug) || '').trim()
    const sid = String((r && r.session_id) || '').trim()
    if (!slug || !sid) continue
    if (!slugSessions.has(slug)) slugSessions.set(slug, new Set())
    slugSessions.get(slug).add(sid)
  }

  // F2（P1 · 评审 §三 F2）：引用身份**三方分开** —— 逻辑来源（sessionId / relPath）、**源版本**
  //   （`source_watermark`）、以及**该版本的证据段**（该版本 `source_ref` 的 startLine-endLine）。
  //   旧实现按 `publicPath` 去重 ⇒ 同一会话的多个版本被合并成一个目录项（version 记的是**最先出现**的那个），
  //   而 `citableRegion` 取**整份文件**行数 ⇒ 旧版本条目引用新版本的行仍判 ok（"路径真实"≠"这是该版本的证据"）。
  //   现在：**一个 (来源, 版本) = 一个条目 = 一个代号**，条目自带自己的证据段；同一物理文件可以有多条，
  //   各绑各的段（不批量改名、不引入额外存储）。无 `source_ref` 的条目（基线遗留指针）保持"整份文件"旧行为。
  const segmentsOf = (ref) => {
    let r = ref
    if (typeof r === 'string' && r) { try { r = JSON.parse(r) } catch { r = null } }
    if (!r || typeof r !== 'object') return null
    const a = Number(r.startLine), b = Number(r.endLine)
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) return null
    return { startLine: a, endLine: b }
  }
  const collected = []
  const seenVersion = new Set(), seenName = new Set(), seenSession = new Set()
  const sessionEntries = new Map()   // sessionId → 已建条目数（基线遗留指针不重复建条目）
  // t224（F3）：**别名索引必须记在 Map 里，而不是只记进一个去重 Set** —— 否则"同一个会话已经有条目
  //   （来自本批输入）"时，基线里的 slug 别名会只进 Set、不进 `byAlias` ⇒ 解析不到 ⇒ 落成 `unverified`
  //   （真机表现：注册表里 3 个 slug 短名永远纠正不回真实路径）。
  const aliasIndex = new Map()   // alias（slug）→ publicPath
  const addEntry = (sid, meta = {}) => {
    const id = String(sid || '').trim()
    if (!id) return null
    const relPath = `rollout_summaries/${safeSlug(id)}.md`
    const publicPath = renderReferencePath(relPath)
    const sourceVersion = String(meta.sourceVersion || '')
    const versionKey = `${publicPath}::${sourceVersion}`
    const isBaselineMeta = meta.kind === 'baseline' || meta.kind === 'baseline-slug'
    // 基线遗留指针（来自当前权威文件里的旧引用）**不新版本信息** ⇒ 该会话已有条目时不再建重复条目，
    //   只把 slug 别名接回去（t224 F3 的修法点必须保留）。多个**本批输入版本**才允许多条目。
    if (isBaselineMeta && sessionEntries.has(id)) { if (meta.slug) aliasIndex.set(String(meta.slug), publicPath); return null }
    if (seenVersion.has(versionKey)) { if (meta.slug) aliasIndex.set(String(meta.slug), publicPath); return null }
    const absPath = memoryRoot ? path.join(memoryRoot, relPath) : ''
    const lines = absPath ? lineCountOf(absPath) : 0
    // 证据段按**实际文件行数**夹紧：追加写之后旧段的 endLine 仍 ≤ 文件总行数（prepend/重写才可能越界）。
    let segment = segmentsOf(meta.sourceRef)
    if (segment && lines > 0) {
      segment = { startLine: Math.min(segment.startLine, lines), endLine: Math.min(segment.endLine, lines) }
    }
    const e = {
      code: '',
      kind: String(meta.kind || 'input'),
      relPath,
      publicPath,
      absPath,
      name: path.basename(relPath),
      sessionId: id,
      sourceVersion,
      segment,
      versionAt: String(meta.versionAt || ''),
      citableRegion: segment ? `${segment.startLine}-${segment.endLine}` : lines > 0 ? `1-${lines}` : '',
      lines,
      exists: lines > 0,
      slug: String(meta.slug || ''),
      summary: String(meta.summary || ''),
    }
    collected.push(e)
    seenVersion.add(versionKey)
    seenName.add(e.name)
    seenSession.add(id)
    sessionEntries.set(id, (sessionEntries.get(id) || 0) + 1)
    if (e.slug) aliasIndex.set(e.slug, publicPath)
    return e
  }

  // ①-1 本批输入（kind=input）：来源身份 = session_id，源版本 = source_watermark，证据段 = 该输出的 source_ref。
  for (const it of inputs) {
    addEntry(it.session_id, {
      kind: 'input',
      sourceVersion: it.source_watermark,
      sourceRef: it.source_ref,
      versionAt: it.generated_at,
      slug: it.rollout_slug,
      summary: String(it.cwd || '') ? `cwd=${String(it.cwd)}` : '',
    })
  }

  // ①-2 有效基线：当前权威文件里**已经登记的引用**——仍只能用插件记录解析（绝不"因为磁盘上有同名文件"就认）。
  const knownSessions = new Set(sources.map((r) => String((r && r.session_id) || '')).filter(Boolean))
  const legacyNames = new Set()
  const unverified = []
  for (const text of baselineTexts) {
    const re = referencePathRe()
    let m
    while ((m = re.exec(text)) !== null) legacyNames.add(String(m[1]))
  }
  for (const name of legacyNames) {
    const bare = name.replace(/\.md$/, '')
    if (seenName.has(name) || aliasIndex.has(bare)) continue
    if (knownSessions.has(bare)) { addEntry(bare, { kind: 'baseline' }); continue }
    const set = slugSessions.get(bare)
    if (set && set.size === 1) { addEntry([...set][0], { kind: 'baseline-slug', slug: bare }); continue }
    unverified.push({ name, reason: set && set.size > 1 ? 'ambiguous-slug' : 'unresolvable-name' })
  }

  // 只把**目标真实存在**的来源放进目录（不能核验的来源不能给代号：给了就等于把无法验证的引用发出去）。
  // 被剔除的来源名仍留在 `legacyNames` 里 ⇒ 若模型只是**照抄基线**里的旧指针，标记为 `unverified`（不阻断、
  // 不猜测、不造文件）；而**新造的**路径不在 legacyNames 里 ⇒ 判 `unmapped` ⇒ 整批不发布（R2 §5.3）。
  const entries = []
  for (const e of collected) {
    if (e.exists) { e.code = `REF${entries.length + 1}`; entries.push(e) }
    else unverified.push({ name: e.name, reason: 'missing-target', sessionId: e.sessionId, kind: e.kind })
  }
  const byCode = new Map(), byPublic = new Map(), byName = new Map(), bySession = new Map(), byAlias = new Map()
  const byVersion = new Map()   // `<sessionId>::<sourceVersion>` → 条目（F2：版本级索引，供测试/审计）
  const byPathVersions = new Map()   // publicPath → 该物理文件的**全部版本条目**（追加写 ⇒ 各段互不重叠）
  // F2：同一物理文件现在可能有多条（每 (来源, 版本) 一条）。**路径/文件名/别名/session 级索引取"最新版本"** ——
  //   滚动草稿是**追加写**（见 `buildEvidenceContent` 的 append-only），故证据段 startLine 越大 = 该版本越新；
  //   无段的条目（基线遗留指针，范围=整份文件）排在最后（rank 0），不抢新版本的位。
  const rankOf = (e) => (e && e.segment ? e.segment.startLine : 0)
  const pickLatest = (cur, e) => (!cur || rankOf(e) >= rankOf(cur) ? e : cur)
  for (const e of entries) {
    byCode.set(e.code, e)
    byPublic.set(e.publicPath, pickLatest(byPublic.get(e.publicPath), e))
    byName.set(e.name, pickLatest(byName.get(e.name), e))
    bySession.set(e.sessionId, pickLatest(bySession.get(e.sessionId), e))
    byVersion.set(`${e.sessionId}::${e.sourceVersion}`, e)
    if (!byPathVersions.has(e.publicPath)) byPathVersions.set(e.publicPath, [])
    byPathVersions.get(e.publicPath).push(e)
    if (e.slug) byAlias.set(e.slug, e)
  }
  // t224（F3）：把**去重时**记下的别名也接回条目。没有这一步，基线里那些"其会话已有条目（本批输入）"的
  //   slug 短名就解析不到 ⇒ 只能标 `unverified`（真机 3 例）⇒ 重整合时永远纠正不回真实路径。
  //   信任面不变：别名的来源仍是**插件记录**（`stage1_outputs.rollout_slug`，且要求 session 唯一）。
  for (const [alias, publicPath] of aliasIndex) {
    const e = byPublic.get(publicPath)
    if (e && !byAlias.has(alias)) byAlias.set(alias, e)
  }
  return { entries, byCode, byPublic, byName, bySession, byAlias, byVersion, byPathVersions, legacyNames, unverified, slugSessions, memoryRoot }
}

/**
 * ② 给模型的**可信引用目录**（只有代号 + 可读摘要）。空映射 ⇒ 返回 ''（不编造目录）。
 */
export function referenceCatalogText(map) {
  if (!map || !Array.isArray(map.entries) || !map.entries.length) return ''
  const lines = []
  lines.push('## SOURCE REFERENCE CATALOG (TRUSTED — built by the program from its own records, NOT from the web or from you)')
  lines.push('- These codes are the ONLY valid references. To cite a source, append its code in double brackets: `[[REF1]]` (optional line range `[[REF1:12-20]]`).')
  lines.push('- NEVER write a path, filename, slug or session id yourself — the program renders codes into real paths at publish time.')
  lines.push('- Only cite a source when it actually supports the conclusion. The program does not infer support for you; an unmapped (invented) reference is rejected.')
  lines.push('- Each code is bound to ONE source version AND to that version\'s evidence line range. If you cite a line range, it MUST lie inside that code\'s range; a range taken from another version of the same file is rejected. Citing a code without a range cites exactly that code\'s own range.')
  for (const e of map.entries) {
    const bits = [e.publicPath]
    if (e.sourceVersion) bits.push(`watermark=${e.sourceVersion}`)
    if (e.citableRegion) bits.push(`lines=${e.citableRegion}`)
    if (e.summary) bits.push(e.summary)
    lines.push(`- [[${e.code}]] = ${bits.join(' | ')}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * ③ 抽取文本里的引用片段并**逐条对映射**。返回
 * `{ tokens:[{kind,raw,start,end,entry,code,lineRange,inCredentialField}], unmapped:[…], unverified:[…] }`。
 * 分类是**互斥**的：命中映射 ⇒ token；映射外但在基线遗留名单里 ⇒ unverified；其余 ⇒ unmapped（虚构）。
 */
export function extractReferences(text, map) {
  const s = String(text == null ? '' : text)
  const tokens = [], unmapped = [], unverified = []
  if (!s || !map || typeof map !== 'object') return { tokens, unmapped, unverified }
  const legacy = map.legacyNames instanceof Set ? map.legacyNames : new Set((Array.isArray(map.legacyNames) ? map.legacyNames : []))
  const push = (kind, raw, start, end, entry, lineRange) => {
    tokens.push({
      kind, raw, start, end, entry: entry || null, code: entry ? entry.code : '',
      lineRange: lineRange || null, inCredentialField: inCredentialField(s, start),
    })
  }
  const rc = referenceCodeRe()
  let m
  while ((m = rc.exec(s)) !== null) {
    const code = String(m[1]).toUpperCase()
    const entry = map.byCode ? map.byCode.get(code) : null
    if (entry) push('code', m[0], m.index, m.index + m[0].length, entry, refLineRange(m[2], m[3]))
    else unmapped.push({ raw: m[0], reason: 'unknown-reference-code', index: m.index })
  }
  const rp = referencePathRe()
  let p
  while ((p = rp.exec(s)) !== null) {
    const name = String(p[1])
    const bare = name.replace(/\.md$/, '')
    const key = renderReferencePath('rollout_summaries/' + name)
    const lineRange = refLineRange(p[2], p[3])
    // 查找顺序（F2 返修）：**先按"路径 + 行段"在该物理文件的全部版本条目里定位**（追加写 ⇒ 各段互不重叠，
    //   含该行段的版本唯一 ⇒ 版本身份无歧义），再退回 精确公开路径 → 精确文件名 → **插件记录里的 slug 别名**。
    //   为什么必须这一步：模型**手写路径**时文本里没有版本信息，只按"最新版本"解析会把旧段引用误判成
    //   越界（合法旧引用被拒）；按段定位才能无歧义还原它到底指哪个版本。
    let entry = null
    const list = map.byPathVersions && map.byPathVersions.get(key)
    if (Array.isArray(list) && list.length) {
      if (lineRange) {
        const hit = list.filter((e) => e.segment
          && lineRange.start >= e.segment.startLine && lineRange.end <= e.segment.endLine)
        // 恰好一条 ⇒ 该版本；多条 ⇒ 歧义（交由 unmapped 拒绝，不猜）；零条 ⇒ 回到最新版本（由段校验给出明确理由）。
        entry = hit.length === 1 ? hit[0] : hit.length > 1 ? null : (map.byPublic.get(key) || list[list.length - 1])
      } else {
        entry = (map.byPublic && map.byPublic.get(key)) || list[list.length - 1]
      }
    }
    if (!entry) entry = (map.byPublic && map.byPublic.get(key)) || (map.byName && map.byName.get(name)) || (map.byAlias && map.byAlias.get(bare)) || null
    if (entry) push('path', p[0], p.index, p.index + p[0].length, entry, lineRange)
    else if (legacy.has(name)) unverified.push({ raw: p[0], name, index: p.index })
    else unmapped.push({ raw: p[0], reason: 'unmapped-reference-path', index: p.index })
  }
  tokens.sort((a, b) => a.start - b.start)
  return { tokens, unmapped, unverified }
}

/**
 * ⑤ 过秘密闸门前的**占位保护**：把"已识别且允许、且不在凭据字段里"的引用片段换成占位符。
 * 这样长串启发式不会再遮掉修好的路径；其余正文一个字不动，照常过闸门。
 */
export function protectReferences(text, tokens) {
  const s = String(text == null ? '' : text)
  const list = (Array.isArray(tokens) ? tokens : []).filter((t) => t && t.entry && !t.inCredentialField && t.start >= 0 && t.end > t.start)
  const edits = list.map((t) => ({ start: t.start, end: t.end, text: `\u0001${t.entry.code}\u0001` }))
  edits.sort((a, b) => a.start - b.start)
  let out = '', pos = 0
  for (const e of edits) {
    if (e.start < pos) continue
    out += s.slice(pos, e.start) + e.text
    pos = e.end
  }
  out += s.slice(pos)
  return { text: out, protectedCount: edits.length }
}

/**
 * ④ 发布器渲染：有效代号 / 精确匹配映射的引用 → **真实路径**（可带行段）。
 * 映射外的引用**原样留在文本里**并由 `unmapped` 报出（调用方必须据此拒发，不得静默放行）；
 * 基线遗留的不可解析引用 ⇒ 标 `（未验证引用：<name>）`（不猜测、不造文件）。
 */
export function renderPhase2References(text, map, parsed = null) {
  const s = String(text == null ? '' : text)
  const { tokens, unmapped, unverified } = parsed && Array.isArray(parsed.tokens) ? parsed : extractReferences(s, map)
  const edits = []
  const used = []
  // F2（返修）：把本趟**渲染出的可信引用串**（path 或 path:a-b）一并回吐 —— 校验阶段据此判断
  //   "文本里的引用是否都由本批的可信渲染产生"，而**不再**按最新版本重新解析一遍（那样会丢掉版本身份）。
  const rendered = new Set()
  for (const t of tokens) {
    if (t.inCredentialField) continue
    // F2：条目自带**该来源版本的证据段**时，即使模型只写了 `[[REFn]]`（不带行段），也渲染成**该段自身的行段**
    //   —— 否则裸代号会落成"整份文件"的引用，旧版本又能借此冒充对新区段的支持。
    const lr = t.lineRange || (t.entry && t.entry.segment) || null
    const suffix = lr ? `:${lr.startLine ?? lr.start}-${lr.endLine ?? lr.end}` : ''
    const citation = t.entry.publicPath + suffix
    rendered.add(citation)
    edits.push({ start: t.start, end: t.end, text: citation })
    used.push(t.entry.code)
  }
  for (const u of unverified) edits.push({ start: u.index, end: u.index + String(u.raw).length, text: `（未验证引用：${u.name}）` })
  edits.sort((a, b) => a.start - b.start)
  let out = '', pos = 0
  for (const e of edits) {
    if (e.start < pos) continue
    out += s.slice(pos, e.start) + e.text
    pos = e.end
  }
  out += s.slice(pos)
  return { text: out, used: [...new Set(used)], unmapped, unverified, rendered: [...rendered] }
}

/**
 * ③-结构判据（R2 §5.3）：规范化路径在**允许根**内、无越界/链接绕行、文件属于**允许来源**、版本/行段可核对。
 * **本函数不推断"该引用支持该结论"** —— 支持关系只由模型选、由来源材料与抽样核（不得由"文件真实存在"推得）。
 */
export function verifyReferenceTarget(entry, opts = {}) {
  const reasons = []
  if (!entry || typeof entry !== 'object' || !entry.relPath) return { ok: false, reasons: ['reference-entry-missing'] }
  const rel = normalizeRefRelPath(entry.relPath)
  if (!rel || !REFERENCE_ALLOWED_RELS.test(rel)) reasons.push('reference path not in an allowed root')
  if (Array.isArray(opts.allowedSessions) && opts.allowedSessions.length) {
    // t219（F2）：本分支在生产调用点**未传** —— `validatePhase2Output` 只传 `{ memoryRoot, lineRange }`。
    //   理由（二选一里的"补注释"）：**归属已由映射构造保证** —— `buildReferenceMap()` 的条目只可能来自
    //   ① 本批 `fixedInputs`（session_id 取自批的 input_ids）或 ② 有效基线里能由插件记录解析出来的来源；
    //   `extractReferences()` 又只认 `byCode/byPublic/byName/byAlias` 的**精确命中**。因此到达本函数的
    //   `entry.sessionId` 天然属于"本批允许的来源或已登记基线"。
    //   保留该分支是为了：① 单测能显式构造"不属于本批"的负例；② 将来若有人从别处复用本函数（例如
    //   候选集合校验），调用方**可以**显式收紧。**不是**死代码，也**不**假装生产路径在查它。
    if (!opts.allowedSessions.includes(String(entry.sessionId || ''))) reasons.push('reference source is not allowed for this batch')
  }
  const root = String(opts.memoryRoot || '')
  if (root && rel && REFERENCE_ALLOWED_RELS.test(rel)) {
    const abs = path.resolve(root, rel)
    const inside = path.relative(path.resolve(root), abs)
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) reasons.push('reference escapes the memory root')
    let realOk = false
    try {
      const real = fs.realpathSync(abs)
      const realRoot = fs.realpathSync(path.resolve(root))
      const rr = path.relative(realRoot, real)
      realOk = !!rr && !rr.startsWith('..') && !path.isAbsolute(rr)
      if (!realOk) reasons.push('reference resolves outside the memory root (link traversal)')
    } catch {
      reasons.push('reference target missing')
    }
    if (realOk) {
      const lines = lineCountOf(abs)
      if (!lines) reasons.push('reference target is empty or unreadable')
      const lr = opts.lineRange
      if (lr && (!Number.isFinite(lr.start) || !Number.isFinite(lr.end) || lr.start < 1 || lr.end < lr.start || lr.end > lines)) {
        reasons.push(`reference line range out of bounds (file has ${lines} line(s))`)
      }
      // F2（P1）：**行段必须落在该条目自己那条源版本的证据段内**。
      //   旧实现只查"整份文件的行数"，于是"旧版本条目引用新版本的行"照样 ok —— 而"路径真实"不等于
      //   "这是该来源版本的证据"。段来自该版本 `source_ref`（`buildReferenceMap` 逐 (来源, 版本) 建条目）。
      const seg = entry.segment
      if (lr && seg && !(lr.start >= seg.startLine && lr.end <= seg.endLine)) {
        reasons.push(
          `reference line range ${lr.start}-${lr.end} is outside the cited source version's evidence segment ` +
          `${seg.startLine}-${seg.endLine} (source version ${entry.sourceVersion || 'unknown'})`,
        )
      }
    }
  }
  return { ok: reasons.length === 0, reasons }
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

/** 执行者候选工作区的目录名（`<记忆根>/.consolidation-out/<这个名字>` 或每次尝试一个子目录）。 */
export const EXECUTOR_WORKSPACE_DIRNAME = 'executor-workspace'

/**
 * 受限执行者的**纯规格**（不触任何服务，可单测）。
 *
 * **t220（R2 §8-2）边界**：执行者的可写根**不得**是记忆根本身 —— 它必须落在记忆根内的**隔离候选工作区**
 *   （`opts.candidateDir`，缺省 `<记忆根>/.consolidation-out/executor-workspace`）。
 *   理由：`workspace-write` 的可写根就是会话 cwd；若 cwd = 记忆根，执行者就有权在**校验之前**写
 *   `MEMORY.md` / `current.json` / 现有版本目录，而权威发布本应由外层独占。**仅靠提示词要求
 *   「只写输出文件」不是访问边界。**
 *   传 `candidateDir` = 记忆根本身（或根外路径）⇒ **抛错**（fail-closed，不给"顺手把写边界挪回根"的余地）。
 *
 * @param memoryRoot 记忆根（`<DSH_HOME>/memories` 或配置项 `memoryRoot`）。
 * @param opts.candidateDir 隔离候选工作区（必须是记忆根的**严格子目录**）。
 * @returns `{ cwd, rootDir, sandboxMode, approvalPolicy, toolFilter }`；`cwd` 即会话创建字段 `meta.cwd`。
 * @throws 记忆根为空 / 解析后非绝对路径 / 候选工作区不在记忆根内（**不拿 process.cwd() 兜底**）。
 */
export function consolidationExecutorSpec(memoryRoot, opts = {}) {
  const raw = String(memoryRoot == null ? '' : memoryRoot).trim()
  if (!raw) throw new Error('consolidationExecutorSpec: memoryRoot is required')
  const rootDir = path.resolve(raw)
  if (!path.isAbsolute(rootDir)) throw new Error(`consolidationExecutorSpec: cwd must be absolute, got "${rootDir}"`)
  const candRaw = String((opts && opts.candidateDir) == null ? '' : opts.candidateDir).trim()
  const cwd = candRaw ? path.resolve(candRaw) : path.join(rootDir, EXECUTOR_OUT_SUBDIR, EXECUTOR_WORKSPACE_DIRNAME)
  const inside = path.relative(rootDir, cwd)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`consolidationExecutorSpec: candidate workspace must be a strict subdirectory of the memory root (root=${rootDir}, cwd=${cwd})`)
  }
  return {
    cwd,
    rootDir,
    sandboxMode: CONSOLIDATION_SANDBOX_MODE,
    approvalPolicy: CONSOLIDATION_APPROVAL_POLICY,
    toolFilter: { allow: [...CONSOLIDATION_TOOL_ALLOW], deny: [...CONSOLIDATION_TOOL_DENY] },
  }
}

/** 文件 sha256（不存在/读不到 ⇒ ''）。供"权威文件在本轮里是否被动过"的边界检查用。 */
export function fileSha256(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
  } catch {
    return ''
  }
}

/**
 * t220（R2 §8-2）：**权威面快照** —— 一轮受限会话开始前记下、结束后比对。
 * 覆盖：两个权威文件、`current.json`、以及现存版本目录清单。
 * 作用：即使宿主的沙箱**没有**按预期生效，外层也能发现"执行者动了权威面"并**拒收该轮**（见
 * `runConsolidationExecutorTurn` 的 boundaryViolation），而不是让越界写悄悄进入权威状态。
 */
export function authoritativeSnapshot(root) {
  const r = String(root || '')
  const out = {}
  for (const f of ['MEMORY.md', 'memory_summary.md', 'current.json']) out[f] = fileSha256(path.join(r, f))
  try {
    out['versions/'] = fs.readdirSync(path.join(r, 'versions')).sort().join(',')
  } catch {
    out['versions/'] = ''
  }
  return out
}

/** 比对两份权威面快照，返回发生变化的键（无变化 ⇒ []）。 */
export function authoritativeDiff(before, after) {
  const changed = []
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})])
  for (const k of keys) if ((before || {})[k] !== (after || {})[k]) changed.push(k)
  return changed
}

/** 停止/释放一个受限执行者会话（超时、建会话后限制不成立、派发抛错都要调它）。**绝不抛**。 */
export async function stopConsolidationExecutor(executor, reason, opts = {}) {
  const h = executor && executor.handle ? executor.handle : executor
  const agent = h && h.agent
  const out = { cancelled: false, disposed: false, notes: [] }
  if (agent && typeof agent.cancel === 'function') {
    try {
      agent.cancel(reason ? { reason: String(reason) } : undefined)
      out.cancelled = true
    } catch (err) {
      out.notes.push('cancel-failed: ' + (err && err.message ? err.message : String(err)))
    }
  } else {
    out.notes.push('agent-cannot-cancel')
  }
  if (h && typeof h.dispose === 'function') {
    try {
      const ms = Number((opts && opts.timeoutMs) > 0 ? opts.timeoutMs : EXECUTOR_STOP_TIMEOUT_MS)
      await withTimeoutMs(Promise.resolve(h.dispose()), ms)
      out.disposed = true
    } catch (err) {
      out.notes.push('dispose-failed: ' + (err && err.message ? err.message : String(err)))
    }
  } else {
    out.notes.push('handle-cannot-dispose')
  }
  if (executor && typeof executor === 'object') executor.stopped = true
  return out
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
 * **绝不抛**（除 `consolidationExecutorSpec` 的参数错）：宿主没有 `agents` 服务、或建会话/定策略失败，
 * 都返回 `{ok:false, reason}` 让调用方继续走既有路径（批的成败不因此改变）。`setup` 在子会话"创建窗口"
 * 里执行，故 `restrict()` 生效于该会话发布之前（该会话的工具面里不存在 `subagent` 等被拒工具）。
 *
 * **t220（R2 §8-1、§8-2）两处硬边界**：
 *   · **§8-2 写边界**：`meta.cwd` = `opts.candidateDir`（记忆根内的隔离候选工作区；缺省
 *     `<记忆根>/.consolidation-out/executor-workspace`）。**永不**把记忆根当 cwd ⇒ 执行者没有
 *     写 `MEMORY.md` / `current.json` / 现有版本目录的**权限**（权威发布仍由外层独占）。
 *   · **§8-1 限制不成立就不派发**：`restricted !== true`（`tools.restrict` 缺失或抛错）或沙箱/审批
 *     **未按预期落成**时，返回 `ok:false` + 明确原因，并**停掉刚建的会话**；
 *     **不得**只把字段记下来再继续走受限路径。
 * @param opts.ctx 宿主上下文（取 `agents`/`approval`/`sandboxPolicy` 三个可选服务）。
 * @param opts.memoryRoot 记忆根（仅用于解析候选工作区的**上界**，不再直接当 cwd）。
 * @param opts.candidateDir 本次尝试的隔离候选工作区（必须严格位于记忆根内）。
 * @param opts.sessionId 该会话 id（调用方给，便于日志与幂等排查）。
 */
export async function startConsolidationExecutor({ ctx, memoryRoot: root, sessionId, candidateDir, agentPreset: presetOverride } = {}) {
  const spec = consolidationExecutorSpec(root, { candidateDir })
  // 写边界的前提：候选工作区**先存在**（否则宿主可能拒绝 cwd，或把 cwd 兜底到别处）。
  try { fs.mkdirSync(spec.cwd, { recursive: true }) } catch { /* 建不出 ⇒ 下面 create 会失败并回落 */ }
  const agents = optionalService(ctx, 'agents')
  if (!agents || typeof agents.create !== 'function') {
    return { ok: false, reason: 'agents-service-unavailable', spec, candidateDir: spec.cwd, handle: null, restricted: false, restrictCalls: 0, applied: null }
  }
  // ── v0.1.23（T31-3）：**按宿主正规配方装配执行者**（真机证据驱动）────────────────
  //  真机事实（v0.1.22 那次）：执行者会话建了、限制建立了，但**一轮没产生任何会话事件**、也没有模型
  //  请求 ⇒ 批次 `executor-no-output`、回落。根因锁定在宿主 loop 的**请求配置解析**：
  //    `@deepseek-ai/dsh-agent-loop`（加载副本 SHA `257EB83C00A05EE068E9F4BA80CA71AB94E3A1275D24B7A0CF5038FF23DD0FD8`）
  //    **L1132-1133** `provider: this.options.provider ?? ""` / `model: this.options.model ?? ""`；
  //    **L1149** `if (!proposedConfig.provider || !proposedConfig.model) throw new Error('agent "…" has no
  //    provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall')`。
  //  而我们当时 `agents.create({sessionId, meta:{cwd}, setup})` **既不传 agentOptions 也不挂 preset** ⇒ 只要
  //  有一步走到请求配置就必抛；`kick()` 的 catch 把该错误**吞掉**（只发 `agent/error` 事件）⇒ 外层只见"无产物"。
  //  宿主正规路径（`@deepseek-ai/dsh-api-session-controller` SHA `16ECB48F33996EFE72868F1603223214430634C5AC4C3E8FE9060BF240E990FF`
  //  的 `composeAgent` **L354-367**、`agentOptions()` **L456-462**、`createOrAdopt` **L445-454**）做三件事：
  //    ① `presets.resolve(id)` 取 preset id 并写进 `meta.agentPreset`；② `agentOptions={provider,model}=
  //    agentDefaultModel.currentSelection()`；③ `setup` 里 `presets.mount(agentCtx, id)`。本函数照此补齐。
  //  **顺序有意**：先 `mount` 再 `restrict`。`mount` 走 `bindScopeParent(agentKey, standingKey)`，预设组合落在
  //  agent 作用域的**祖先层** ⇒ 会进 `view(scope).restrictableNames` ⇒ **能被 deny 覆盖**（不是绕过限制）。
  const assembly = {
    route: 'agents.create+custom-setup', presetId: '', presetSource: '', provider: '', model: '',
    agentOptions: null, mounted: false, mountError: '', agentErrors: [],
  }
  const presets = optionalService(ctx, 'agentPresets')
  const wantPreset = String(presetOverride == null ? '' : presetOverride).trim()
  if (presets && typeof presets.resolve === 'function') {
    try {
      const resolved = await presets.resolve(wantPreset || undefined)
      assembly.presetId = String((resolved && resolved.id) || '')
      assembly.presetSource = wantPreset ? 'config.executorAgentPreset' : 'agentPresets.default'
    } catch (err) {
      assembly.mountError = 'preset-resolve-failed: ' + (err && err.message ? err.message : String(err))
    }
  } else {
    assembly.presetSource = 'agentPresets-unavailable'
  }
  const modelSvc = optionalService(ctx, 'agentDefaultModel')
  try {
    const cur = modelSvc && typeof modelSvc.currentSelection === 'function' ? modelSvc.currentSelection() : null
    assembly.provider = String((cur && cur.provider) || '')
    assembly.model = String((cur && cur.model) || '')
  } catch { /* 取不到 ⇒ 下面 fail-closed */ }
  assembly.agentOptions = { provider: assembly.provider, model: assembly.model }
  // fail-closed（与宿主 loop 同一条硬要求，但**在派发前**就报出来，不再让它变成"无产物"）：
  if (!assembly.provider || !assembly.model) {
    return {
      ok: false, reason: 'executor-model-route-missing: provider/model empty (agentDefaultModel.currentSelection)',
      spec, candidateDir: spec.cwd, handle: null, restricted: false, restrictCalls: 0, applied: null, assembly,
    }
  }
  let restricted = false
  let restrictCalls = 0
  let restrictError = null
  // t230：派生自宿主的可限制名单 + 「想要但不存在」的名字（显式上报，不静默）。
  let restrictObs = { names: [], source: '', unknownDesired: [], note: '' }
  const handle = await agents.create({
    sessionId,
    // ① preset id 进会话元数据（宿主正规路径同款；缺省由 resolve() 给默认预设）。
    //   t249（T33-一）：另写 `delegationDepth: 1` —— 这是**我们自己的可信创建记录**（宿主 `dsh-session`
    //   的 `validateSessionHeader` 会校验并持久化进会话头，跨重启可读），使内部执行者会话在任何入口
    //   都能被 `internalExecutionReason` 认出，**不依赖名字前缀**。
    //   为何不用 `origin: 'subagent'`：那会把该会话交给宿主的 subagent 归属路由
    //   （`hasApiSessionSubagentOwner` → `ApiSessionSubagentOwnership`），可能干扰我们后面要用的
    //   **官方读取接口**取证；`delegationDepth` 只进血缘/预算判定，没有这层副作用。
    meta: { cwd: spec.cwd, ...(assembly.presetId ? { agentPreset: assembly.presetId } : {}), delegationDepth: 1 },
    // ② 模型路由（宿主 `agentOptions()` 同款）：不传就必然在首步抛 `has no provider/model`。
    agentOptions: { provider: assembly.provider, model: assembly.model },
    setup: async (childCtx) => {
      // ⓪ 抓宿主自己的失败原因：`kick()` 吞错，只发 `agent/error` —— 这是"受限轮次真发生/真失败"的第一手证据。
      try {
        if (childCtx && typeof childCtx.on === 'function') {
          childCtx.on('agent/error', (payload) => {
            try {
              const e = payload && payload.error
              const msg = e && e.message ? String(e.message) : String(e == null ? '' : e)
              if (msg && assembly.agentErrors.length < 3) assembly.agentErrors.push(msg.slice(0, 300))
            } catch { /* 观测失败不影响轮次 */ }
          })
        }
      } catch { /* 订阅不上不阻断 */ }
      // ① 先挂预设组合（缺它则系统提示/工具面不完整；挂失败 ⇒ fail-closed，不静默跑一个没装配的执行者）。
      if (presets && assembly.presetId && typeof presets.mount === 'function') {
        try {
          await presets.mount(childCtx, assembly.presetId)
          assembly.mounted = true
        } catch (err) {
          assembly.mountError = 'preset-mount-failed: ' + (err && err.message ? err.message : String(err))
        }
      }
      // ② 后做工具面限制（此时预设的工具已在祖先层 ⇒ 会出现在 restrictableNames 里 ⇒ 能被 deny 覆盖）。
      const tools = childCtx && childCtx.tools
      if (!tools || typeof tools.restrict !== 'function') {
        restrictError = 'tools.restrict unavailable'
        restrictCalls += 1
        return
      }
      try {
        // t230：**从宿主真实注册表派生** deny = 全部可限制的全局工具（执行者一个插件工具都不需要：
        //   整合提示词已内联权威文件与输入）。内建文件工具不在此列 —— 它们的边界由 cwd 沙箱保证。
        //
        // t241（R3 修复）：**不再读 `childCtx.agent`**。在作用域上下文上读 `agent` 会走 Cordis 的
        //   `internal/get` 瀑布，落到 `cannot get property "agent" without inject`（**参数求值期**就抛）。
        //   宿主 loop 的 setup 签名是 `(agentCtx, agent)`（v0.1.5-rc.1 的 L1856），Agent 走**第二个参数**，
        //   不是上下文属性。作用域改由 `restrictableGlobalTools` 内部从 `tools` 自身派生（② 权威路径）。
        const derived = restrictableGlobalTools(tools)
        restrictObs = derived
        if (!derived.names.length) {
          restrictError = 'restrictable-name-set-unavailable' + (derived.note ? ': ' + derived.note : '')
          restrictCalls += 1
          return
        }
        tools.restrict({ deny: derived.names })
        restricted = true
      } catch (err) {
        restrictError = err && err.message ? err.message : String(err)
      }
      restrictCalls += 1
    },
  })
  const applied = applyExecutorSessionPolicies({ ctx, handle, spec })
  const policiesApplied = applied.sandboxMode === spec.sandboxMode && applied.approvalPolicy === spec.approvalPolicy
  if (restricted !== true || !policiesApplied || (assembly.presetId && !assembly.mounted)) {
    // 边界 1（R2 §8-1）：限制/策略/预设装配**任一没成立** ⇒ **不走受限路径**（显式回落 + 写明原因），
    //   并停掉刚建的会话（不留活着的、也不会被派发的执行者）。
    const why = restricted !== true
      ? `tool-restrict-not-established${restrictError ? ' (' + restrictError + ')' : ''}`
      : (!policiesApplied
          ? `policies-not-applied sandbox=${applied.sandboxMode || '-'} approval=${applied.approvalPolicy || '-'} notes=${(applied.notes || []).join('|') || '-'}`
          : `preset-not-mounted (${assembly.mountError || 'unknown'})`)
    const stopped = await stopConsolidationExecutor({ handle }, 'executor-restrictions-not-established')
    return {
      ok: false,
      reason: 'executor-restrictions-not-established: ' + why,
      spec, candidateDir: spec.cwd, handle: null, restricted, restrictCalls, restrictError, applied, stopped, restrictObs, assembly,
    }
  }
  return { ok: true, reason: '', spec, candidateDir: spec.cwd, handle, restricted, restrictCalls, restrictError, applied, restrictObs, assembly }
}

// ─────────────────────────────────────────────────────────────────────────────
// t213：① 的**实质** —— 把整合的**模型调用本身**搬进该受限会话。
//   t211 的独立复核证明：t187 落的是**接口层**（会话被真建、策略真落），但 `sessionStats={turns:0,…}`、
//   `blank=true` ⇒ **一次轮次都没跑**；`consolidateWithLlm(prompt)` 只吃 prompt ⇒ 模型调用仍在进程内。
//   本批按宿主 `Agent` 的既有面走（`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts` L186/L192/L164）：
//     `agent.followup(message)`（起一轮并唤醒）→ `await agent.whenIdle()`（等收敛）→ 回读结果。
//   结果回读优先读**受限会话自己写出的产物文件**（在记忆根内 ⇒ 同时验证"根内可写"），
//   退回扫会话里的 assistant 文本（best-effort）。**任何一步不成 ⇒ 显式回落**（见调用点）。
// ─────────────────────────────────────────────────────────────────────────────

/** 受限执行者一轮的等待上界（含模型调用与工具执行；超时即回落，不把批挂死）。 */
export const EXECUTOR_TURN_TIMEOUT_MS = 10 * 60 * 1000
/** 停止执行者会话的等待上界（cancel + dispose；超时也不阻塞批）。 */
export const EXECUTOR_STOP_TIMEOUT_MS = 5000
/** 产物文件的新鲜度宽限（ms）：早于"本轮派发时刻 − 该宽限"的产物视为**上一次尝试的旧结果**，拒收。 */
export const EXECUTOR_OUTPUT_FRESHNESS_GRACE_MS = 2000
/** 受限执行者的**候选工作区根**（每次尝试一个子目录写在其下）。读回后即清理。 */
export const EXECUTOR_OUT_SUBDIR = '.consolidation-out'

// ─────────────────────────────────────────────────────────────────────────────
// t252（T35）：**承载切换** —— 默认改为「插件后台（`plugin-background`）」，受限会话降为显式实验。
//   依据：用户拍板"直接根治，不做过渡" + `D:\分类\DSH本体管理\rollout-后台载体方案-2026-09-21.md`。
//   裁决 §八/§4.3 三点在此落实：① 用宿主**已有** `ctx.llm`（不另造凭据/HTTP 客户端/供应商适配）；
//   ② 只换"谁产出候选"这一步，队列/租约/来源水位/引用核验/发布锁与基线复核**原样保留**；
//   ③ **不建任何会话** ⇒ 不继承普通聊天预设、不产生会话残留、不产生自我摄取面。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把配置值**归一化**为承载名（向后兼容既有的布尔开关）：
 *   · `'plugin-background'`（默认）⇒ 插件后台单次调用（不建会话）；
 *   · `'restricted-session-experiment'` ⇒ 走受限会话实验路径（失败仍显式回落后台）；
 *   · 旧布尔：`true` ⇒ 受限会话实验（旧"开"的语义就是"试受限执行者"）；
 *            `false` ⇒ 插件后台（旧"关"的语义就是"跳过执行者、走进程内"）。
 * @returns `'plugin-background' | 'restricted-session-experiment'`
 */
export function consolidationCarrier(config) {
  const v = config ? config.consolidationExecutor : undefined
  if (v === CONSOLIDATION_CARRIER_RESTRICTED) return CONSOLIDATION_CARRIER_RESTRICTED
  if (v === true) return CONSOLIDATION_CARRIER_RESTRICTED
  return CONSOLIDATION_CARRIER_PLUGIN
}

/**
 * t252：**后台承载的一轮** —— 用宿主已有模型服务**一次**调用产出候选（`{memory_summary, registry}` 的
 * **原始文本**），**全程不建会话**（不调用任何建会话 / agent 生命周期 API）、**不带工具面**、
 * **不注入任何指令**。输入 = 与受限会话路径**同一份** `buildConsolidationPrompt(...)` 产物（**不截断**：
 * 单次调用没有"按需再读证据"的能力，所有依据必须事先进提示词）；输出交给调用方走**同一套**
 * `parseExtractionJson` → 证据校验 → 基线复核 → 发布（外层链一字不改）。
 *
 * **有界循环（`readEvidence` / `readCurrentMemory` / `proposeChange`）本轮连代码接口都不做**
 * （用户口径：只能用一个直接的 API 请求；少一层代码面＝少一处风险）。若将来确实需要按需查证，
 * 再加且**必须**带上限与白名单 —— 该说明只写在方案文档里，本文件不预置任何未受限读写。
 *
 * 依赖以 `call` 注入（便于单测与"不另造凭据"的边界）：调用方传 `callConsolidationLlmRaw(...)`
 * （**结构化调用**：带 `category` / `detail` / `stream_calls`；t254 · F1/F2）。
 * @param opts.prompt 整合提示词（同一份输入）
 * @param opts.call `async (prompt) => { ok, text, category, detail, stream_calls }`（宿主 `ctx.llm` 的**单次**调用）
 * @returns `{ ok, reason, text, cost }`；`cost` = 方案 §3.2 的成本记录字段（失败也可诊断）
 */
export async function runConsolidationBackgroundTurn({ prompt, call, batchId } = {}) {
  const t0 = Date.now()
  const inputChars = String(prompt == null ? '' : prompt).length
  // ── 计量口径（T36 · 四，**局部诊断字段**，不是全域账目）────────────────────────────
  //   · `input_chars`  = **脱敏前**的 prompt 长度，**不含**独立的 system 提示（`CONSOLIDATION_SYSTEM_PROMPT`）；
  //   · `source_bytes_read = 0` 只表示**后台包装本身不额外读源**（依据已在 prompt 里），
  //        ≠"本批没有读过任何来源"（读源发生在更早的 stage-1 / 组 prompt 阶段）；
  //   · `wall_clock_ms` = **本包装内**这一次调用往返的耗时（起始点=进入本函数），
  //        **不是**"批次创建 → 发布"的全链耗时（后者还含领取/校验/基线复核/写盘）；
  //   · `model_calls` = **实际 stream 调用次数**，取自 `call(...).stream_calls`（本层**不自行 +1**）。
  const cost = {
    wall_clock_ms: 0,
    model_calls: 0,
    turns: 1,
    input_chars: inputChars,
    output_chars: 0,
    source_bytes_read: 0,
    extra_session_artifacts: 0,    // **不建会话** ⇒ 0
    failure_category: '',          // t254（F1）：结构化失败类别（'llm-*'；成功为 ''）
    failure_visibility: '',
  }
  const finish = (ok, reason, text, visibility, category) => {
    cost.wall_clock_ms = Date.now() - t0
    cost.output_chars = String(text == null ? '' : text).length
    cost.failure_category = ok ? '' : String(category || '')
    cost.failure_visibility = ok ? 'batch-record:reason/cost (no session log)' : visibility
    return { ok, reason, text: text == null ? '' : String(text), cost, batchId: String(batchId || '') }
  }
  if (typeof call !== 'function') {
    return finish(false, 'background-llm-call-not-wired', '', 'llm-call-not-wired', 'llm-call-not-wired')
  }
  if (!String(prompt || '').trim()) {
    return finish(false, 'background-llm-empty-prompt', '', 'empty-prompt', 'llm-empty-prompt')
  }
  let res
  try {
    res = await call(prompt)
  } catch (err) {
    const detail = String((err && err.message) || err || '').slice(0, 200)
    return finish(false, 'background-llm-stream-error: ' + detail, '', 'llm-call-threw', 'llm-stream-error')
  }
  if (res === null || res === undefined || res === '') {
    return finish(false, 'background-llm-empty-output', '', 'no-output', 'llm-empty-output')
  }
  // 兼容：注入方直接返回字符串（无结构信息）——按"成功的一次调用"计一次；类别字段留空。
  if (typeof res === 'string') {
    cost.model_calls += 1
    return finish(true, '', res, '')
  }
  cost.model_calls = Number(res.stream_calls || 0)
  if (!res.ok) {
    const category = String(res.category || 'llm-stream-error')
    const detail = String(res.detail || '')
    return finish(false, 'background-' + category + (detail ? ': ' + detail : ''), '', category, category)
  }
  if (!res.text) return finish(false, 'background-llm-empty-output', '', 'empty-output', 'llm-empty-output')
  return finish(true, '', res.text, '')
}

/**
 * 构造发给受限会话的**用户消息**（形状对齐宿主 `UserMessage`：`{id, role, content, source}`）。纯函数，可单测。
 *
 * **t249（T33-二 · 消息契约）**：`id` 是**必需**的，不是可选装饰。加载副本 `dsh-session`
 * （SHA `05E94F57D96E7979670A5B51024C8591572EB0051CE793613DBDEC35CF2C47BF`）的 `assertMessageEventShape`
 * 对 `user/message` 事件要求 `typeof data.id === 'string' && data.id !== ''`，否则：
 *   `throw new Error('session event at seq N lacks an identified message')`
 * ⇒ 会话日志会被官方读服务判为 **`SESSION_QUERY_CORRUPT_SESSION`**（v0.1.23 真机实测：成功的那次执行者会话
 * 就是这样"跑得通、读不回"）。本函数按真实契约补齐身份；**不重写、不删除历史坏日志**。
 * @param text 消息正文。
 * @param opts.id 显式消息 id（缺省用 `exec-<nonce>` 生成）。
 */
export function buildExecutorUserMessage(text, opts = {}) {
  const given = String((opts && opts.id) || '').trim()
  const id = given || `exec-${crypto.randomBytes(6).toString('hex')}`
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: String(text == null ? '' : text) }],
    source: { kind: 'plugin', plugin: 'dsh-memory_rollout' },
  }
}

/** 简单超时包装（`promise` 超时 ⇒ reject；用于 `whenIdle`，避免批被挂死）。 */
function withTimeoutMs(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), Math.max(1, Number(ms) || 1))
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * v0.1.23（T31-2）：**受限执行者会话的事件计数 —— 换成本宿主真有的 API**。
 *
 * 旧实现读 `agent.session.events`（旧版 `dsh-session` 里有 `get events()`），但**加载副本**（0.1.5-rc.1，
 * SHA `05E94F57D96E7979670A5B51024C8591572EB0051CE793613DBDEC35CF2C47BF`）的 `Session` **没有** `events`
 * 访问器，只有 `ownEvents()` / `snapshotEvents(fromSeq?, toSeqExclusive?)`（`lib/types/index.d.ts` L187/L192）
 * ⇒ 旧探针恒返回 `-1`，批次里落 `events=-1->-1` 是无意义值（真机实测）。
 * 现在按真实面逐层取，并**带回口径名**，绝不写 `-1`：取不到就写 `unreadable`。
 * @returns `{count, basis}`；`count` 为 null 表示读不到（basis='unreadable'）。
 */
export function sessionEventStats(session) {
  const tries = [
    ['ownEvents', () => (typeof session.ownEvents === 'function' ? session.ownEvents() : undefined)],
    ['snapshotEvents', () => (typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : undefined)],
  ]
  for (const [basis, get] of tries) {
    try {
      const a = get()
      if (Array.isArray(a)) return { count: a.length, basis }
      if (a && typeof a[Symbol.iterator] === 'function') return { count: [...a].length, basis }
    } catch { /* 换下一层 */ }
  }
  try {
    const e = session && session.events
    if (Array.isArray(e)) return { count: e.length, basis: 'events-array' }
    if (e && typeof e[Symbol.iterator] === 'function') return { count: [...e].length, basis: 'events-iterable' }
  } catch { /* 读不到 */ }
  return { count: null, basis: 'unreadable' }
}

/** 会话事件数的简写（拿不到上下文对象时用）。 */
function sessionEventCount(session) {
  return sessionEventStats(session).count
}

/**
 * v0.1.23（T31-5）：**该会话有没有"助手输出"**（模型真的回复过）。
 *
 * 为什么不用"事件数 == 0"当空壳判据：真实会话在**创建/策略阶段就有事件**（`sandbox/mode`、
 * `approval/policy`、`turn/start`…）—— 真机那次执行者会话在创建后 17 ms 就有 17,572 B 的落盘。
 * 所以"零事件"永远不成立，用它会**永远不清**。真正无价值的是"**模型从未回复**"的那次失败尝试
 * （`executor-no-output` / `no-activity` / 超时）：这种会话出现在会话列表里就是纯残留。
 * @returns `{count, basis}`；`count` 为 null = 事件面读不到（**不敢断言空壳**，就不清）。
 */
export function sessionAssistantOutput(session) {
  const scan = (arr) => {
    let n = 0
    for (const ev of arr) {
      const t = ev && typeof ev === 'object' ? String(ev.type || '') : ''
      if (t.startsWith('assistant/')) n += 1
    }
    return n
  }
  const stats = sessionEventStats(session)
  if (stats.count == null) return { count: null, basis: 'unreadable' }
  try {
    if (typeof session.ownEvents === 'function') return { count: scan(session.ownEvents()), basis: 'ownEvents' }
    if (typeof session.snapshotEvents === 'function') return { count: scan(session.snapshotEvents()), basis: 'snapshotEvents' }
    const e = session && session.events
    if (Array.isArray(e)) return { count: scan(e), basis: 'events-array' }
    if (e && typeof e[Symbol.iterator] === 'function') return { count: scan([...e]), basis: 'events-iterable' }
  } catch { /* 落下面 */ }
  return { count: null, basis: 'unreadable' }
}

/**
 * v0.1.23（T31-6）：**"这个会话还在不在宿主里"的安全探测**（绝不抛、绝不挂）。
 * 顺序：活体注册表（`agents`/`sessions` 的 `get`）→ 官方 `sessionPersistence.list()` 里是否还有它的 header。
 * @returns `false`=确实还在；`true`=存储里也找不到（会话目录已被外部清掉）；`undefined`=判不出来（**不据此改任何状态**）。
 */
export async function executorSessionGone(ctx, sessionId) {
  const id = String(sessionId || '')
  if (!id) return undefined
  try {
    const a = optionalService(ctx, 'agents')
    if (a && typeof a.get === 'function' && a.get(id)) return false
  } catch { /* 换下一层 */ }
  try {
    const s = optionalService(ctx, 'sessions')
    if (s && typeof s.get === 'function' && s.get(id)) return false
  } catch { /* 换下一层 */ }
  try {
    const p = optionalService(ctx, 'sessionPersistence')
    if (!p || typeof p.list !== 'function') return undefined
    const list = await p.list({})
    const arr = Array.isArray(list) ? list : []
    for (const snap of arr) {
      const h = snap && snap.header
      if (h && String(h.id) === id) return false
    }
    return arr.length ? true : undefined
  } catch {
    return undefined
  }
}

/**
 * v0.1.23（T31-5）→ 本批（C2 / Codex R5「只停不删」）：**识别**"自己的、空的、失败的执行者会话"，**不删**。
 *
 * **本批改动（撤销插件侧驱动删除）**：旧实现识别到空壳后会调用宿主提供的**会话删除工具**（由
 * `dsh-archive-flow` 提供，该插件已从桌面 profile 摘除）把会话整体移走。用户裁定
 * 「归档＝宿主标准配置、**删除＝可选项**」⇒ 插件侧
 * **不得再驱动删除**，故删除调用整段移除（`lib/` 内**会话删除工具名**命中归零）。**识别逻辑原样保留**
 * 并落到批观测字段（`executor_cleanup`），便于复盘的"为什么没走 / 空壳还在"有据可查。
 *
 * 不再调用的历史手段（保留结论，便于回看为什么当初用工具）：加载副本
 * `@deepseek-ai/dsh-session-persistence-jsonl`（0.1.5-rc.1）的公开方法面只有
 * read/append/flush/close/create/open/stat/list/locate/handle 之类，**没有 delete/remove/prune**；
 * `dsh-session` 的 `ctx.sessions` 也只管内存 ⇒ 当时唯一受支持的移除通道是工具。现**一并不用**。
 *
 * 判定（识别）三条，全中才报"空壳"，其余一律不碰：
 *   ① id 必须是**我们自己造的**（前缀 `p2-exec-<batchId>-`）；
 *   ② **零会话事件**（空壳；有任何事件的就是本轮证据）；
 *   ③ 已经 stop/dispose 过（调用方保证顺序）。
 * 配置键 `executorEmptySessionCleanup`（`Config` schema 尾部）**保留读取兼容**：旧配置里 `false` 仍能加载、
 * 仍被本函数读到（`false` ⇒ 连"识别到空壳"这条记录都不记）；它**不是**"是否停止任务"的开关 —— 停止路径见
 * `stopConsolidationExecutor()` 与 `stopExecutorIfAlive('executor-not-dispatched')`，两者不受该键影响
 * （Codex R5 明文：**不应把旧"空壳清理"开关改造成"是否停止任务"的开关**）。
 *
 * **绝不抛、绝不影响批状态**；返回值如实：`attempted` 恒 false（本批不含任何删除尝试）、
 * `deleted` 恒 false、`emptyShell` 区分"识别到空壳"（true，`scope: 'identified-only-no-delete'`）与
 * "不是空壳 / 不该记"（false，`scope: 'not-an-empty-shell'`）。
 * @returns `{attempted, outcome, text, deleted, id, emptyShell, scope}`
 */
export async function cleanupEmptyExecutorSession({ ctx, config, batchId, sessionId, assistantEvents } = {}) {
  const id = String(sessionId || '')
  const bid = String(batchId || '')
  const off = (text) => ({ attempted: false, outcome: 'skipped', text, deleted: false, id, emptyShell: false, scope: 'not-an-empty-shell' })
  if (!id || !bid) return off('missing-id-or-batch')
  if (!id.startsWith(`p2-exec-${bid}-`) && id !== `p2-exec-${bid}`) return off('not-our-executor-session')
  // "空壳"判据 = **模型从未回复**（`assistantEvents === 0`）。判据读不到（null）⇒ 不敢断言。
  if (assistantEvents === null || assistantEvents === undefined) return off('assistant-output-unreadable')
  if (!(Number(assistantEvents) === 0)) return off('session-has-assistant-output(' + String(assistantEvents) + ')')
  // 旧配置键的读取兼容：值仍是"这条空壳要不要清理"的老语义；`false` ⇒ 连识别记录都不记。
  if (config && config.executorEmptySessionCleanup === false) return off('disabled-by-config')
  // 三条全中 ⇒ 空壳。**只报告，不删除**（本批撤掉删除编排；这里刻意不去取任何删除工具）。
  return {
    attempted: false,
    outcome: 'no-delete-by-design',
    text: '空壳执行者会话（我们自己的 id + 零会话事件 + 已停）已识别；本批不执行删除（插件侧不驱动会话删除）',
    deleted: false,
    id,
    emptyShell: true,
    scope: 'identified-only-no-delete',
  }
}

/**
 * 会话活动证据串（不依赖控制台；落批记录用）。**不再写 `-1`**：
 *   `events=<before>-><after>(<basis>) turns=<agent.status>`；`agent.status` 在本宿主是**字符串**
 *   （`'idle' | 'running'`，见加载副本 `dsh-agent` SHA `B05AA36F…` 的 `runtime-types.d.ts` L90），
 *   旧代码按 `status.turns` 读 ⇒ 恒 undefined ⇒ 串里连 `turns=` 段都没有（真机实测）。
 */
function executorActivity(agent, before) {
  const after = sessionEventStats(sessionOfHandle(agent) || (agent && agent.session))
  const b = before && typeof before === 'object' ? before : { count: null, basis: 'unreadable' }
  let status = 'unknown'
  try {
    const st = agent && agent.status
    if (typeof st === 'string') status = st
  } catch { /* status 读不到 */ }
  const fmt = (s) => (s.count == null ? 'unreadable' : String(s.count))
  const basis = after.basis !== 'unreadable' ? after.basis : b.basis
  return `events=${fmt(b)}->${fmt(after)}(${basis}) turns=${status}`
}

/** 派发前的活动基线（供 `executorActivity` 对比）。 */
function executorActivityBaseline(agent) {
  return sessionEventStats(sessionOfHandle(agent) || (agent && agent.session))
}

/** 从受限会话的会话日志里尽力提取 assistant 文本（形状随宿主而异 ⇒ 逐层兜底；拿不到返回 ''）。 */
export function collectExecutorAssistantText(session) {
  try {
    const evs = typeof session?.events === 'function' ? session.events() : session?.events
    const arr = Array.isArray(evs) ? evs : evs && typeof evs[Symbol.iterator] === 'function' ? [...evs] : []
    const out = []
    for (const ev of arr) {
      const type = String((ev && ev.type) || '')
      if (type !== 'assistant/message' && type !== 'assistant/text') continue
      const d = ev && ev.data ? ev.data : ev
      const cands = [d && d.text, d && d.content, d && d.message && d.message.content]
      for (const c of cands) {
        if (typeof c === 'string' && c.trim()) out.push(c)
        else if (Array.isArray(c)) for (const b of c) if (b && b.type === 'text' && typeof b.text === 'string') out.push(b.text)
      }
    }
    return out.join('\n')
  } catch {
    return ''
  }
}

/**
 * t213/t220：在受限会话里**真跑一轮**整合（模型调用 + 可能的工具执行都在该会话内）。
 * **绝不抛**：任何一步失败都返回 `{ok:false, reason, sessionId, activity}`，由调用方**显式回落**。
 *
 * **t220（R2 §8）两处硬边界**：
 *   · **§8-2 越界写**：产物写在**隔离候选工作区**里（`opts.candidateDir`，缺省取 `executor.spec.cwd`）；
 *     本轮**派发前**记下**权威面快照**（`MEMORY.md` / `memory_summary.md` / `current.json` / `versions/` 清单），
 *     读完**先比对再采纳**：一旦发现权威面被动过 ⇒ `ok:false` + `boundaryViolation:true`（调用方**整批不发布**）。
 *     提示词里也明令"只许写产物文件"，但那**只是提示、不是访问边界**；真正的边界是这条检查 + 宿主沙箱。
 *   · **§8-3 超时/旧输出**：超时或派发抛错 ⇒ **停掉该会话**（`stopConsolidationExecutor`：cancel + dispose）；
 *     回读带**新鲜度闸门**（产物必须晚于本轮派发时刻）⇒ 防止读到**上一次尝试的旧结果**；每次尝试另有
 *     **独立子目录**（`attempt-<tag>/result.json`）⇒ 路径层面天然不共用。
 * @param opts.executor `startConsolidationExecutor` 的返回体（需 `ok:true` 且 `handle.agent` 可用）。
 * @param opts.prompt 整合提示词（`buildConsolidationPrompt` 的产物）。
 * @param opts.memoryRoot 记忆根（= 权威面快照的根，也是候选工作区的上界）。
 * @param opts.candidateDir 本次尝试的隔离候选工作区（缺省 `executor.candidateDir` / `spec.cwd`）。
 * @param opts.batchId 批 id（仅用于日志与可读性）。
 * @param opts.attemptTag 本次尝试标记（如 `2-ab12cd`）⇒ 子目录 `attempt-<tag>/`。
 * @param opts.timeoutMs 等待上界（默认 `EXECUTOR_TURN_TIMEOUT_MS`）。
 */
export async function runConsolidationExecutorTurn({ executor, prompt, systemPrompt, memoryRoot: root, batchId, timeoutMs, candidateDir, attemptTag } = {}) {
  const agent = executor && executor.handle ? executor.handle.agent : undefined
  const sessionId = String((agent && agent.id) || (executor && executor.sessionId) || '')
  if (!agent) return { ok: false, reason: 'executor-agent-unresolved', sessionId, activity: '' }
  const canFollowup = typeof agent.followup === 'function'
  const canSend = typeof agent.send === 'function'
  if (!canFollowup && !canSend) return { ok: false, reason: 'executor-agent-cannot-dispatch', sessionId, activity: '' }
  if (typeof agent.whenIdle !== 'function') return { ok: false, reason: 'executor-agent-cannot-await', sessionId, activity: '' }
  const memRoot = String(root || '')
  const workDir = path.resolve(String(
    candidateDir || (executor && executor.candidateDir) || (executor && executor.spec && executor.spec.cwd) ||
    path.join(memRoot, EXECUTOR_OUT_SUBDIR, EXECUTOR_WORKSPACE_DIRNAME),
  ))
  // 边界 2 自检：候选工作区必须**严格位于记忆根内**（否则本函数拒跑，绝不把写边界放回记忆根）。
  const relWork = memRoot ? path.relative(path.resolve(memRoot), workDir) : ''
  if (!memRoot || !relWork || relWork.startsWith('..') || path.isAbsolute(relWork)) {
    return { ok: false, reason: 'executor-candidate-workspace-required: ' + workDir, sessionId, activity: '' }
  }
  const attemptDir = path.join(workDir, `attempt-${String(attemptTag || batchId || 'batch')}`)
  const outFile = path.join(attemptDir, 'result.json')
  try { fs.mkdirSync(attemptDir, { recursive: true }) } catch { /* 建不出 ⇒ 回读会失败并回落 */ }
  const before = executorActivityBaseline(agent)
  const dispatchedAtMs = Date.now()
  const authBefore = authoritativeSnapshot(memRoot)
  // v0.1.23（T31-1）：**所有失败/提前 return 都收口到 stop/dispose**。旧实现只在"派发抛错/超时/越界"
  //   三条路上停会话，`executor-no-output`、`executor-stale-output` 这两条**直接 return** ⇒ 执行者会话
  //   留在宿主里（用户 GUI 里能看到条目名 `executor-workspace`；磁盘上 09-14→09-21 累积 10 个）。
  //   现在用一个收口函数：先停（绝不抛），再返回；返回值统一带 `stopped`。
  const failClosed = async (reason, extra = {}) => {
    const activity = executorActivity(agent, before)
    const sess = sessionOfHandle(agent) || (agent && agent.session)
    const eventsAfter = sessionEventStats(sess).count
    const assistantEvents = sessionAssistantOutput(sess).count
    const stopped = await stopConsolidationExecutor(executor, String(reason).slice(0, 120))
    cleanup()
    return { ok: false, reason, sessionId, activity, eventsAfter, assistantEvents, stopped, agentErrors: executorAgentErrors(executor), ...extra }
  }
  const instruction =
    `\n\n## OUTPUT DELIVERY (isolated candidate workspace)\n` +
    `You are running inside a restricted session whose working directory is an ISOLATED candidate workspace:\n` +
    `  ${attemptDir}\n` +
    `Put ONLY these two things there, and write nothing else anywhere:\n` +
    `  1) the final JSON answer, as your reply text;\n` +
    `  2) that same exact JSON text, in the file \`result.json\` (absolute path: ${outFile}) using the \`write\` tool.\n` +
    `NEVER create or modify MEMORY.md, memory_summary.md, current.json, or anything under versions/ —\n` +
    `publishing is the outer layer's job; any such write is detected and rejects the whole batch.\n`
  const message = buildExecutorUserMessage(`${String(systemPrompt || '')}\n\n${String(prompt || '')}${instruction}`, {
    // 稳定、可复查的消息 id（同一批同一次尝试固定）：宿主 `assertMessageEventShape` 要求非空字符串。
    id: `exec-${String(batchId || 'batch')}-${String(attemptTag || '0')}`,
  })
  const cleanup = () => {
    try { fs.rmSync(attemptDir, { recursive: true, force: true }) } catch {}
    // 顺手：候选工作区/根目录空了就删（R2 §8 明确不为此另开任务，故并入本批，不单独开工单）。
    try { fs.rmdirSync(workDir) } catch {}
    try { fs.rmdirSync(path.join(memRoot, EXECUTOR_OUT_SUBDIR)) } catch {}
  }
  try {
    if (canFollowup) agent.followup(message)
    else agent.send(message, 'next-turn', true)
  } catch (err) {
    return await failClosed('executor-dispatch-threw: ' + (err && err.message ? err.message : String(err)))
  }
  try {
    await withTimeoutMs(agent.whenIdle(), Number(timeoutMs) > 0 ? Number(timeoutMs) : EXECUTOR_TURN_TIMEOUT_MS)
  } catch (err) {
    // 边界 3（§8-3）：超时/失败后**必须**保证原执行者停止，否则它可能迟到写回、与回落发布竞争。
    const base = isWriteConflictError(err) ? 'executor-turn-write-conflict' : 'executor-turn-failed: ' + (err && err.message ? err.message : String(err))
    return await failClosed(base)
  }
  const activity = executorActivity(agent, before)
  const afterStats = sessionEventStats(sessionOfHandle(agent) || (agent && agent.session))
  // v0.1.23（T31-4）：**"受限轮次真发生"必须可断言** —— 有可读事件计数时，要求本轮事件数**严格增长**
  //   （宿主 loop 开一轮的第一件事就是 append `turn/start`：加载副本 `dsh-agent-loop` L926）。计数读不到时
  //   不假装通过，记 `activityGate:'unverifiable'` 并由外层如实落观测；产物照旧要过证据/边界检查。
  const activityGate = (before.count != null && afterStats.count != null)
    ? (afterStats.count > before.count ? 'passed' : 'failed')
    : 'unverifiable'
  if (activityGate === 'failed') {
    return await failClosed('executor-no-activity: session events did not grow (' + activity + ')', { activityGate })
  }
  // 边界 2：**先查权威面，再谈采纳**。
  const changed = authoritativeDiff(authBefore, authoritativeSnapshot(memRoot))
  if (changed.length) {
    return await failClosed(
      'executor-boundary-violation: authoritative surface modified during executor turn: ' + changed.join(', '),
      { boundaryViolation: true, changed, activityGate },
    )
  }
  let text = ''
  let source = ''
  let staleNote = ''
  try {
    if (fs.existsSync(outFile)) {
      const st = fs.statSync(outFile)
      if (Number(st.mtimeMs) + EXECUTOR_OUTPUT_FRESHNESS_GRACE_MS < dispatchedAtMs) {
        // 边界 3：产物早于本轮派发 ⇒ 它是**上一次尝试的旧结果**，不得复用（宁可回落）。
        staleNote = `stale output: mtime=${new Date(Number(st.mtimeMs)).toISOString()} < dispatch=${new Date(dispatchedAtMs).toISOString()}`
      } else {
        text = String(fs.readFileSync(outFile, 'utf8') || '')
        if (text.trim()) source = 'executor-out-file'
        else text = ''
      }
    }
  } catch { text = '' }
  if (staleNote) {
    return await failClosed('executor-stale-output: ' + staleNote, { activityGate })
  }
  if (!text) {
    const fromEvents = collectExecutorAssistantText(agent.session)
    if (fromEvents.trim()) { text = fromEvents; source = 'executor-session-events' }
  }
  cleanup()
  if (!text.trim()) {
    return await failClosed('executor-no-output', { activityGate, agentErrors: executorAgentErrors(executor) })
  }
  // 成功路径也要**停会话**（释放活着的 agent）：会话日志（本轮证据）已落盘，不受影响。
  const stopped = await stopConsolidationExecutor(executor, 'executor-turn-completed')
  return {
    ok: true, reason: '', text, source, sessionId, activity, activityGate, stopped,
    agentErrors: executorAgentErrors(executor), eventsAfter: afterStats.count,
    assistantEvents: sessionAssistantOutput(sessionOfHandle(agent) || (agent && agent.session)).count,
  }
}

/** 取执行者装配期捕获的宿主 `agent/error` 文本（`startConsolidationExecutor` 落 `assembly.agentErrors`）。 */
function executorAgentErrors(executor) {
  try {
    const a = executor && executor.assembly && executor.assembly.agentErrors
    return Array.isArray(a) ? [...a] : []
  } catch {
    return []
  }
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
    // 防御：部分历史测试用极简假表（只有 put/delete/keys/entries，没有 get）——
    // 启动期新增的 `armStage1Wake()` 会同步读 meta，读不到时按"空 meta"处理，不把宿主/测试拖崩。
    let m = null
    try {
      m = typeof stage1MetaTable.get === 'function' ? stage1MetaTable.get(STAGE1_META_KEY) : null
    } catch {
      m = null
    }
    // GPT P0-7：返回浅拷贝，防止调用方「读→字段改→writeStage1Meta」原地改到存储对象
    // （后端 put 失败时内存旧值已被改掉，与磁盘分叉）。
    return m && typeof m === 'object'
      ? { ...m }
      : { runDay: '', modelAttemptsToday: 0, lastSuccessWatermark: '', lastPhase2At: '', phase2_last_error: '' }
  }
  /**
   * **D-07（评估 §六）· 并发元数据写**：原实现是"调用处 read → 合并 → put"，两个写者交错时**后写者的
   * 合并基线是旧值** ⇒ 前一次写入的字段被抹掉（丢更新）。这里复用"串行写"这一既有机制的最轻形式：
   * 一个**本条目的** promise 链 —— 每个 patch 在链上**重读最新值**再合并，且不占用 `withWrite`
   * （`withWrite` 是不可重入的，调用方常已在其中，套用会冲突）。**不做泛化重构**（评估划界）。
   */
  let metaWriteTail = Promise.resolve()
  const writeStage1Meta = (patch) => {
    const run = async () => {
      const cur = readStage1Meta()
      return stage1MetaTable.put(STAGE1_META_KEY, { ...cur, ...patch })
    }
    const next = metaWriteTail.then(run, run)
    metaWriteTail = next.then(() => {}, () => {})
    return next
  }

  // ── t249（T33-一）：内部执行者会话的**创建台账**（可信记录之二；之三是名字前缀，只作辅助）──
  /** 台账容量上限（按创建时间保留最新者，避免无限增长）。 */
  const EXECUTOR_LEDGER_MAX = 200
  /** 读台账（只读；读不到 ⇒ {}）。 */
  const executorSessionLedger = () => {
    const m = readStage1Meta()
    return m.executorSessions && typeof m.executorSessions === 'object' ? m.executorSessions : {}
  }
  /**
   * 记一条"这个会话是我们建的执行者"（**在创建成功之后**调用；失败不影响批次）。
   * 落 `stage1_meta.meta.executorSessions`（既有 meta 记录，**不新增表**）。
   */
  const recordExecutorSession = async (sessionId, batchId) => {
    const id = String(sessionId || '')
    if (!id) return false
    try {
      await withWrite(async () => {
        const all = { ...executorSessionLedger() }
        all[id] = { batchId: String(batchId || ''), at: nowIso() }
        const ids = Object.keys(all)
        if (ids.length > EXECUTOR_LEDGER_MAX) {
          const keep = ids
            .sort((a, b) => String(all[b] && all[b].at || '').localeCompare(String(all[a] && all[a].at || '')))
            .slice(0, EXECUTOR_LEDGER_MAX)
          const out = {}
          for (const k of keep) out[k] = all[k]
          await writeStage1Meta({ executorSessions: out, executorSessionsLastAt: nowIso() })
          return
        }
        await writeStage1Meta({ executorSessions: all, executorSessionsLastAt: nowIso() })
      })
      return true
    } catch {
      return false
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // T29：**统一摄入口 + 三个触发面**（A 静置扫描 / B 显式点名 `memory_ingest_session` /
  //   C 删前按钮）。三者共用同一套：入队（`enqueueStage1JobIntoTable`，键 `<sid>::<contentWatermark>`）、
  //   去重（`stage1_jobs` + `stage1_seen`）、预算/保底门（在 drain 里，入口不绕过）、
  //   "已记忆"判定（**stage1 草稿落盘**）、产物形态（同一草稿文件的追加块）。
  //   对齐 codex：摄取挂在"**根会话 + 时间/空闲窗口 + 启动扫**"上，**与销毁事件无关**
  //   （镜像 `codex-rs/memories/README.md` L29-51、`write/src/start.rs` L24/L33-38、
  //    `state/src/runtime/memories.rs` L159-172/L243-252）；`session/disposed` 保留为**同一套逻辑的
  //    另一个入口**（结束走得快、静置兜得住）。**不新增表、不新增定时器**：扫描记账与 D2 碑都落在
  //    既有 `stage1_meta.meta` 里；周期性由既有 stage-1 唤醒（`scheduleStage1Wake`）承担。
  // ═══════════════════════════════════════════════════════════════════════════
  /** 静置扫描的周期（ms）——复用既有 stage-1 唤醒计时器，不新开定时器平台。 */
  const IDLE_SCAN_INTERVAL_MS = 30 * 60 * 1000
  /** `stage1_meta.meta.scanSeen` / `unrefined` 的容量上限（按 mtime 保留最新者，避免无限增长）。 */
  const SCAN_SEEN_MAX_ENTRIES = 1000

  /** "已记忆"判定（三个入口共用）：该会话的 stage-1 草稿文件路径。 */
  const draftFileOf = (sessionId) => path.join(dirs().summaries, `${safeSlug(String(sessionId || 'unknown'))}.md`)
  /** 草稿文件字节数（读不到 ⇒ 0）。空文件**不算**已提炼。 */
  const draftBytesOf = (sessionId) => {
    try {
      const st = fs.statSync(draftFileOf(sessionId))
      return Number(st && st.size) || 0
    } catch {
      return 0
    }
  }

  /**
   * **R1（评审 P1）：「删前放行 / 已提炼」判据绑定本次来源版本**。
   *
   * 旧判据是 `existsSync(草稿文件)` —— 把「该会话**任何历史**草稿」当成「**本次水位**已提炼」。触发场景
   * （评审独立复现）：某会话以前有草稿，之后恢复对话又加了新决定；用户点「记忆并删除」时新正文刚入队
   * （`pending`），旧草稿仍在 ⇒ 旧判据约 3 ms 就放行删除，新决定可能在提炼前随会话日志一起消失。
   *
   * 新判据（三项**全**满足才 `ok:true`）：
   *   ① `stage1_jobs` 里存在 `<sid>::<watermark>`，且终态为 `succeeded_with_output`
   *      （`pending` / `running` / `failed_retryable` / `failed_terminal` / `succeeded_no_output`
   *      **一律不放行**——空来源、过短内容、提炼失败、模型无产出都不是"已提炼"）；
   *   ② 该作业的 `stage1_outputs` 记录带 `source_ref`，且**现在就能读出**该证据段
   *      （`validateSourceRef`：文件在、行号在、引用文本在）⇒ 是"**可读证据**"，不是"文件存在"；
   *   ③ 草稿文件字节数 > 0（**空文件不算**）。
   *
   * 纯读判定：不写盘、不调模型、不触发提炼；任何一路不成立都返回 `ok:false` + 机器可读理由。
   * @returns `{ ok, basis, reason, jobStatus, outputKey, sourceRef, lineCount, draftFile, draftBytes }`
   */
  function draftEvidenceOf(sessionId, watermark) {
    const sid = String(sessionId || '')
    const wm = String(watermark || '')
    const none = (basis, reason, extra = {}) => ({
      ok: false, basis, reason, jobStatus: '', outputKey: '', sourceRef: null, lineCount: 0,
      draftFile: draftFileOf(sid), draftBytes: draftBytesOf(sid), ...extra,
    })
    if (!sid || !wm) return none('missing-input', 'missing-session-id-or-watermark')
    const key = stage1JobKey(sid, wm)
    const job = typeof stage1JobsTable.get === 'function' ? stage1JobsTable.get(key) : null
    if (!job) return none('job-absent', 'no-stage1-job-for-watermark')
    const status = String(job.status || '')
    if (status !== 'succeeded_with_output') {
      return none('job-not-succeeded', 'stage1-job-' + (status || 'unknown'), { jobStatus: status })
    }
    const outputKey = stage1OutputKey(job.id)
    const out = typeof stage1OutputsTable.get === 'function' ? stage1OutputsTable.get(outputKey) : null
    if (!out) return none('output-absent', 'no-stage1-output-record', { jobStatus: status, outputKey })
    const v = validateSourceRef(out.source_ref, memoryRoot())
    if (!v || v.ok !== true) {
      return none('evidence-unreadable', 'evidence-unreadable:' + String((v && v.reason) || 'unknown'),
        { jobStatus: status, outputKey, sourceRef: out.source_ref || null })
    }
    const bytes = draftBytesOf(sid)
    if (!(bytes > 0)) return none('draft-empty', 'draft-file-missing-or-empty', { jobStatus: status, outputKey })
    return {
      ok: true, basis: 'watermark-evidence-readable', reason: '', jobStatus: status, outputKey,
      sourceRef: out.source_ref || null, lineCount: Number(v.lineCount || 0),
      draftFile: draftFileOf(sid), draftBytes: bytes,
    }
  }

  /** 取会话日志最后写入时间：首选官方 `locate(header).path` + `fs.stat`；回退 `revision` 里的 mtimeNs。 */
  const sessionSourceMtimeMs = (persistence, header, snapshot) => {
    try {
      const loc = persistence && typeof persistence.locate === 'function' ? persistence.locate(header) : null
      const p = loc && loc.path ? String(loc.path) : ''
      if (p) {
        const st = fs.statSync(p)
        if (st && Number.isFinite(st.mtimeMs) && st.mtimeMs > 0) return st.mtimeMs
      }
    } catch { /* fall through to revision */ }
    const rev = snapshot && snapshot.revision ? String(snapshot.revision) : ''
    const ns = Number(rev.split(':')[3])
    return Number.isFinite(ns) && ns > 0 ? Math.floor(ns / 1e6) : 0
  }

  /**
   * **C4（契约 §C4 ①）：唯一的自动摄取资格判定** —— 把静置扫描原先内联的两段时间门
   * （静置 ≥ `minRolloutIdleHours`、年龄 ≤ `maxRolloutAgeDays`）提成**一个函数**，供**所有自动入口**共用。
   *
   * 为什么必须唯一（Codex R3 + 用户裁定 §10.1）：旧实现里这两道门**只在 `ingestIdleScan` 里**，
   * `ingestSessionById` 与 `session/disposed` **不含任何时间检查** ⇒ 事件入口在入口层绕过静置窗口。
   * 用户明文：「`session/disposed` 最多帮助重新检查/调度，**不得绕过六小时门槛**」。
   *
   * 口径（与扫描原本的判定**逐字一致**，只是搬了家）：
   *   · `idleFor = nowMs − mtime`；`mtime` 优先由调用方给出（扫描已算过，避免重复 stat），否则本函数自取；
   *   · `idleFor < idleMs` ⇒ `{ok:false, reason:'not-idle-enough'}`；
   *   · `idleFor > ageMs` ⇒ `{ok:false, reason:'too-old'}`（**注意**：年龄上限**不再是永久排除** ——
   *     扫描侧把这些会话收进**分批回补**（C6），由同一函数在**允许**时放行）；
   *   · 取不到时间信号 ⇒ `{ok:false, reason:'no-time-signal'}`，**保守不放行**
   *     （与扫描"取不到 mtime 就跳过"同向；调用方按 plain skip 处理，不计成失败重试）。
   * **`mode:'backfill'`（C6 回补路径专用，唯一一处合法的"跳过年龄上限"）**：只放松**年龄上限**这一个上界，
   * **静置下限（6h）照旧强制**（用户裁定 §10.2 只要求"年龄上限不得造成永久遗漏"，从未放松静置门）。
   * 若不这样做，回补就永远入不了队 —— 因为"超龄"恰恰**是**入池条件，而自动入口的门会以同一个
   * `too-old` 把回补尝试原样挡回（本批实测：`tooOldDiscovered=1` 而 `tooOldQueued=0`）。
   * 资格判定仍然只有这一个函数（回补不是"另一套判据"，而是同一判据的显式放宽模式）。
   * 纯函数（除可选的 mtime 自取外无副作用）；`explicit`（用户/模型点名）**不经此门**。
   * **F2（2026-10-01）**：`idleFor` 的基准改为**内容观测时刻**（调用方给的 `contentAtMs`，否则查已落盘的
   *   `contentSeen` 记录）；宿主不提供内容身份 ⇒ 见 `contentClockFor` 的注释块。物理文件时间只在
   *   "既无内容记录、调用方也没给"时回退，并在返回体里以 `timeBasis` 标注（`content` / `file-mtime` / `none`）。
   * @returns `{ ok, reason, mtimeMs, idleFor, mode }`
   */
  const qualifiesForAutoIngest = ({ header = null, snapshot = null, mtimeMs = 0, contentAtMs = 0, nowMs = 0, mode = 'auto' } = {}) => {
    const now = Number(nowMs) > 0 ? Number(nowMs) : Date.now()
    const idleHours = Number(config.minRolloutIdleHours)
    const ageDays = Number(config.maxRolloutAgeDays)
    const idleMs = (Number.isFinite(idleHours) && idleHours > 0 ? idleHours : DEFAULT_MIN_ROLLOUT_IDLE_HOURS) * 3600000
    const ageMs = (Number.isFinite(ageDays) && ageDays > 0 ? ageDays : DEFAULT_MAX_ROLLOUT_AGE_DAYS) * 86400000
    // 上界（年龄）只有 `auto` 模式强制；`backfill` 模式**放松上界**（下界仍然强制，见文档块）。
    const ageCapApplies = mode !== 'backfill'
    let mt = Number(mtimeMs)
    if (!(mt > 0)) {
      try {
        const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence', false) : undefined
        mt = sessionSourceMtimeMs(persistence, header, snapshot)
      } catch { mt = 0 }
    }
    // **F2**：内容计时优先 —— 调用方给出 `contentAtMs` 就用它，否则查已落盘的 `contentSeen` 记录。
    const contentMs = Number(contentAtMs) > 0 ? Number(contentAtMs) : contentFirstSeenAtMs(header && header.id)
    if (contentMs > 0) {
      const idleFor = now - contentMs
      if (idleFor < idleMs) return { ok: false, reason: 'not-idle-enough', mtimeMs: mt, idleFor, mode, timeBasis: 'content' }
      if (ageCapApplies && idleFor > ageMs) return { ok: false, reason: 'too-old', mtimeMs: mt, idleFor, mode, timeBasis: 'content' }
      return { ok: true, reason: '', mtimeMs: mt, idleFor, mode, timeBasis: 'content' }
    }
    // 回退：物理文件时间（调用方既没给内容时刻、也没落盘记录）。返回体标 `file-mtime` 便于审计。
    if (!(mt > 0)) return { ok: false, reason: 'no-time-signal', mtimeMs: 0, idleFor: 0, mode, timeBasis: 'none' }
    const idleFor = now - mt
    if (idleFor < idleMs) return { ok: false, reason: 'not-idle-enough', mtimeMs: mt, idleFor, mode, timeBasis: 'file-mtime' }
    if (ageCapApplies && idleFor > ageMs) return { ok: false, reason: 'too-old', mtimeMs: mt, idleFor, mode, timeBasis: 'file-mtime' }
    return { ok: true, reason: '', mtimeMs: mt, idleFor, mode, timeBasis: 'file-mtime' }
  }

  /**
   * D2：登记"未提炼"碑 —— **不读已删语料、不重试抢救、不拦删除、不催办**；不依赖任何第三方插件
   * （判定只靠官方 `sessionPersistence.list()` 的缺席 / 读源失败 + 我们自己的台账）。
   */
  const recordUnrefined = async (sessionId, reason, extra = {}) => {
    const id = String(sessionId || '').trim()
    if (!id) return false
    try {
      await withWrite(async () => {
        const m = readStage1Meta()
        const all = m.unrefined && typeof m.unrefined === 'object' ? { ...m.unrefined } : {}
        const prev = all[id] && typeof all[id] === 'object' ? all[id] : {}
        all[id] = {
          sessionId: id,
          firstSeenAt: prev.firstSeenAt || nowIso(),
          detectedAt: nowIso(),
          reason: String(reason || 'source-unavailable'),
          wasEnqueued: !!(extra.wasEnqueued || prev.wasEnqueued),
          attempts: Number(prev.attempts || 0) + 1,
        }
        await writeStage1Meta({ unrefined: all, unrefinedLastAt: nowIso() })
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * **统一摄入口**（三个触发面唯一的入队路径）：读正文 → 根会话门 → 入队（去重交给既有机制）。
   * @param opts.explicit  true = B/C 显式入口（不受 `generateMemories` 自动开关约束，与 memory_precompact 同侧）
   * @param opts.header    已知血缘头（事件路径带进来，省一次读）
   * @param opts.liveSession 事件路径的 live 会话（持久读取为空时的回退）
   */
  async function ingestSessionById(sessionId, opts = {}) {
    const id = String(sessionId || '').trim()
    if (!id) return { queued: false, reason: 'missing-session-id', sid: '' }
    // t249（T33-一）：**内部执行者会话永不作来源** —— 入队前先按可信创建记录判身份（三条触发面共用此一处）。
    //   放在最前（连 `generateMemories` 开关之前）：显式入口（B/C）也不得把它变成来源。
    const preReason = internalExecutionReason({ header: opts.header, sessionId: id, ledger: executorSessionLedger() })
    if (preReason) return { queued: false, reason: 'internal-executor-session', internalReason: preReason, sid: id }
    if (opts.explicit !== true && config.generateMemories === false) {
      return { queued: false, reason: 'generate-memories-disabled', sid: id }
    }
    // ── C4（契约 §C4 ②）：**自动入口的资格前置** —— 唯一的资格判定（上面 `qualifiesForAutoIngest`）。
    //   自动入口（`opts.explicit !== true`）在**读源与入队之前**先过这道门；不合格 ⇒ 直接返回，
    //   **不进 `stage1_jobs`**。显式入口（B/C，`explicit === true`）**不经此门**（用户点名即授权）。
    //   扫描趟已在进门前用同一函数过滤，故此门对扫描路径是**幂等复核**（不会误拦）；`opts.mtimeMs`
    //   由扫描传入 ⇒ 不重复 stat。
    if (opts.explicit !== true) {
      const q = qualifiesForAutoIngest({ header: opts.header, snapshot: opts.snapshot || null, mtimeMs: opts.mtimeMs, contentAtMs: opts.contentAtMs, nowMs: opts.nowMs, mode: opts.mode === 'backfill' ? 'backfill' : 'auto' })
      if (!q.ok) {
        // `no-time-signal` 与"还没静置够"分开报（可观测性：别把两类混成一个数）。
        return { queued: false, reason: q.reason, sid: id, idleFor: q.idleFor, mtimeMs: q.mtimeMs }
      }
    }
    let raw = ''
    let lineageHeader = opts.header && typeof opts.header === 'object' ? opts.header : null
    let persisted = null
    try {
      persisted = await sessionMessagesByPersistence(id)
      if (persisted && persisted.header) lineageHeader = persisted.header
      if (persisted && Array.isArray(persisted.messages)) raw = messagesToDraftBody(persisted.messages)
    } catch { /* 读源失败：下面按 live 回退 / 记碑 */ }
    // 读回来的头里带血缘/预算标记（例如 `delegationDepth>0`）时也判一次（头可能比入参更权威）。
    const headerReason = internalExecutionReason({ header: lineageHeader, sessionId: id, ledger: executorSessionLedger() })
    if (headerReason) return { queued: false, reason: 'internal-executor-session', internalReason: headerReason, sid: id }
    if (!isRootSessionHeader(lineageHeader)) return { queued: false, reason: 'non-root-session', sid: id }
    if (!raw && opts.liveSession && typeof opts.liveSession.deriveMessages === 'function') {
      try { raw = messagesToDraftBody(opts.liveSession.deriveMessages()) } catch { /* ignore */ }
    }
    if (!raw) {
      if (persisted && persisted.sourceStatus === 'unavailable') {
        await recordUnrefined(id, 'source-unavailable-at-ingest', { wasEnqueued: opts.wasEnqueued })
        return { queued: false, reason: 'source-unavailable', sid: id }
      }
      // 空源/短源**照旧入队**（保持 v0.1.19 的行为：作业入队后由 drain 判 `succeeded_no_output`，
      //   理由 empty_source / short_content / model_empty）——绝不在这里改成"静默不入队"。
      //   与 `session/disposed` 路径的既有语义一致（同一套逻辑，不许两套）。
    }
    const watermark = contentWatermark(raw)
    const enq = await enqueueStage1JobIntoTable(
      id,
      watermark,
      {
        sourceWatermarkKind: 'content-body',
        ...(opts.forced === true ? { forced: true, forceReason: opts.forceReason || 'explicit-entry' } : {}),
        // F1（2026-10-01）：记下"**显式入口**入的队" —— 消费阶段发现正文已变时，自动作业作废、
        //   显式/强制作业保持即时（但仍须引用实际消费的那一版）。
        ...(opts.explicit === true ? { explicit: true } : {}),
      },
    )
    return { ...enq, sid: id, watermark, reason: enq && enq.queued ? '' : 'already-ingested' }
  }

  /** `scanSeen` 记账裁剪：按 mtimeMs 保留最新 N 条。 */
  const capScanSeen = (seen, max = SCAN_SEEN_MAX_ENTRIES) => {
    const ids = Object.keys(seen)
    if (ids.length <= max) return seen
    const keep = ids
      .sort((a, b) => Number(seen[b] && seen[b].mtimeMs || 0) - Number(seen[a] && seen[a].mtimeMs || 0))
      .slice(0, max)
    const out = {}
    for (const id of keep) out[id] = seen[id]
    return out
  }

  /**
   * **F3（评估 §三 F3）· 回补公平规则的 K**：连续 `K-1` 趟"池非空却一格没取到" ⇒ 第 K 趟**强制**把
   * 主循环的上限压到 `remaining-1`，留 1 格给回补。**不扩大总预算、不加第二套任务平台。**
   * ⚠️ 预算 = 1 时无法拆分（那 1 格会被主循环用掉）⇒ 公平规则退化为无，如实登记。
   */
  const BACKFILL_FAIRNESS_K = 3

  /**
   * **F2（评估 §三 F2）· 内容计时**：把"静置 6h / 年龄 10 天"的基准从**物理文件 mtime** 换成
   * **内容观测时刻**。
   *
   * 为什么不能再用 mtime：宿主**不提供内容身份** —— asar 内 `dsh-session-persistence-jsonl` 的
   * `fileRevision(identity)` = `[dev, ino, size, mtimeNs, ctimeNs].join(':')`（**stat 派生**；复制/搬迁/
   * 触碰都会变），快照里的 `sizeBytes` 是**物理文件长度**（同源注释：physical artifact size）；
   * `list()` 快照没有 `updatedAt`、也没有 content hash。⇒ 只能用**自建的最小内容变更记录**。
   *
   * 记录（不新增表）：`stage1_meta.meta.contentSeen[sid] = { sizeBytes, watermark, firstSeenAt, firstSeenSource }`
   *   · `sizeBytes` 未变 ⇒ **不读正文**、沿用 `firstSeenAt`（复制/改文件元信息 ⇒ **不重置**计时）；
   *   · `sizeBytes` 变了 ⇒ 只读**那一条**会话的正文算水位：与记录里的 `watermark` 相同 ⇒ 视为重写/
   *     压实（**不重置**）；不同 ⇒ 新内容 ⇒ `firstSeenAt = 现在`（**重置**）；
   *   · 首次观测（无记录）⇒ 用**既有物理时间**（文件 mtime）**一次性播种**并标 `seeded-from-file-mtime`
   *     （**不声称是内容时间、不加精度**；物理时间读不到才退回"现在"）—— 避免迁移时整库白等 6h；
   *     播种只发生一次，此后**一律内容计时**（判据①/②都建立在"记录已存在"之后的状态上）；
   *   · 读不到正文 ⇒ 沿用旧 `firstSeenAt`，标 `unreadable`（不重置、不伪造）。
   * 失败模式是保守的：最多多等一轮 6h，绝不放行"拿新内容冒充旧版本"。
   */
  const capContentSeen = (map, max = SCAN_SEEN_MAX_ENTRIES) => {
    const ids = Object.keys(map || {})
    if (ids.length <= max) return map
    const keep = ids
      .sort((a, b) => String((map[b] && map[b].firstSeenAt) || '').localeCompare(String((map[a] && map[a].firstSeenAt) || '')))
      .slice(0, max)
    const out = {}
    for (const id of keep) out[id] = map[id]
    return out
  }
  const contentSeenMap = () => {
    const m = readStage1Meta()
    return m.contentSeen && typeof m.contentSeen === 'object' ? { ...m.contentSeen } : {}
  }
  /** 取某会话的内容计时起点（毫秒）；无记录 ⇒ 0（调用方决定回退）。 */
  const contentFirstSeenAtMs = (sessionId) => {
    const sid = String(sessionId || '')
    if (!sid) return 0
    const rec = contentSeenMap()[sid]
    const t = rec && rec.firstSeenAt ? Date.parse(rec.firstSeenAt) : 0
    return Number.isFinite(t) && t > 0 ? t : 0
  }
  /**
   * 取/刷新内容计时记录。
   * `opts.persist !== false` ⇒ 立即合并写回该 key（`session/disposed` 路径用）；
   * 扫描趟传 `persist:false`，把返回的 `record` 收进本趟 map，趟末随 `scanSeen` 一次性写。
   * @returns `{ firstSeenAtMs, source, record }`
   */
  const contentClockFor = async (sessionId, snap, opts = {}) => {
    const sid = String(sessionId || '')
    if (!sid) return { firstSeenAtMs: 0, source: 'no-id', record: null }
    const sig = Number((snap && snap.sizeBytes) || 0)
    // **R1（复核 §三 R1）**：物理元信息（长度 / `revision`）**降级为"线索"**，不是内容身份 ——
    //   线索**任一**变化都触发"读那一条正文核对水位"（不做全库重算）；`revision` 是宿主 stat 派生的
    //   `dev:ino:size:mtimeNs:ctimeNs`，能抓住"同长度改写/替换"这类只看长度会漏掉的情形。
    const rev = String((snap && snap.revision) || '')
    const prev = contentSeenMap()[sid]
    const stamp = nowIso()
    const persist = async (record) => {
      if (opts.persist === false) return
      const map = contentSeenMap()
      map[sid] = record
      try { await writeStage1Meta({ contentSeen: capContentSeen(map) }) } catch { /* 记账失败不改结论 */ }
    }
    if (!prev || !prev.firstSeenAt) {
      // **首次观测的播种口径（迁移）**：我们**不知道真实内容时间**，但也不能把整库都推成"刚从此刻开始
      //   —— 那会让所有既有会话白等 6h。折中且可审计：用**既有物理时间**（文件 mtime）**一次性播种**，
      //   并在记录里标 `firstSeenSource:'seeded-from-file-mtime'`（**不声称它是内容时间、也不加精度**）。
      //   此后一律走内容计时 ⇒ 判据①（复制/改元信息**不重置**）与判据②（新对话**重置**）都成立；
      //   物理时间读不到 ⇒ 保守用"现在"（`first-observation`）。
      const seedMs = Number(opts.seedMtimeMs) > 0 ? Number(opts.seedMtimeMs) : Date.parse(stamp)
      // 首次观测：**基线未知**（`watermark:''`）—— 只能播种计时起点，**不声称**已确认内容身份（R2）。
      const record = {
        sizeBytes: sig,
        revision: rev,
        watermark: '',
        firstSeenAt: new Date(seedMs).toISOString(),
        firstSeenSource: Number(opts.seedMtimeMs) > 0 ? 'seeded-from-file-mtime' : 'first-observation',
      }
      await persist(record)
      return { firstSeenAtMs: seedMs, source: record.firstSeenSource, record }
    }
    const prevAt = Date.parse(prev.firstSeenAt)
    const keepAt = Number.isFinite(prevAt) && prevAt > 0 ? prevAt : 0
    if (Number(prev.sizeBytes) === sig && String(prev.revision || '') === rev) {
      // 线索完全没变 ⇒ 走**契约内快路径**（宿主消息追加是 `open(path,'a')`；见报告"宿主写入契约"节）。
      // ⚠️ 契约外（同长度原地改写/替换且 revision 也未变）不保证 —— 这是**有意**接受的优化。
      return { firstSeenAtMs: keepAt, source: 'unchanged', record: null }
    }
    // 线索变了 ⇒ **必须核对内容身份**（只读这一条）。
    let wm = ''
    try {
      const p = await sessionMessagesByPersistence(sid)
      if (p && p.sourceStatus === 'unavailable') {
        // **无法确认身份 ⇒ 不得借旧时钟放行**（R1）：本轮按"刚更新"处理；**不落盘**（旧记录保留，
        //   恢复可读后再核对，不会把一次临时读失败永久转成"内容已变"）。
        return { firstSeenAtMs: Date.parse(stamp), source: 'identity-unconfirmed', record: null }
      }
      if (!(p && Array.isArray(p.messages) && p.messages.length)) {
        return { firstSeenAtMs: Date.parse(stamp), source: 'identity-unconfirmed-empty', record: null }
      }
      wm = contentWatermark(messagesToDraftBody(p.messages))
    } catch {
      return { firstSeenAtMs: Date.parse(stamp), source: 'identity-unconfirmed-error', record: null }
    }
    if (wm && prev.watermark && wm === prev.watermark) {
      // **核对到同一正文** ⇒ 沿用旧时钟（管理操作 / 重写 / 搬迁 **不重置**）✔
      const record = { sizeBytes: sig, revision: rev, watermark: wm, firstSeenAt: prev.firstSeenAt, firstSeenSource: 'metadata-only' }
      await persist(record)
      return { firstSeenAtMs: keepAt, source: 'metadata-only', record }
    }
    // **基线未知 + 线索变了 ⇒ 不借旧时钟放行**：按新内容重置并**建立基线**（R2）；
    //   基线已知且核对到不同正文 ⇒ 同样是新内容重置。
    const record = {
      sizeBytes: sig,
      revision: rev,
      watermark: wm,
      firstSeenAt: stamp,
      firstSeenSource: prev.watermark ? 'content-change' : 'baseline-established',
    }
    await persist(record)
    return { firstSeenAtMs: Date.parse(stamp), source: record.firstSeenSource, record }
  }

  /**
   * A：**静置扫描**（统一摄入的自动入口）。数据面只用官方 `sessionPersistence`
   * （`list()` → `{header, revision, sizeBytes}`；时间取 `locate(meta).path` + `fs.stat`）。
   * 候选 = 根会话 + 静置窗口 + 年龄窗口；每趟有界（复用 `maxSourcesPerStartup` 的 per-pass 语义）。
   * **不读归档账本、不监听任何第三方插件状态**（归档最多是可选的只读注解，本轮不做）。
   *
   * **R2（评审 P1）**：`scanSeen` 是「**完成水位**」，只在**确知已入队/已处理**时推进；读源失败等
   * 「尝试过但失败」的候选只计 `stats.deferred`，**不写** `scanSeen` ⇒ 临时故障恢复后同一 mtime
   * 仍会被重新入队。已知取舍（如实登记，本轮不改）：入队上限按 `enqueued` 计，失败多时本趟仍会
   * 继续读更多候选，即"最多入队 N 条 ≠ 最多读源 N 条"；无故障耗时数据，不据此加调参平台。
   */
  async function ingestIdleScan(reason = 'idle-scan') {
    const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence', false) : undefined
    if (!persistence || typeof persistence.list !== 'function') {
      return { ran: false, reason: 'session-persistence-unavailable', scanned: 0, enqueued: 0 }
    }
    let snapshots
    try {
      snapshots = await persistence.list({})
    } catch (err) {
      return { ran: false, reason: 'session-list-failed: ' + String((err && err.message) || err), scanned: 0, enqueued: 0 }
    }
    const list = Array.isArray(snapshots) ? snapshots : []
    const budget = perPassSourceBudget()
    const now = Date.now()
    const m0 = readStage1Meta()
    const seen = m0.scanSeen && typeof m0.scanSeen === 'object' ? { ...m0.scanSeen } : {}
    // F2：本趟起始的内容计时记录（读一次；趟末与 scanSeen 一起写回）。
    const contentSeenBase = contentSeenMap()
    // C6：`tooOld` 拆成**两个可观测面** —— 发现（超龄、进回补池）与本趟纳入（按预算入队）。
    //   旧实现把两者压成一个 `tooOld` 且**永久跳过**；用户裁定 §10.2 要求"不得继续无说明地跳过长期归档会话"。
    const stats = {
      scanned: list.length, candidates: 0, enqueued: 0, nonRoot: 0, fresh: 0,
      tooOldDiscovered: 0, tooOldQueued: 0, done: 0, sourceGone: 0, deferred: 0, internal: 0,
      nonRootDeferred: 0,
      // 顺手收口②（评估 §六）：根会话取不到时间信号而跳过的条数 —— **明确计数**，不再"一条统计都不计"。
      noTimeSignal: 0,
      // F2：为内容计时读过的正文条数（只在 `sizeBytes` 变化时读 ⇒ 不是每趟全量重算）。
      contentBodyReads: 0,
      // F3：本趟是否因公平规则为回补**保留**了 1 格预算（可观测）。
      backfillReserved: 0,
    }
    // 顺手收口①（评估 §六）：原 `tooOldDeferred` / `notIdleDeferred` **结构性恒 0**（其自增点在
    //   "已过资格门"的分支里，永不触发）⇒ 按评估"删掉或改准含义"**删除**；真实原因由 `noTimeSignal` /
    //   `nonRootDeferred` / `deferred` 与作业记录里的 `last_skip_reason` 承担。
    const backfillPool = []
    // F2：本趟累积的内容计时记录（趟末随 `scanSeen` 一次性写，避免每会话一次 meta 写）。
    const contentSeenNext = { ...contentSeenBase }
    // F3：**总预算内的小型公平规则** —— 上一趟"池非空却一格没取到"的连续趟数达 `K-1` ⇒ 本趟主循环
    //   上限压到 `remaining-1`，**强制留 1 格给回补**（不扩大总预算、不加第二套任务平台）。
    const prevBf = m0.backfill && typeof m0.backfill === 'object' ? m0.backfill : null
    const prevBfWait = Number((prevBf && prevBf.waitPasses) || 0)
    const reserveForBackfill = prevBfWait >= BACKFILL_FAIRNESS_K - 1 && Number((prevBf && prevBf.poolSeen) || 0) > 0
    const mainEnqueueCap = Math.max(0, budget.remaining - (reserveForBackfill ? 1 : 0))
    if (reserveForBackfill) stats.backfillReserved = 1
    const ledger0 = executorSessionLedger()
    for (const snap of list) {
      const header = snap && snap.header && typeof snap.header === 'object' ? snap.header : null
      if (!header || !header.id) continue
      // t249/t250（T33-一、T34 更正）：**内部执行者会话永不作候选**。放在根会话判据**之前**：
      //   身份 = 我们自己的创建台账 ∨ 执行者 id 前缀（辅助）；**不含** `delegationDepth`（那是普通子代理
      //   也会带的血缘字段，单独用它会把 77 个普通子代理会话误标成内部执行者——真机实测）。普通子代理
      //   会话照旧由下面的 `isRootSessionHeader` 按**非根**跳过（行为不变，计数与理由串不再混淆）。
      //   命中 ⇒ 单独计数 + **推进 scanSeen 水位**（"永不入队"是终局决定，不必每周期重查）。
      const intR = internalExecutionReason({ header, sessionId: header.id, ledger: ledger0 })
      if (intR) {
        stats.internal += 1
        const mt = sessionSourceMtimeMs(persistence, header, snap)
        if (mt) seen[header.id] = { mtimeMs: mt, at: nowIso(), queued: false, reason: 'internal-executor-session:' + intR }
        continue
      }
      // 落点③（用户 2026-09-30 裁定）：**血缘门保持不动**，但必须把它显式登记/计数为
      //   "**已发现未资格（血缘门）**"，与"读源不可用"同等待遇 —— 不许静默跳过（§9.2：不得仅因旧代码
      //   如此就宣称"任意会话已覆盖"）。既有面 `nonRoot` 保留（工具 schema 原有），新增面
      //   `nonRootDeferred` 与其它"已发现未提炼"的原因并列。
      if (!isRootSessionHeader(header)) { stats.nonRoot += 1; stats.nonRootDeferred += 1; continue }
      const mtimeMs = sessionSourceMtimeMs(persistence, header, snap)
      if (!mtimeMs) {
        // 顺手收口②（评估 §六）：根会话取不到时间信号 —— **计数 + 原因**（日志在趟末统一打），
        //   不再"一条统计都不计"。仍保守跳过（不推进水位、不算失败重试）。
        stats.noTimeSignal += 1
        continue
      }
      // **F2**：内容计时起点（宿主无内容身份 ⇒ 自建最小内容变更记录；只在 `sizeBytes` 变化时读正文）。
      const clock = await contentClockFor(header.id, snap, { persist: false, seedMtimeMs: mtimeMs })
      if (clock.record) contentSeenNext[header.id] = clock.record
      if (clock.source === 'content-change' || clock.source === 'metadata-only') stats.contentBodyReads += 1
      // **C4**：同一个资格函数给出窗内 / 超龄 / fresh 的分档（不再内联两段 if）。
      // **F2**：静置 / 年龄以 **内容观测时刻** 为基准（`contentAtMs`），不再用物理文件 mtime。
      const q = qualifiesForAutoIngest({ header, snapshot: snap, mtimeMs, contentAtMs: clock.firstSeenAtMs, nowMs: now })
      if (!q.ok && q.reason === 'not-idle-enough') { stats.fresh += 1; continue }
      if (!q.ok && q.reason === 'too-old') {
        // D1（2026-10-01 · 真机取证后收窄）：**先过完成水位**再计"发现" —— "早已提炼完成、只是后来超龄"的会话不得每趟被计成"发现"。
        const prevTooOld = seen[header.id]
        if (prevTooOld && Number(prevTooOld.mtimeMs) >= mtimeMs) { stats.done += 1; continue }
        // C6：超龄**不再永久跳过** —— 收进回补池（= **发现**），相 2 按"最老优先 + 剩余预算"纳入。
        stats.tooOldDiscovered += 1
        backfillPool.push({ header, snap, mtimeMs })
        continue
      }
      // 兜底：已知原因（not-idle-enough / too-old）都在上面分流；这里只可能是 no-time-signal，
      //   按"尝试过但没入队、不推进水位"如实计 `deferred`（下次扫描仍会重试）。
      if (!q.ok) { stats.deferred += 1; continue }
      // **R3（复核 §三 R3）· 发现与预算解耦**：达到本趟入队上限后**不再提前 `break`** —— 继续走完清单，
      //   把**队尾**的超龄来源收进回补池、其余状态照常分类；只是不再入队。总预算仍由 `mainEnqueueCap`
      //   封顶，回补池再按**同一总预算 + 公平规则**取名额（预算 = 1 时该趟主循环 0 格，唯一名额给回补）。
      if (stats.enqueued >= mainEnqueueCap) { stats.deferred += 1; continue }
      const prev = seen[header.id]
      if (prev && Number(prev.mtimeMs) >= mtimeMs) { stats.done += 1; continue } // 该活动已处理过 ⇒ 不重复入队
      stats.candidates += 1
      // F2：把本趟算出的**内容计时起点**一路带进入队口（`ingestSessionById` 的资格复核与扫描同基准）。
      const out = await ingestSessionById(header.id, { header, explicit: false, snapshot: snap, mtimeMs, contentAtMs: clock.firstSeenAtMs, nowMs: now })
      // **R2（复核 §三 R2）**：入队那一趟**已经读过正文、算过水位** ⇒ 把该水位**回填**成内容计时基线
      //   （**不重复读**）。回填后，后续"线索变但正文没变"才能被正确判成"不重置"。
      if (out && out.watermark) {
        const baseRec = contentSeenNext[header.id] || contentSeenBase[header.id] || null
        const atMs = clock.firstSeenAtMs > 0 ? clock.firstSeenAtMs : now
        contentSeenNext[header.id] = {
          sizeBytes: Number((snap && snap.sizeBytes) || 0),
          revision: String((snap && snap.revision) || ''),
          watermark: String(out.watermark),
          firstSeenAt: new Date(atMs).toISOString(),
          firstSeenSource: (baseRec && baseRec.firstSeenSource) || 'content-change',
        }
      }
      // **R2（评审 P1）**：只把「**确知已入队/已处理**」的尝试登记成完成水位；「尝试过但失败」**不推进**
      //   `scanSeen`，这样临时读不到来源（`source-unavailable`）在恢复后**同一 mtime 还能再入队**。
      //   旧代码在此**无条件**写 `seen[id]`，下一次扫描按 `prev.mtimeMs >= mtimeMs` 永久跳过 ⇒
      //   一次临时读失败被转成长期摄入遗漏（评审独立复现：恢复服务后 done=1、candidates=0、enqueued=0）。
      //   记录"确知已处理"的两类（与入队去重语义一一对应）：
      //     · `queued:true` —— 本次真入了队（含 `failed_terminal` 被重置回 pending 的重入队）；
      //     · `reason:'already-ingested'` —— 同 `session::watermark` 已在 `stage1_jobs`/`stage1_seen` ⇒ 确知已处理。
      //   其余（`source-unavailable` / `generate-memories-disabled` / 其它未入队原因）一律**只记 deferred**，
      //   不推进水位 ⇒ 允许既有扫描周期下有界重试（不另建故障管理平台，也不无限重试：扫描周期 30 分钟）。
      const alreadyKnown = out && out.reason === 'already-ingested'
      // 兜底：入队口若判出内部身份（例如头里没标记、靠台账认出）⇒ 与上面同处理（计数 + 推进水位）。
      if (out && out.reason === 'internal-executor-session') {
        stats.internal += 1
        seen[header.id] = { mtimeMs, at: nowIso(), queued: false, reason: 'internal-executor-session:' + String(out.internalReason || '') }
        continue
      }
      if ((out && out.queued) || alreadyKnown) {
        seen[header.id] = { mtimeMs, at: nowIso(), queued: !!(out && out.queued), reason: String((out && out.reason) || '') }
      } else {
        // 用户口径①：把"已发现但未提炼"的**具体原因**分开计数（不许静默消失）。
        //   顺手收口①（2026-10-01）：原 `tooOldDeferred` / `notIdleDeferred` **结构性恒 0**
        //   （本分支只在 `out.reason` 为其它值时到达）⇒ 已按评估**删除**；此处如实计 `deferred`，
        //   具体原因看作业记录的 `last_skip_reason`。
        stats.deferred += 1
      }
      if (out && out.queued) stats.enqueued += 1
      if (out && out.reason === 'source-unavailable') stats.sourceGone += 1
      // R3：**不再 break** —— 上限已由循环前的守卫保证；本趟继续走完清单以完成"发现"（否则队尾来源永不被看见）。
    }
    // ── 相 2：C6 分批回补（**最老优先** + **同一资格判定** + **同一去重** + 每趟 ≤ 剩余预算）────────
    //   "最老优先"必须显式排序：主循环的中断条件是"入队数达预算即 break"，按清单顺序取会让"最老的排在
    //   清单末尾"时被无限推迟 —— 那正是用户 §10.2 要消除的"无说明地永久跳过"。
    // D2 口径（2026-10-01）：`backfill.cursor` **每趟重置**；语义 = **本趟最后一个走到"尝试入队"那一步的候选 id**
    //   （写入点只有两处：资格不合格 / 迭代末）；空值只表示"**本趟没走到尝试**"（池空 / 闸门关 / 候选全被
    //   完成水位挡下），**不表示**"从未成功纳入"；它不是跨趟进度游标。
    // F3：`poolSeen` / `waitPasses` 是**公平规则自己的输入**（跨趟持久 —— 上一趟状态决定本趟是否
    //   保留 1 格）；`cursor` 仍是**本趟诊断**（每趟重置，见上面的 D2 口径注释）。
    const backfill = {
      lastScannedAt: nowIso(),
      cursor: '',
      poolSeen: backfillPool.length,
      waitPasses: backfillPool.length > 0 && stats.tooOldQueued === 0 ? prevBfWait + 1 : 0,
      reserved: reserveForBackfill ? 1 : 0,
    }
    if (stats.enqueued < budget.remaining && backfillPool.length) {
      backfillPool.sort((a, b) => a.mtimeMs - b.mtimeMs)   // mtimeMs 升序 = 最老优先
      for (const cand of backfillPool) {
        if (stats.enqueued >= budget.remaining) break
        const prev = seen[cand.header.id]
        if (prev && Number(prev.mtimeMs) >= cand.mtimeMs) { stats.done += 1; continue }  // 已处理过 ⇒ 不重复
        // 同一函数**再判一次**（窗口/配置可能在两趟之间被改过）。
        const q2 = qualifiesForAutoIngest({
          header: cand.header, snapshot: cand.snap, mtimeMs: cand.mtimeMs, nowMs: now, mode: 'backfill',
        })
        if (!q2.ok) {
          // 顺手收口①：原 `tooOldDeferred`（结构性恒零）已删 ⇒ 记"本趟延后" + 游标留痕。
          stats.deferred += 1
          backfill.cursor = String(cand.header.id)
          continue
        }
        const out = await ingestSessionById(cand.header.id, {
          header: cand.header, explicit: false, snapshot: cand.snap, mtimeMs: cand.mtimeMs, nowMs: now, mode: 'backfill',
        })
        const wasQueued = !!(out && out.queued)
        // 兜底：入队口若判出内部身份（例如头里没标记、靠台账认出）⇒ 与主循环同处理（计数 + 推进水位）。
        if (out && out.reason === 'internal-executor-session') {
          stats.internal += 1
          seen[cand.header.id] = { mtimeMs: cand.mtimeMs, at: nowIso(), queued: false, reason: 'internal-executor-session:' + String(out.internalReason || '') }
          continue
        }
        if (wasQueued || (out && out.reason === 'already-ingested')) {
          seen[cand.header.id] = { mtimeMs: cand.mtimeMs, at: nowIso(), queued: wasQueued, reason: String((out && out.reason) || '') }
        } else {
          stats.deferred += 1
        }
        if (wasQueued) { stats.enqueued += 1; stats.tooOldQueued += 1 }
        if (out && out.reason === 'source-unavailable') stats.sourceGone += 1
        backfill.cursor = String(cand.header.id)
      }
    }
    try {
      await writeStage1Meta({
        scanSeen: capScanSeen(seen), scanLastAt: nowIso(), scanLastReason: String(reason), scanLastStats: stats, backfill,
        // F2：本趟的内容计时记录（与 scanSeen 同一次写，避免每会话一次 meta 写）。
        contentSeen: capContentSeen(contentSeenNext),
      })
    } catch { /* 记账失败不改扫描结论 */ }
    // 观测面（C6 ⑤）：显式区分"已发现/待资格处理"与"已提炼"，并给超龄回补的独立计数。
    try {
      console.info(
        '[dsh-memory_rollout] idle scan (' + String(reason) + '): scanned=' + stats.scanned + ' candidates=' + stats.candidates + ' enqueued=' + stats.enqueued +
        ' | nonRoot=' + stats.nonRoot + ' internal=' + stats.internal + ' fresh=' + stats.fresh +
        ' | tooOldDiscovered=' + stats.tooOldDiscovered + ' tooOldQueued=' + stats.tooOldQueued +
        ' nonRootDeferred(血缘门待资格处理)=' + stats.nonRootDeferred + ' noTimeSignal(无时间信号)=' + stats.noTimeSignal +
        ' | done(完成水位挡下)=' + stats.done + ' sourceGone=' + stats.sourceGone + ' deferred=' + stats.deferred +
        ' | contentBodyReads=' + stats.contentBodyReads + ' backfillCursor=' + (backfill.cursor || '-') +
        ' backfillPool=' + backfill.poolSeen + ' backfillWaitPasses=' + backfill.waitPasses + ' backfillReserved=' + backfill.reserved,
      )
    } catch { /* 日志失败不影响结论 */ }
    return { ran: true, ...stats }
  }

  /** 读取 D2 碑（供工具/观测；只读）。 */
  const unrefinedTombstones = () => {
    const m = readStage1Meta()
    return m.unrefined && typeof m.unrefined === 'object' ? m.unrefined : {}
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
  // v0.1.28：文件格式统一为 {version:1, savedAt, values:{…}}；**旧裸对象仍原样加载**（非破坏性）。
  const lastOverlayError = { reason: '' }
  const readSettings = () => {
    try {
      const o = JSON.parse(readText(settingsPath()))
      if (!o || typeof o !== 'object') return {}
      if (o.values && typeof o.values === 'object' && !Array.isArray(o.values)) return o.values
      return o
    } catch {
      return {}
    }
  }
  const saveSettings = (values) => writeText(settingsPath(), JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    values: { ...values },
  }, null, 2))

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
    } catch (err) {
      // v0.1.28：**不再静默**——记一条带原因的日志（boot 期也能在宿主日志里看到），
      //   同时保留 boot 期解析出的配置（一个非法 overlay 不应让插件起不来）。
      lastOverlayError.reason = String((err && err.message) || err)
      try {
        console.warn('[dsh-memory_rollout] settings overlay rejected: ' + lastOverlayError.reason + ' (path=' + settingsPath() + ')')
      } catch {}
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
        // t198（F1 兼容）：旧版遗痕字段必须**带过投影** —— 否则 `lastUsageOf` 的兼容读在召回路径上永远
        //   看不到它（投影丢字段 = 旧证据不可见，正是 F1 的成因之一）。只在读路径带上，**不重写**记录。
        last_used_at: String(value.last_used_at || ''),
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
          // t216（D1 · R2 §5.2 步 4）：确定性重建路径与发布路径**共用同一引用约定**（`memories/…`），
          // 且不再把裸会话号内联进自由文本（身份由路径承载；内联 `session=<uuid>` 会撞长串规则）。
          `- ${renderReferencePath(`rollout_summaries/${it.file}`)} (cwd=${it.cwd}, updated_at=${it.updatedAt})`,
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
          `- [${e.tags.join(',')}] ${redactSecrets(e.content)} (updated=${e.updatedAt})`,
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
        lines.push(`- ${m.cwd || '?'}: ${m.title} → ${renderReferencePath(`rollout_summaries/${m.file}`)}`)
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

  /**
   * Coarse input-token guard: cap the transcript by chars (≈ tokens × 4).
   *
   * F1（P1）：**头尾保留 + 明确标注省略区段**。旧实现 `raw.slice(0, cap)` 只留开头 ——
   *   长篇会话里"最后才定下来"的内容（纠正、定论）**通常在**尾部，只留开头可能让它们在提炼前
   *   就消失，后面队列/引用/发布即使全对，也无从据此写对
   *   （独立复现：48,083 字符会话，模型可见 32,026 字符，旧方案保留、末尾纠正不存在）。
   *   故改为：开头 + `[…中段 N 字符被省略…]` + 结尾。尾部固定占 ~40% 预算。
   *   **措辞边界（F1 返修）**：标记里只写"已保留开头与结尾；请特别关注尾部"这一**提示**，
   *   **不**对会话内容作事实断言（"最终决定一定在结尾"之类）；本函数保证的是**输入机会**，
   *   不是"模型必定记对"——结论正确性只能在真实闭环里验证。
   *
   * **已知限制（如实登记，不宣称无损）**：中段信息仍可能被省略；头尾保留是过渡保护，
   *   不是"按任务边界有界提炼"的替代品（后者属后续路线，本批不做）。
   */
  function truncateTranscript(raw, maxTokens) {
    const cap = Math.max(200, (maxTokens || 200000) * 4)
    const s = String(raw == null ? '' : raw)
    if (s.length <= cap) return s
    const marker = (dropped) =>
      `\n\n[...原会话中段 ${dropped} 字符因长度上限被省略（已保留开头与结尾；请特别关注尾部）...]\n\n`
    // 标记长度只用"最坏情形"（按全文长度估）算一次：dropped ≤ s.length ⇒ 实际标记只会更短，
    // 故 head + marker + tail ≤ cap 恒成立，无需迭代收敛。
    const tailBudget = Math.max(1, Math.floor(cap * 0.4))
    const markerReserve = marker(s.length).length
    const headBudget = Math.max(0, cap - tailBudget - markerReserve)
    const head = s.slice(0, headBudget)
    const tail = s.slice(Math.max(headBudget, s.length - tailBudget))
    const dropped = Math.max(0, s.length - head.length - tail.length)
    return head + marker(dropped) + tail
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
    const inputText = redactSecrets(truncateTranscript(prompt, config.maxExtractTokens || 200000))

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

  /**
   * **C4**：按会话 id 从官方 `sessionPersistence.list()` 取该会话快照（`{header,revision,sizeBytes}`）。
   * 用途 = 让"只有 id 的调用方"（`session/disposed` 的复查）也能用**同一个时间基准**判资格
   * （`sessionSourceMtimeMs`：首选 `locate()` 真文件 mtime，回退 `revision` 第 4 段）。
   * 只读、best-effort：拿不到 ⇒ `null`（调用方按"无时间信号 ⇒ 保守不放行"处理）。
   */
  async function sessionSnapshotById(sessionId) {
    const id = String(sessionId || '')
    if (!id) return null
    const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence', false) : undefined
    if (!persistence || typeof persistence.list !== 'function') return null
    try {
      const list = await persistence.list({})
      if (!Array.isArray(list)) return null
      for (const s of list) if (s && s.header && String(s.header.id) === id) return s
      return null
    } catch {
      return null
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
  async function submitStage1Job(claimed, status, extraction, errMsg, now, cwd, skipReason, opts = {}) {
    return withWrite(async () => {
      const key = stage1JobKey(claimed.session_id, claimed.source_watermark)
      // F1（2026-10-01）：**产出/证据/seen 必须引用"实际消费的那一版"**。正常路径 = 作业自己的水位；
      //   只有"显式/强制作业遇到正文已变"这一种情况，调用方才给 `consumedWatermark`。
      const recordedWatermark = String((opts && opts.consumedWatermark) || claimed.source_watermark)
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
          source_watermark: recordedWatermark,
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
        await stage1SeenTable.put(stage1JobKey(sid, recordedWatermark), {
          session_id: sid,
          source_watermark: recordedWatermark,
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
   *   - `scheduleStage1Drain(budget)` 把它绑在某一趟上；**启动/唤醒/事件趟都传 `perPassSourceBudget()`**
   *     （t210 对齐 codex「per pass」）；**只有显式工具 `memory__stage1_drain` 不传 ⇒ 不设限**；
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
      let reserveHeld = null
      let passCapReached = false
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
        // t210：**为整合保底**（本地补充设计，见 `stage1QuotaPlan` 注释）——存在未整合产物/变更时，
        //   提炼只在「这一发用掉后剩余仍 ≥ 门二所需的最小整数剩余」时才开工；否则停手，把额度留给整合。
        const quotaPlan = stage1QuotaPlan({
          attemptsToday: budget,
          maxAttemptsPerDay: cap,
          minRemainingPercent: config.minRemainingQuotaPercent,
          hasPendingConsolidation:
            immediatelyProcessableKind(
              stage1OutputsTable.entries(),
              memoryChangesTable.entries(),
              false,
              null,
            ) !== '',
        })
        if (!quotaPlan.allowed) {
          reserveHeld = quotaPlan
          try {
            console.info(
              `[dsh-memory_rollout] stage-1 quota reserve held for consolidation: used=${quotaPlan.used}/${quotaPlan.cap}, reserve=${quotaPlan.reserve} (threshold=${quotaPlan.thresholdPercent}%) — leaving room for phase 2`,
            )
          } catch {}
          break
        }
        // t189（②·门槛一）/t191/t210：**本趟**来源预算（codex 语义 = per pass）—— **先扫清死数据（上面的
        //   recover/reconcile），再判要不要继续开工**；到顶即止，剩余来源交给后续趟次/事件。预算是
        //   **跨趟共享的对象** ⇒ 补跑趟也吃同一额度。
        if (startupBudget && startupBudget.remaining <= 0) {
          passCapReached = true
          try {
            console.info('[dsh-memory_rollout] stage-1 pass source budget exhausted; remaining sources continue on later passes (>=30s spacing)')
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
        // F1：显式/强制作业"**实际消费的那一版**"水位（默认空 ⇒ 沿用作业自己的水位）。
        //   ⚠️ 作用域：提交调用在 `try` **之外**，所以必须在这里声明。
        let consumedOverride = ''
        try {
          // t249（T33-一）：**队列里已存在的内部作业也要过资格检查**（不能只堵新入口）。
          //   ⚠️ 与"读取失败可重试"是两件事：内部任务**从来不应成为来源** ⇒ 这里**不读源**、不重试，
          //   直接按 no-output 终态提交（`last_skip_reason` 落内部身份理由，便于复核"凭什么认出它"）。
          //   判定只用"我们自己的可信创建记录"（会话头 delegationDepth / 创建台账 / 名字前缀辅助），
          //   因此 `pending` 与 `failed_retryable` 的内部作业都会被这条路收掉，不再反复读源。
          const intReasonQ = internalExecutionReason({ header: null, sessionId: claimed.session_id, ledger: executorSessionLedger() })
          if (intReasonQ) {
            status = 'succeeded_no_output'
            skipReason = `internal_executor_session:${intReasonQ}`
            errMsg = `[dsh-memory_rollout] skip internal executor source (${intReasonQ}): ${claimed.session_id}`
          }
          let raw = ''
          let persisted = null
          // 内部执行会话：**不读源**（从来不该成为来源；也免得走"读失败→重试"那条路）。
          if (claimed.session_id && status !== 'succeeded_no_output') persisted = await sessionMessagesByPersistence(claimed.session_id)
          // P0 source-missing 与 no-output 分离：
          //  - persisted === null：sessionQuery 服务缺失（部署能力缺陷，非该会话源缺失）。
          //    P0-R2-3：不再标成 empty_source（那会让「插件读不了会话」伪装成「会话真的空」）——
          //    改为能力缺失专属原因 source_capability_missing，overview 以 capabilities.stage1SourceRead:false
          //    暴露；因 sessionQuery 已声明为必需 inject，实跑不会走到此（防御性兜底保留 no-op 防死循环）。
          //  - persisted.sourceStatus === 'unavailable'：读源抛错/损坏（会话已删/服务不可用）——
          //    绝不返回成功 no-output，标记 retryable（可恢复时重试、达到 max 后 terminal）。
          //  - 其余：真空源/短内容 → raw 交 extractWithOutcome 归因 no-output（empty/short/model_empty）。
          if (persisted === null && !skipReason) {
            skipReason = 'source_capability_missing'
          } else if (persisted && persisted.sourceStatus === 'unavailable') {
            sourceUnavailable = true
            status = 'failed_retryable'
            errMsg = `[dsh-memory_rollout] stage1 source unavailable: ${claimed.session_id}`
            skipReason = 'source_unavailable'
            // T29（D2）：源确实取不到（会话已删/损坏）⇒ 登记"未提炼"碑。**只登记**：
            //   不读已删语料（读不到）、不重试抢救（走既有退避/上限）、不拦删除、不催办、
            //   不依赖 archive-flow（判定只靠官方持久化的读失败 + 我们自己的台账）。
            await recordUnrefined(claimed.session_id, 'source-unavailable-at-drain', { wasEnqueued: true })
          } else {
            if (persisted && Array.isArray(persisted.messages) && persisted.messages.length) {
              raw = messagesToDraftBody(persisted.messages)
              cwd = persisted.cwd || ''
            }
          }
          // ── F1（评估 §三 F1 · P1）：**消费时的内容身份复核** ─────────────────────────────────
          //   入队时按**当时内容**算水位；消费时重新读到的可能是**更新后的正文**。旧作业若照旧提炼，
          //   新内容就绕过 6h 等待、并沿用旧水位 ⇒ "读到的版本与记录/实际输入不一致"（评估已独立复现）。
          //   口径（队长裁）：用**实际读到的正文**重算水位；≠ 作业的 `source_watermark` ⇒
          //     · **自动作业**：本作业**作废、不提炼**（终态无产物 + 专属 skip reason），交回新一轮
          //       资格/调度 —— 新内容按**内容计时**重新等 6h，下一次扫描按 `<sid>::<新水位>` 重新入队；
          //     · **显式/强制作业**：保持即时，但产出/证据/seen **一律引用"实际消费的那一版"**。
          const consumedWatermark = raw ? contentWatermark(raw) : ''
          // **边界（有意）**：只有"入队处亲手按正文算的水位"（`source_watermark_kind === 'content-body'`，
          //   由 `ingestSessionById` 标注）才使这个对比**有依据**；来源未知的作业（例如测试夹具直接播种、
          //   或未来新入口）**不参与对比** —— 否则会把"水位含义未知"误判成"内容已变"、把合法作业作废。
          // **R4（复核 §三 R4）· 旧版遗留任务也要参与核对**：本插件历史入口（`ingestSessionById` /
          //   `memory_precompact` / 旧 `memory_ingest_session`）写进 `source_watermark` 的**一律是内容水位**
          //   （`contentWatermark(正文)`）⇒ 缺 `kind` 的旧记录**按同一语义归类**，不放行"用未知旧水位消费新正文"。
          //   真正无法确定语义的自动任务同样走这条保守路径：正文不符 ⇒ **作废**，交回资格/调度重建
          //   （终态无产物 + `<sid>::<新水位>` 由扫描重新入队）；**不重跑已完成记录**（drain 只取 pending / 可重试）。
          //   归类判据 = `kind === 'content-body'`，**或**（缺 `kind` **且**水位形态就是内容水位：16 位十六进制）
          //   —— 本插件历史入口一律写 `contentWatermark()` 的 16 位十六进制；形态不符的水位**不可能**由
          //   我们任何历史版本产生（测试夹具除外）⇒ 语义未知 ⇒ 不参与对比、也不冒用。
          const claimKindKnown = claimed.source_watermark_kind === 'content-body' ||
            ((claimed.source_watermark_kind === '' || claimed.source_watermark_kind == null) &&
              /^[0-9a-f]{16}$/.test(String(claimed.source_watermark || '')))
          const claimMoved = !!(claimKindKnown && raw && claimed.source_watermark && consumedWatermark && consumedWatermark !== claimed.source_watermark)
          if (claimMoved && claimed.forced !== true && claimed.explicit !== true) {
            status = 'succeeded_no_output'
            skipReason = 'superseded-by-newer-content'
            errMsg = '[dsh-memory_rollout] stage1 job superseded by newer content: claimed=' + claimed.source_watermark + ' actual=' + consumedWatermark + ' session=' + claimed.session_id
          }
          consumedOverride = claimMoved && status !== 'succeeded_no_output' ? consumedWatermark : ''
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
        const submitted = await submitStage1Job(claimed, status, extraction, errMsg, new Date(), cwd, skipReason, { consumedWatermark: consumedOverride })
        if (submitted.wroteOutput) anyOutput = true
        processed++
      }
      // H3：drain 产出新增量输出后自动触发一次真 Phase 2 整合（best-effort，失败不抛）。
      if (anyOutput) {
        try { await phase2Integrate() } catch {}
      }
      // §3/§5：无立即可运行作业 → 设一次定时唤醒（时间驱动，不靠事件）。用最早到期唤醒。
      let wakeAt = nextStage1WakeAt(Date.now())      // GPT P0-6：预算耗尽且仍有「本应处理」的到期作业 → 安排到下一预算窗口开始的唤醒。
      if (wakeAt == null && budgetExhausted && hasDueStage1Job()) {
        wakeAt = nextDayBoundaryMs(Date.now())
      }
      // t189/t210：**本趟**来源上限到顶 ⇒ 下一趟**至少隔 STARTUP_SOURCE_SPACING_MS**（不立刻补跑，
      //   否则上限形同虚设）；剩余来源在那之后继续处理，不丢。
      if (passCapReached) {
        const spaced = Date.now() + STARTUP_SOURCE_SPACING_MS
        wakeAt = wakeAt == null ? spaced : Math.max(wakeAt, spaced)
      }
      // t210：为整合保底而停手时，同样按 30s 间隔醒来重试 —— 一旦整合把积压产物消化掉
      //   （`hasPendingConsolidation` 变 false）提炼即可恢复；既不 0ms 忙循环，也不干等到次日。
      if (reserveHeld) {
        const spaced = Date.now() + STARTUP_SOURCE_SPACING_MS
        wakeAt = wakeAt == null ? spaced : Math.max(wakeAt, spaced)
      }
      // t251（D-5）：**队列无到期时不要清掉定时器** —— 启动趟/上一拍排好的"扫描到期"必须留着，
      //   否则安静进程里 A 面周期扫描再也不来（真机实测 40 分钟无 wake 扫描）。仅当确实没有定时器时
      //   才按扫描周期补一个（延时 30min < 2h，不影响 t132 那条"跨日唤醒 = 本地次日 00:00"的契约）。
      if (wakeAt == null) {
        if (!stage1WakeTimer) {
          scheduleStage1Wake(nextWakeAtWithScan({
            wakeAt: null,
            scanLastAtIso: readStage1Meta().scanLastAt,
            now: Date.now(),
            intervalMs: IDLE_SCAN_INTERVAL_MS,
          }))
        }
      } else {
        scheduleStage1Wake(wakeAt)
      }
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
  /**
   * t210（对齐 codex 的 **per pass** 语义）：**每一趟自动提炼**都带同一份来源上限 ——
   *   启动趟 / 唤醒趟（含日界）/ 事件趟（`session/disposed`）走同一常量 `maxSourcesPerStartup`；
   *   显式工具 `memory__stage1_drain` **不设限**（与「门二不拦显式整合入口」的既有约定一致）。
   *   为什么必须对齐：codex 的文档原文是 "Maximum number of rollout candidates processed **per pass**"
   *   （镜像 `config/src/types.rs` L317），其唯一使用点也把该值作为**本次 claim 的上限**
   *   （`memories/write/src/phase1.rs` L140 `max_claimed`）；本地此前只把上限绑在启动趟，
   *   唤醒/日界趟不设限 ⇒ 一趟可吞掉全部来源（并配合额度缺陷造成整合挨饿，见 t210）。
   */
  const perPassSourceBudget = () => ({
    remaining: Math.max(1, Math.floor(Number(config.maxSourcesPerStartup) || DEFAULT_MAX_SOURCES_PER_STARTUP)),
  })
  /**
   * **C4（契约 §C4 ③）**：`session/disposed` 的**唯一**动作 —— **只请求一次复查**，**不再直接入队**。
   *
   * 为什么改：旧 disposed 处理器直接调 `ingestSessionById` ⇒ 在**入口层绕过静置窗口**（刚更新就被提炼）。
   * 用户裁定 §10.1：「`session/disposed` 最多帮助重新检查/调度，**不得绕过六小时门槛**」。
   *
   * 做法（**不新增定时器平台**）：
   *   ① 把"谁请求过复查 + 何时"落进既有 `stage1_meta.meta`（`idleRecheck = { lastAt, lastId, source }`，留痕/审计）；
   *   ② 用既有 `scheduleStage1Wake(now)` 把下一次唤醒提前到**立即**（它自带 clearTimeout ⇒ 就是"提前已有唤醒"的
   *      语义，不新建计时器）；那趟会跑 `ingestIdleScan('wake')` + `drainStage1Jobs` —— 即把"复查"交给**唯一**
   *      的资格判定去决定（不合格自然不入队）。
   * **不**在这里读会话正文、**不**在这里入队、**不**在这里判资格（让扫描趟一处判，保证"只有一个自动资格"）。
   */
  async function requestIdleRecheck(sessionId, source = 'session-disposed') {
    const id = String(sessionId || '')
    try {
      await writeStage1Meta({ idleRecheck: { lastAt: nowIso(), lastId: id, source: String(source) } })
    } catch { /* 留痕失败不影响调度 */ }
    try {
      scheduleStage1Wake(Date.now())
      return { scheduled: true, sid: id }
    } catch {
      return { scheduled: false, sid: id }
    }
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
    // t251：`unref()` —— 后台唤醒定时器**不应单独把进程吊住**（生产里宿主本来就有监听句柄，定时器照常触发；
    //   测试进程若只靠它存活会挂住：真机复核时 `t80-gate` 就因"扫描定时器不再被清掉"而挂 >90s）。
    const armSt1 = typeof setTimeout === 'function' ? setTimeout : null
    if (!armSt1) return
    const timer = armSt1(() => {      stage1WakeTimer = null
      // t180/t210：与**同一次 drain 的另一个入口** `scheduleStage1Drain` 对齐——它也是"调度回调里起写"，
      // 同样必须走 `runScheduledPass`（写锁竞争 ⇒ 短退避重试 + 降噪）；否则两个入口待遇不同：
      // 一个会重试，一个会把整次丢掉、只记一条 error。
      // t210：唤醒趟（含日界）**也带 per-pass 来源上限** —— 此前不设限，一趟能把全部来源吞掉。
      // T29：唤醒趟**先跑静置扫描**（统一摄入的 A 入口），再跑 drain —— 这样"到期唤醒"和"静置扫描"
      //   共用一个计时器（**不新增定时器平台**）；扫描只入队、不调模型。
      runScheduledPass('stage-1 wake drain error', 'stage1-wake', async () => {
        try {
          await ingestIdleScan('wake')
        } catch (err) {
          try { console.warn('[dsh-memory_rollout] idle scan (wake) failed:', err && err.message ? err.message : err) } catch {}
        }
        const processed = await drainStage1Jobs({ budget: perPassSourceBudget() })
        armStage1Wake()
        return processed
      })
    }, delay)
    try { if (timer && typeof timer.unref === 'function') timer.unref() } catch { /* unref 不是硬要求 */ }
    stage1WakeTimer = timer
  }

  /**
   * T29：**武装下一次 stage-1 唤醒** = min（队列里最早的到期时刻，静置扫描的下一次到期）。
   *   复用同一个 `scheduleStage1Wake` 计时器 ⇒ 不新增定时器平台；`nextStage1WakeAt` 本身语义不变
   *   （纯队列函数，既有测试不受影响），扫描的周期由这里叠加。
   */
  function armStage1Wake() {
    const now = Date.now()
    let next = nextStage1WakeAt(now)
    try {
      // t251（D-5）：与 drain 收尾共用同一合并规则（`nextWakeAtWithScan`），两个写者不再互相覆盖。
      next = nextWakeAtWithScan({ wakeAt: next, scanLastAtIso: readStage1Meta().scanLastAt, now, intervalMs: IDLE_SCAN_INTERVAL_MS })
    } catch {
      // 记账读不到 ⇒ 只按队列到期排程（不因扫描记账把唤醒拖崩）
    }
    scheduleStage1Wake(next)
    return next
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
          // F1（2026-10-01）：显式入口标记（job schema 用 .passthrough()，但显式声明便于读者与校验）。
          ...(opts.explicit === true ? { explicit: true } : {}),
          // F1：`source_watermark` 的**来源种类** —— `'content-body'` = 入队处亲手按正文算的内容水位
          //   （只有这种作业，消费期的"实际水位 ≠ 作业水位"才**有依据**判成"内容已变"）。
          ...(opts.sourceWatermarkKind ? { source_watermark_kind: String(opts.sourceWatermarkKind) } : {}),
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
    '6. Progressive disclosure: each memory_summary entry MUST be a single line of at most ~120 characters stating the conclusion, followed by a source reference CODE from the catalog supplied in the user message, written as double brackets (e.g. `[[REF1]]`; optional line range `[[REF1:12-20]]`). Detail text belongs in the referenced detail files, which stay on disk and remain searchable — do not inline it.',
    '7. Every line must carry durable information: no filler, no duplicated facts, no restating the registry, no restating the profile/preferences sections already present.',
    // ── t83：普通批同款禁令，与安全门对齐（redactSecrets 键名白名单 L814 + 长 token 启发式 L838-841
    // + looksLikeToken L852-858）。普通批把 registry 全文喂给模型，而真实 MEMORY.md 含 `session_id:` ×18；
    // 模型照抄即被 validatePhase2Output（L456）判 unredacted secret → 整批被拒（潜在静默整合失败）。
    // t82 只在压缩模式规避，这里补上普通批。**安全门本身一个字不改。**
    '8. ABSOLUTELY FORBIDDEN — never write metadata as `key: value` or `key=value`. In particular never emit any of: session_id, token, api_key, secret, auth, password, access_token, client_secret. A safety scanner treats such keyed pairs as leaked secrets and REJECTS the entire batch.',
    '9. ABSOLUTELY FORBIDDEN — never attach a label or key to a session id either. Forms like `session_id: <id>` AND `session=<id>` are BOTH rejected by the same scanner (the latter because a `session=` prefix followed by a long id forms a long high-entropy run). Do NOT reproduce the keyed metadata that appears in the registry input.',
    // t216（D1）：**删掉旧的逃生口**（原文：「若必须引用会话，就把裸 id 或短 id 单独写出来」——正是它把模型
    // 逼成写「不含数字的短名」⇒ 3 条悬空引用）。改为「只用目录里的引用代号」，由代码渲染真实路径。
    '10. To cite a source, use its reference CODE from the catalog (`[[REF1]]`). NEVER hand-write a path, filename, slug or session id into your output — invented or hand-written references are detected and the whole batch is rejected. The program renders codes into real paths at publish time.',
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
    lines.push('- Each line MUST end with a source reference CODE from the catalog below, in double brackets: `[[REF1]]` (optional line range `[[REF1:12-20]]`).')
    lines.push('- NEVER write a path, filename, slug or session id yourself — the program renders codes into real paths when it publishes, and an invented reference is rejected.')
    lines.push('- Do NOT copy the registry into memory_summary; do NOT repeat the same fact twice.')
    lines.push('')
    // t216（D1）：把**可信引用目录**交给模型（只有代号 + 可读摘要；映射由插件记录生成，模型加不进条目）。
    const catalog = referenceCatalogText(opts && opts.references)
    if (catalog) for (const ln of catalog.split('\n')) lines.push(ln)
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
      // t216（D1）：输入块只给**代号 + 可读摘要**（不再把会撞闸门的 `session=<uuid>` 形态摆到模型面前）。
      const entry = opts && opts.references && opts.references.bySession
        ? opts.references.bySession.get(String(it.session_id))
        : null
      const refTag = entry ? ` ref=[[${entry.code}]]` : ''
      lines.push(`--- input ${i + 1}: source_watermark=${it.source_watermark}${refTag} ---`)
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
      lines.push('- To cite a source, use its reference CODE from the catalog (`[[REF1]]`). NEVER hand-write a path, filename, slug or session id — the program renders codes into real paths at publish time.')
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
   * Consolidate the incremental inputs + current files via the consolidation LLM. **只取原始文本**
   * （t252：拆出来供后台承载路径复用**同一份输入与同一套路由/脱敏**；解析交给调用方走既有链）。
   * Mirrors extractWithLlm's routing (config override wins, else agentDefaultModel).
   * D1: redact the prompt just before it reaches the provider (defense-in-depth; the incremental
   * inputs were already redacted when serialized).
   * t254（T36 · F1/F2）：失败分类落在本条 `callConsolidationLlmRaw`（四类可区分 + 计数在实际调用处）；
   *   旧的 `consolidateWithLlmRaw` / `consolidateWithLlm`（一律 null 的吞错壳，已无调用点）**本轮删除**，
   *   只留这一条路径 ⇒ 不再存在"悄悄把类别吞掉"的第二条路。
   */
  /**
   * t254（T36 · F1）：**实际模型调用边界**上的结构化调用 —— 失败在**这里**分类（不再一律 `null`）。
   *
   * 返回 `{ ok, text, category, detail, stream_calls, redacted_input_chars }`：
   *   · `ok=true` 且 `category=''` ⇒ 成功；
   *   · `llm-service-unavailable`（宿主无 `ctx.llm`）/ `llm-route-unavailable`（provider/model 路由不全）/
   *     `llm-reasoning-effort-unsupported`（宿主拒绝推理强度）/ `llm-stream-error`（流式异常）/
   *     `llm-empty-output`（流跑完但文本为空）/ `llm-empty-prompt`。
   * **调用次数只在本函数内自增**（`stream_calls`，紧贴 `llmSvc.stream(...)` 之前）——外层**不得**再自行 `+1`，
   *   这样 `recordedModelCalls === actualStreamCalls` 由构造保证（T36 · F2）。
   * **本函数不做任何内部重试**（用户口径"一次请求"是硬约束）：推理强度不被支持 ⇒ **直接归类失败**，
   *   交既有批次重试机制（每次重试是**新的批尝试**，`attempt_count` / `last_error` 可见）。
   * `detail` 经 `redactSecrets` + 截断 200 字符 ⇒ 不落完整请求/凭据。
   * 路由与脱敏与旧 `consolidateWithLlmRaw` **逐字一致**（同一份输入、同一套语义）。
   */
  async function callConsolidationLlmRaw(prompt) {
    const p = String(prompt || '').trim()
    const inputText = redactSecrets(p)
    const base = {
      ok: false,
      text: '',
      category: '',
      detail: '',
      stream_calls: 0,
      redacted_input_chars: inputText.length,
    }
    if (!p) return { ...base, category: 'llm-empty-prompt', detail: 'empty-prompt' }
    const llmSvc = typeof ctx.get === 'function' ? ctx.get('llm', false) : undefined
    if (!llmSvc || typeof llmSvc.stream !== 'function') {
      return { ...base, category: 'llm-service-unavailable', detail: 'llm-service-unavailable' }
    }
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
    if (!provider || !model) {
      return {
        ...base,
        category: 'llm-route-unavailable',
        detail: `provider=${provider || '(empty)'} model=${model || '(empty)'}`,
      }
    }
    const reasoningEffort =
      (config.consolidationReasoningEffort && config.consolidationReasoningEffort.trim()) || ''
    const buildOptions = (effort) => ({
      provider,
      model,
      purpose: 'compaction',
      system: CONSOLIDATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: inputText }], source: { kind: 'user' } }],
      ...(effort ? { reasoningEffort: effort } : {}),
    })

    let streamCalls = 0
    let text
    try {
      // t254（T36 · F2）：计数就在**真正的 stream 调用**处 +1；**无内部重试** ⇒ 计数与实际调用一一对应。
      streamCalls += 1
      text = await collectStreamText(llmSvc.stream(buildOptions(reasoningEffort)))
    } catch (err) {
      const detail = redactSecrets(String((err && err.message) || err || '')).slice(0, 200)
      const category = isReasoningEffortError(err) ? 'llm-reasoning-effort-unsupported' : 'llm-stream-error'
      return { ...base, category, detail, stream_calls: streamCalls }
    }
    if (!text) {
      return { ...base, category: 'llm-empty-output', detail: 'stream finished with empty text', stream_calls: streamCalls }
    }
    return { ok: true, text: String(text), category: '', detail: '', stream_calls: streamCalls, redacted_input_chars: inputText.length }
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
   *
   * **t219（R2 §6）语义正名（重要，别读成记忆淘汰）**：
   *   · `phase2_abandoned` = **可审计的隔离 / 人工待处理状态**，**不是**记忆语义上的"淘汰/无价值"；
   *   · **停止重试 ≠ 恢复成功** —— 它只说明"这套配置下重试已到上界"，不说明来源内容没价值（D1 那类
   *     误判正是反例）；
   *   · 被放弃的 `memory_changes` 同样需要恢复语义：用户明确要求的"记住 / 更正 / 忘记"**不得**因执行
   *     失败被默默撤销；
   *   · **有界、去重、可追溯的恢复入口**（不清零全部历史失败次数、不重跑全库）属**未启用**的后续小批，
   *     本批只写清语义。
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
        // t224（F2）：成功提交 ⇒ **清掉批级 `last_error`**（与上面 meta 的 `phase2_last_error = ''` 同一口径），
        //   避免把**上一轮**留下的错误串（真机实例：昨天的 `unredacted secret in memory_summary; …`）
        //   误读成"本轮仍然失败"。**不静默丢弃**：被清的值转存 `last_error_history`（可审计，一字段看完）。
        last_error_history: String(curJ.last_error || '') || String(curJ.last_error_history || ''),
        last_error: '',
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
      // t219（R2 §6）：这**不是**记忆语义上的淘汰，而是"可审计的隔离 / 人工待处理"；**停止重试 ≠ 恢复成功**
      //   （见 `MAX_PHASE2_RELEASES` 的注释）；恢复入口属未启用的后续小批，本批不改行为。
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
      // t219（R2 §3.2）：**每个 manifest 必须标明它登记的是「完整当前选择集合」还是「本批新消费输入」**。
      //   原生（codex）语义需要**前者**（S_base = 当前权威 manifest 里的成功集合）。
      //   本地当前只登记**本批消费的输入** ⇒ 如实标 `batch-inputs`，**不**把它冒充成"完整当前选择集合"；
      //   "把批次 input_ids 抄进 manifest 仍然没有当前集合"（R2 原话）——这是**未启用的目标能力**，本批不实现。
      selection_scope: 'batch-inputs',
      selection_scope_note: 'this manifest registers the inputs consumed by this batch; it is NOT the full current selection set (codex semantics require the full set)',
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
    // t216（D1 · R2 §5.2 步 1）：**可信引用映射** —— 只由插件既有记录产生：
    //   ① 本批 stage1_outputs（来源身份 = session_id，源版本 = source_watermark）；
    //   ② 当前权威基线里**已经登记**、且能被插件记录解析出来的来源（含 slug 别名回收）。
    //   模型/网页**无法**往里加条目；"磁盘上恰有同名文件"也不算可信（可信只来自记录）。
    const referenceSources = []
    for (const [, o] of stage1OutputsTable.entries()) if (o && typeof o === 'object') referenceSources.push(o)
    for (const [, o] of stage1OutputsArchiveTable.entries()) if (o && typeof o === 'object') referenceSources.push(o)
    const referenceMap = buildReferenceMap({
      memoryRoot: memoryRoot(),
      inputs: fixedInputs,
      sources: referenceSources,
      baselineTexts: [curSummaryText, curRegistryText],
    })
    const prompt = buildConsolidationPrompt(
      fixedInputs,
      curSummaryText,
      curRegistryText,
      fixedChanges,
      { compress: isCompressBatch, truncationOut, references: referenceMap },
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
    // F5（P2 · 评审 §三 F5）：**基线乐观并发校验（提交契约的一部分）** —— 进入模型调用前记下"本次 prompt 面向的
    //   权威基线"（版本号 + 两份权威文件/current.json 的 SHA + 现存版本目录清单）。发布前必须复核它**没变**；
    //   用已有版本号/SHA 做乐观校验，不新建事务平台。
    const baselineOf = () => ({ version: String(resolveCurrentFiles().versionId || ''), snap: authoritativeSnapshot(memoryRoot()) })
    const baseline = baselineOf()
    // 疑似越界（执行者动了权威面）导致的拒发理由；非空 ⇒ 本批不发布、交回重试。
    let baselineRefusal = ''
    // t187：① 受限执行者 —— 模型调用前先按 codex 形态建"受限会话"（**插件自建会话**，不是子代理工具）：
    //   `meta.cwd` = 记忆根 ⇒ 写边界随之落在记忆根；`setup` 里 restrict 到最小工具集并 deny `subagent`；
    //   会话沙箱 `workspace-write` + 审批 `never`。
    //   **失败/宿主无 agents 服务 ⇒ 只记 warn，本批照旧**（既有单次 JSON 路径）；关掉走配置
    //   `consolidationExecutor: false`。第一验收项「meta.cwd 被真实宿主接受」需重启后实测，本批不视作已通过。
    let executor = null
    let executorObs = { path: '', sessionId: '', restricted: false, reason: '', activity: '', source: '', cwd: '', boundaryViolation: '', assembly: null, activityGate: '', agentErrors: [], eventsAfter: undefined, assistantEvents: undefined, cleanup: null, sessionMissing: '' }
    // t220（R2 §8-3）：每次尝试一个**独立产物路径**（`attempt-<attempt_count>-<nonce>`）⇒ 重试不会共用
    //   输出路径、也就读不到上一次尝试的旧结果。
    const executorAttemptTag = `${Math.max(0, Number(batch.attempt_count) || 0)}-${crypto.randomBytes(3).toString('hex')}`
    // t224（F1，真机高优先）：**会话 id 必须与尝试解耦** —— 真机实测同一批第 2 次尝试会撞名
    //   （`executor-start-failed: session "p2-exec-<batchId>" already exists`）⇒ 受限路径对**任何重试**
    //   永久不可用。拼上**与候选目录同一个** `executorAttemptTag` ⇒ 一次尝试 = 一个会话 + 一个产物路径（自洽）。
    const executorSessionId = `p2-exec-${batch.id}-${executorAttemptTag}`
    // t224（F4）：cwd = **候选工作区根**，本次尝试的产物落在它下面的 `attempt-<tag>/`（**只一层**）。
    //   t220 曾把 cwd 设成 `…/attempt-<tag>` 而轮内又套一层 ⇒ 失败尝试会留下无人清的空 `attempt-*` 目录。
    const executorWorkspace = path.join(memoryRoot(), EXECUTOR_OUT_SUBDIR, EXECUTOR_WORKSPACE_DIRNAME)
    // t252（T35）：**承载切换** —— 默认 `plugin-background`（不建会话）；只有显式实验才建受限会话。
    const carrier = consolidationCarrier(config)
    if (carrier === CONSOLIDATION_CARRIER_RESTRICTED) {
      // t254（T36 · F3）：**实验载体不是安全回退** —— 显式告警（日志 + 批字段 `executor_carrier_note`）。
      //   本轮**不改用户配置、不加设置界面**；旧安装写过 `consolidationExecutor: true` 的会留在这里。
      executorObs.carrierNote = CARRIER_EXPERIMENT_WARNING
      try { console.warn('[dsh-memory_rollout] ' + CARRIER_EXPERIMENT_WARNING) } catch {}
      try {
        executor = await startConsolidationExecutor({
          ctx, memoryRoot: memoryRoot(), sessionId: executorSessionId, candidateDir: executorWorkspace,
          // v0.1.23（T31-3）：preset 可用配置覆盖；缺省（空串）走 `presets.resolve(undefined)` = 部署默认预设。
          agentPreset: config.executorAgentPreset,
        })
        executorObs.cwd = String((executor && executor.candidateDir) || '')
        // t230：把**派生证据**落观测（不只是日志）—— 哪些名字想要却不在宿主名单里、名单从哪来。
        {
          const ro = (executor && executor.restrictObs) || {}
          executorObs.restrictUnknown = (ro.unknownDesired || []).join(',')
          executorObs.restrictSource = String(ro.source || ro.note || '')
        }
        // v0.1.23（T31-3）：装配证据落批记录（预设 / 模型路由 / 是否挂上 / 宿主 agent/error）。
        {
          const asm = (executor && executor.assembly) || {}
          executorObs.assembly = {
            route: String(asm.route || ''),
            presetId: String(asm.presetId || ''),
            presetSource: String(asm.presetSource || ''),
            provider: String(asm.provider || ''),
            model: String(asm.model || ''),
            mounted: !!asm.mounted,
            mountError: String(asm.mountError || ''),
          }
        }
        if (executor.ok) {
          const ap = executor.applied || {}
          executorObs.sessionId = executorSessionId
          executorObs.restricted = !!executor.restricted
          // t249（T33-一）：把"这是我们建的内部执行者会话"落进**我们自己的创建台账**（可信记录之二）。
          //   头里的 `delegationDepth=1`（记录之一）已随会话持久化；台账用于复核"凭什么认出它"。
          try { await recordExecutorSession(executorSessionId, batch.id) } catch { /* 台账失败不影响批次 */ }
          console.info(
            `[dsh-memory_rollout] consolidation executor: cwd=${executor.spec.cwd} sandbox=${ap.sandboxMode || '-'} approval=${ap.approvalPolicy || '-'} restricted=${executor.restricted} preset=${(executor.assembly && executor.assembly.presetId) || '-'} model=${(executor.assembly && executor.assembly.model) || '-'} route=[${(ap.routes || []).join(',')}]`,
          )
        } else {
          // t220（R2 §8-1）：限制没建立 ⇒ **不派发**受限轮次（下面 `executor.ok === false` 直接走回落），
          //   并把原因落到观测字段（不是"只记字段继续走受限路径"）。
          executorObs.reason = String(executor.reason || 'executor-unavailable')
          console.warn(`[dsh-memory_rollout] consolidation executor not usable (${executor.reason}); keeping the in-process single-shot path`)
        }
      } catch (err) {
        // 安全阀：执行者建不起来绝不拖垮批（例如 sessionId 形状或 meta.cwd 被宿主拒绝）。
        executorObs.reason = 'executor-start-failed: ' + (err && err.message ? err.message : String(err))
        console.warn('[dsh-memory_rollout] consolidation executor start failed:', err && err.message ? err.message : err)
      }
    } else {
      // t252（T35）：**默认后台承载** —— 不建任何会话；这里只记承载名与"无会话"的事实。
      executorObs.path = CONSOLIDATION_CARRIER_PLUGIN
      executorObs.source = 'plugin-background'
      try { console.info(`[dsh-memory_rollout] consolidation carrier = ${carrier} (no session created)`) } catch {}
    }
    // v0.1.23（T31-1/6）：**兜底收口** —— 只要执行者会话活着却没被派发/没被停（例如上面 create 成功、
    //   但 `turn` 之前抛错，或 ok:false 之外的早退），在这里统一 stop；缺会话（目录被清）⇒ 只记 note，不抛。
    const stopExecutorIfAlive = async (reason) => {
      try {
        if (executor && executor.ok && executor.handle && !executor.stopped) {
          const st = await stopConsolidationExecutor(executor, reason)
          executorObs.stopped = st
          return st
        }
      } catch (err) {
        executorObs.stopError = String((err && err.message) || err)
      }
      return null
    }
    // 慢速模型调用在写锁外执行（M4）+ GPT P0-5：长调用期间心跳续租。
    const hb = startHeartbeat(HEARTBEAT_INTERVAL_MS, () => renewPhase2Lease(batch.id, batch.lease_token))
    let result
    try {
      // t213：优先在**受限会话内**跑这一轮（模型调用 + 工具执行都在该会话的沙箱/白名单/审批下）；
      //   任何一步不成 ⇒ **显式回落**到进程内单发，并把"走了哪条路 + 原因 + 会话 id + 活动证据"记下来。
      let turn = null
      if (executor && executor.ok) {
        turn = await runConsolidationExecutorTurn({
          executor,
          prompt,
          systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
          memoryRoot: memoryRoot(),
          batchId: batch.id,
          candidateDir: executorWorkspace,
          attemptTag: executorAttemptTag,
        })
      }
      if (turn && turn.ok) {
        const parsed = parseExtractionJson(turn.text)
        const ms = parsed ? String(parsed.memory_summary || '').trim() : ''
        const rg = parsed ? String(parsed.registry || '').trim() : ''
        if (ms && rg) {
          result = { memory_summary: ms, registry: rg }
          executorObs = {
            path: 'restricted-session',
            sessionId: turn.sessionId || executorObs.sessionId,
            restricted: !!executorObs.restricted,
            reason: '',
            activity: String(turn.activity || ''),
            source: String(turn.source || ''),
            cwd: executorObs.cwd,
            boundaryViolation: '',
            assembly: executorObs.assembly,
            // t249（T33-三 · D-1）：成功分支重建 `executorObs` 时**保留限制观测**（最小必要，不扩成审计系统）。
            //   旧版漏了这两个字段 ⇒ 真机成功路径把它们写成空串，丢掉"限制名单从哪来/缺哪些名字"的审计线索。
            restrictUnknown: String(executorObs.restrictUnknown || ''),
            restrictSource: String(executorObs.restrictSource || ''),
            activityGate: String(turn.activityGate || ''),
            agentErrors: Array.isArray(turn.agentErrors) ? turn.agentErrors : [],
            eventsAfter: turn.eventsAfter,
            assistantEvents: turn.assistantEvents,
          }
        } else {
          executorObs.reason = 'executor-output-unparsable-or-empty'
        }
      } else if (turn) {
        executorObs.reason = String(turn.reason || 'executor-turn-failed')
        if (turn.sessionId) executorObs.sessionId = String(turn.sessionId)
        if (turn.activity) executorObs.activity = String(turn.activity)
        if (turn.activityGate) executorObs.activityGate = String(turn.activityGate)
        if (Array.isArray(turn.agentErrors)) executorObs.agentErrors = turn.agentErrors
        if (turn.eventsAfter !== undefined) executorObs.eventsAfter = turn.eventsAfter
        if (turn.assistantEvents !== undefined) executorObs.assistantEvents = turn.assistantEvents
        // F5（P2）：执行者**动了权威面** ⇒ 这一轮的产物**拒收**，且**不再用"构建 prompt 时的旧权威"回落重发**
        //   （旧实现是 `consolidateWithLlm(prompt)` 拿旧材料完整重写 —— 等待期间的合法新结论会被覆盖）。
        //   旧注释"越界写不会被采纳进权威状态"表述过强：越界写在磁盘上**已经发生**，外层重发只是覆盖它，
        //   不等于"没发生"。改为：本批**不发布**、交回重试；下一趟重新读取当前权威再生成。
        if (turn.boundaryViolation) {
          executorObs.boundaryViolation = String((turn.changed || []).join(',') || 'unknown')
          // 这一轮**确实跑在受限会话里**（观测要如实：不是 fallback），只是产物被拒收。
          executorObs.path = 'restricted-session'
          if (turn.sessionId) executorObs.sessionId = String(turn.sessionId)
          if (turn.activity) executorObs.activity = String(turn.activity)
          baselineRefusal = 'executor-boundary-violation'
          console.warn(`[dsh-memory_rollout] executor boundary violation (authoritative surface modified): ${executorObs.boundaryViolation} — executor result REFUSED; the batch will retry against the new baseline (no stale-baseline republish)`)
        }
      }
      if (!result && !baselineRefusal) {
        // t252（T35）：**后台承载** —— 单次调用（同一份 prompt / 同一套 parse→校验→发布链）。
        //   只有从**受限会话实验**回落下来时，路径名才保持 `in-process-fallback`（如实区分"试过实验但失败"）；
        //   默认承载则记为 `plugin-background`。**全程不建会话**。
        const fromExperiment = carrier === CONSOLIDATION_CARRIER_RESTRICTED
        if (fromExperiment) executorObs.path = 'in-process-fallback'
        if (fromExperiment && !executorObs.reason) executorObs.reason = executorObs.reason || 'executor-unavailable'
        const bgStartedAt = Date.now()
        const bg = await runConsolidationBackgroundTurn({
          prompt,
          batchId: batch.id,
          // t254（T36 · F1/F2）：注入**结构化**调用（四类失败可区分；`model_calls` 取自实际 stream 调用次数）。
          call: (p) => callConsolidationLlmRaw(p),
        })
        executorObs.cost = bg.cost
        executorObs.bgReason = String(bg.reason || '')
        if (bg.ok) {
          const parsed = parseExtractionJson(bg.text)
          if (parsed) {
            // t252：解析成功就**照原样**交给下游既有校验链 —— 空/不合法字段由 `validatePhase2Output`
            //   给出精确原因（如 `memory_summary must start with a bare "v1" line`）。
            //   这里若按"空即拒"提前吞掉，批记录只会剩含糊的 `llm-unavailable`，
            //   把"哪一项不合法"这条排查线索丢掉（t224 实测到的观测性回归）。
            result = {
              memory_summary: String(parsed.memory_summary || '').trim(),
              registry: String(parsed.registry || '').trim(),
            }
            executorObs.path = fromExperiment ? 'in-process-fallback' : CONSOLIDATION_CARRIER_PLUGIN
            executorObs.source = 'plugin-background-llm'
            // t252：活动串**只在还没有会话证据时**才用后台调用成本填充 ——
            //   从受限会话实验回落时，`executor_activity` 必须保住会话侧证据（如 `events=0->0(idle) turns=idle`），
            //   否则失败理由 `executor-no-activity` 就与活动串**互相矛盾**（成本另有 `cost_*` 八个字段记录）。
            if (!executorObs.activity) executorObs.activity = `model_calls=${bg.cost.model_calls} input_chars=${bg.cost.input_chars}`
          } else {
            executorObs.reason = executorObs.reason || 'background-output-unparsable'
          }
        } else {
          executorObs.reason = executorObs.reason || String(bg.reason || 'background-llm-empty-output')
        }
        if (fromExperiment) {
          console.warn(`[dsh-memory_rollout] consolidation fell back to the in-process single-shot path (${executorObs.reason})`)
        } else if (!result) {
          console.warn(`[dsh-memory_rollout] consolidation background turn produced no candidate (${bg.reason})`)
        }
        try { executorObs.cost.wall_clock_ms = Math.max(bg.cost.wall_clock_ms || 0, Date.now() - bgStartedAt) } catch {}
      }
    } finally {
      stopHeartbeat(hb)
    }
    // v0.1.23（T31-1）：**收口** —— 执行者会话若还活着（没派发到轮次、或轮次里的停没成功），在这里停。
    //   幂等：轮内的 stop 已把 `executor.stopped = true`，这里不会重复停。绝不抛、绝不改批状态。
    await stopExecutorIfAlive('executor-not-dispatched')
    // v0.1.23（T31-5）→ 本批（C2）：**空壳执行者会话只识别、不删除** —— 只有"我们自己的 id + 零会话事件 +
    //   已停"三条全中才报空壳（有内容是本轮证据，绝不碰）。撤销插件侧驱动删除后，这里**不再调用任何删除**；
    //   识别结果如实落观测字段，便于复盘"为什么空壳还在"。**绝不影响批的状态**。
    if (executor && executor.ok && executorObs.assistantEvents === 0) {
      try {
        const cl = await cleanupEmptyExecutorSession({
          ctx, config, batchId: batch.id, sessionId: executorSessionId, assistantEvents: executorObs.assistantEvents,
        })
        executorObs.cleanup = cl
        if (cl && cl.emptyShell === true) {
          console.warn(`[dsh-memory_rollout] empty executor session identified (no deletion by design): outcome=${cl.outcome} (${cl.text || '-'})`)
        }
      } catch (err) {
        executorObs.cleanup = { attempted: false, outcome: 'error', text: String((err && err.message) || err), deleted: false, id: executorSessionId, emptyShell: false }
      }
    }
    // v0.1.23（T31-6）：**悬空引用容错** —— 会话目录被外部清掉时（用户 GUI 清理）只**追加标记**，
    //   不改批状态、不擦除 `executor_session_id`（那是"哪次尝试用了哪个会话"的唯一审计线索）。
    if (executorObs.sessionId && !(executorObs.cleanup && executorObs.cleanup.deleted === true)) {
      try {
        const gone = await executorSessionGone(ctx, executorObs.sessionId)
        if (gone === true) {
          executorObs.sessionMissing = nowIso()
          console.warn(`[dsh-memory_rollout] executor session ${executorObs.sessionId} no longer present in session storage; recording a marker only (batch status unchanged)`)
        }
      } catch { /* 探测失败不影响批 */ }
    }
    // t224（F4）：**失败尝试的遗留清理**。选"清理"而不是"登记为常驻产物"：候选目录只是中间态，
    //   留着既会被误当产物、又会逐次堆积（真机已观察到空 `attempt-*` 目录无人清）。
    //   本处是**幂等**收尾：成功路径已由轮内 `cleanup()` 删过，这里补掉"建了目录但没走到轮次"的路径
    //   （例如会话创建失败 / 限制未建立）。任何一步失败都不影响批的结论。
    try {
      fs.rmSync(path.join(executorWorkspace, `attempt-${executorAttemptTag}`), { recursive: true, force: true })
      fs.rmdirSync(executorWorkspace)
      fs.rmdirSync(path.join(memoryRoot(), EXECUTOR_OUT_SUBDIR))
    } catch { /* 清理失败不改变批的结果 */ }
    // t213：**不依赖控制台**的观测 —— 无论走哪条路都落到批记录（失败路径也留痕，便于复盘"为什么没走受限会话"）。
    try {
      const asm = executorObs.assembly || {}
      const cl = executorObs.cleanup || null
      await phase2JobsTable.update(batch.id, (cur) => ({
        ...cur,
        executor_path: executorObs.path || 'in-process-fallback',
        executor_session_id: executorObs.sessionId || '',
        executor_restricted: !!executorObs.restricted,
        executor_reason: executorObs.reason || '',
        executor_activity: executorObs.activity || '',
        executor_source: executorObs.source || '',
        executor_cwd: executorObs.cwd || '',
        executor_boundary_violation: executorObs.boundaryViolation || '',
        executor_restrict_unknown: executorObs.restrictUnknown || '',
        executor_restrict_source: executorObs.restrictSource || '',
        // v0.1.23（T31）新增观测面：装配证据 / 活动门 / 宿主 agent/error / 空壳清理 / 悬空引用标记。
        executor_preset_id: String(asm.presetId || ''),
        executor_preset_source: String(asm.presetSource || ''),
        executor_model: String(asm.model || ''),
        executor_provider: String(asm.provider || ''),
        executor_preset_mounted: !!asm.mounted,
        executor_assembly_error: String(asm.mountError || ''),
        executor_activity_gate: String(executorObs.activityGate || ''),
        executor_agent_errors: (Array.isArray(executorObs.agentErrors) ? executorObs.agentErrors : []).join(' | ').slice(0, 900),
        executor_assistant_events: (executorObs.assistantEvents === undefined || executorObs.assistantEvents === null) ? '' : String(executorObs.assistantEvents),
        // C2：`executor_cleanup` 现在只表达"识别结果"（`no-delete-by-design` 表示识别到空壳但不删除），
        //   不再有 `/deleted` 这类后缀 —— 插件侧不再驱动会话删除。
        executor_cleanup: cl ? `${cl.outcome || ''}${cl.deleted ? '/deleted' : ''}` : '',
        executor_session_missing_at: String(executorObs.sessionMissing || ''),
        // ── t252（T35）：承载 + 成本记录（方案 §3.2 的字段面；同输入 A/B 未跑就如实为空/标未取得）──
        executor_carrier: carrier === CONSOLIDATION_CARRIER_RESTRICTED ? CONSOLIDATION_CARRIER_RESTRICTED : CONSOLIDATION_CARRIER_PLUGIN,
        cost_wall_clock_ms: Number((executorObs.cost && executorObs.cost.wall_clock_ms) || 0),
        cost_model_calls: Number((executorObs.cost && executorObs.cost.model_calls) || 0),
        cost_turns: Number((executorObs.cost && executorObs.cost.turns) || 0),
        cost_input_chars: Number((executorObs.cost && executorObs.cost.input_chars) || 0),
        cost_output_chars: Number((executorObs.cost && executorObs.cost.output_chars) || 0),
        cost_source_bytes_read: Number((executorObs.cost && executorObs.cost.source_bytes_read) || 0),
        cost_extra_session_artifacts: Number((executorObs.cost && executorObs.cost.extra_session_artifacts) || 0),
        cost_failure_visibility: String((executorObs.cost && executorObs.cost.failure_visibility) || ''),
        // t254（T36 · F1）：**结构化失败类别**（'llm-service-unavailable' 等；成功为空）——
        //   与 `executor_reason`（人读串）、`last_error`（批级原因）三处同源，保证"四类可区分"落到记录里。
        cost_failure_category: String((executorObs.cost && executorObs.cost.failure_category) || ''),
        // t254（T36 · F3）：实验载体**不是安全回退** ⇒ 同一条告警落批字段（日志另外打一条）。
        executor_carrier_note: carrier === CONSOLIDATION_CARRIER_RESTRICTED ? CARRIER_EXPERIMENT_WARNING : '',
      }))
    } catch (err) {
      try { console.warn('[dsh-memory_rollout] executor observability write failed:', err && err.message ? err.message : err) } catch {}
    }
    // F5（P2）：**提交契约里的最后一道一致性闸门** —— 用版本号 + 权威面 SHA 复核"构建本结果的基线是否仍是
    //   当前版本"。变了（等待期间另一条合法写路径发布了新版本）⇒ **绝不发布**：旧材料完整重写会覆盖新结论。
    //   本批交回重试（retry_wait），下一趟会重新读取当前权威再生成 —— 这正是评审允许的"重新读取并重新生成 /
    //   明确让该批等待重试"，而不是"为了避免失败计数而消除闸门"。
    //   两类原因分开留痕：疑似越界 = `executor_boundary_violation`（上面已写）；正常并发变更 = 本处的 last_error。
    if (baselineRefusal) {
      const msg = `baseline-changed: ${baselineRefusal} — refusing to publish; the batch will retry against the new baseline`
      return failPhase2Batch(batch, msg, nowMs, [msg])
    }
    {
      const nowBaseline = baselineOf()
      const changed = [...authoritativeDiff(baseline.snap, nowBaseline.snap)]
      if (baseline.version !== nowBaseline.version) changed.push('current.json:version')
      if (changed.length) {
        const msg = `baseline-changed: authoritative surface changed while this batch was consolidating (${[...new Set(changed)].join(', ')}) — refusing to publish; the batch will retry against the new baseline`
        return failPhase2Batch(batch, msg, nowMs, [msg])
      }
    }
    if (!result) {
      // t254（T36 · F1）：**真实失败原因**落批级 `last_error`（旧实现一律写含糊的 `llm-unavailable`，
      //   把"服务缺失 / 路由缺失 / 流式异常（含推理强度不支持）/ 空输出"四类差异吞掉）。
      const msg = String(executorObs.reason || 'llm-unavailable')
      return failPhase2Batch(batch, msg, nowMs, [msg])
    }
    // t216（D1 · R2 §5.2 步 4/5）：发布前**由代码渲染引用** —— 有效代号 → 真实路径（含行段）；
    //   映射外的（虚构）引用 ⇒ **整批不发布**（虚构引用不发布，绝不静默放行）。
    // F2（返修 · 独立复核 §4）：**版本身份必须在渲染前核**。`renderPhase2References` 把代号换成
    //   物理路径 + 行段之后，文本里**不再有版本信息**；若渲染后再解析（按"最新版本"），就会同时出现
    //   两个方向的错：合法旧引用被拒、旧版本冒用新段却能发布。故：先在**代号仍在**的原始输出上逐条核
    //   版本与证据段（错配 ⇒ 整批不发布），再把这份**可信解析结果**交给渲染器，并把渲染出的可信引用串
    //   交给校验器（`trustedRendered`）—— 校验阶段**不再重新推断身份**。
    const preParsed = []
    for (const k of ['memory_summary', 'registry']) {
      const ex = extractReferences(String(result[k] || ''), referenceMap)
      if (ex.unmapped.length) {
        const msg = 'unmapped reference: ' + ex.unmapped.map((u) => u.raw).join(', ')
        return failPhase2Batch(batch, msg, nowMs, [msg])
      }
      for (const t of ex.tokens) {
        const vr = verifyReferenceTarget(t.entry, { memoryRoot: referenceMap.memoryRoot, lineRange: t.lineRange })
        if (!vr.ok) {
          const msg = `invalid reference ${t.entry.publicPath} in ${k}: ${vr.reasons.join(', ')}`
          return failPhase2Batch(batch, msg, nowMs, [msg])
        }
      }
      preParsed.push(ex)
    }
    const renderedSummary = renderPhase2References(String(result.memory_summary || ''), referenceMap, preParsed[0])
    const renderedRegistry = renderPhase2References(String(result.registry || ''), referenceMap, preParsed[1])
    const trustedRendered = [...renderedSummary.rendered, ...renderedRegistry.rendered]
    const refUnmapped = [...renderedSummary.unmapped, ...renderedRegistry.unmapped]
    const refUnverified = [...renderedSummary.unverified, ...renderedRegistry.unverified]
    if (refUnmapped.length) {
      const msg = 'unmapped reference: ' + refUnmapped.map((u) => u.raw).join(', ')
      return failPhase2Batch(batch, msg, nowMs, [msg])
    }
    result = { ...result, memory_summary: renderedSummary.text, registry: renderedRegistry.text }
    // 引用可观测（R2 §5.5-7：只记代号与匹配结论，不记原始敏感输出）。
    try {
      await phase2JobsTable.update(batch.id, (curJ) => ({
        ...curJ,
        reference_codes: renderedSummary.used.concat(renderedRegistry.used).filter((v, i, a) => a.indexOf(v) === i).join(','),
        unverified_references: refUnverified.map((u) => u.name).join(','),
      }))
    } catch (err) {
      try { console.warn('[dsh-memory_rollout] reference observability write failed:', err && err.message ? err.message : err) } catch {}
    }
    const validation = validatePhase2Output(result, {
      maxSummaryChars: summaryCapChars(),
      maxRegistryChars: registryCapChars(),
      references: referenceMap,
      trustedRendered,
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
        references: referenceMap,
        trustedRendered,
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
    // F5（返修 · 独立复核 §5）：**最终基线复核移进发布写锁内**。上面的锁外基线闸门只是"早退省工作量"，
    //   它到真正发布之间还夹着引用观测状态更新、所有权检查等步骤 —— 检查正确不等于稍后拿到写锁时仍正确。
    //   因此在 `withWrite` 内、**任何权威写入之前**再核一次；不一致 ⇒ 只**退出写区**（记下冲突），
    //   由写区外的既有作业机制记重试（`failPhase2Batch` 自己会 `withWrite`，**绝不能在锁内调它**）。
    //   范围如实声明：这只守住**本进程自身合法写路径**的并发契约；对不遵守本进程锁的外部写者不构成事务保证。
    let baselineConflict = []
    try {
      // 发布（staging + 切换 current + 根镜像）在写锁内进行，与 import/UI 等写路径串行，
      // 防止并发 import 抹掉正在写的版本目录；model 调用与读取 input 仍在锁外（M4）。
      await withWrite(async () => {
        const nowBaseline = baselineOf()
        const changed = [...authoritativeDiff(baseline.snap, nowBaseline.snap)]
        if (baseline.version !== nowBaseline.version) changed.push('current.json:version')
        baselineConflict = [...new Set(changed)]
        if (baselineConflict.length) return
        await publishPhase2Version(batch.id, result.memory_summary, result.registry)
      })
    } catch (e) {
      const msg = 'publish-failed: ' + String((e && e.message) || e)
      return failPhase2Batch(batch, msg, nowMs, [msg])
    }
    if (baselineConflict.length) {
      const msg = `baseline-changed: authoritative surface changed after the pre-publish check and before the publish lock (${baselineConflict.join(', ')}) — refusing to publish; the batch will retry against the new baseline`
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
  //     定时回调里起写必须走它 ⇒ 写锁竞争时有界重试 + 降噪）+ `withWrite` 内逐条 `put`（`get` 读改写，见下）；
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

  // ── T29：统一摄入的两个入口（A 的调试把手 / B 显式点名）──────────────────────
  const ingestScanTool = defineTool({
    name: 'memory__ingest_scan',
    description: '调试/内部：手动触发一次「静置扫描」（统一摄入口的 A 入口）。按官方 sessionPersistence 列会话，取**根会话 + 静置窗口 + 年龄窗口**内尚未提炼的会话并**只入队**（不调模型）。与启动趟/唤醒趟走的是同一个函数。**F2（2026-10-01）**：静置/年龄以**内容观测时刻**为基准 —— 复制会话/改文件元信息**不重置**计时；宿主不提供内容身份，故用插件自建的最小内容变更记录（详见 CHANGELOG v0.1.28 §十）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ran: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
          scanned: { type: 'integer', required: true },
          candidates: { type: 'integer', required: true },
          enqueued: { type: 'integer', required: true },
          nonRoot: { type: 'integer', required: true },
          fresh: { type: 'integer', required: true },
          // C6：`tooOld` 拆成两个可观测面 + 三个"已发现未提炼（待资格处理）"的原因计数。
          //   （旧 `tooOld` 含义 = 永久跳过，已按契约删除。）
          tooOldDiscovered: { type: 'integer', required: true },
          tooOldQueued: { type: 'integer', required: true },
          // 顺手收口②（评估 §六）：根会话取不到时间信号而跳过的条数（不再静默不计）。
          noTimeSignal: { type: 'integer', required: true },
          // F2：为内容计时读过的正文条数（只在 `sizeBytes` 变化时读 ⇒ 不是每趟全量重算）。
          contentBodyReads: { type: 'integer', required: true },
          // 落点③：被**血缘门**（`isRootSessionHeader`，用户已裁定保持）判为"已发现未资格"的条数。
          nonRootDeferred: { type: 'integer', required: true },
          done: { type: 'integer', required: true },
          sourceGone: { type: 'integer', required: true },
          // t241（R2）：本趟「尝试过但没入队、因此**不推进**完成水位」的候选数（下次扫描仍会重试）。
          deferred: { type: 'integer', required: true },
          // t249（T33-一）：本趟识别为**内部执行者会话**（永不作来源）而跳过的条数。
          internal: { type: 'integer', required: true },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: v.ran
          ? `静置扫描：扫到 ${v.scanned}，候选 ${v.candidates}，入队 ${v.enqueued}（非根 ${v.nonRoot} / 内部执行者 ${v.internal} / 未静置 ${v.fresh} / 超龄发现 ${v.tooOldDiscovered}（其中本趟纳入 ${v.tooOldQueued}） / 已发现未提炼：血缘门待资格处理 ${v.nonRootDeferred}、无时间信号 ${v.noTimeSignal} / done(完成水位挡下，**与"整理完成"不同义**) ${v.done} / 源已不在 ${v.sourceGone} / 本次延后 ${v.deferred} / 内容计时读正文 ${v.contentBodyReads} 条）`
          : `静置扫描未运行：${v.reason}`,
      }],
    },
    async execute() {
      const r = await ingestIdleScan('manual')
      scheduleStage1Drain(perPassSourceBudget())
      return {
        ran: !!r.ran,
        reason: String(r.reason || ''),
        scanned: Number(r.scanned || 0),
        candidates: Number(r.candidates || 0),
        enqueued: Number(r.enqueued || 0),
        nonRoot: Number(r.nonRoot || 0),
        fresh: Number(r.fresh || 0),
        tooOldDiscovered: Number(r.tooOldDiscovered || 0),
        tooOldQueued: Number(r.tooOldQueued || 0),
        noTimeSignal: Number(r.noTimeSignal || 0),
        contentBodyReads: Number(r.contentBodyReads || 0),
        nonRootDeferred: Number(r.nonRootDeferred || 0),
        done: Number(r.done || 0),
        sourceGone: Number(r.sourceGone || 0),
        deferred: Number(r.deferred || 0),
        internal: Number(r.internal || 0),
      }
    },
  })

  const ingestSessionTool = defineTool({
    name: 'memory_ingest_session',
    description: '把一个指定会话摄入记忆（统一摄入口的**显式入口**）。默认只入队；awaitDraft=true 时等到**本次来源水位**的 stage-1 草稿落盘且证据可读再返回（上限 timeoutMs，默认 600000 = 10 分钟）。"已提炼"的判定 =(本次水位的 stage-1 作业 succeeded_with_output)且(其 rollout_summaries/<会话id>.md 里的证据段现在可读)；旧草稿不算。超时/失败只如实返回结果、不产生任何产物；插件**不驱动任何删除动作**（"记忆并删除"编排已撤除，见 CHANGELOG v0.1.28 §一）。',
    parameters: {
      sessionId: { type: 'string', required: true, description: '要摄入的会话 id。' },
      awaitDraft: { type: 'boolean', description: 'true = 等到本次水位的草稿+可读证据落盘再返回（默认 false，仅入队）。' },
      timeoutMs: { type: 'integer', description: '等待上限（毫秒，默认 600000 = 10 分钟，范围 1000–3600000）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: { type: 'boolean', required: true },
          ingested: { type: 'boolean', required: true },
          sessionId: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          draftFile: { type: 'string', required: true },
          waitedMs: { type: 'integer', required: true },
          key: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: v.ingested
          ? `已提炼本次内容：${v.sessionId}（草稿 ${v.draftFile}，等待 ${v.waitedMs} ms）`
          : `未取得本次内容的可读草稿：${v.sessionId}（queued=${v.queued}${v.reason ? `, reason=${v.reason}` : ''}，等待 ${v.waitedMs} ms）`,
      }],
    },
    async execute(args) {
      const sid = String((args && args.sessionId) || '')
      const awaitDraft = !!(args && args.awaitDraft)
      const rawTimeout = Number(args && args.timeoutMs)
      const timeoutMs = Math.max(1000, Math.min(3600000, Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_INGEST_AWAIT_DRAFT_MS))
      const t0 = Date.now()
      const out = await ingestSessionById(sid, { explicit: true, forceReason: 'memory_ingest_session' })
      scheduleStage1Drain(perPassSourceBudget())
      // R1：判据绑定**本次来源水位**（旧判据 `draftLanded(sid)` = 草稿文件存在 ⇒ 历史草稿会误放行）。
      const watermark = String((out && out.watermark) || '')
      let ev = watermark ? draftEvidenceOf(sid, watermark) : { ok: false, reason: String((out && out.reason) || 'no-watermark') }
      while (awaitDraft && !ev.ok && Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 500))
        if (watermark) ev = draftEvidenceOf(sid, watermark)
      }
      return {
        queued: !!(out && out.queued),
        ingested: !!ev.ok,
        sessionId: sid,
        reason: String((out && out.reason) || (ev.ok ? 'watermark-evidence-readable' : (ev.reason || 'timeout'))),
        draftFile: ev.ok ? draftFileOf(sid) : '',
        waitedMs: Date.now() - t0,
        key: String((out && out.key) || ''),
      }
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
      // M1-R3：只锚定去除 writeRegistry() 固定生成的行尾元数据后缀，不删任意圆括号内容（避免误伤事实里的括号）。
      // t216（D1）：长-期记忆行不再内联 `session=`，故后缀两种形态都要兼容（旧出版本 + 新出版本）。
      s = s.replace(/\s*\((?:session=[^)]*,\s*)?updated=[^)]*\)\s*$/, '')
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
        if (!best || hits > best.m) best = { content: t, citation: `${renderReferencePath(`rollout_summaries/${name}`)}:${i + 1}-${i + 1}`, m: hits }
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
    const regRel = renderReferencePath(path.relative(memoryRoot(), cur.registryPath).replace(/\\/g, '/') || 'MEMORY.md')
    const regLines = readText(cur.registryPath).split(/\r?\n/)
    const memo = (p, s, e) => `${p}:${s}-${e}|note=[recalled from memory]`
    const UNVERIFIED = 'unverified:0-0|note=[no verifiable file+line source; not attested]'
    return entries.map((e) => {
      // P1-1：条目通过 stage1_outputs 有真实 source_ref → 用证据文件 + 精确行段。
      const sr = sourceRefForEntry(e)
      // t216（D1）：读工具与发布/注入**共用同一引用约定**（统一渲染为 `memories/…`）。
      if (sr && sr.ref) return memo(renderReferencePath(sr.ref.path), sr.ref.startLine, sr.ref.endLine)
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
          if (normalContent && normalSpan.includes(normalContent)) return memo(renderReferencePath(relPath), 1, draft.spanEnd)
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
      // t195（④ 照 codex）／t219 正名：这是「**entries 层检索资格策略**」—— **只**过滤 entries。
      //   依据镜像 `codex-rs/state/src/runtime/memories.rs` L473-477：用过看 `last_usage`、从未用过看
      //   来源新鲜度，二者都要落在 `max_unused_days`（默认 30）窗口内；本地映射见 `entryEligible()`。
      //   **分层范围差异**：`searchMemoryFiles()`（权威文件 + 草稿）与总纲注入**不走**这条链
      //   ⇒ 一条 entries 失格**不保证**同一事实从文件搜索/注入里消失（见文件头「三层分离」）。
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
      '压缩前/会话关键时主动调用，防信息因上下文压缩丢失。把当前会话的关键要点**立即**写入本会话草稿（rollout_summaries/<sessionId>.md，保全内容、不调模型）；**但它排的提炼作业走正常 6h 内容静置资格**（模型自行调用 ≠ 用户授权 —— 不够静置时只留一条复查请求、不入队）。只有用户明确要求并显式传 force=true 才立即提炼。参数 content 为 agent 提炼的要点。',
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
          '【AI 不得擅自使用；仅当用户明确要求「把这段写进记忆」时才传 true】默认 false。true = 跳过**静置资格**（并绕过 external_context 生成资格跳过），强制把本会话作为一次 Stage1 作业**立即**入队并提炼。绕过后果：外部来源内容可能因此进入长期记忆、且不等 6h。不传 / false = **只立即落草稿**；提炼作业按**正常 6h 静置资格**排队（不够静置则只留一条复查请求、不入队）。',
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
        // 资格（队长裁定 2026-10-01 · 评估 §五「模型自行调用 ≠ 用户授权」）：**草稿已在上一行立即落盘**
        //   （保全内容、不调模型 —— 语义不变）；但它排的**提炼作业走正常 6h 内容静置资格**：
        //   `explicit` **不再自动为真**，只有 `force=true`（用户明确要求）才即时入队。
        let precompactQualified = forceOn
        if (!forceOn) {
          const snapQ = await sessionSnapshotById(sid)
          const persistenceForTime = ctx.get('sessionPersistence', false)
          const seedMt = sessionSourceMtimeMs(persistenceForTime, (sess && sess.header) || null, snapQ)
          const clock = await contentClockFor(sid, snapQ, { persist: true, seedMtimeMs: seedMt })
          const q = qualifiesForAutoIngest({
            header: (sess && sess.header) || null, snapshot: snapQ, mtimeMs: seedMt, contentAtMs: clock.firstSeenAtMs,
          })
          precompactQualified = q.ok === true
          if (!precompactQualified) {
            // 不够静置（或取不到时间信号）⇒ **不入队**，只请求一次复查；下一次扫描/唤醒按同一资格判定决定。
            await requestIdleRecheck(sid, 'precompact-not-qualified:' + String(q.reason || 'unknown'))
          }
        }
        if (precompactQualified) {
          const enq = await enqueueStage1JobIntoTable(
            sid,
            contentWatermark(raw),
            {
              ...(forceOn ? { forced: true, forceReason: 'user_requested' } : {}),
              // 只有 force（用户明确要求）才标 explicit ⇒ 消费期"正文已变"时保持即时。
              ...(forceOn ? { explicit: true } : {}),
              sourceWatermarkKind: 'content-body',
            },
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
  // T29：统一摄入的两个入口（A 的调试把手 + B 显式点名）
  ctx.tools.register(ingestScanTool)
  ctx.tools.register(ingestSessionTool)

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
  // T29（A 静置扫描）：启动趟先扫一遍"根会话 + 静置/年龄窗口内、且未提炼"的会话并**只入队**
  //   （与 codex 的 startup claim 同构：`codex-rs/memories/README.md` L29-51），随后再排 drain；
  //   空闲期的周期由 `armStage1Wake()` 叠加（复用同一计时器，不新增定时器平台）。
  try {
    const scan = await ingestIdleScan('boot')
    if (scan && scan.ran) {
      try { console.info(`[dsh-memory_rollout] idle scan (boot): scanned=${scan.scanned} candidates=${scan.candidates} enqueued=${scan.enqueued} (nonRoot=${scan.nonRoot} internal=${scan.internal || 0} fresh=${scan.fresh} tooOldDiscovered=${scan.tooOldDiscovered || 0} tooOldQueued=${scan.tooOldQueued || 0} noTimeSignal=${scan.noTimeSignal || 0} nonRootDeferred(血缘门待资格处理)=${scan.nonRootDeferred || 0} contentBodyReads=${scan.contentBodyReads || 0} done(完成水位挡下)=${scan.done} sourceGone=${scan.sourceGone} deferred=${scan.deferred || 0})`) } catch {}
    }
  } catch (err) {
    try { console.warn('[dsh-memory_rollout] idle scan (boot) failed:', err && err.message ? err.message : err) } catch {}
  }
  armStage1Wake()
  // t189（②·门槛一）：把"本次启动最多处理 N 个来源"绑在启动这一趟 drain 上。
  //   t191（t190 发现②，选 A）：预算改为**可继承对象** ⇒ busy-rerun 补跑趟吃同一额度，不再是"只影响这一趟"。
  scheduleStage1Drain(perPassSourceBudget())
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
  // C4（契约 §C4 ③④）：事件面**只保留一个**监听者 —— `session/disposed`，且它**只请求复查、不再直接入队**；
  //   原先的**空监听** `session/event`（只为"不空注册"而存在、内部无任何操作）按契约删除。
  const eventDisposers = [
    // C4：会话被销毁 ⇒ **先取该会话的持久快照**，再用**唯一**资格判定决定"够静置了才入队"。
    //   旧行为是直接 `ingestSessionById` ⇒ 绕过静置窗口（用户裁定 §10.1 明文禁止）。
    //   disposer 依旧短小：不读会话正文、不跑模型；拿不到快照 ⇒ 只留复查请求、保守不放行。
    ctx.on('session/disposed', async (session) => {
      const sid = session && session.id ? String(session.id) : ''
      if (!sid) return
      try {
        const snap = await sessionSnapshotById(sid)
        if (!snap) {
          await requestIdleRecheck(sid, 'session-disposed-no-snapshot')
          return
        }
        // ⚠️ **C4 真缺陷修复（本批实测发现）**：快照头取自 `persistence.list()`，它**可能不含血缘字段**
        //   （真宿主也只在列出快照里给最小头）。若把它当作权威头传下去，`isRootSessionHeader` 就会
        //   因为"字段缺失"把**非根会话误判成根**（且旧代码到读源那里还会用持久头覆盖入参头 ⇒ live 会话上的
        //   `parentSession`/`delegationDepth` 被抹掉）。实测（t189 T6）：`live.header={parentSession}`
        //   经 disposed 后**仍然入队成功** ⇒ `non-root-session` 这道安全门被穿透。
        //   修法 = **给入参头起一个"保留血缘"的合并头**：以 live 会话头为基（拿不到则用快照头），只补
        //   快照里多出来的键。分桶按**字段存在性**判定 ⇒ 不覆盖 `delegationDepth`/`parentSession`/`origin`
        //   就等于**没有伪造血缘**；未知血缘仍按既有保守口径（`isRootSessionHeader` 默认放行）。
        const liveHeader = session && session.header && typeof session.header === 'object' ? session.header : null
        const snapHeader = snap && snap.header && typeof snap.header === 'object' ? snap.header : null
        const baseHeader = liveHeader || snapHeader
        const lineageHeader = { ...(snapHeader || {}), ...(baseHeader || {}) }
        const persistenceForTime = ctx.get('sessionPersistence', false)
        const mt = sessionSourceMtimeMs(persistenceForTime, lineageHeader, snap)
        // F2：本会话还没有内容计时记录时就地建立（保守起点 = 现在；`persist:true` ⇒ 立即落盘），
        //   再按**内容计时**判资格 —— 与扫描趟同一基准。
        const clock = await contentClockFor(sid, snap, { persist: true, seedMtimeMs: mt })
        const q = qualifiesForAutoIngest({ header: lineageHeader, snapshot: snap, mtimeMs: mt, contentAtMs: clock.firstSeenAtMs })
        if (!q.ok) {
          // 未达标（刚更新 / 取不到时间）⇒ **只请求复查**，绝不入队 —— 这就是"不得绕过 6h"。
          await requestIdleRecheck(sid, 'session-disposed-not-qualified:' + q.reason)
          return
        }
        // 达标 ⇒ 走**同一个统一摄入口**（同一资格判定 + 同一去重 + 同一根会话门）。
        const enq = await ingestSessionById(sid, {
          header: lineageHeader, snapshot: snap, liveSession: session, mtimeMs: q.mtimeMs,
          contentAtMs: clock.firstSeenAtMs, explicit: false,
        })
        // R2：同一趟已读过正文 ⇒ **回填内容基线**（不重复读），让后续"线索变而正文未变"能判成"不重置"。
        if (enq && enq.watermark) {
          const map = contentSeenMap()
          const prevRec = map[sid] || {}
          map[sid] = {
            sizeBytes: Number((snap && snap.sizeBytes) || 0),
            revision: String((snap && snap.revision) || ''),
            watermark: String(enq.watermark),
            firstSeenAt: prevRec.firstSeenAt || nowIso(),
            firstSeenSource: prevRec.firstSeenSource || 'content-change',
          }
          try { await writeStage1Meta({ contentSeen: capContentSeen(map) }) } catch { /* 记账失败不改结论 */ }
        }
        if (enq && enq.queued === false && enq.reason && enq.reason !== 'already-ingested') {
          try { console.info('[dsh-memory_rollout] session/disposed (idle-qualified) not queued:', enq.reason) } catch {}
        }
      } catch (err) {
        try { console.error('[dsh-memory_rollout] session/disposed handler error:', err) } catch {}
      }
      // 消费到期 pending 作业（领取→锁外提炼→提交）；t210：事件趟**也带 per-pass 来源上限**。
      scheduleStage1Drain(perPassSourceBudget())
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
            if (body && body.action === 'reset') {
              // 「一键恢复默认」= **清掉 overlay**，让 schema 默认重新生效（不是把默认值写进 overlay，
              //   否则默认值会被"冻结"成显式值、将来改默认不再生效）。默认值由 Config({}) 派生。
              const p = settingsPath()
              const bak = p + '.pre-reset'
              let backup = ''
              try {
                if (fs.existsSync(p)) {
                  // 同族只留最新 1：建新备份前先删旧的
                  try { if (fs.existsSync(bak)) fs.rmSync(bak, { force: true }) } catch {}
                  fs.copyFileSync(p, bak)
                  backup = path.basename(bak)
                  fs.rmSync(p, { force: true })          // 删不掉会抛 ⇒ 下面如实回报失败
                  if (fs.existsSync(p)) throw new Error('overlay still exists after delete')
                }
              } catch (err) {
                sendJson(res, 500, { saved: false, reset: false, error: 'reset failed: ' + String((err && err.message) || err) })
                return
              }
              // 内存里把 overlayable 键恢复成 schema 默认 ⇒ 本会话立刻就是默认态
              try {
                const defaults = Config({})
                for (const k of OVERLAYABLE_KEYS) if (k in defaults) config[k] = defaults[k]
              } catch {}
              sendJson(res, 200, {
                saved: true, reset: true, backup,
                hasOverlay: fs.existsSync(p),
                config: currentConfigView(),
                defaults: configDefaults(),
                fields: CONFIG_FIELDS,
                root: memoryRoot(),
              })
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
