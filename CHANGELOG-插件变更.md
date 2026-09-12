# CHANGELOG — dsh-memory_rollout 插件变更

遵循《向 Codex 原版系统看齐》工程总纲 §19 工作纪律：每次变更记录对应需求、行为变化、测试与成熟度等级变化。成熟度等级（L0–L4）见总纲 §3。

## 2026-09-12 · v0.1.10：每日预算「日界」由 UTC 日改为**本机时区**日（本地 00:00 换日）

本次把阶段 A 的「每日模型尝试预算」**日界口径**从 **UTC 日**改为**本机（客户端）时区日**。基线：`759121d`（v0.1.9）。

### 变更（**行为变更**）

- `dayKey()` 由 `d.toISOString().slice(0, 10)`（**UTC 日**）改为用本地 `getFullYear/getMonth/getDate` 拼 `YYYY-MM-DD`（**补零**）。
  全仓复核：**再无以 UTC 日作日界的地方**（仅此一处，另有 2 个调用点 `drain` 前预算门 / 真模型尝试后计数，均只调 `dayKey()`，未改语义）。
- **`runDay` 字段与 `modelAttemptsToday` 的重置时点随之改变**：以前在 **UTC 午夜**换日（东八区 = 北京时间 **08:00**），现在在**本地 00:00**换日。
- **不新增任何持久字段**，`runDay` 仍是 `YYYY-MM-DD` 字符串（schema 未动）。
- **（t132 补完）`nextDayBoundaryMs()` 唤醒点同步为本地午夜**：该函数原用 `d.setUTCHours(24, 0, 0, 0)`（**UTC 午夜**），被「预算耗尽 + 有到期作业 → 跨日唤醒」调用。日界本地化后二者口径不一致——新预算日从**本地 00:00** 起算，唤醒点却仍在 **UTC 午夜**（东八区＝本地 **08:00**），⇒ 新预算日开始后最多 **8 小时**（UTC−5 约 19h）没有跨日唤醒、作业干等。已改为 `d.setHours(24, 0, 0, 0)`（**本地下一午夜**，与 `dayKey()` 同一套语义），返回类型与语义均未变。

### ⚠ 首日一次性额外重置（必须知晓）

旧 `runDay` 是 UTC 日字符串。**升级后首次 drain** 会拿它与**本地日**比较：

| 情形 | 结果 |
|---|---|
| 本地日 ≠ 存储里的旧 UTC 日 | 触发一次**额外重置**：`runDay` 改写为本地日，`modelAttemptsToday` **归零**（当日已用量被清空 → 当日可再跑满一整轮预算） |
| 本地日 == 旧值（本地 08:00–24:00 之间升级） | 不额外重置，按本地日继续计数 |

本机实测（2026-09-12 16:26 本地 / 08:26 UTC）：主脚 `runDay="2026-09-11"`、`modelAttemptsToday=17` → **升级后首次 drain 即归零**；闲脚 `runDay="2026-09-12"` 与当日本地日相同 → **不额外重置**。
**下一次重置时刻**：旧口径 = 2026-09-13 08:00（本地）；新口径 = **2026-09-13 00:00（本地）**。
这是**一次性**的（此后 `runDay` 恒为本地日），不会每天多给预算。

### 测试

- 新增 `test/daykey-local-timezone.test.mjs`：把 `process.env.TZ` 固定为 `Asia/Shanghai`（UTC+8）并**冻结全局时钟**在一个「UTC 日 ≠ 本地日」的时刻（`2026-09-12T17:30:00Z` → 本地 `2026-09-13 01:30`），用**真实 drain** 观察 `stage1_meta.runDay`：
  - 断言 `runDay === '2026-09-13'`（本地日）**且** `!== '2026-09-12'`（同一时刻的 UTC 日）→ **旧实现必红**；
  - 覆盖「旧 UTC 日 → 跨日归零 + 恢复领取」「同一本地日内不重置」「**本地 00:00 边界**：23:59:59 → 次日 00:00:01 即换日并归零」。
  - 开头硬断言 `getTimezoneOffset() === -480`，TZ 前提不成立就失败，避免"看起来通过"。
- **修正既有测试** `test/polish-retry-lease-budget.test.mjs`：其内部有一份**旧的 UTC 版 `dayKey` 副本**（`toISOString().slice(0,10)`）；不改它会在**本地 00:00–08:00** 之间与本插件写下的 `runDay` 不一致而**假失败**。已改为同口径的本地日实现（断言未放宽）。
- 回归：`pwsh -NoProfile -File test/run-tests.ps1` → **51/51**（原 50 + 新增 1）；`node --check lib/index.js` / `lib/client.js` 均 exit 0。

### 成熟度

功能完成度约 88%～92%（工程判断）。口径修正已在部署副本同步（三处 SHA256 一致）；**需重启 DSH 才生效**。仍处候选观察期。

## 2026-09-11 · v0.1.9：整合提示词「元数据键」禁令补齐（普通批与压缩批同一套）

本次收口整合提示词上的一个**发布阻断**：整合模型若在产物里写出 `key: value` 形式的元数据键，会被**既有安全闸门**判为泄露、被发布前校验拒绝，导致整批不发布、长期停在上一版。**安全闸门本身零改动**（`redactSecrets` / `looksLikeToken` / `validatePhase2Output` 逐字未动），只补提示词侧的禁令与正确写法。基线：`b21c5c3`（v0.1.8）。

### 变更

**(a) 压缩批禁令（t82）**
- `COMPRESSION MODE` 覆盖块补 4 行禁令：产物**不得**出现 `key: value` / `key=value` 形式的元数据键；点名 `session_id` / `token` / `api_key` / `secret` / `auth` / `password` / `access_token` / `client_secret`；`[REDACTED]` 必须原样保留、不得改写。

**(b) 普通批同一套禁令（t83）**
- 把同一套禁令写入**普通批（非压缩）**的系统提示词 `CONSOLIDATION_SYSTEM_PROMPT`（新增规则 8–11）。**压缩批与普通批自此同一套口径**，不再只在压缩路径上防。

