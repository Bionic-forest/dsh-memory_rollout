# CHANGELOG — dsh-memory_rollout 插件变更

遵循《向 Codex 原版系统看齐》工程总纲 §19 工作纪律：每次变更记录对应需求、行为变化、测试与成熟度等级变化。成熟度等级（L0–L4）见总纲 §3。

## 2026-09-13 · v0.1.12（t198）：F1 旧版用量字段兼容 —— 读路径认回 `last_used_at`（与 `last_usage` 取较新者）

**来源**：t196 独立验证（裁定通过 9/9）报出的两条**非阻断发现**，本批收口（`lib/` 上一单的冻结正式解冻）。

**F1〔中低，真问题〕旧版遗痕字段被忽略 ⇒ 可能误淘汰**：真实 `entries`（13 条，只读实测 `…\.dsh\storages\dsh_rollout.json`）里 **2 条**带旧版遗痕 —— `m-mtb8hgha-2ht8o0`（`updatedAt` 2026-08-27T08:01:17Z）/ `m-mtcay5xs-aerxa7`（`updatedAt` 2026-08-28T01:58:02Z），均 `usage_count=1` + `last_used_at=2026-08-28T17:12:29` + `status=active`；字段普查：`usage_count` 存在 2 / 缺失 11、`last_usage` 存在 **0**、`last_used_at` 存在 2。该字段由本插件**写过、后于本文件 L353 删除**（「`memory_recall` 改为纯读：删除 `last_used_at` / `usage_count` 写回与按历史召回次数自我加权」）；t195 重新引入了同名 `usage_count` + 新名 `last_usage`，**旧字段却没人读** ⇒ 条目退化成"从未用过、只看 `updatedAt`"，在 30 天窗口下会被**误淘汰**（= 静默丢记忆），与本地自定的失败模式纪律（误淘汰重 / 误保留轻）正面相冲。当前**零即时损失**（两字段此刻都在窗口内）。

### 变更（`lib/index.js`）
- **`lastUsageOf` 兼容读旧字段**：由「只认 `last_usage`」改为 **`last_usage` / `last_used_at` 取较新者**；一侧不可解析 ⇒ 安全忽略、不影响另一侧；非对象入参 ⇒ `null`。**方向只会更宽松，永不因它而失格**。**只改读路径、不重写记录**：写入路径不变，仍只写 `last_usage`（不复活已删除的字段）。
- **投影带上该字段（承重）**：`allEntries()` 增加 `last_used_at`。否则 `lastUsageOf` 的兼容读在召回路径上**永远看不到它**（投影丢字段 = 旧证据不可见，正是 F1 的成因之一）。已用"半修树"实测证明这处改动**承重**（见下）。
- **`usageCountOf` 自决：旧 `usage_count` 保留（不当 0 抹掉）**，理由与排序影响写进函数注释：① 同名同义 —— 旧机制写"历史召回次数"、现在的 `scheduleUsageBump` 写"被交付次数"，同一近似口径 ⇒ 旧值 1 = "真被用过 1 次"的合法记载，不是异种单位；② 它**只作排序键、从不参与资格判定**（`entryEligible` 完全不读它）⇒ 保留它不可能造成误淘汰，最多让该条目在**均已具资格**的候选里等效"被用过 1 次"而略微前移；③ 视 0 = 抹掉一条真实使用证据，与本次修法方向自相矛盾；④ 自愈（再被交付会在旧值上单调 +1）。排序影响（如实）：仅当两条候选在相关性与上次使用时间上打平时，`usage_count=1` 才压过 `0`。
- **F2〔低〕注释措辞一致化**：`scheduleUsageBump` 处注释原写「`withWrite` 内逐条 `update`」，实际实现是 `get` + `put` ⇒ 改为「逐条 `put`（`get` 读改写，见下）」。**只改注释，行为不动**。

### 测试
- 新增 `test/t198-legacy-usage-field.test.mjs`（**25 断言**：T0 导出/常量 3 + T1 纯函数 8 + T2 真实遗痕与手算 6 + T3 行为级 8）。T2/T3 投入**两条真实遗痕的字段级原样**（`id`/`tags`/`createdAt`/`updatedAt`/`last_used_at`/`usage_count`/`status` 逐字照抄；`content` 用同 token 中性占位 —— 本仓库为公开仓库、真实正文含用户私有工作规则，且正文与淘汰判定无关）。
- **牙齿（实测三棵树，同一份测试文件逐字）**：还原口树（`lib/index.js.pre-legacyusage-2026-09-13` = `4EB51079…` / 338,789 B）**17 绿 / 8 红 / exit 1**，8 红全部是文件内预标「必红」的断言；「半修树」（只修 `lastUsageOf`、不修投影）**22 绿 / 3 红 / exit 1** ⇒ 证明投影那处改动**承重**（纯函数修好也不够）；工作区树 **25 绿 / 0 红 / exit 0**。文件内 13 条「改前也过」的断言已就地标注 **假阳性**，不计入牙齿。
- 手算分歧（真实两条）：`now = 2026-09-27T12:00:00Z` 时 A 的 `updatedAt` 已过 31d4h、`last_used_at` 仅过 29d18.8h；B 的 `updatedAt` 已过 30d10h、`last_used_at` 同样 29d18.8h ⇒ 改前双双失格、改后双双保留；而在**真实此刻**两字段都在窗口内 ⇒ **零即时损失**（与 t196 实测 `DELTA_LOST=0` 一致）。窗口照旧：`last_used_at` 也超 30 天 ⇒ 照样失格（兼容读不是"一律保留"）。
- 回归：`pwsh -NoProfile -File test/run-tests.ps1` → **70/70 全绿**（= 69 + 本批 1）；`node --check lib/index.js` 通过。

### 成熟度
F1/F2 收口，④ 生命周期（t195 引入的"用没用过"判据）对**旧数据**也成立。`v0.1.11`（`f814789`，2026-09-13 20:16 已推送公开）⇒ 本批 bump **0.1.12**（新版本号才有新版本节可挂）。**未 commit / 未 push / 未重启**（提交推送由后续专单执行）。

## 2026-09-13 · v0.1.11（t149）：S0-2 —— 去「截断当前权威文件后全文替换」，改「整篇读入 + 增量编辑」（GPT 大纲 §12）

