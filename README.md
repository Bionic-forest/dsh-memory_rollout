# dsh-memory-rollout

> **Project status: experimental / not yet public.** This is a **vibe-coding**
> project — it was built rapidly by an AI agent with its human collaborator,
> iterating on ideas as they came. It works well enough for the author's own
> use, but it has NOT been battle-tested, may have rough edges, and its API and
> behavior can change without notice. Issues, gaps, and bugs are fair game and
> expected at this stage. It is published to learn and to gather feedback, not
> presented as a finished, production-ready plugin.

Codex-style per-session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Inspired by the [Codex memory model](https://github.com/openai/codex) — layered, restrained, and passive. `dsh-memory-rollout` gives each session a draft paper and the agent a persistent, well-organized memory that is written only when it makes sense.

- **One session, one draft** — each session writes `rollout_summaries/<sessionId>.md` (like a sub-`AGENTS.md`), writable by the agent on demand.
- **Layered disclosure** — `memory_summary.md` (摘要, injected into the prompt) + `MEMORY.md` (searchable registry) + `rollout_summaries/` (per-session drafts) + notes. Grep-friendly, no full-scan.
- **Restrained & passive** — the memory is written only on explicit user request; a decision boundary + quick memory pass (≤ 4-6 steps) guard when to look up memory, so it never floods the context.
- **Idempotent integration** — a fingerprint + watermark gate skips re-integration when nothing changed (no wasted tokens).
- **6 user-facing tools** — `memory_remember` / `memory_recall` / `memory_forget` / `memory_note` / `memory_integrate` / `memory_precompact`, plus two `memory__*` internal scheduler tools for operations and tests.
- **Browser management page** — a "记忆库 / Memory" page to browse summaries, registry, drafts, and notes.

## Install

```bash
dsh plugin --profile web add dsh-memory-rollout
```

The `dsh.bundle` manifest wires the `dsh-memory-rollout` row into the profile automatically. To install by hand instead:

```bash
pnpm add dsh-memory-rollout
```

then add a row to your profile `cordis.yml` (or `cordis.patch.yml`):

```yaml
- id: dsh-memory-rollout
  name: dsh-memory-rollout
```

Requires a DSH base of `0.1.1-rc.2` or newer (`peerDependencies` list `^0.1.1-rc.2`).

The plugin declares `sessionQuery` as a **required** service (provided by the DSH base). If the base does not mount it, the plugin fails to load and automatic memory (Stage 1 source reading) is disabled.

## Usage

Tell the agent to remember something, or do it yourself:

> "记住：这个项目的部署目标是 Windows，测试命令是 `pnpm test`。"

The agent writes durable facts with `memory_remember`, explicit update notes with `memory_note`, and pre-compaction checkpoints with `memory_precompact`:

```
memory_remember(content="用户偏好…", tags=["pref"])   # → 长期记忆（带来源 sessionId）
memory_note(slug="fix-x", content="…")               # → 临时 note（用户显式要求时）
memory_integrate()                                    # → 幂等整合 summary/MEMORY.md
memory_precompact(content="要留的关键要点")          # → draft + durable queue before compaction
```

When context from an earlier session matters, the agent runs a quick memory pass: skim the injected summary → search `MEMORY.md` → open 1-2 relevant drafts → stop if no hits. `memory_recall(query="…")` is the explicit search entry.

### Configuration

The plugin exposes a schemastery config schema. The full parameter table:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `recallLimit` | int | 10 | Max entries returned by `memory_recall` |
| `summaryTokens` | int | 4000 | Approximate token budget for injected `memory_summary.md` |
| `maxQuickSteps` | int | 5 | Quick memory pass search-step budget |
| `memoryRoot` | string | `''` | Optional override of the memory root; empty = `<ds_home>/memories` |
| `generateMemories` | boolean | `true` | M2: whether a session contributes future memory (auto Phase 1). false = no auto Stage 1 job on dispose (manual `memory_precompact` / `memory_remember` still work). Independent from `useMemories`. |
| `useMemories` | boolean | `true` | Whether to provide memory to the model (inject + recall). false = no inject/recall (generation can be toggled independently) |
| `maxModelAttemptsPerDay` | number | 24 | Daily Stage 1 model-attempt cap; failed attempts count |
| `extractProvider` | string | `''` | Provider route for LLM extraction; empty = harness default |
| `extractModel` | string | `''` | Provider model id for extraction; empty = harness default |
| `extractReasoningEffort` | string | `'low'` | Reasoning effort for extraction (adapter vocab) |
| `maxExtractTokens` | number | 8000 | Coarse input-token cap for the transcript fed to the LLM |
| `consolidationProvider` | string | `''` | Provider route for Phase 2 consolidation; empty = harness default |
| `consolidationModel` | string | `''` | Model id for Phase 2 consolidation; empty = harness default |
| `consolidationReasoningEffort` | string | `''` | Reasoning effort for Phase 2 consolidation; empty = model default |

```yaml
- id: dsh-memory-rollout
  name: dsh-memory-rollout
  config:
    summaryTokens: 3000
    maxQuickSteps: 5
```

The settings page can edit these at runtime (see below). Runtime edits are persisted to
`<ds_home>/dsh-memory-rollout.settings.json` and re-applied on the next startup, taking precedence
over `cordis.patch.yml`. `memoryRoot` is read-only. Changes you make in the settings
page affect the live process immediately.

## Memory layout

```
<home>/memories/
├── memory_summary.md         # injected summary (first line `v1`)
├── MEMORY.md                 # searchable registry
├── rollout_summaries/        # one draft per session (session_id / updated_at / cwd header)
│   └── <sessionId>.md
├── extensions/ad_hoc/notes/  # user-requested temporary notes
├── .watermark                # idempotency watermark
```

> A session draft (`rollout_summaries/<sessionId>.md`) is **append-only**: new content appends after the previous line ranges, which stay stable, so line-range citations remain verifiable across repeated integrations.

## Browser page

Settings → 记忆库 (Memory). Browse summaries, the registry, per-session drafts, and notes; quick-add and delete. Hosted via the harness `webServer` service (`GET/POST /dsh-memory-rollout/entries`, `/dsh-memory-rollout/overview`).

`GET /dsh-memory-rollout/overview` exposes `status.capabilities.stage1SourceRead` to show whether the current process can read session sources, useful to diagnose when automatic memory is skipped due to a missing capability.

The page also has a **Settings** block:

- **Config form** — read/edit the plugin config at runtime (`GET/POST /dsh-memory-rollout/config`). Each editable field shows its current value and a "≠ 默认" marker when it differs from the schema default.
- **Export** — download the whole `memories/` tree (`memory_summary.md`, `MEMORY.md`, `rollout_summaries/`, `extensions/ad_hoc/notes/`, `.watermark`, …) plus the long-term entries table as a single JSON backup (`GET /dsh-memory-rollout/export`).
- **Import** — restore a backup file. The existing memory root is copied to `<ds_home>/memories-backup-<timestamp>` first, then the bundle is unpacked into `memories/` and the entries table is restored. Import is intentionally replace-semantics: it backs up first, then imports (`POST /dsh-memory-rollout/import`).

## Development

The plugin is one cordis package:

- `lib/index.js` — host half: domain, tools, prompt injection, integration
- `lib/client.js` — web half: settings page

Host-half changes need a **restart of `dsh web`** (Node caches the code); client-half
can hot-reload with `pnpm run dev:web`. After editing `lib/*.js`, sync the two extra
copies (`.dsh/plugins/dsh-memory-rollout/` and `.dsh/profiles/web/node_modules/dsh-memory-rollout/`)
and confirm the three SHA-256 hashes match.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full maintainer guide — how the
memory model works, where to change common things, and how to ship a version.

## License

MIT

## Acknowledgments

This plugin's memory model and LLM extraction prompt are **inspired by, and
adapted from**, the memory system of
[openai/codex](https://github.com/openai/codex) (Apache License 2.0). It is an
independent re-implementation for DeepSeek Harness and does not redistribute
openai/codex source verbatim. See `NOTICE` for attribution. It was also adapted
from `flymysql/dsh-memory` (MIT), the original "cross-session memory vault" the
plugin grew out of.