**两个陷阱（为什么「别写 session_id」还不够）**
1. **键名陷阱**：脱敏器的键白名单里含 `session[_-]?id` —— 产物里一旦出现 `session_id: <值>`，**值会被就地替换成 `[REDACTED]`**；随后发布前校验看到 `[REDACTED]`，判定「未脱敏的秘密仍在产物里」→ 整批拒绝、保留上一版。
2. **长串陷阱（易漏）**：长串规则 `[A-Za-z0-9+/_=-]{40,}` 加 `looksLikeToken`（≥40 位、含数字、且含大写或含 `[+/_=-]`）会把 **`session=<完整 uuid>`** 这种「键=值」写法整体判为令牌——`=` 本身就在该字符类里，44 字符长串 + 含数字 + 含 `=` → 判令牌 → `[REDACTED]` → **同样被拒**。因此「沿用既有写法 `(session=<id>)`」在 id 为完整 uuid 时**本身就会失败**。

**正确写法**：会话 id 只以**裸 id / 短 id** 出现，或干脆省略；**绝不加标签、绝不写成等号形式**。

### 测试
- 新增 `test/t80-gate.test.mjs`（此前未纳入仓库）：覆盖 t80 三层闸门 + t82 双陷阱探针 + t83 普通批禁令断言——提示词规则 8–11 存在、8 个点名键齐全、喂入含 `session_id` 的注册表后提示词里确实出现该串（证明风险真实）、确认走的是非压缩批、负控被拒且 `current.json` 未变、正控发布成功且 ≤ 上限。
- 回归：`pwsh -NoProfile -File test/run-tests.ps1` → **50/50**；`node test/m3-e2e-acceptance.mjs` → **ALL M3 E2E ACCEPTANCE PASSED**（合计 **51/51**，0 FAIL）；`node --check lib/index.js && node --check lib/client.js` 通过。
- **隔离沙箱验证**（临时 `DSH_HOME` + 真实 `memories/` 副本 + 注册表内**实含** `session_id`）：负控（违规产物）→ 被拒、`current.json` **未变**；正控（合规产物）→ 发布成功且 ≤ 14,400 字符、含指针；压缩批回归 → 仍正常发布；`entries` 表**字节一致**。真实记忆库全程未被触碰。
- **诚实边界**：沙箱用的是**模拟产出**，只证明「管线接受合规产物、拒绝违规产物」，**不等于真实 LLM 一定会照禁令写**；真实批次的实际遵从度待真实运行观察。

### 成熟度
功能完成度约 88%～92%（工程判断）。本仓库同步后 51/51 全绿。仍处候选观察期。

## 2026-09-11 · v0.1.8：显式入口 force 开关 + 记忆总纲尺寸闸门四件套

本次把已在部署副本运行验证的两类改动同步回本仓库：**(a) 显式入口 `force` 绕过开关**、**(b) 记忆总纲尺寸闸门四件套**（三层闸门 / 一次性压缩 / 分层披露 / 上限参数化）。基线：`ef76cdf`（v0.1.7）。

### 变更

**(a) 显式入口 `force` 开关（主动记忆，默认关）**
- `memory_precompact` 新增**可选、默认 false** 的 `force` 参数。传 `force:true` 才绕过 `assessEligibility()` 的 `external_context` 跳过（本会话出现过 `web_search`/`web_fetch` 时整会话跳过生成）；**不传 / false 行为与原来完全一致**。
- **白名单式**：`force` 只由该显式入口透传到入队；**自动路径（`session/disposed`）永不携带 force**，`external_context` 规则本身与自动路径**零改动**。
- 已存在的同 watermark 作业若已是 `succeeded_no_output`（被外部上下文跳过），force 时**重置为 pending** 以按 force 重新提炼（否则会被「已提炼过」永久挡掉）。
- **留痕可审计**：job 记录写 `forced` / `force_reason` / `forced_at`，产出记录写 `forced` / `force_reason`，并在**日志**打两条明确记录（入队时 + worker 绕过时）。
- **纪律条款（必须遵守）**：`force` **默认关**；**AI 不得擅自使用**；**仅当用户明确要求「把这段写进记忆」时**才可传 `force:true`。它绕过的是「会话用过 web_search/web_fetch → 整会话跳过提炼」这道门，**后果是外部来源内容可能因此进入长期记忆**；使用后 job/产出永久留 `forced:true` 痕迹，可被审计追责。**不替代条件判断。**

**(b) 记忆总纲尺寸闸门四件套（t80）**
- **三层闸门**：L1 输入限量（`clampPromptInputs` 按预算裁剪喂给整合模型的输入）；L2 尺寸限长 + 分层披露（提示词内下发 SIZE BUDGET / PROGRESSIVE DISCLOSURE 规则）；**L3 发布前尺寸闸门**（按代码点计数校验 `memory_summary` / `MEMORY.md`，超限**不发布、保留上一版**）。
- **一次性压缩批**：新增批次模式 `mode: 'compress'`（`enqueueCompressBatch`）——**只由显式入口** `memory_integrate {compress:true}` **创建**；**调度器（`claimNextPhase2Job`）与自动路径永不创建 compress 批**。compress 批「无新输入」是正常语义，故对 `no-inputs` 失败豁免（普通批行为逐字不变）。
- **分层披露**：`memory_summary` 每条记忆限单行、约 ≤120 字符（Progressive disclosure），把「总纲」压成可注入的摘要层。
- **上限参数化**：字符上限由 `config.summaryTokens` 派生（`summaryCapFromTokens` / `registryCapFromTokens`，默认 4000 → summary 14,400 / registry 24,000 字符），并使提示词里的 SIZE BUDGET / COMPRESSION MODE 文本随 `summaryTokens` 变化。
- **纪律条款**：`compress` 批**只由显式入口独占创建**，**调度器永不创建**。

### 测试
- 回归（同步后的新 `lib/index.js`）：`pwsh -NoProfile -File test/run-tests.ps1` → **49/49**；`node test/m3-e2e-acceptance.mjs` → **ALL M3 E2E ACCEPTANCE PASSED**（合计 **50/50**，0 FAIL）。
- `force` 专项（隔离临时 DSH_HOME）：不带 force 仍被 `external_context` 跳过（未调 llm、未产出、作业无 `forced` 字段）；带 force 经显式入口入队 `forced=true` 并产出 `stage1_outputs`（产物 `forced=true`）；worker 层 forced 绕过；已跳过作业 force 后重置 pending 并产出；自动路径入队作业无 `forced`；无外部上下文会话行为不变。真实记忆库 SHA/size/mtime 跑测试前后完全一致（未污染）。

### 成熟度
功能完成度约 88%～92%（工程判断）。两类改动已在部署副本经真实运行验证并重启生效；本仓库同步后 50/50 全绿。仍处候选观察期。