**缺陷（真实数据已触发）**：整合提示词用 `clampPromptInputs` 把「当前总纲 / 当前注册表」按 `PROMPT_CURRENT_SUMMARY_CHARS=12000` / `PROMPT_CURRENT_REGISTRY_CHARS=6000` **字符截断**后再让模型**全文替换**输出。截断点之后的独有结论**模型从未看到**，新版本里自然消失 = **静默丢结论**。实测（2026-09-13）：`MEMORY.md` 6,476 码点 > 6,000（约 10 分钟后涨到 7,406），**注册表侧已在被截**；总纲侧 7,486/7,605 < 12,000 尚未触线。

### 变更（`lib/index.js`）
- **当前权威文件不再截断**：`clampPromptInputs` 不再对 `currentSummary` / `currentRegistry` 调 `clampChars`，**整篇原样传入**提示词；`PROMPT_CURRENT_SUMMARY_CHARS` / `PROMPT_CURRENT_REGISTRY_CHARS` 标注为**退役**（保留常量仅为历史/兼容引用）。
- **无法可靠表达 ⇒ 明确失败（fail-closed）**：新增 `PROMPT_CURRENT_HARD_MAX_CHARS = 200000` 与 `currentTooLargeDiagnostic()`；`processPhase2Batch` 在组装提示词前先判整篇长度，**超硬顶直接 `failPhase2Batch('current-version-too-large: …')`**，绝不静默砍尾。
- **提示词改为「增量编辑」契约**：新增 `## INCREMENTAL MERGE (HARD …)` 段（当前文件是**被编辑的基线**、不得整篇重写、旧有持久结论必须带进新文件除非 exclusion 移除、输出完整文件而非 diff）；开场句改为「shown IN FULL (untruncated)」。
- **截断可观测（写进作业结果）**：`clampPromptInputs` 新增返回 `clampedInputs` / `incrementalCharsCut` / `perInputLimit` / `truncatedCurrent`（恒 false）/ `currentChars`；新增纯函数 `truncationReportOf()`，把每批的截断事实整理为 `{ truncated, currentFilesTruncated, currentCharsCut, currentChars, incrementalInputs:{count,charsCut,perInputLimit}, droppedInputs }`，由 `buildConsolidationPrompt` 经 `opts.truncationOut` 回填、`processPhase2Batch` 以 **`truncation`** 字段随**作业结果**返回（不再只有模型能在提示词里看到）；提示词里若有增量输入被截断会明写一行 note。
- **注册表与总纲同等待遇**：新增 `currentRegistryOverCap()` / `currentOverCapWhich()`；`enqueueCompressBatch` 的门由「仅总纲超限」改为「**总纲或注册表**超限皆可触发」（仍**只由显式入口**调用，调度器与自动路径永不创建 compress 批）。
- **丢结论检测（可观测非阻断）**：新增纯函数 `normalizeConclusionLine()` / `droppedDurableConclusions()`；发布前逐行核对「旧权威文件里的结论行在新文件里仍有落点（归一化完整子串，或 token 覆盖率 ≥0.8；exclusion 命中豁免）」，**数量记入返回字段 `droppedConclusions` 并 `console.warn`，但不阻断发布**（合并/改写是合法操作；compress 批豁免）。注：曾试过把它做成硬失败，实测会把 14 个既有测试判死 ⇒ 改为可观测。

### 测试
- 新增 `test/s0-2-authoritative-file-truncation.test.mjs`（**GPT §12 硬判据**）：把独有结论放在注册表 **offset > 6000 的尾部**，模型只回显「它在提示词里看到的当前文件 + 一条新结论」，断言该尾部结论**仍在提示词里、且仍在发布版（根镜像与版本目录）里**，并反驳"原样拷贝/原地覆盖"两种自欺。
- 新增 `test/s0-2-hard-max-failclosed.test.mjs`：整篇超硬顶时**模型零调用** + 批记录带 `current-version-too-large` + 根文件**字节零变化**（修复前该场景会把 200,565 码点塌成 19 码点并丢尾部结论）。
- 新增 `test/s0-2-compress-gate-parity.test.mjs`：**只有注册表**超上限也要开 compress 门（同等待遇），并含"只有总纲超限"的反向 sanity。
- 新增 `test/s0-2-truncation-observable.test.mjs`：批结果里必须有 `truncation`，且「是否截断 / 截断字符数 / 截断文件」三项齐备；含"全在限内 ⇒ truncated=false"的反向用例。
- **检验效力**（把上述测试与 §12 测试跑在修复前代码 `git show 73f89ae:lib/index.js` 上）：§12 测试 **3 条断言红**；hard-max **5 条红**；compress-gate-parity **1 条红**；truncation-observable **13 条红**（均 exit 1）。修复后 4 个 s0-2 测试文件全绿。
- 既有 `test/t80-gate.test.mjs` 的 2 条断言原为「currentSummary 截到 12000 / currentRegistry 截到 6000」——**该行为正是 S0-2 要废除的**，已就地改为断言**相反的不变量**（整篇原样传入 + `truncatedCurrent` 恒 false + `currentChars` 如实 + `clampedInputs` 可观测）。
- 回归：`pwsh -NoProfile -File test/run-tests.ps1` → **56/56 全绿**（= t144 后的 52 + S0-2 新增 4）；`node --check lib/index.js` 通过。

### 成熟度
S0-1（冻结点分批）+ S0-2（权威文件不截断 + 增量编辑 + fail-closed）+ t164（自动续跑/旧批兼容/完整请求预算）合上「输入侧静默丢内容」这一族。**未 commit、未 push、未重启**。

