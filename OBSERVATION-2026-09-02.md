# 观察基线 — dsh-memory_rollout 候选观察（2026-09-02）

> 对应《再次全量评估（2026-09-02）》§七/§九-C：**观察，不开发**。修复与发布收口后运行 2~5 天，
> 只记录四项指标，出现趋势性问题再优化；无新用户可见故障则停止持续审计、进入正常使用。
> 本文件只记录**基线快照**，供此后几天对照；工具为只读，不改真实 `dsh_rollout.json`。

## 一、观察协议（每次记录这四项）

| 指标 | 定义 | 观测方式 |
|---|---|---|
| 非终态作业最大滞留时间 | `phase2_jobs`（及 `stage1_jobs`）中非终态（非 committed/failed_terminal/terminal）作业从 `available_at`/`created_at` 到「当前」的最长秒数 | 只读扫 `D:\软件\Deepseek\.dsh\storages\dsh_rollout.json` → `tables.phase2_jobs` / `tables.stage1_jobs` |
| 秘密校验失败次数 | `last_error` 含 `unredacted secret` 的 phase2 批次数量（含终态） | 同上，搜 `last_error` |
| 召回未验证比例 | 一次 `memory_recall` 结果里 `unverified` 引用占比 | 真实 DSH 里跑一次 `memory_recall` 统计 |
| 存储大小 + 召回耗时 | `dsh_rollout.json` 字节数；一次召回耗时的毫秒数 | `Get-Item` 大小；真实 recall 计时 |

## 二、当前基线快照（2026-09-02 17:05 只读）

- **存储文件**：`D:\软件\Deepseek\.dsh\storages\dsh_rollout.json` = **484,151 字节**（约 473 KB）。
- **Phase2 非终态**：共 39 批，仅 1 个非终态 `p2-mtjc0ywk-688raj`（`retry_wait`，attempt 2 / max 3，
  `available_at=2026-09-02T08:44:53Z`，`last_error=unredacted secret in memory_summary`）。截至快照时间它仍停在
  `retry_wait`，**已过 `available_at` 数小时**——这正是 P0-9 缺陷在「旧部署代码」下的真实表现。
- **秘密校验失败（含终态）**：至少 2 个批次曾 `last_error` 含 `unredacted secret`（`p2-mtemsf4h-yrbgec` committed / attempt 1、`p2-mtjc0ywk-688raj` retry_wait / attempt 2）。
- **召回未验证比例**：本快照未实测（需真实 recall）；注意 §六历史引用债务：54/67 可验证、13 条来自旧数据（7 无 source、5 片段找不到、1 行范围无效），未验证引用会降级 `unverified` 而非伪造。
- **召回耗时**：本快照未实测。

## 三、观察前提（P0-9 修复要生效）

`D:\软件\Deepseek\.dsh\plugins\dsh-memory_rollout\lib\index.js` 仍是旧代码（SHA256 与仓库我的修复版不一致）。
要让上述 `retry_wait` 批次在无新事件/无重启下自动进第 3 次尝试（并因秘密校验失败而进 `failed_terminal`、不泄露），
需：①把仓库修复版 `lib/index.js` 同步到该部署副本；②重启运行中的 DSH 进程（属宿主/用户域）。
重启后，预期该批次在下一轮 wake 中被自动领取 → 第 3 次尝试 → 秘密校验仍拒绝 → 按 `max_attempts=3` 进 `failed_terminal`。

## 四、后续判定

- 连续 2~5 天无新队列悬挂 + 无用户可见回归 → 停止审计，进入正常使用。
- 若再出现：非终态滞留时间突破上次观察值、秘密校验失败次数持续攀升、召回未验证比例异常、存储/召回耗时急剧增长 → 再处理，而非现在就重构。