## 2026-09-02 · v0.1.7 候选发布收口：P0-9 Phase2 过期作业延迟重试失醒修复 + 发布身份闭合

响应《再次全量评估（2026-09-02）》：主体架构不需返工，但有一项真实运行中已出现的 P0（Phase 2 `retry_wait` 到期后失醒）与两组发布收口（版本/改名/npm 路径）未闭合。**判定：暂不宣布「稳定正式版」，先完成此轮 P0 与发布收口，再进入 2~5 天观察。** 基线：`1c036d8`。

### 变更
- **P0-9 修复 Phase 2 过期作业失醒**：`nextPhase2WakeAt()` 原来只把「未来的 `available_at`/租约」当唤醒时间；作业一旦已到期（`av<=nowMs` 或 `le<=nowMs`），反而返回 `null`。而 `schedulePhase2Wake()` 每次都先清旧计时器，于是到期附近若发生一次额外调度（busy / no-change / 恢复早退），过期的 `retry_wait`/`pending` 批会从时间调度视野消失，无新事件时无限停住。修复后对已到期非终态批返回「立即」（`nowMs`），由 `phase2Integrate` 单飞吸收，且已领取批的退避总是未来 `available_at`（≥30s），不形成忙循环。
- **发布身份闭合（v0.1.7）**：版本升至 `0.1.7`；`files` 白名单改为显式列出脚本/文档/协议（确保 `.bak-*` 备份与 `*.tgz` 永不进包）；`description` 修订——区分「**合格会话自动提炼**（`generateMemories`）」与「**手动增/改/忘仅在显式请求时执行**」，不再笼统写 「only on explicit user request」。
- **改名兼容策略（确定为不可逆）**：确认候选版（旧命名 `dsh-rollout`/`dsh-memory-rollout`）**未对外分发**（npm registry 尚未发布、仅本地 Git 远端、本机无旧设置文件），因此按评估第二分支「正式发布前的破坏性改名」处理：**不为此增加旧 settings 回退读取 / 旧 backup format 兼容**，并在发布说明明确 `dsh_rollout` 存储域不变、改名不可逆。
- **README 安装路径改为可兑现**：把 GitHub 仓库 / `npm pack` 本地 tgz 设为「已兑现、推荐」安装路径；`dsh plugin --profile web add dsh-memory_rollout` / `pnpm add dsh-memory_rollout` 标注为「npm registry 尚未正式发布，暂不可用」。

### 测试
- 新增 `test/p0-9-phase2-expired-wake.test.mjs`（定时器级，黑盒驱动真实 `schedulePhase2Wake → setTimeout → phase2Integrate` 链，不直接调内部函数）四项：
  - T1 恢复早退（`published→commit`）后重新武装唤醒，过期 `retry_wait` 不失醒；
  - T2 busy 单飞吸收后由运行中纤维在返回点重排，过期批不丢；
  - T3 启动时已过期批次被自动处理（启动冒烟）；
  - T4 安全校验持续失败 → 按 `max_attempts` 进 `failed_terminal`，未泄露、不无限高频重试。
- 验证：临时把修复回滚为缺陷版本 → T1/T2 各 2 条断言失败（4 失败），证明测试确能抓住缺陷；恢复修复后全绿。
- 回归：`pwsh -NoProfile -File test/run-tests.ps1` → **49/49**；`node --check lib/index.js && node --check lib/client.js` 通过；`node test/m3-e2e-acceptance.mjs` A~G 全过；`npm pack` 产出 9 文件、`npm install <tgz> --legacy-peer-deps` 离线安装冒烟成功（tarball 内代码与仓库 SHA256 一致）。

### 成熟度
功能完成度约 88%～92%（工程判断）。P0 修复 + 发布收口完成；A.4「真实运行观察该批次自动进第三次尝试/终态」需**部署新代码并重启 DSH 进程**后验证（重启属宿主/用户域）。进入 2~5 天观察期，之后才可自信称「稳定正式版」。

## 2026-09-01 · R2.1 收口：会话草稿引用回退改为规范化完整子串（废除单 token 放行）

响应 GPT 独立复核：`memoryCitationEntries` 的会话草稿回退原实现只要 entry 与草稿共享一个特征词（`tokenizeContent` 有交集）就返回 1-N 引用——同关键词不同事实（草稿「pnpm build failed」/ entry「user prefers pnpm over npm」）会被伪装成已核验引用，provenance 伪装成 evidence，与精确 Stage1 路径已删的单 token 放行同病。独立交叉复核（子代理，fresh context）确认缺陷实质消除、无残留单 token 放行路径。基线：`106a557`。

### 变更
- **草稿引用回退改完整子串**：`memoryCitationEntries` 的会话草稿回退仅当草稿正文（`normalizeContent` 归一化）**确含** entry 内容的规范化完整子串时才返回草稿引用（1-N 行段）；否则诚实回退 `unverified`（宁缺毋滥）。`tokenizeContent` 不再参与任何引用放行（仅用于 remember 去重/自动取代）。
- **`validateSourceRef` 内容分支同步收紧**：改为「规范化完整子串包含」判定，删除「共享一个 ASCII 特征词即放行」的单 token 放行。
- **citation-format 契约更新**：场景 [2]（草稿确含完整内容仍引用）+ 新增场景 [3]（草稿仅共享 token 不引用草稿、回退 unverified）。

### 测试
- 更新 `test/citation-format.test.mjs`（[2] 保留、新增 [3]）。
- 新增 `test/p0-r2-4-real-e2e-verify.test.mjs`：真实 lib/index.js + 真实 DomainFacility + 真实文件后端，覆盖 idle remember/note/forget 自主入 current、source_unavailable 可重试至 terminal 不烧配额、empty/short/model_empty 分型、同 session 双 watermark 双 source_ref、召回引用不出现同关键词不同事实错配。
- 回归：`pwsh -NoProfile -File test/run-tests.ps1` → **48/48**；`npm run check` 通过。

### 成熟度
R2 遗留引用缺陷收齐（单 token 放行残余消除），48/48 全绿；进入候选发布观察。

## 2026-08-31 · P0-R2 收口（Phase2 唤醒覆盖统一变更流 · 引用校验去单 token 放行 · sessionQuery 能力声明）

对照独立验收暴露的 3 处残留：① Phase2 自动唤醒只散落在 `memory_remember`/UI add，`forget`/`note`/UI delete 写入 pending change 后不唤醒（空闲期 change 长期 pending、权威 current 不更新）；② 引用校验仍按「共享一个 ASCII 特征词」放行；③ `sessionQuery` 服务缺失被当作 `empty_source` 静默成功。基线：`da63474`。