### 追加（同日 · t164，按 GPT《设计答复评审 R1》§5/§6 补验收边界）
同版本内继续，**未重做**已修部分。
- **自动续跑（§5.2，补 S0-1 的缺口）**：旧 `nextPhase2WakeAt` 只扫**已创建作业**，看不到"尚未绑定"的残余来源 ⇒ 第一批跑完后第 21 条**没有任何唤醒入口**。新增 `phase2WakePlan()`（把 `immediate-unbound-work` / `due-batch` / `backoff` / `none` 分开，并暴露 `wake` 到返回值）+ `armPhase2Wake()`（4 处唤醒点统一改走它），并以 `hasImmediatelyProcessableWork()` 判定残余。**有界**：每次唤醒都领到 ≥1 条的批并消费掉，残余单调减少；继续条件 = 残余 > 0，退出条件 = 残余 = 0 或已有活跃批；单飞 `phase2Busy` 吸收重入。实测：21 条只调一次工具 ⇒ 第 1 批 20 条 + **自动**第 2 批 1 条，27ms 内 21/21 消费，2 批全 committed，残余清零后不再新开批。
- **旧超限批兼容（§5.3）**：新增纯函数 `splitBatchIdsByBudget()`。① **升级期检测**：`reconcilePhase2Bindings` 对**非终态**且 `input_ids > PROMPT_MAX_INPUTS` 的旧批告警（只报不切）。② **领取侧截批**：`claimNextPhase2Job` 的 pending/retry_wait 分支保留前 20 条、其余**解绑 + 保持未消费**留队，并记 `legacy_split`。③ **提交侧守卫**：`commitPhase2Batch` 只把前 `PROMPT_MAX_INPUTS` 条标已消费，超出的**放开绑定**留待重领 —— 覆盖 `prepared`/`published`（**不盲切其 input_ids**，按原有发布记录恢复）。实测：21 条旧 `retry_wait` 批 → 截批 20 + 延后 1（最终 21/21）；21 条旧 `published` 批 → `input_ids` 仍 21（未切）、补提交不重跑模型、只消费 20，未见来源被放开并最终重领处理。
- **诊断降级（§6.2）**：`droppedDurableConclusions` → **`diagnosePossibleConclusionLoss`**，改为**可选诊断**（新配置 `phase2Diagnostics`，默认 **false**）；关闭时完全不跑；开启时结果进返回体 `diagnostics`（含 `advisory:true` / `persisted:false` / 能力边界 note）并告警。**不调阈值、不升为硬闸门**；**未持久化**（不写 `phase2_jobs`），如实声明。**提示词纠偏**：删掉「丢结论 ⇒ 批次被拒绝」这句与程序实际（只告警不阻断）不符的表述，改为把责任落到模型侧并明写程序**无法判断语义是否有损**。
- **完整请求预算（§6.3）**：新增 `REQUEST_HARD_MAX_CHARS = 200000`（**未放大**）+ 纯函数 `estimateRequestChars()` / `requestTooLargeDiagnostic()`。单文件上限仍作**组件级早退**（`current-version-too-large`）；新增**整请求**预算 = 两份旧文件之和 + 全部 `memory_changes` + 增量输入 + 提示词骨架 + **输出预留**（两目标文件上限之和）。超预算 ⇒ **明确失败** `request-too-large: total=…>200000 (各分量)`，**模型零调用、旧文件字节零变化**。实测两份各 12 万码点（各自合法）⇒ 明确失败；预算内批返回 `request` 构成。
- **S0-2 表述边界（§6.1/§6.3）**：提示词与报告只声明「**输入完整性**」（程序把整篇当前文件交给了模型），**不冒充**"真实模型语义合并不会遗漏"；明写程序无法判断语义损失。
- **测试**：新增 `t164-auto-continue` / `t164-legacy-batch` / `t164-request-budget` / `t164-diagnostics` 4 个文件；回归 **60/60 全绿**。

### 追加（同日 · t170）：修事故级缺陷——`failed_terminal` 批的未消费输入**永久卡死**
- **缺陷链路**：`claimNextPhase2Job` 的 `if (o.phase2_batch_id) continue` ⇒ 绑定即**永不再选**；而 `reconcilePhase2Bindings` 的 orphan 判据是 `!j && !archived`（只释放"批**不存在**"的绑定），**failed_terminal 批仍在表里** ⇒ **永不释放**。原实现是**有意为之**（注释理由：防"terminal→解绑→新建批"无限烧 LLM），代价是这些来源**永久卡死且无人登记** = **静默不消费**。真实数据：**8 条** failed_terminal（旧安全门 `unredacted secret`，09-13 02:43–03:51），**11 条输入**全部卡死。
- **修法（有界释放 + 显式登记）**：`reconcilePhase2Bindings` 新增 `releaseFromFailedBatch` —— 批为 `failed_terminal` **且**输出未消费（`selected_for_phase2 !== true`）⇒ 释放绑定（可重选）；每条输出记 `phase2_release_count`；达 **`MAX_PHASE2_RELEASES = 3`** 后置 **`phase2_abandoned = true` + `phase2_abandoned_reason`**（显式登记、不再重选、`console.warn` 汇总计数）⇒ **既解除卡死，又消掉原实现担心的无限振荡**。
- **不破坏既有语义**：`committed` 批的输入**不释放**；`running`/`prepared`/`published` **不动**；原 orphan（批不存在）释放逻辑**保留**。
- **配套**：`stage1_outputs` schema 增 `phase2_release_count` / `phase2_abandoned` / `phase2_abandoned_reason`；`claimNextPhase2Job` 与 `hasImmediatelyProcessableWork` 均**跳过 abandoned**（后者尤其重要：否则已放弃的来源会被当成"立即可处理"，造成立即唤醒空转）。
- **契约改向（2 处既有断言按新契约改写，非放水）**：`invariant-recovery` 的「failed_terminal 批 input B **仍绑定**、B **未被消费**」→ 改为「B **已解绑**（release_count=1）、**被重新入队并消费**、未达上界不标 abandoned」；`p0-9` T4 的「下一轮 no-change / 0 次 LLM」→ 改为「释放后**有界重试一次**（恰好 1 次 LLM，非忙循环）」。
- **测试**：新增 `t170-stuck-binding-release`（① 释放→可重选并消费 ② 达上界⇒显式 abandoned 且不再重选、批数不增 ③ **反例**：committed 批绑定不动）；回归 **61/61 全绿**。
- **生效条件**：**需重启才生效**（当前运行进程加载的是重启前那版）。未 commit、未 push。
- **还原口**：`lib/index.js.pre-stuckfix-2026-09-13`（= 改前 `AF7D34BA…` / 286,366 B，脱离 `*.bak-*` 族）。**退出条件**：用户重启当前实例、确认卡死项已清后，由 `G-维护` 清掉。

