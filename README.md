# dsh-memory_rollout

> 为 DeepSeek Harness (DSH) 提供的 Codex 式会话持久记忆。
> [English README](./README.en.md)

> 早期版本（0.1.x），48/48 测试通过、已进入候选观察期，欢迎反馈。

## 解决什么问题

DSH 的每个会话都从零开始。你开一个新会话，Agent 不知道上一轮定了什么、你偏好什么、踩过哪些坑。`dsh-memory_rollout` 给 Agent 一份**有组织、只在必要时才写**的持久记忆：事实、偏好、决策、项目笔记能跨会话活下来，并在需要时被想起、给出来源。

## 项目功能

- **一会话一草稿** — 每个会话写 `rollout_summaries/<sessionId>.md`（类似子 `AGENTS.md`），Agent 按需写。
- **分层披露** — `memory_summary.md`（注入提示）→ `MEMORY.md`（可搜索注册表）→ 少量相关草稿 / 笔记。grep 友好，不做全量扫描。
- **克制被动** — 只在显式请求时写；快速记忆通道（≤4–6 步）决定何时查记忆，不淹没上下文。
- **幂等整合** — 指纹 + 水印，无变化则不重复整合（不浪费 token）。
- **6 个用户工具** — `memory_remember` / `memory_recall` / `memory_forget` / `memory_note` / `memory_integrate` / `memory_precompact`，另有 2 个 `memory__*` 内部调度工具。
- **浏览器管理页** — 「记忆库 / Memory」页浏览摘要、注册表、草稿、笔记，可改配置、导入导出记忆。

## 管线基本描述

```
会话结束/闲置 → 持久入队 (Stage 1)
  → 提炼候选记忆 + append-only 证据（草稿 + source_ref）
  → Phase 2 全局整合 + 版本化发布（current 原子切换 / 旧版可回退）
  → 分层读取（总纲 → 注册表 → 少量草稿/证据）
  → remember / forget / supersede 进入统一变更流，再整合成权威版本
```

约束：无信号会话不产出脏记忆；失败不伪装成成功；秘密在入口 / 模型 / 落盘三处脱敏；引用指向真实内容，否则诚实 `unverified`；当前用户指令与 `AGENTS.md` 高于记忆。

## 安装

```bash
dsh plugin --profile web add dsh-memory_rollout
```

`dsh.bundle` manifest 会自动把本插件挂进 profile。手动安装：

```bash
pnpm add dsh-memory_rollout
```

再在 profile 的 `cordis.yml`（或 `cordis.patch.yml`）加一行：

```yaml
- id: dsh-memory_rollout
  name: dsh-memory_rollout
```

要求 DSH 基座 `0.1.1-rc.2` 或更新（`peerDependencies` 声明 `^0.1.1-rc.2`）。插件把 `sessionQuery` 声明为**必需**服务（由 DSH 基座提供）——基座未挂载它则加载失败、自动记忆（Stage 1 来源读取）被禁用。

## 使用

让 Agent 记住事情，或自己写：

```text
memory_remember(content="用户偏好…", tags=["pref"])   # → 长期记忆（带来源 sessionId）
memory_note(slug="fix-x", content="…")               # → 临时 note（用户显式要求时）
memory_integrate()                                    # → 幂等整合 summary/MEMORY.md
memory_precompact(content="要留的关键要点")          # → 压缩前防丢信息（草稿 + 持久队列）
```

当涉及先前会话时，Agent 跑一次**快速记忆通道**：扫注入总纲 → 搜 `MEMORY.md` → 打开 1–2 个相关草稿 → 无命中即停。`memory_recall(query="…")` 是显式搜索入口。

## 配置

插件暴露一个 schemastery 配置 schema。完整参数表：

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `recallLimit` | int | 10 | `memory_recall` 最多返回条目数 |
| `summaryTokens` | int | 4000 | 注入 `memory_summary.md` 的 token 预算 |
| `maxQuickSteps` | int | 5 | 快速记忆通道搜索步数预算 |
| `memoryRoot` | string | `''` | 覆盖记忆根；空 = `<ds_home>/memories` |
| `generateMemories` | boolean | `true` | 会话是否贡献未来记忆（自动 Stage 1）；false = 不自动入队 |
| `useMemories` | boolean | `true` | 是否给模型记忆（注入 + 召回） |
| `maxModelAttemptsPerDay` | number | 24 | 每日 Stage 1 模型尝试上限；失败也算 |
| `extractProvider` / `extractModel` / `extractReasoningEffort` / `maxExtractTokens` | | | Stage 1 提取的 LLM 路由 / 模型 / 推理档位 / 输入 token 上限 |
| `consolidationProvider` / `consolidationModel` / `consolidationReasoningEffort` | | | Phase 2 整合的 LLM 路由 / 模型 / 推理档位 |

设置页可在运行时编辑，改动持久化到 `<ds_home>/dsh-memory_rollout.settings.json`，下次启动重新应用（优先于 `cordis.patch.yml`）。`memoryRoot` 只读。

## 参考

本插件的记忆模型与 LLM 提炼提示词**改编自** [openai/codex](https://github.com/openai/codex) 的记忆系统（Apache License 2.0）——面向 DeepSeek Harness 的独立重实现，未逐字分发其源码。同时改编自 `flymysql/dsh-memory`（MIT），即本插件脱胎的原始「跨会话记忆库」。详见 `NOTICE` 的署名。

## 协议

MIT（见 `LICENSE`）。