### 变更
- **Phase2 唤醒收口到 `writeChangeRecord`**：成功 `put` 后统一调用 `requestPhase2Integrate()`（busy 置 rerun latch、空闲经 `setImmediate` 异步入队，绝不同步调避免 `withWrite` 嵌套死锁），删除 `memory_remember`/UI add 的散落调用——「成功产生 pending change」成为 Phase2 唤醒唯一边界；手动 `memory__phase2_integrate` 仍 `clearImmediate`+清 latch 取消 pending 自动请求，不吞手动整合。
- **删除引用校验单 token 放行**：`validateSourceRef` 内容分支只接受规范化完整子串，删除「共享一个 ASCII 特征词即放行」；草稿回退路径单独改为文件存在+行段有效+共享特征词的粗粒度会话指针（保住 citation-format 契约）。
- **`sessionQuery` 声明必需 + 能力暴露**：`inject` 声明 `sessionQuery` 必需（cordis 未提供即加载失败/禁用生成）、`apply` 新增 `hasSessionQuery`、overview `status.capabilities.stage1SourceRead` 暴露能力缺失、drain 对 `persisted===null` 标专属 `source_capability_missing`（不再叫 `empty_source`）。

### 测试
- 新增 `test/p0-r2-1-phase2-wake-all-changes.test.mjs`（forget / note / UI delete 各自仅执行即自动 integrate，不手动 integrate、无 Stage1 事件）。
- 新增 `test/p0-r2-2-reference-match.test.mjs`（同词三类拒绝 Stage1 引用 + 真实完整子串仍通过）。
- 新增 `test/p0-r2-3-sessionquery-capability.test.mjs`（无 sessionQuery 能力缺失 + 对照 real empty_source）。
- 回归：`pwsh -NoProfile -File test/run-tests.ps1` → **47/47**；`node --check lib/index.js` 通过。

### 成熟度
P0 发布阻断最小返修收口；R2.1 待独立复核后进入候选发布观察。

## 2026-08-31 · 5 条 P0 发布阻断最小返修（Stage1 busy rerun latch · Phase2 统一 request+pending 主动唤醒 · source missing 与 no-output 分离 · entry↔source_ref 语义配对 · 证据文件 append-only）

对《dsh-rollout-详细系统评估-发布阻断与最小返修路线-2026-08-31.md》的 P0 断言做最小返修，消除 5 条发布阻断。基线：`e4bb07e`。

### 变更
- **#1 Stage1 busy rerun latch**：新增模块级 `stage1RerunRequested` 布尔，`drainStage1Jobs` 忙时置位、`finally` 释放后补跑，修掉收尾窗口丢触发（作业在 claim 已返回无作业、finally 未释放 busy 的窗口入队即永远不被消费）。
- **#2 Phase2 统一 request + pending 主动唤醒**：新增 `requestPhase2Integrate()`，`memory_remember`/UI add 写 pending change 后调用；busy 置 rerun latch、空闲经 `setImmediate` 异步调度（绝不同步调避免 `withWrite` 嵌套死锁）。idle 时 pending change 无需新 Stage1 事件也自动进 Phase2/current。
- **#3 source missing 与 no-output 分离**：`sessionMessagesByPersistence` 返回值增加 `sourceStatus`（ok/unavailable），源不可用置 `failed_retryable` 记错、绝不返回 `succeeded_no_output`；`persisted===null`（插件缺失）仍按空源 no-op 防永久 retry。`extractWithOutcome` 增加 `empty_source`/`short_content`/`model_empty` 原因写入 `last_skip_reason`，`statusView` 聚合 noOutputReasons。
- **#4 entry↔source_ref 语义配对**：`sourceRefForEntry` 改传 citeless ref + `{ content: e.content }` 强制校验 entry 内容确在行段内（`validateSourceRef` 未改）。
- **#5 证据文件 append-only**：证据文件改追加式，新增 `countFileLines`；`buildEvidenceContent` 支持 `existingLineCount` 偏移，新块追加在旧行之后（同 session 第二 watermark 后旧 output 的 source_ref 仍可验证）。

### 测试
- 新增 5 个反例测试：`test/p0-1-stage1-rerun-latch` / `p0-2-phase2-pending-autowake` / `p0-3-source-missing-not-nooutput` / `p0-4-entry-source-pairing` / `p0-5-evidence-append-only`。
- 原有 39 个测试文件零改动（手动 integrate 取消 pending 自动请求保住 phase2-changes 契约、`persisted===null` 不算 source_missing 保住 drain-stage1）。
- 全量 `pwsh -NoProfile -File test/run-tests.ps1` → **44/44**；`node --check lib/index.js` 通过。

### 成熟度
5 条 P0 发布阻断全部实质消除；进入 P0-R2 收口。

## 2026-08-29 · 唯一发布阻断修复：恢复会话水印改用持久正文（方案 A）

对照锚点快速复核《dsh-rollout-M3-锚点快速复核与唯一阻断-2026-08-29.md》。修复唯一发布阻断。

### 变更
- **dispose 入队水印改用持久正文**（方案 A）：`session/disposed` 处理器先通过 `sessionMessagesByPersistence(sid)` 取得规范 messages，经同一个 source-aware serializer 得到 raw，用该 raw 计算 `contentWatermark` 后入队；持久读取失败才回退 live `deriveMessages()`。修复「同一 session 恢复后新增内容被旧空水印去重」的灾难性漏记（旧实现 dispose 用 live `deriveMessages()`（可能为空）算水印，恢复会话后新增决定得到与上次相同的空水印，命中旧 job/seen 被当作重复事件，新增内容不再被提炼）。仍不在事件路径运行模型或 Phase 2。
- 引入 dispose 事件的一次异步持久读取（方案 A 自然后果）；事件入队最终仍「不丢」（waitUntil 验证 B 入队）。

### 测试
- 新增 `test/m3-session-resume-watermark.test.mjs`：同一 session 持久正文 A→A+B 后再次 dispose → 新水印/新 job（不漏记）；无新增持久事件时再去重。
- 更新 `test/event-queue-during-drain.test.mjs`：B 入队改为 waitUntil 等（dispose 引入持久读取异步），保持「不丢」核心性质。
- 回归：`npm run check` 通过；`npm test` 39/39 通过（38 + 新增 1）；`node test/m3-e2e-acceptance.mjs` 通过；三处 `lib/index.js` SHA256 一致（`8835AAA1...`）。