### 追加（同日 · t172）：同族残余——**已归档**的 `failed_terminal` 批同样卡死其未消费输入（真实 5 例）
- **缺陷链路**（两条释放路径**都**跳过归档批）：`unbindOrphan` 的 `orphan = !j && !archived` ⇒ 批在归档表就不释放；`releaseFromFailedBatch` **只查活跃表** `phase2JobsTable` ⇒ 批已归档 ⇒ `!j` ⇒ 直接 return。⇒ 归档失败批的未消费来源成**静默死角**；且唤醒计划只看"无绑定的残余"，它们有绑定 ⇒ **没有任何其它调度事件时 reconcile 永不运行 ⇒ 重启也不解除**。真实 5 例；未消费口径 = 11（t170）+ 5 = **16 条**。
- **修法**：① `releaseFromFailedBatch` 改查 **活跃表 ‖ 归档表**（`const j = live || archived`），判据仍是 `status === 'failed_terminal'` 且未消费；上界/`abandoned` 语义沿用，并新增 `releasedArchived`/`abandonedArchived` 计数进告警（**显式点名归档来源**）。② 新增纯函数 `immediatelyProcessableKind()`（`hasImmediatelyProcessableWork` 变薄封装），把 failed_terminal 批 id（**活跃 + 归档**）交给判据：绑在失败批上的未消费输出**也算"立即可处理"**，唤醒理由为 `immediate-failed-bound-work` ⇒ **即使没有任何工具调用/其它调度事件，启动后也会自动跑一轮 reconcile 把它放出来**。
- **归档动作的选择**：**不在 `archiveVault` 里加释放分支**，而是让归档后由 reconcile 正常处理 —— 理由：归档是运维/清理路径，往里加业务释放会引入"归档成功但释放失败"的不一致来源；而 reconcile 是每次 phase2 调度的第一步，配合 ② 的唤醒条件，归档后**一定会被处理**。归档记录仍可查（`restoreTable` 可恢复），信息不丢。
- **测试**：新增 `t172-archived-failed-release`（6 组 / 24 条断言：纯函数判据、归档 failed ⇒ 释放并消费、达上界 ⇒ abandoned、**反例** 归档 committed / published ⇒ 不释放、**端到端：一次工具都不调、仅靠启动唤醒 34ms 自动解除**）；回归 **62/62 全绿**。
- **还原口**：`lib/index.js.pre-archfix-2026-09-13`（= 改前 `28A2CA90…` / 290,463 B，脱离 `*.bak-*` 族）。**退出条件**：用户重启当前实例、确认那 5 条归档卡死已解除（或已显式 abandoned）后，由 `G-维护` 清掉。
- **部署**：编辑会破坏 HardLink ⇒ 已**显式 `Copy-Item`** 覆盖部署副本；三处 SHA 全等 `86F57EA7…` / 293,685 B。**需重启才生效**。

### 追加（同日 · t175）：第三档卡死——绑 `failed_terminal` 批的未消费 **`memory_changes`** 永不释放（真实 0 例，结构性就位）
- **根因（一句话）**：把"批终态失败 ⇒ 释放绑定"做成了**产物专用** —— 缺的是**变更侧那次调用**（老机制少覆盖一张表）。三处表现：① 领取侧 `if (ch.status !== 'pending' || ch.phase2_batch_id) continue`（**L3471** 区）跳过已绑定者；② 释放循环**只遍历 `stage1OutputsTable`**（t170/t172 的 `releaseFromFailedBatch`）；③ 唤醒判据的 change 分支要求 pending **且无绑定** ⇒ 这一档不触发 reconcile。而 `unbindOrphan` 本来就是**双表通用**的。
- **影响面**：真实 **0 例**（`memory_changes` 5 条 + `changes_archive` 16 条全部 `consumed`、`pending=0`）；但触发前置都在正常路径内（建批时存在 pending 变更行 × 该批转 `failed_terminal`），**变更不参与 `PROMPT_MAX_INPUTS` 裁剪** ⇒ 一旦触发单批可**静默丢多条**，且无上界/无 abandoned/无告警。
- **修法**：① 释放核心泛化为 `releaseBoundFromFailedBatch(table, key, rec, isConsumed, kind)`（**L3256**），**产物与变更各跑一遍**（**L3290 / L3296**），口径与 `unbindOrphan` 对齐：**双表（活跃 + 归档）+ 同套上界 + abandoned 登记**；② `immediatelyProcessableKind` 的 change 分支补 `failed-bound` 档（**L420**），并排除已 `abandoned` 的（**L417**）；③ 领取循环跳过 `phase2_abandoned` 的变更（**L3471**）；④ `memoryChangeSchema` 加**同套字段名** `phase2_release_count`/`phase2_abandoned`/`phase2_abandoned_reason`（**L581-583**，选择"沿用同套"而非另立：同语义、同套测试/工具、`unbindOrphan` 的双表写法可直接延用）；⑤ 告警扩展为**产物 + 变更**双侧计数（**L3300**，含 archived 细分）。
- **测试**：新增 `t175-change-side-stuck-release`（6 组 / 20 条断言：纯函数 failed-bound 档、pending×绑活跃 failed ⇒ 释放并 `consumed`、pending×绑**归档** failed ⇒ 同样释放、**反例** 已 `consumed` 不误伤、上界 3 ⇒ abandoned 不再重试、**端到端：一次工具都不调、仅靠启动唤醒 33ms 自动解除**）；回归 **63/63 全绿**。（顺带：`t172` 里那条"告警点名归档来源"的断言随文案升级改为 `/archived:\s*1\s*input\(s\)/`，**行为未变**。）
- **还原口**：`lib/index.js.pre-changefix-2026-09-13`（= 改前 `86F57EA7…` / 293,685 B，脱离 `*.bak-*` 族）。**退出条件**：用户重启当前实例、确认卡死项已清后，由 `G-维护` 清掉。
- **部署**：编辑破坏 HardLink ⇒ 已**显式 `Copy-Item`** 覆盖部署副本；三处 SHA 全等 `6C4461F9…` / 295,964 B。**需重启才生效**。
- **提示**：`lib\*.pre-*` 现共 **3 个**（t170 `pre-stuckfix` + t172 `pre-archfix` + 本批 `pre-changefix`）⇒ **建议下次重启确认后统一清掉**，不再堆积。

