# dsh-memory_rollout

> Codex-style per-session memory for DeepSeek Harness (DSH).
> [中文 README](./README.md)

> Early version (0.1.x), 48/48 tests passing, in candidate-release observation. Feedback is welcome.

## What problem it solves

Every DSH session starts from zero. When you open a new session, the agent doesn't know what was decided last time, what you prefer, or what pitfalls you already hit. `dsh-memory_rollout` gives the agent an **organized, write-only-when-it-makes-sense** persistent memory: facts, preferences, decisions, and project notes survive across sessions, and can be recalled with their source when needed.

## Features

- **One session, one draft** — each qualifying session has its evidence draft generated or appended by Stage 1 (`rollout_summaries/<sessionId>.md`, like a sub-`AGENTS.md`); the agent may also explicitly save key points before compaction.
- **Layered disclosure** — `memory_summary.md` (injected into the prompt) → `MEMORY.md` (searchable registry) → a few relevant drafts / notes. Grep-friendly, no full-scan.
- **Restrained & passive** — automatic generation only processes qualifying sessions; manually adding, editing, or forgetting long-term memory happens only on explicit user request; a quick memory pass (≤4–6 steps) decides when to look memory up, so it never floods the context.
- **Idempotent integration** — fingerprint + watermark; skips re-integration when nothing changed (no wasted tokens).
- **6 user-facing tools** — `memory_remember` / `memory_recall` / `memory_forget` / `memory_note` / `memory_integrate` / `memory_precompact`, plus two `memory__*` internal scheduler tools.
- **Browser management page** — a "记忆库 / Memory" page to browse summaries, registry, drafts, and notes; edit config and import/export memory.

## Pipeline at a glance

```
session ends / goes idle → durable queue (Stage 1)
  → extract candidate memories + append-only evidence (draft + source_ref)
  → Phase 2 consolidation + versioned publish (atomic current switch / old versions recoverable)
  → layered read (summary → registry → a few drafts/evidence)
  → remember / forget / supersede enter the unified change stream, re-integrated into an authoritative version
```

Constraints: no-signal sessions produce no dirty memory; failures never masquerade as success; secrets are redacted at ingress / model / disk; citations point at real content or honestly fall back to `unverified`; the current user instruction and `AGENTS.md` take precedence over memory.

## Install

```bash
dsh plugin --profile web add dsh-memory_rollout
```

The `dsh.bundle` manifest wires this plugin into the profile automatically. To install by hand:

```bash
pnpm add dsh-memory_rollout
```

then add a row to your profile's `cordis.yml` (or `cordis.patch.yml`):

```yaml
- id: dsh-memory_rollout
  name: dsh-memory_rollout
```

Requires a DSH base of `0.1.1-rc.2` or newer (`peerDependencies` declare `^0.1.1-rc.2`). The plugin declares `sessionQuery` as a **required** service (provided by the DSH base) — if the base does not mount it, the plugin fails to load and automatic memory (Stage 1 source reading) is disabled.

## Usage

Tell the agent to remember something, or do it yourself:

```text
memory_remember(content="用户偏好…", tags=["pref"])   # → long-term memory (with source sessionId)
memory_note(slug="fix-x", content="…")               # → temporary note (only when the user asks)
memory_integrate()                                    # → idempotent integrate summary/MEMORY.md
memory_precompact(content="要留的关键要点")          # → draft + durable queue before compaction
```

When context from an earlier session matters, the agent runs a **quick memory pass**: skim the injected summary → search `MEMORY.md` → open 1–2 relevant drafts → stop if no hits. `memory_recall(query="…")` is the explicit search entry.

## Configuration

The plugin exposes a schemastery config schema. Full parameter table:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `recallLimit` | int | 10 | Max entries returned by `memory_recall` |
| `summaryTokens` | int | 4000 | Token budget for the injected `memory_summary.md` |
| `maxQuickSteps` | int | 5 | Quick-memory-pass search-step budget |
| `memoryRoot` | string | `''` | Override of the memory root; empty = `<ds_home>/memories` |
| `generateMemories` | boolean | `true` | Whether a session contributes future memory (auto Stage 1); false = no auto enqueue |
| `useMemories` | boolean | `true` | Whether to give the model memory (inject + recall) |
| `maxModelAttemptsPerDay` | number | 24 | Daily Stage 1 model-attempt cap; failed attempts count |
| `extractProvider` / `extractModel` / `extractReasoningEffort` / `maxExtractTokens` | | | Stage 1 extraction LLM route / model / reasoning effort / input-token cap |
| `consolidationProvider` / `consolidationModel` / `consolidationReasoningEffort` | | | Phase 2 consolidation LLM route / model / reasoning effort |

The settings page can edit these at runtime; changes persist to `<ds_home>/dsh-memory_rollout.settings.json` and are re-applied on the next startup, taking precedence over `cordis.patch.yml`. `memoryRoot` is read-only.

## References

This plugin's memory model and LLM extraction prompt are **adapted from** the memory system of [openai/codex](https://github.com/openai/codex) (Apache License 2.0) — an independent re-implementation for DeepSeek Harness that does not redistribute its source verbatim. It was also adapted from `flymysql/dsh-memory` (MIT), the original "cross-session memory vault" it grew out of. See `NOTICE` for attribution.

## License

MIT (see `LICENSE`).