### 成熟度
M2/M3 功能主体完成，唯一发布阻断已修复；可冻结 M2/M3、进入候选发布。

## 2026-08-29 · M2 生成资格与隐私闭环

对照 GPT 裁决《M2 设计实测清单》与《M2-R0 设计收口与外部信号证据》。基线：`f57ce0a`。

### 变更
- **唯一公开开关 `generateMemories`（默认 true）**：决定是否让会话贡献未来记忆（自动 Phase 1），与 `useMemories`（使用旧记忆）独立。旧 `autoTrigger` 从公开设置页退役，仅保留一次性兼容迁移（旧设置 `autoTrigger==='off'` 且未显式设置 `generateMemories` 时映射为 false）；旧 `precompactAuto` 仅作兼容保留，不再驱动自动 Phase 1。
- **`compaction/start` 退役为自动持久记忆入口**：它是「活跃会话」的上下文压缩事件（非会话结束/闲置边界），不再自动入队 stage1_jobs。满足「活跃会话不持久」。显式 `memory_precompact` 工具仍可用。
- **外部上下文整段跳过自动生成**：Stage 1 drain 在「任何模型调用、预算扣减、草稿写入」之前，用 `assessEligibility(events)` 判定会话是否命中已证实的外部工具（初始集 `{web_search, web_fetch}`，harness 内置 `@deepseek-ai/dsh-tool-web` 注册）。命中 → 整会话 `succeeded_no_output` + 记录 `last_skip_reason=external_context:*`，不烧配额、不产出、不进 Phase 2。不靠文本猜测；本地工具（pwsh/read/grep 等）不作外部，避免误杀真实用户决定。
- **默认不 gate Phase 2**：`generateMemories` 只决定是否接收新的自动 Stage 1 job；已接受的 output、显式 `memory_remember` change、恢复中的 Phase 2 批次照常完成。不新增来源字段/迁移/悬挂恢复规则。
- **`messagesToDraftBody` 改 source-aware**：以 `m.source.kind` 过滤——保留 `user`（真人输入）与 `model`（助手说明），排除 `plugin`（注入上下文：AGENTS/skill/recall/cron）与 `tool`（工具结果正文），避免把注入工具外部内容重新记为事实。不把 tool arguments / tool results / 完整 source JSON 拼进 prompt。
- **`sessionMessagesByPersistence` 返回 `{events, messages, cwd}`**：m 现 `.stage1-state.json` 不再存在；持久读取扩展 events 供资格判定在 LLM 前扫描 `tool/call.name`；消息重建失败时也保留 events（不因 events 被清空而漏判外部）。
- **`submitStage1Job` 可选 `skipReason`**：`succeeded_no_output` 时写入 job 的 `last_skip_reason`（仅本地诊断，不进 Phase 2）。

### 测试
- 新增 `test/m2-generate-memories.test.mjs`：外部工具整段跳过（不调 llm/不烧配额/不产出/记 skip reason）、本地工具不被误杀、generateMemories=false 不入队、generate/use 独立、compaction/start 不自动入队。
- 更新 `test/precompact-new-queue.test.mjs`：[1] 改为断言 compaction/start 不再自动入队（对齐 M2 活跃会话不持久语义）。
- 回归：`npm run check` 通过；`npm test` 38/38 通过；三处 `lib/index.js` SHA256 一致（`85026D3E...`）。

### 成熟度
M2 设计成熟度约 85% 后进入实现；本轮完成 M2 核心（生成资格与隐私闭环）。M1 继续冻结。

## 2026-08-29 · 性能与复杂度减法审计（隔离候选）

基线：`f3c506f`。本节变更先在 `codex/subtraction-review` 隔离分支验证，不直接覆盖 DSH 正在维护的主目录。

### 运行时减法

- 删除 5 个已无运行时消费者的旧配置：`injectLimit`、`minIdleHours`、`maxDraftAgeDays`、`maxExtractPerTrigger`、`maxPipelineRunsPerDay`；设置页与 README 同步移除，避免继续形成虚假控制面。
- 退役 `stage1_meta.sessions` 活动水位与 `turn/end` 每轮持久写。新 Stage 1 已用 `session_id + content watermark` 入队和去重，不再读取这份水位。
- `memory_recall` 改为纯读：删除 `last_used_at` / `usage_count` 写回与按历史召回次数自我加权；一次 recall 从最多 `recallLimit` 次持久写降为 0 次。
- `find/forget/supersede` 从复制并遍历整表改为 storage-domain 原生 `get(key)`；启动 outbox 修复从 entries×changes 重复扫描改为一次引用集合索引。
- Stage 1 / Phase 2 的退避定时器从“最长睡 60 秒后反复扫表”改为精准睡到 `available_at` / 跨日预算窗口；插件卸载时显式清理两个 timer。
- 删除与自动 Stage 1 / `memory_precompact` 重叠的 `memory_draft` 模型工具；历史 `kind=draft` 变更仍保持可消费兼容。

### 测试减法与可信度修复

- 修复 40 个测试全部硬编码导入主仓的问题：统一改为 `new URL('../lib/index.js', import.meta.url)`，确保测试当前 checkout，而不是另一目录的版本。
- 删除 6 个已经失去行为对象或被更强测试覆盖的用例：旧 `maxExtractPerTrigger`、旧 stale/secondary 候选、重复额度、重复启动恢复、重复 import mutex。
- 7 个 `test-*.mjs` 改为描述性 `*.test.mjs` 名称；运行器只执行 `*.test.mjs`，不会误跑 helper/临时文件，失败时打印完整输出。
- 回归结果：`npm run check` 通过；`npm test` 为 34/34 通过。

### 保留不删

Phase 1/2 持久作业、租约与 token、心跳续租、失败退避、孤儿绑定恢复、版本化发布、forget 强语义、导入回滚与故障注入测试均保留。它们属于 L3 可靠性骨架，不是本轮性能负担的主要来源。

## 2026-08-27 · 阶段 0 第一批（L2 安全封口起步）

对应总纲：§5.5 所有入口共享同一安全边界 / §11 三道防线 / §14.2 不变量「maxExtractPerTrigger=N 时实际尝试数绝不超过 N」。

