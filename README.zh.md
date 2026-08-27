# dsh-rollout

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的 **Codex 式会话记忆**插件（一会话一草稿）。

灵感来自 [Codex 记忆模型](https://github.com/openai/codex)——分层、克制、被动。`dsh-rollout` 给每个会话一张草稿纸，给 Agent 一份有组织、只在必要时才写入的持久记忆。

- **一会话一草稿** — 每个会话写 `rollout_summaries/<sessionId>.md`（像子 `AGENTS.md`），由 Agent 按需写入。
- **分层渐进披露** — `memory_summary.md`（摘要，注入提示）+ `MEMORY.md`（可搜索注册表）+ `rollout_summaries/`（逐会话草稿）+ notes。可 grep、不全扫。
- **克制被动** — 记忆只在用户显式要求时写；**决策边界 + 快速记忆通道（≤4-6 步）** 决定何时查记忆，绝不淹没上下文。
- **幂等整合** — fingerprint + watermark 门槛，无变化就跳过（省 token）。
- **6 个模型工具** — `memory_remember` / `memory_recall` / `memory_forget` / `memory_draft` / `memory_note` / `memory_integrate`。
- **浏览器管理页** — 「记忆库 / Memory」页浏览摘要、注册表、草稿与笔记。

## 安装

```bash
dsh plugin --profile web add dsh-rollout
```

`dsh.bundle` manifest 会自动把 `dsh-rollout` 行挂进 profile。手动安装：

```bash
pnpm add dsh-rollout
```

再在你的 profile `cordis.yml`（或 `cordis.patch.yml`）加一行：

```yaml
- id: dsh-rollout
  name: dsh-rollout
```

要求 DSH 基座为 `0.1.1-rc.2` 或更新（`peerDependencies` 声明 `^0.1.1-rc.2`）。

## 用法

让 Agent 记住事情，或自己写：

> "记住：这个项目的部署目标是 Windows，测试命令是 `pnpm test`。"

Agent 用 `memory_draft` 写本会话草稿，或用 `memory_remember` 写长期事实：

```
memory_draft(content="本会话结论：…", title="xxx")    # → rollout_summaries/<sessionId>.md
memory_remember(content="用户偏好…", tags=["pref"])    # → 长期记忆（带来源 sessionId）
memory_note(slug="fix-x", content="…")                # → 临时 note（用户显式要求时）
memory_integrate()                                     # → 幂等整合 summary/MEMORY.md
```

当涉及先前会话的上下文时，Agent 跑一次快速记忆通道：扫注入摘要 → 搜 `MEMORY.md` → 打开 1-2 个相关草稿 → 无命中即停。`memory_recall(query="…")` 是显式搜索入口。

### 配置

插件暴露一个 schemastery 配置 schema。完整参数表：

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `recallLimit` | int | 10 | `memory_recall` 返回的最大条目数 |
| `injectLimit` | int | 8 | 保留用于配置兼容；本版本只注入记忆摘要 |
| `summaryTokens` | int | 2500 | 注入的 `memory_summary.md` 最大字符数 |
| `maxQuickSteps` | int | 5 | 快速记忆通道的搜索步数预算 |
| `memoryRoot` | string | `''` | 可选覆盖记忆根目录；空 = `<ds_home>/memories` |
| `autoTrigger` | `'sessionEnd'` \| `'off'` | `'sessionEnd'` | 自动触发模式：`sessionEnd` 会话结束时跑管线，`off` 关闭（手动工具仍可用） |
| `minIdleHours` | number | 6 | 会话成为管线候选所需的最小空闲小时 |
| `maxDraftAgeDays` | number | 10 | 跳过草稿比这更旧的候选会话（陈旧清理） |
| `maxExtractPerTrigger` | number | 2 | 每次管线运行最多写草稿的候选会话数 |
| `maxPipelineRunsPerDay` | number | 12 | 每日历日管线运行上限（防失控预算） |
| `precompactAuto` | boolean | `false` | true 时也在 `compaction/start` 跑前置整理 |
| `extractProvider` | string | `''` | 提炼所用的 Provider 路由；空 = harness 默认 |
| `extractModel` | string | `''` | 提炼所用的模型 id；空 = harness 默认 |
| `extractReasoningEffort` | string | `'low'` | 提炼的推理强度（adapter 词汇） |
| `maxExtractTokens` | number | 8000 | 喂给 LLM 的转录输入粗算 token 上限 |
| `consolidationProvider` | string | `''` | 预留用于后续整合 pass；本版本未接线 |
| `consolidationModel` | string | `''` | 预留用于后续整合 pass；本版本未接线 |

```yaml
- id: dsh-rollout
  name: dsh-rollout
  config:
    summaryTokens: 3000
    maxQuickSteps: 5
```

设置页可在运行时编辑这些参数（见下）。运行时改动持久化到 `<ds_home>/dsh-rollout.settings.json`，下次启动重新应用，优先于 `cordis.patch.yml`。`memoryRoot` 与两个预留的 `consolidation*` 字段为只读。设置页里的改动即时影响当前进程。

## 记忆布局

```
<home>/memories/
├── memory_summary.md         # 注入摘要（首行 `v1`）
├── MEMORY.md                 # 可搜索注册表
├── rollout_summaries/        # 每会话一个草稿（session_id / updated_at / cwd 头）
│   └── <sessionId>.md
├── extensions/ad_hoc/notes/  # 用户要求的临时 note
├── .watermark                # 幂等水印
```

## 浏览器页

设置 → 记忆库（Memory）。浏览摘要、注册表、逐会话草稿与笔记；快速添加与删除。经 harness `webServer` 服务托管（`GET/POST /dsh-rollout/entries`、`/dsh-rollout/overview`）。

页面还有一块「**设置**」：

- **配置表单** — 运行时读取/编辑插件配置（`GET/POST /dsh-rollout/config`）。每个可编辑字段显示当前值，偏离 schema 默认时标「≠ 默认」。
- **导出记忆** — 把整个 `memories/` 树（`memory_summary.md`、`MEMORY.md`、`rollout_summaries/`、`extensions/ad_hoc/notes/`、`.pipeline-state.json`、`.watermark` 等）连同长期记忆 entries 表一并打包成单个 JSON 备份下载（`GET /dsh-rollout/export`）。
- **导入记忆** — 恢复备份文件。先把现有记忆根复制到 `<ds_home>/memories-backup-<时间戳>`，再把备份解包到 `memories/` 并恢复 entries 表。导入是「替换」语义：先备份再导入（`POST /dsh-rollout/import`）。

## 开发

插件是一个 cordis 包：

- `lib/index.js` — host 半区：存储域、工具、提示注入、整合
- `lib/client.js` — web 半区：设置页

host 半改动需**重启 `dsh web`**（Node 缓存代码）；client 半可随 `pnpm run dev:web` 热更。改完 `lib/*.js` 后同步另两份副本（`.dsh/plugins/dsh-rollout/` 与 `.dsh/profiles/web/node_modules/dsh-rollout/`），并确认三处 SHA-256 一致。

完整维护指南见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)——含记忆模型如何运作、常见的改动在哪、怎么发布版本。

## 许可证

MIT

## 致谢（Acknowledgments）

本插件的记忆模型与 LLM 提炼提示词**灵感来自、并改编自** [openai/codex](https://github.com/openai/codex) 的记忆系统（Apache License 2.0）。它是面向 DeepSeek Harness 的独立重实现，未逐字分发 openai/codex 源码。详见 `NOTICE` 的署名。同时改编自 `flymysql/dsh-memory`（MIT），即本插件脱胎的原始「跨会话记忆库」。
