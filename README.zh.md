# dsh-memory_rollout

> **项目状态：实验性 / 尚未公开。** 这是一个 **vibe coding**（直觉驱动、AI 辅助快速开发）项目——由 AI agent 与人类协作者快速迭代而成。它足以支撑作者自用，但**未经充分测试、可能有粗糙边缘、API 与行为随时可能变动**。此阶段的缺陷、遗漏、bug 属正常预期。发布是为了学习与收集反馈，**不是**作为生产就绪的成熟插件。

## 这是什么？

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的 **Codex 式会话记忆**插件（**一会话一草稿**）。

灵感来自 [Codex 记忆模型](https://github.com/openai/codex)——分层、克制、被动。说白了：**给每个 DSH 会话一张「草稿纸」，给 Agent 一份有组织、只在必要时才写的持久记忆**。它解决的是「会话一关，之前的上下文就丢了」这个问题——把值得留的东西沉淀下来，下次会话还能想起来。

## 它解决什么问题？

DSH 的每个会话都从零开始。你开了新会话，Agent 不知道上一轮定了什么、你偏好什么、踩过哪些坑。`dsh-memory_rollout` 就是给 Agent 的「**第二大脑**」：事实、偏好、决策、项目笔记能跨会话活下来，并在需要时被想起。

关键的设计取舍（这也是它和普通「记忆库」不一样的地方）——**克制、不打扰**：

- **一会话一草稿** — 每个会话独立写 `rollout_summaries/<sessionId>.md`（像一份子 `AGENTS.md`），由 Agent 按需写，互不干扰。
- **分层渐进披露** — `memory_summary.md`（总纲，注入提示）+ `MEMORY.md`（可搜索注册表）+ `rollout_summaries/`（逐会话草稿）+ notes。**可 grep、不全扫**，查的时候只翻该看的。
- **克制被动** — 记忆只在**用户显式要求**或**自动触发**时写；配一套「**决策边界 + 快速记忆通道（≤4-6 步）**」，决定什么时候才值得查记忆，绝不把上下文淹没。
- **幂等整合** — `fingerprint + watermark` 门槛，**没变化就跳过**，不浪费 token。
- **6 个用户工具** — `memory_remember` / `memory_recall` / `memory_forget` / `memory_note` / `memory_integrate` / `memory_precompact`；另有两个 `memory__*` 内部调度工具供运维与验收。
- **浏览器管理页** — 「记忆库 / Memory」设置页，能浏览摘要、注册表、草稿、笔记，还能**改配置、导入导出记忆**。

## 安装

```bash
dsh plugin --profile web add dsh-memory_rollout
```

`dsh.bundle` manifest 会自动把 `dsh-memory_rollout` 行挂进 profile。手动安装：

```bash
pnpm add dsh-memory_rollout
```

再在你的 profile `cordis.yml`（或 `cordis.patch.yml`）加一行：

```yaml
- id: dsh-memory_rollout
  name: dsh-memory_rollout
```

要求 DSH 基座为 `0.1.1-rc.2` 或更新（`peerDependencies` 声明 `^0.1.1-rc.2`）。

插件把 `sessionQuery` 声明为**必需**服务（由 DSH 基座提供）。若基座未挂载它，插件加载失败，自动记忆（Stage 1 来源读取）会被禁用。

## 用法

让 Agent 记住事情，或自己写：

> "记住：这个项目的部署目标是 Windows，测试命令是 `pnpm test`。"

Agent 用 `memory_remember` 写长期事实；显式更新写 note；压缩前关键内容走 precompact：

```
memory_remember(content="用户偏好…", tags=["pref"])    # → 长期记忆（带来源 sessionId）
memory_note(slug="fix-x", content="…")                # → 临时 note（用户显式要求时）
memory_integrate()                                     # → 幂等整合 summary/MEMORY.md
memory_precompact(content="要留的关键要点")           # → 压缩前防丢信息（写草稿+持久队列）
```

当涉及先前会话的上下文时，Agent 跑一次**快速记忆通道**：扫注入总纲 → 搜 `MEMORY.md` → 打开 1-2 个相关草稿 → 无命中即停。`memory_recall(query="…")` 是显式搜索入口。

### 配置

插件暴露一个 schemastery 配置 schema。完整参数表（设置页也能改）：

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `recallLimit` | int | 10 | `memory_recall` 一次返回的最大条目数 |
| `summaryTokens` | int | 4000 | 注入的 `memory_summary.md` 最大 token 数，越大注入越多但更占上下文 |
| `maxQuickSteps` | int | 5 | 快速记忆通道的搜索步数预算（≤12） |
| `memoryRoot` | string | `''` | 可选覆盖记忆根目录；空 = `<ds_home>/memories` |
| `generateMemories` | boolean | `true` | M2：是否让会话贡献未来记忆（自动 Phase 1）。false = 会话结束时不自动入队提炼（手动 `memory_precompact` / `memory_remember` 仍可用）。与 `useMemories` 独立。 |
| `useMemories` | boolean | `true` | 是否向模型提供记忆（注入 + recall）。false = 不注入、不召回（生成可独立开关） |
| `maxModelAttemptsPerDay` | number | 24 | 每日 Stage 1 模型尝试上限（失败尝试也计数） |
| `extractProvider` | string | `''` | LLM 提炼所用的 Provider 路由；空 = harness 默认 |
| `extractModel` | string | `''` | LLM 提炼所用的模型 id；空 = harness 默认 |
| `extractReasoningEffort` | string | `'low'` | 提炼的推理强度（adapter 词汇；若模型拒绝会自动去掉重试） |
| `maxExtractTokens` | number | 8000 | 喂给 LLM 的转录输入粗算 token 上限（超长先截断） |
| `consolidationProvider` | string | `''` | Phase 2 全局整合使用的 Provider；空 = harness 默认 |
| `consolidationModel` | string | `''` | Phase 2 全局整合使用的模型；空 = harness 默认 |
| `consolidationReasoningEffort` | string | `''` | Phase 2 整合推理强度；空 = 模型默认 |

```yaml
- id: dsh-memory_rollout
  name: dsh-memory_rollout
  config:
    summaryTokens: 4000
    maxQuickSteps: 5
```

设置页可在运行时编辑这些参数。改动持久化到 `<ds_home>/dsh-memory_rollout.settings.json`，下次启动重新应用（优先于 `cordis.patch.yml`）。`memoryRoot` 为只读。

## 记忆布局

```
<home>/memories/
├── memory_summary.md         # 注入总纲（首行 `v1`）
├── MEMORY.md                 # 可搜索注册表
├── rollout_summaries/        # 每会话一个草稿（session_id / updated_at / cwd 头）
│   └── <sessionId>.md
├── extensions/ad_hoc/notes/  # 用户要求的临时 note
├── .watermark                # 幂等水印
```

> 同一会话草稿（`rollout_summaries/<sessionId>.md`）是**追加式**：新内容追加在旧行段之后，旧行段保持稳定，因此基于行段的引用在多次整合后仍可核验。

> ⚠️ **`memories/` 目录在你本机 `<ds_home>` 下，与插件代码分开**——卸载插件不会删你的记忆；但请记得**定期用设置页「导出记忆」备份**（你的记忆是本机数据，不进仓库）。

## 浏览器页

设置 → 记忆库（Memory）。浏览摘要、注册表、逐会话草稿与笔记；快速添加与删除。经 harness `webServer` 服务托管（`GET/POST /dsh-memory_rollout/entries`、`/dsh-memory_rollout/overview`）。

`GET /dsh-memory_rollout/overview` 的 `status.capabilities.stage1SourceRead` 会暴露「当前进程能否读取会话来源」，用于诊断自动记忆是否因能力缺失被跳过。

页面还有一块「**设置**」：

- **配置表单** — 运行时读取/编辑插件配置（`GET/POST /dsh-memory_rollout/config`）。每个可编辑字段显示当前值，偏离默认时标「≠ 默认」，悬浮 `?` 看解释。
- **导出记忆** — 把整个 `memories/` 树（`memory_summary.md`、`MEMORY.md`、`rollout_summaries/`、`notes/`、`.watermark` 等）连同长期条目表一并打包成单个 JSON 备份下载（`GET /dsh-memory_rollout/export`）。
- **导入记忆** — 恢复备份文件。先把现有记忆根复制到 `<ds_home>/memories-backup-<时间戳>`，再把备份解包进 `memories/` 并恢复条目表。导入是「替换」语义：先备份再导入（`POST /dsh-memory_rollout/import`）。

## 开发

插件是一个 cordis 包：

- `lib/index.js` — host 半区：存储域、工具、提示注入、整合
- `lib/client.js` — web 半区：设置页

host 半改动需**重启 `dsh web`**（Node 缓存代码）；client 半可随 `pnpm run dev:web` 热更。改完 `lib/*.js` 后同步另两份副本（`.dsh/plugins/dsh-memory_rollout/` 与 `.dsh/profiles/web/node_modules/dsh-memory_rollout/`），并确认三处 SHA-256 一致。

完整维护指南见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)——含记忆模型怎么运作、常见改动在哪、怎么发版。

## 许可证

MIT

## 致谢（Acknowledgments）

本插件的记忆模型与 LLM 提炼提示词**灵感来自、并改编自** [openai/codex](https://github.com/openai/codex) 的记忆系统（Apache License 2.0）。它是面向 DeepSeek Harness 的独立重实现，未逐字分发 openai/codex 源码。详见 `NOTICE` 的署名。同时改编自 `flymysql/dsh-memory`（MIT），即本插件脱胎的原始「跨会话记忆库」。