### 变更
- **全写入入口统一脱敏**：UI「添加条目」与「导入条目」在写入 `entries` 表前经 `redactSecrets` 脱敏（此前这两条路径漏脱敏，仅自动路径与工具已脱敏）。对应 §11 三道防线、§5.5。
- **`maxExtractPerTrigger` 边界修复**：触发会话计入上限，循环顶部先判断预算已满即结束；修掉旧实现「push 后再 break」导致 `maxExtractPerTrigger=1` 仍可能产生 2 个候选的超额问题。对应 §14.2。
- **测试迁入仓库**：新增 `test/`，首批入库 `redaction-all-ingress.test.mjs`（UI+导入脱敏）、`phase1-maxextract-boundary.test.mjs`（预算不变量）。对应 §14。

### 行为变化
- UI/导入写入含秘密内容 → 落盘为 `[REDACTED]`，不再泄漏。
- `maxExtractPerTrigger=1` 时实际提取数为 1（触发会话），不再额外抓取次级。

### 自动化测试
- `node test/redaction-all-ingress.test.mjs`
- `node test/phase1-maxextract-boundary.test.mjs`
- 另回归 `test-rollbackfailed / import-p0 / noop / redact / secondary / pipeline-p03 / import-mutex / pipeline-queue / stale / citation` 全部通过。

### 成熟度
L1 → L2 中段（安全封口补齐大部分）；阶段 0 剩余项（导入 integrate 回滚、统一写协调、严格导入校验、引用无占位、额度过尝试计数、全量测试入库）仍在进行。

## 2026-08-27 · 阶段 0 批次 2（安全封口）

对应总纲：§12.2 导入事务必含「切换成功但整合失败也属失败并回滚」/ §5.4、§9.3 引用不做占位。

### 变更
- **导入后 `integrate()` 纳入回滚**：把派生产物重建（integrate）移进切换事务的 try 块；若切换成功但整合失败，整个事务回滚到导入前状态并返回可重试错误（原实现 integrate 在 catch 外，整合失败不会回滚，会留下「新版已写但派生物未重建」的半状态）。对应 §12.2。
- **引用不再返回占位来源**：无真实文件+行号证据时（不在 MEMORY.md 且无会话草稿），引用改为明确 `unverified:0-0|note=[no verifiable file+line source; not attested]`，不再伪造 `MEMORY.md:1-1`。对应 §5.4 / §9.3。
- **测试入库**：新增 `test/import-integrate-rollback.test.mjs`（整合失败回滚）、`test/citation-unverified.test.mjs`（无占位引用）。

### 行为变化
- 导入时整合失败 → 整事务回滚、旧记忆保留、客户端收到「可重试」而非成功。
- 无法证明来源的记忆引用不再伪装成真实行号。

### 自动化测试
`node test/import-integrate-rollback.test.mjs`、`node test/citation-unverified.test.mjs`；另全量回归（ingress-redaction / maxextract / 10 个旧项）全部通过。

### 成熟度
L2 中段；阶段 0 剩余项：严格导入校验（大小/路径/Base64）、额度按模型尝试计数、统一写协调、旧测试全量迁入。

## 2026-08-27 · 阶段 0 批次 3（导入严格校验）

对应总纲：阶段0 MUST「严格导入大小、路径和 Base64 校验」。

### 变更
- 导入前硬限制：请求体上限 50MB、文件数上限 2000、单文件解码后 10MB、解码总大小 50MB、条目数上限 10000。
- Base64 严格校验：合法字符集正则 + 解码长度检查，拒绝非法/空解码内容；路径 traversal、重复路径已有但保持。
- 任何校验失败都在触碰 live 状态前抛错（保持文件树与 entries 表不动）。对应 §12.2。

### 测试
`test/import-validation.test.mjs`（非法 base64 / traversal / 重复路径 / 单文件超限 / 有效导入）全过。

### 成熟度
L2 中段；阶段 0 剩余：额度按模型尝试计数、统一写协调、旧测试全量迁入。

## 2026-08-27 · 阶段 0 批次 4（测试迁入仓库 + 固定命令）

对应总纲：§14 测试进入仓库、使用固定命令运行。