### 追加（同日 · t178）：启动期写锁竞争不再把一次调度 pass 丢掉（error → 短退避重试 + warn）
- **现象**（用户启动日志）：`stage-1 drain error: … another write is in progress — retry shortly` 与 `phase-2 wake drain error: …`。
- **成因**：`withWrite`（**L2006**，冲突分支紧随其后）是**非队列锁**——`writeBusy` 为真**直接抛**（无内部重试）。启动块里同时起多条写路径：`setImmediate` 的 stage1 drain（**L2501-2503**）、0ms 的 phase2 wake 定时器（**L3821-3824**）、`setImmediate` 的 phase2 auto（**L3213-3219**），以及**被 await** 的启动 `reconcilePhase2Bindings`（**L5026**，同块还有 `scheduleStage1Drain` L5021 / `armPhase2Wake` L5023 / `requestPhase2Integrate` L5033）⇒ 调度那几条撞上正在持锁的 await 者。真实存储写是异步慢写 ⇒ 锁跨越 macrotask ⇒ 必然偶发。
- **不是纯噪音（实测）**：落败路径的 catch **只 log、不重新武装** ⇒ 没有别的触发时，那一次 pass 的工作被**无限期拖延**。加"存储写延迟"模拟后复现：修前 3 次里出现 1/1/**2** 条 error，其中一次 **0/3 消费、0 次 LLM**（整轮工作丢掉）。
- **修法**：新增导出纯函数 `isWriteConflictError()`（**L391**）+ 常量 `WRITE_CONFLICT_RETRY_MS=200` / `MAX_WRITE_CONFLICT_RETRIES=5`（**L397-398**）+ 调度包装 `runScheduledPass(label, key, run)`（**L2480**）：**识别冲突 ⇒ 短退避重试（有界 5 次，成功即清零）**，并把日志**从 error 降为 warn**（写明第几次/何时重试）；非冲突错误仍按 error。三处调度点全部接入：stage1 drain（**L2503**）、phase2 auto（**L3219**）、phase2 wake（**L3824**）。
- **修后实测**（同探针同延迟 ×3）：**0 条 error**、1–2 条 `write lock busy — retry n/5` warn、**始终 3/3 消费**。
- **测试**：新增 `t178-write-lock-conflict`（**8** 条断言 = `isWriteConflictError` 4 条 + 启动期竞争「0 error / 3/3 消费」4 条；**原记「10 条」系我的误计，t182 更正**）；回归 **64/64 全绿**。
- **还原口**：`lib/index.js.pre-locknoise-2026-09-13`（= 改前 `6C4461F9…`，脱离 `*.bak-*` 族）。**退出条件**：用户重启确认后与其他 `pre-*` 一起清掉。
- **部署**：编辑破坏 HardLink ⇒ 已**显式 `Copy-Item`** 覆盖部署副本；三处 SHA 全等 `E3C238F7…` / 298,574 B。**需重启才生效**（现行 3518 pid 46928 起于 17:48:04，加载的是 `6C4461F9`）。

### 追加（同日 · t180）：补齐第 4 处调度写路径 + 穷举同类（确认无第 5 处）
- **补的这处**：`scheduleStage1Wake` 的定时器（原 **L2513-2518**，`drainStage1Jobs().catch(只 log)`）与 `scheduleStage1Drain` 调的是**同一个** `drainStage1Jobs()`，却只有后者被包 ⇒ 现改走 `runScheduledPass('stage-1 wake drain error', 'stage1-wake', …)`（**L2518**），与 **L2503** 对齐。**唯一 `lib` 改动**；日志格式不变（仅写锁竞争降为 warn + 重试）。
- **穷举结论**：全库 `setImmediate`/`setTimeout`/`setInterval` 共 **7 个真实定时器位点**（**原记「6 个真实回调」、并把 `wait` 记在 L2530 —— 均系误计，t182 更正**：漏计了 `runScheduledPass` 内部的重试载体 L2491），其中**起写**的 4 个 = stage1 drain(L2503) / stage1 wake(**L2518**) / phase2 auto(L3220) / phase2 wake(L3825)，**现已全部走 `runScheduledPass`**；另 3 个不起写或按设计吞错（**L2531** `wait` 工具、L2042 心跳：租约 60s ≫ 心跳 20s，设计如此、且与调度 pass 不同类、L2491 重试载体）。**同一类的第 5 处：没有。**8 处"awaited 启动写 / 工具内写 / 事件入队写"虽同样只 log，但**要么在武装之前跑、要么是持锁的赢家、要么根本不用这把锁** ⇒ **形态相似但暴露面不同**（报告中逐处标注）。
- **测试**：扩充 `t178-write-lock-conflict`（断言 **8 → 10**；**原记「10 → 12」，真实起点是 8，t182 更正**）：新增**确定性**场景「不冲突时零重试」（有竞争的 ② 场景仍证明「冲突⇒重试并最终成功」）；连跑 3 次全过。回归 **64/64 全绿**（未新增测试文件）。
- **关于第 4 处的可复现性（如实）**：**未能**稳定把竞争单独压到这条入口上 —— 因为两个入口最终都调 `drainStage1Jobs()` 而它是**单飞**的（在飞时后者直接返回 0，不去抢锁）⇒ 本处价值是**静态对齐**（与 C 报的"3 次 0/3 未复现"一致），报告未包装成"已复现"。
- **登记（不删）**：`lib\*.pre-*` 现 **6 个**，其中 **`pre-assertdecouple` ≡ `pre-locknoise`（SHA 均 `6C4461F9E531899C`，逐字节相同 —— 因 t177 只改测试未动 lib）** ⇒ 重启后统一回收时**这两个只需留 1 个**。`lib\*.bak*` = 0。
- **部署**：显式 `Copy-Item` 覆盖后三处 SHA 全等 `7E5A5334…` / 298,863 B。**需下次重启才生效**。

### 追加（同日 · t182）：补上 L2518 接线的 2 条锚点断言 + 更正两处断言计数误记
> 本节行号对应 `lib/index.js` SHA `7E5A5334BEF57F1F888062CE1D46A5917639A3850812B7C378EACB61F8078639`（298,863 B）；文件若有变动须重算。

- **起因（C-脚本环境 t181 复核发现）**：t180 声称"断言 10 → 12"**不成立** —— `check(` 实测**只有 10 条**，而 t180 改的那处（`scheduleStage1Wake` 定时器体 → `runScheduledPass('stage-1 wake drain error', …, 'stage1-wake', …)`，**L2518**）**零测试覆盖**。⇒ 本批补上缺的 2 条。
- **补的 2 条**（`test/t178-write-lock-conflict.test.mjs` 新增场景 ④，**源码级锚点**——因为行为型断言压不到这条入口，两个入口共用**单飞**的 `drainStage1Jobs()`）：① 源码里**存在** `runScheduledPass('stage-1 wake drain error', …, 'stage1-wake', …)`；② 源码里**不存在**旧形态 `drainStage1Jobs().catch(只 log)`。
- **牙齿（可复跑）**：把 `lib/index.js` 换成改前版本 `E3C238F7…`（`lib/index.js.pre-wakepath-2026-09-13`）跑该测试 ⇒ **2 条红 / `2 TESTS FAILED` / exit 1**，其余 10 条绿 ⇒ 锚点**确实锁住 t180 的改动**。
- **计数口径更正（含我自己的错）**：`t178` 初版 = **8** 条（原记「10 条」）；`t180` = **8 → 10**（原记「10 → 12」）；本批 = **10 → 12**（`check(` 实测 **12**）。**上面 t178/t180 两节的错记已就地更正。**
- **定时器位点口径更正**：全库 **7 个**真实定时器位点（原记「6 个真实回调」：漏计 `runScheduledPass` 内部的重试载体 **L2491**；`wait` 在 **L2531** 而非 L2530）。**起写口径不变**：4 处 = L2503 / L2518 / L3220 / L3825，**现全部走 `runScheduledPass`**；**同一类的第 5 处仍为「没有」**（结论不因计数更正而变）。
- **测试 / 回归**：单跑该文件 **12 ✓ / 0 ✗ / exit 0**、**连跑 3 次全过**；`pwsh -NoProfile -File test/run-tests.ps1` → **ALL 64 TESTS PASSED / exit 0**（未新增测试文件）；`node --check lib/index.js` exit 0。
- **改动面**：本批**只改测试**，`lib/index.js` **未动** ⇒ 三处 SHA 仍 `7E5A5334…` / 298,863 B；部署副本仍按契约**显式 `Copy-Item` 覆盖并复核三处一致**（顺带查清：工作区与部署副本**不在同一 inode**、部署两份互为硬链接 ⇒ 编辑工作区**不会**连带更新部署副本，这就是"必须显式覆盖"的由来）。`test/` 不在部署范围。**未 commit / 未 push / 未重启。**
- **还原口**：本批真正的还原口 = `test/t178-write-lock-conflict.test.mjs.pre-assertanchor-2026-09-13`（追加前的 **10 断言版**，实跑 10 ✓ / exit 0）；另按契约第 5 条保留 `lib/index.js.pre-assertanchor-2026-09-13`（**= 现行 lib 逐字节副本 ⇒ 零信息量**，回收时可先删）。**退出条件**：用户重启确认后与其他 `pre-*` 一并清掉。

### 追加（同日 · t187）：① 受限执行者的**接口层**落地（整合执行体改插件自建会话）+ 相位 2 租约 3600s
> 本节行号对应 `lib/index.js` SHA `A644E683CCF217606EC6883F247EA4F4347E8A055487D3797362D26484500D9A`（311,190 B）；文件若有变动须重算。

- **接口层（本批落的就是"接口层"，不搬模型调用）**：新增 `consolidationExecutorSpec(memoryRoot)`、`applyExecutorSessionPolicies({ctx,handle,spec})`、`startConsolidationExecutor({ctx,memoryRoot,sessionId})`；`processPhase2Batch` 在**模型调用前**先建**插件自建会话**（`ctx.agents.create({ sessionId, meta:{ cwd: <记忆根> }, setup })`，setup 内 `tools.restrict({ allow:['read','write','edit','glob','grep'], deny:['subagent'] })`），并把该会话钉成沙箱 `workspace-write` + 审批 `never`（优先走 `sandboxPolicy.setMode` / `approval.setPolicy`，服务缺失则直接 append 同名会话事件）。**为什么不是子代理工具**：`SubagentStartRequest` 没有 `cwd` 字段（子代理会话恒继承父 workspace）—— t186 定案。
- **失败不拖累批**：宿主无 `agents` 服务或建会话抛错 ⇒ 只 warn，继续走既有单次 JSON 路径；配置 `consolidationExecutor: false` 可整体关掉（逃生阀）。
- **租约**：`PHASE2_LEASE_MS` **60s → 3600s**（照 codex `JOB_LEASE_SECONDS = 3_600`，镜像 `codex-rs/memories/write/src/lib.rs` L84）；心跳仍 20s。重启后旧批仍被 `foreign-owner` 路径立即收回（`bootId` 每次 apply 重新生成）。
- **残余面（不掩饰）**：**无网做不到** —— DSH 沙箱没有网络维度，只由工具白名单近似，**不是硬边界**（代码常量 `CONSOLIDATION_NETWORK_RESIDUAL` 载明此点）。
- **测试 / 回归**：新增 `test/t187-restricted-executor.test.mjs`（6 组 / **33 断言**），改前树（`lib/index.js.pre-executor-2026-09-13`）**11 条红**；回归 **ALL 65 TESTS PASSED**；三处 SHA 全等 `A644E683…`；`node --check` exit 0。
- **未通过项（必须记住）**：`meta.cwd` 能否被**真实宿主**接受 = 实现时第一验收项，**需重启后实测，尚未通过**；若失败，退路 = 有界工具循环（12 轮 / 整批 10 分钟 / 租约 1h）。

### 追加（同日 · t189）：② 两道启动门槛 + 启动顺序对齐（抄 codex）+ 只对根会话生成
> 本节行号对应 `lib/index.js` SHA `5757528CA0C8ED2F87A6188E78385035F1FB92D37049EF46C720F7778A95A361`（322,903 B）。

- **门槛一 · 每启动来源上限**：新增配置 `maxSourcesPerStartup`（默认 **2**，范围 1–128；抄 codex `DEFAULT_MEMORIES_MAX_ROLLOUTS_PER_STARTUP = 2`，镜像 `codex-rs/config/src/types.rs` L50/L317-319）。实现上把上限**绑在启动那一趟 drain** 上（`scheduleStage1Drain(maxSources)` → `drainStage1Jobs({ maxSources })`），其余调度者（事件 / 唤醒 / 显式工具）**不传 ⇒ 不设限**；到顶后下一趟至少隔 `STARTUP_SOURCE_SPACING_MS = 30000`（抄 codex「下个启动窗口再继续」，不立刻补跑，否则上限形同虚设）。剩余来源不丢。
- **门槛二 · 额度门**：新增配置 `minRemainingQuotaPercent`（默认 **25**；抄 codex `DEFAULT_MEMORIES_MIN_RATE_LIMIT_REMAINING_PERCENT = 25`，同文件 L53/L322-324）+ 纯函数 `bootQuotaPlan()`：`已用% ≤ 100 − 阈值` 才放行 ⇒ **剩余恰好等于阈值也放行**（浮点加 1e-9 容差）。自动路径在 `phase2Integrate` 入口判门，不过则**不启动新整合**并把唤醒排到**下一个本地日边界**（不忙循环）；**在途批次（published/running/prepared）不拦**（那是收尾不是开工）；**显式 `memory__phase2_integrate` 绕过此门**（`{ manual: true }`）。
- **启动顺序对齐 codex**：镜像 `codex-rs/memories/write/src/start.rs` L59-92 —— **先做不耗额度的 prune/清理**（遗留状态归档 → stage-1 迁移 → 过期租约回收 → change-outbox 半提交修复）**再**进两道门；顺序在代码里以编号注释标出。
- **只对根会话生成**：新增纯函数 `isRootSessionHeader()`；`session/disposed` 入队前判血缘（`parentSession` / `origin==='subagent'` / `delegationDepth>0` ⇒ **不入队**），对齐 codex `start.rs` L33-38 排除非根会话。**未知血缘 ⇒ 视为根会话**（保守：不因读不到血缘就停掉记忆生成）—— 此点如实登记。
- **契约改向（1 处既有测试按新契约改写，非放水）**：`test/drain-quota.test.mjs` 的「drain 产出后自动触发 1 次整合」改为「额度耗尽（剩余 0% < 25%）⇒ 自动整合被额度门拦住 = 0 次」。
- **测试 / 回归**：新增 `test/t189-boot-gates.test.mjs`（6 组 / **25 断言**），改前树（`lib/index.js.pre-bootgate-2026-09-13`）**17 条红**；回归 **ALL 66 TESTS PASSED**；三处 SHA 全等 `5757528C…`；`node --check` exit 0。
- **t191 收口（t190 发现②，选 A：让启动上限成为每次启动的**真约束**）**：启动来源预算从"一趟一个数字"改为**可继承的预算对象**（`scheduleStage1Drain({ remaining })`；**busy-rerun 补跑趟继承在飞那一趟的剩余预算**、同一对象继续扣减；`scheduleStage1Drain` 早退时**合并**预算而不是丢掉）⇒ 补跑趟**不再绕过启动上限**，预算耗尽仍走 30s 间隔唤醒（间隔照旧生效）。新增 `test/t191-boot-budget-rerun.test.mjs`（含牙齿：还原口树（`5757528C…`）上必红）。**t190 发现①（账目）**：本文件上一行的「23 断言」已更正为 **25**（运行时 ✓25 / 静态 `check(`=25 / 分组 5+6+4+5+1+4=25 三处自证）。
- **未做**：仍未把整合的**模型调用**搬进受限会话（属下一批，且须先过 t187 的第一验收项）。

### 追加（同日 · t193）：修「工具返回体违声明 schema（`wake`）」+ 穷举 `memory*` 工具返回体一致性 + 补宿主 schema 校验测试
> 本节行号对应 `lib/index.js` SHA `65DD012BE6D69E95955E3AA56CB7F36FB5D1B6828CAC7A44A9E35881713FCC77`（329,458 B）；宿主校验器行号对应实际加载副本 `dsh-tools/lib/index.js`。

- **真机现象（队长实测逐字）**：`memory__phase2_integrate` 报 `returned invalid output: "value.wake" is not a declared property (additionalProperties: false)`；副作用为零（整合没跑，是输出校验层判非法）⇒ 该工具对模型不可用，而它又是**额度门唯一的绕过入口**。
- **归因**：返回体多出 **4 个未声明字段** —— `wake`（t164 自动续跑，4 条返回路径都带）、`truncation`（S0-2 截断可观测）、`request`（t164 §6.3 完整请求预算）、`diagnostics`（t164 §6.2 可选诊断）；另 `quota`（t189 额度门）属同一函数返回面但工具路径不可达。**旧单测没抓到**：它们直接调 handler 断言字段值，**从不经过宿主 `dsh-tools` 的输出校验层**。
- **修法**：① `wake` **从返回体裁掉**（内部调度状态；`armPhase2Wake()` 副作用保留，"何时再醒"仍可从 `phase2_jobs.available_at` 观测）；② `truncation`/`request`/`diagnostics`/`quota` **如实补进声明 schema**（前三项是已验收的可观测契约，裁掉会回退）；③ `diagnostics` 关闭时**不返回该键**（宿主方言不支持 null 型对象属性，保留 `null` 会让默认配置照样被拒）——`test/t164-diagnostics.test.mjs` 的对应断言按新契约改写（**契约改向，非放宽**）。
- **穷举**：10 个 `memory*` 工具逐一核对 ⇒ **只有 `memory__phase2_integrate` 违约**（其 5 个字段全部处理）；其余 9 个一致。顺带登记：本插件 schema 用的**属性级 `required: true` 宿主不认**（只认顶层 `required` 数组），属惰性装饰，本批未改（避免在未驱动分支引入新拒绝）。
- **测试（牙齿核心）**：新增 `test/t193-tool-output-schema.test.mjs` —— 内置**宿主等价** schema 校验器（含 `additionalProperties: false` 语义与同款文案），对**每个** `memory*` 工具的真实返回体逐样本校验；`memory__phase2_integrate` 取早退/恢复/处理三条路径。当前树 **✓34 ✗0 / exit 0**；还原口树（`4B299C86…`）**exit 1 / ✓31 ✗3**（真机那条 `wake` 在内）。
- **回归**：**ALL 68 TESTS PASSED**（基线 67 + 新增 1）；`node --check` exit 0；三处 SHA 全等 `65DD012B…`。**未 commit / 未 push / 未重启**（现行进程仍加载 `4B299C86…` ⇒ 该工具在真机上仍报错，直到下次重启）。

### 追加（同日 · t195）：④ 生命周期照 codex 对齐 —— 30 天未用**失格** + `usage_count` 降序（撤销 freshness 软降权）
> 本节行号对应 `lib/index.js` SHA `4EB510793991E3E98BA459041183461BB23AAB97A7F636B60E25086078A06B22`（338,789 B）；codex 依据取自本地镜像 `_ref-codex\`（提交 `a592c38c…`）。

- **依据（镜像逐字）**：`codex-rs/state/src/runtime/memories.rs` **L439-446**（资格+排序文档：`last_usage` 在 `max_unused_days` 内，**或**从未用过时 `source_updated_at` 在该窗口内；排序 `usage_count DESC, COALESCE(last_usage, source_updated_at) DESC, source_updated_at DESC, thread_id DESC`）、**L459**（cutoff）、**L473-477**（WHERE 资格）、**L479-482**（ORDER BY）、**L70-80**（`usage_count = COALESCE(usage_count,0)+1, last_usage = now`）；`config/src/types.rs` **L55**（`max_unused_days = 30`）。
- **改了什么**：① 新增 `entryEligible()`（**30 天未用即失去资格**；`forgotten`/`superseded` 仍最高优先；负数窗口按 0）；② `entries` 新增 **`usage_count` / `last_usage`**（schema 默认 0 / ''，**旧数据读时补默认、不迁移、不重写**）；③ 召回资格改**硬淘汰**（L5186-5187）、排序**首键 = `usage_count DESC`**（L5188-5194 区）；④ **撤销降权**：`scoreMemory` 只返回相关性、`freshnessWeight` 标 `@deprecated` 不再参与；⑤ 配置项 `maxUnusedDays`（默认 30）。
- **使用计数（设计）**：`memory_recall` 真正交付给模型的条目异步累加（`setImmediate` + **`runScheduledPass`**（t180 纪律）+ `withWrite` + **`get`+`put`**，**10 分钟去抖**）；`usage_count` **只作排序键、不作资格判据**。**偏差如实登记**：codex 的计数由**引用解析**驱动（`citations.rs`），本地无该信号 ⇒ 用"被交付"近似。
- **契约改向（非放宽）**：`phase-c-lifecycle` [7] 与 `phase-c-recall` [1] 原断言「stale 只被降权 / 排第二」→ 改为「stale **失格**」；`phase-c-recall` 的"recall 只读"改为"**调用本身**不写，计数是异步写" + 新增"异步计数已落盘"断言。
- **测试 / 回归**：新增 `test/t195-codex-lifecycle.test.mjs`（**26 断言**）；改前树（`lib/index.js.pre-codexlifecycle-2026-09-13` = `65DD012B…`）**21 条红**（并点名 5 条不算牙齿的 ✓）；回归 **ALL 69 TESTS PASSED**；`node --check` exit 0；三处 SHA 全等 `4EB51079…`。
- **影响面（用户需知）**：从未使用且 `updatedAt` 超 30 天的条目**重启后不再被召回**（codex 语义）；若太严，**调大 `maxUnusedDays` 即可**，无需改码。**未 commit / 未 push / 未重启** ⇒ 真机生效需重启。

## 2026-09-12 · v0.1.10：每日预算「日界」由 UTC 日改为**本机时区**日（本地 00:00 换日）

本次把阶段 A 的「每日模型尝试预算」**日界口径**从 **UTC 日**改为**本机（客户端）时区日**。基线：`759121d`（v0.1.9）。

### 变更（**行为变更**）

- `dayKey()` 由 `d.toISOString().slice(0, 10)`（**UTC 日**）改为用本地 `getFullYear/getMonth/getDate` 拼 `YYYY-MM-DD`（**补零**）。
  全仓复核：**再无以 UTC 日作日界的地方**（仅此一处，另有 2 个调用点 `drain` 前预算门 / 真模型尝试后计数，均只调 `dayKey()`，未改语义）。
- **`runDay` 字段与 `modelAttemptsToday` 的重置时点随之改变**：以前在 **UTC 午夜**换日（东八区 = 北京时间 **08:00**），现在在**本地 00:00**换日。
- **不新增任何持久字段**，`runDay` 仍是 `YYYY-MM-DD` 字符串（schema 未动）。
- **（t144 修复 S0-1）「预算裁剪」与「消费提交」同口径，消除静默丢来源**：此前 `claimNextPhase2Job()` 把**全部**未消费 `stage1_outputs` 冻进批次 `input_ids`，而提示词只喂 `clampPromptInputs()` 的前 **`PROMPT_MAX_INPUTS`＝20** 条 ⇒ **第 21 条起从未进过模型，却被 `commitPhase2Batch()` 按整批 `input_ids` 标为已消费**（静默丢来源）。
  改法选 **(a) 冻结点分批**：`claimNextPhase2Job()` 冻结时就按 `PROMPT_MAX_INPUTS` 切批（`unconsumed.length >= MAX_INPUTS_PER_BATCH` 即停），**多余的不入本批、保持未消费、由下一批领取**。这样「批次持有的 id」≡「模型实际看到的」≡「被提交消费的」成为**结构性事实**，且**不改** `commitPhase2Batch()` / 崩溃恢复路径的既有契约。
  `memory_changes` **不参与**该预算裁剪（`buildConsolidationPrompt` 对 changes 全量渲染，L2462 `changes.forEach` 无上限），故其消费标记本就同口径，**无需一并切批**。
  新增 `test/phase2-input-budget-consume.test.mjs`：造 21 条带唯一标记的输入，逐条断言「**被标已消费** ⇔ **标记确实出现在本轮提示词里**」，并点名第 21 条不得"未见即消费"；**修复前实跑 4 条断言失败**（第 21 条 `consumed=true / inPrompt=false`），修复后全绿。

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