### 变更
- 把此前散在备份目录的一次性隔离测试全部迁入 `test/`（15 个）。
- 新增 `test/run-tests.ps1` 聚合运行器（遍历 test/*.mjs 逐个跑并汇总）。
- `package.json` 增加 `scripts.test`（`npm test` → 运行 run-tests.ps1）与 `scripts.check`（语法检查）。
- 一条命令 `npm test` 即可跑全量：15/15 通过。

### 成熟度
L2 中段；阶段 0 剩余：额度按模型尝试计数、统一写协调。

## 2026-08-27 · 阶段 0 批次 5（额度按模型尝试计数）

对应总纲：阶段0 MUST「每日额度按模型尝试计数」/ §12.3。

### 变更
- 每日额度由「产物变化计数」改为「真实 LLM 尝试计数」：`state.global.modelAttemptsToday`。
- 候选提炼前判预算：已达 `maxModelAttemptsPerDay`（默认 24）则停止继续提炼（break）。
- 尝试在调用**前**计数——任何尝试（含失败/无法解析/no-output）都消耗额度；只有本地判定无法到达模型（短会话/空）不计。
- 配置新增 `maxModelAttemptsPerDay`。
- 测试 `test/phase1-model-attempt-budget.test.mjs`（cap=1 时只尝试 1 次即停）。

### 成熟度
L2 中段；阶段 0 剩余：统一写协调（规模较大）。

## 2026-08-27 · 阶段 0 批次 6（全局写协调）——阶段 0 完成

对应总纲：§12.1 统一写入协调 / 阶段0 MUST「导入与其他写入路径建立统一协调」。

### 变更
- 引入全局写维护锁 `withWrite`（异步）+ `withWriteSync`（同步），忙则拒绝（抛 writeConflict）。
- **导入**：`importBundle` 持全局写锁（`withWrite`），替换原仅导入互斥的 `importLock`；并发第 2 个导入仍返回 409（importConflict 语义保留）。
- **整合**：Phase 2 / 手动整合的 `integrate()` 用 `withWriteSync` 包裹（派生物发布互斥）。
- **UI 增删**：`/dsh-memory_rollout/entries` 的 add/delete 用 `withWrite[Sync]` 包裹。
- 读路径（recall/注入/overview/export/status）不持锁。
- 设计对齐文档：`dsh-rollout-全局写协调-设计.md`。
- 测试：`test/global-write-coordination.test.mjs`（导入进行中 UI 写被拒、锁释放后可写、导入自身成功）。

### 说明 / 边界
- 工具单条写入（memory_remember/forget/draft/note）与 Phase 1 草稿提交的全局协调，将在**阶段 A 持久作业调度**中一并纳入（避免每条写路径独立嵌套 withWrite 的复杂编排；阶段 A 本就要求统一写协调）。

### 成熟度
L1 → L2 中段 → 阶段 0 完成（9/9）。下一步进入阶段 A：持久 Phase 1 作业系统。

## 2026-08-27 · 阶段 A 起步（stage-1 作业状态机核心）

对应总纲：§15 阶段 A（持久 Phase 1 作业系统）。

### 变更
- 模块级导出 `stage1BackoffSeconds(attempt)`（分级退避，60s→120s→240s…封顶 3600s）。
- 模块级导出 `reclaimStage1Jobs(state, now)`：把 `running` 且租约过期的 stage-1 作业收回 `pending`（进程中断/重启恢复边界）；纯函数。
- 设计文档：`dsh-rollout-Phase1持久作业系统-数据结构与状态机设计.md`（存储层、enqueue、drain、迁移方案）。
- 测试：`test/phase1-job-state.test.mjs`（退避递增 + 租约回收）。

### 说明
- 阶段 A 核心「持久 `.stage1-state.json` 存储层 + `enqueueStage1Job` + `drainStage1Jobs` 领取/提炼/提交 + 事件回调只入队 + `.pipeline-state.json` 迁移 + 废弃内存 pendingPipeline」为后续实现块；本提交先落地状态机可单测部分。

## 2026-08-28 · 阶段 A/B/C 完整落地 + 自检闭环（30 测试全绿）

对照《向 Codex 原版系统看齐》总纲 + GPT/自检评估：

### 阶段 A（持久 Phase 1 作业系统）完成
事件只入队（disposer→`enqueueStage1JobFile`）→ 持久 `.stage1-state.json` → `drainStage1Jobs`（`withWrite` 领取、锁外提炼、提交、**每日模型尝试限额**、失败退避+`failed_terminal`）→ `stage1Recover`（**重启恢复接线：apply 启动时回收过期 running 并消费**）。验收：`pipeline-restart-style`/`startup-recover`/`drain-quota`/`drain-stage1`/`phase1-job-state`/`phase1-source-watermark`/`event-enqueue` 全过。

### 阶段 B（真 Phase 2 全局整合）完成
`phase2Integrate`：增量输入（`selected_for_phase2` 标记，消除重复/漏整合）→ 整合 LLM（`consolidate*`；**锁外调用、不长期持写锁**）→ 强校验（`validatePhase2Output`：`v1` 开头、合法安全引用路径、无秘密）→ **原子发布**（`atomicWritePair`）+ 成功水印；无变化不调模型；drain 产出后**自动触发**；`.phase2-authoritative` 标记使真 Phase 2 的 LLM 内容**不被确定性 integrate() 覆盖**。

### 阶段 C（读取反馈与生命周期）完成
entries 增 `last_used_at/usage_count/status`；`recall` 排序纳入相关性+新鲜度(`freshnessOf`/`freshnessWeight`)+使用反馈(`scoreMemory`)，并 `recordUsage` 更新使用反馈；`memory_forget` 只按精确 id 删除（禁 tag 批量误删）。

### 自检闭环（对照总纲）
自检/Qo 审查揪出的 H1/H2/H3a/H3b/M1-M6/L1/L7/L8 已全部修复（每项有失败路径测试）；`npm test` 30/30 全绿；三处副本 SHA256 一致。剩余**低**项（L2 引用证据强度/L3 unverified 标记/L4 输出元数据空/L5 退避自动触发/L6 陈旧注释）与阶段 D（发布候选）待后续。

## 之前发布（2026-08-27 · P0/P1 修复，总纲作为基线）
- `0801c22` fix: P0 数据安全（导入原子切换、草稿防套娃）
- `97eb85e` feat: 秘密脱敏（三道防线 + 存量补全）
- `701bbaf` fix: 失败/短会话不降级为脏记忆（含次级盲区）
- `4fdf98e` fix: 回滚失败向客户端报告（rollbackFailed/backupPath）
- `17f56e5` fix: 导入真单飞（UUID + 全局互斥）
- `8ec989a` fix: 管线锁住时排队而非丢弃
- `6f10316` fix: stale 按会话最近活动判定，不否决新活动
- `09b5dbf` fix: 引用块 Codex 兼容（path:start-end）

## 2026-08-28 · 第三轮返工 · 第 3 步（Phase 2 持久批次 + 版本化发布）

对照《第三轮返工设计-持久存储域状态机》§2/§6/§8/§13 +《第三轮程序监察与结构性返工指导》P0-6/P0-7/P0-8、R3/R4、§11.3。

### 变更
- **新增两表**：`phase2_jobs`（不可变批次：input_ids 冻结、status pending|running|retry_wait|prepared|published|committed|failed_terminal、lease、attempt/max、available_at、staging_version）；`publish_versions`（版本化发布：summary/registry/manifest 文件路径、staging|published）。
- **`phase2Integrate` 改为持久批次调度**：恢复（published→committed 幂等补提交；running/prepared 租约过期→重做）→ 领取（重试优先，否则从未消费 `stage1_outputs` 冻结新批，并将该批 outputs 标 `phase2_batch_id` 防重复选取）→ 锁外读固定 `input_ids` → `consolidateWithLlm` → `validatePhase2Output` → staging（写 `versions/<batchId>/{memory_summary.md, MEMORY.md, manifest.json}` + `publish_versions=staging`）→ 原子切换 `current.json`（published）→ `withWrite` 内提交（outputs 标 `phase2_batch_id`+`selected_for_phase2`、推 `lastSuccessWatermark`、清 `phase2_last_error`、job=committed、写 `.phase2-authoritative`）。失败任意阶段 → `retry_wait`（attempt+1 + 退避 available_at），达 max → `failed_terminal`。新增 `schedulePhase2Wake` 时间驱动（到最早 available_at/lease_expires_at），无新输出也按退避自动重试。
- **版本化读取兼容（P0-7）**：`readMemorySummary()`/`memoryCitationEntries()`/overview 改为经 `resolveCurrentFiles()` 读 `current.json` 指向的版本（校验 manifest + 双文件一致性），坏则回退上一可用版本（保留 ≥1 旧版）；根目录 `memory_summary.md`/`MEMORY.md` 保留为稳定兼容入口（发布时 best-effort 镜像）。
- **`.phase2-authoritative`** 保留为「有权威版本不跑确定性重建覆盖」标记（content=batch id），manifest 亦携带 `phase2_authoritative:true`；manifest/切换写失败不报成功。
- `atomicWritePair` 改造为路径参数版，供版本目录与根镜像共用（语义不变）。
- 新增测试 `test/phase2-batch.test.mjs`（6 验收点：模型期间新输出不误消费 / 同批重试不重复消费 / 第二文件失败仍见旧版 / published 未 committed 重启补提交 / 失败后按退避自动重试 / manifest 写失败不报成功）；`phase2-integrate` 用例 [4] 改为版本目录隔离注入（M2→P0-7 迁移）。

### 行为变化
- Phase 2 从「一次性读 stage1_outputs」升级为「持久批次 + 版本化发布」：模型期间新增输出不被本批误消费；发布与消费记录解耦、可崩溃恢复；读取方只读 `current.json` 指向的完整版本（不再有「新 summary 旧 registry」混合）。
- `memory__phase2_integrate` 工具返回新增 `batchId` 字段。

### 自动化测试
- `node test/phase2-batch.test.mjs`（新增）
- `node test/phase2-integrate.test.mjs`（[4] 改版本目录隔离，其余语义不变）
- 回归：`phase2-autotrigger`/`phase2-overwrite`/`phase2-core` 等全部通过；`pwsh -NoProfile -File test/run-tests.ps1` → `ALL 33 TESTS PASSED`（32 现有 + 1 新增）。

### 说明 / 边界
- `memory_changes` 表未接入（属下一第 4 步）；本步 Phase 2 只消费 `stage1_outputs`（不可变批次）。
- `stage1_loadState/saveStage1State` 遗留旧 helpers（无调用点）；已在返工收尾删除（见 CHANGELOG 最新一节）。

### 成熟度
L2 → L2+/L3 中段（Phase 2 持久化 + 版本化发布落地，消除 P0-6/P0-7/P0-8）。

---

## 2026-08-29 · P1 归档协议（历史数据保留/归档）第一步

对应《性能与减法审计》§六 P1：「terminal stage1_jobs / consumed stage1_outputs / committed/failed phase2_jobs / consumed memory_changes / 旧 versions 会无限增长，而调度与恢复从头扫这些表」。设计文档 `dsh-rollout-P1归档协议设计-2026-08-29.md`。

### 变更（`lib/index.js`）
- **新增 4 个归档表**（`stage1_jobs_archive` / `stage1_outputs_archive` / `phase2_jobs_archive` / `changes_archive`，复用 `.passthrough()` 的现有 valueSchema，允许 `archived_at`/`archive_reason` 透传）。
- **`archiveVault({dryRun})`** + 工具 **`memory__archive_vault`**（默认 `dryRun=true`）：
  - **dry-run**：只统计各表「终态/已消费且不再被读取路径需要」的候选量（stage1_jobs 仅算「终态且无未消费产物」；outputs 算 `selected_for_phase2===true`；phase2 算 committed/failed_terminal；changes 算 consumed），**不动作**。
  - **实际归档（dryRun=false）**：仅把**绝对安全**的 `consumed memory_changes` 复制到 `changes_archive`（保留全字段 + `archived_at`/`archive_reason`）再移出活跃表 —— **不破坏任何读路径/去重/引用/回退**，可恢复。

### 安全边界（本步刻意不做，设计文档已列）
- `stage1_jobs`/`stage1_outputs`：被 watermark 去重 + `source_ref` 引用依赖 → 需 seen-index/引用索引改造后才可归档。
- `phase2_jobs`：归档会让 `reconcilePhase2Bindings` 把其绑定 input 当孤儿解绑（重复消费）→ 需改 reconcile 后才可归档。
- `versions`（current + 最近 2 之外）：需保留回退，暂不动。
- 以上仅 dry-run 统计并标注边界，不自动归档；**不硬删**（归档表保留全字段，可恢复）。

### 测试
- 新增 `test/archive-vault.test.mjs`：①dry-run 统计正确且不动作；②dry-run=false 仅归档 consumed changes（移原表、进归档表保留全字段），phase2/stage1 不动；③归档后候选减少。
- 全量 `pwsh -NoProfile -File test/run-tests.ps1` → **35/35 PASS**（34 + 1 新增）；`node --check lib/index.js` 通过；三处 `lib/index.js` SHA256 一致 = `9EDD73ED…`。

### 成熟度
L3 → L3（归档协议第一步落地；完整归档需先改造去重/引用/reconcile 读路径，属后续）。

---

## 2026-08-29 · P1 归档协议 · 完整版（seen-index / 引用保护 / reconcile 承认归档，git `c06a4e1`）

在第一步（表归档 + versions）基础上补齐三块，使 stage1/phase2 也能安全归档：

### 变更（`lib/index.js`）
- **seen-index（新增 `stage1_seen` 表）**：`enqueueStage1JobIntoTable` 去重改查「stage1_jobs 存在 或 seen-index 存在」；`submitStage1Job` 成功终态（succeeded_*）写 seen-index；`archiveVault` 归档 stage1_jobs 前补写 seen-index → **归档 job 后同内容再 dispose 仍去重**。
- **引用保护**：`sourceRefForEntry` 先查活跃 `stage1_outputs`、查不到再查 `stage1_outputs_archive`（归档 output 保留 `source_ref` 全字段）→ **归档 output 后引用仍可核验**。
- **reconcile 承认归档批次**：`reconcilePhase2Bindings` 解绑孤儿前查 `phase2_jobs_archive`——目标批次已归档则视为有效、不解绑 → **归档 phase2 不被重复消费**。
- **`archiveVault(dryRun=false)` 完整归档**：consumed `stage1_outputs`、终态 `phase2_jobs`、终态且无未消费产物的 `stage1_jobs`、consumed `memory_changes`、旧版本目录（保留 current+最近2 非当前 published）。默认 dry-run；**不硬删**（归档表/目录保留全字段、可恢复）；**不自动/定时**（仅手动）。

### 测试
- `test/archive-vault.test.mjs` 重写覆盖完整归档 + 三处保护（dry-run 统计 / 完整归档 / 归档后保护）。全量 **35/35**；`node --check` 通过；真实 DomainFacility（5 新表）仍能开机（P0-7/passthrough 不破，real-domain-smoke 通过）。

### 成熟度
L3（归档协议完整落地；真实 DSH 启动验证 + 可选自动归档留后续）。


