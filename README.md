# dsh-rollout

> **Project status: experimental / not yet public.** This is a **vibe-coding**
> project — it was built rapidly by an AI agent with its human collaborator,
> iterating on ideas as they came. It works well enough for the author's own
> use, but it has NOT been battle-tested, may have rough edges, and its API and
> behavior can change without notice. Issues, gaps, and bugs are fair game and
> expected at this stage. It is published to learn and to gather feedback, not
> presented as a finished, production-ready plugin.

Codex-style per-session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Inspired by the [Codex memory model](https://github.com/openai/codex) — layered, restrained, and passive. `dsh-rollout` gives each session a draft paper and the agent a persistent, well-organized memory that is written only when it makes sense.

- **One session, one draft** — each session writes `rollout_summaries/<sessionId>.md` (like a sub-`AGENTS.md`), writable by the agent on demand.
- **Layered disclosure** — `memory_summary.md` (摘要, injected into the prompt) + `MEMORY.md` (searchable registry) + `rollout_summaries/` (per-session drafts) + notes. Grep-friendly, no full-scan.
- **Restrained & passive** — the memory is written only on explicit user request; a decision boundary + quick memory pass (≤ 4-6 steps) guard when to look up memory, so it never floods the context.
- **Idempotent integration** — a fingerprint + watermark gate skips re-integration when nothing changed (no wasted tokens).
- **6 model tools** — `memory_remember` / `memory_recall` / `memory_forget` / `memory_draft` / `memory_note` / `memory_integrate`.
- **Browser management page** — a "记忆库 / Memory" page to browse summaries, registry, drafts, and notes.

## Install

```bash
dsh plugin --profile web add dsh-rollout
```

The `dsh.bundle` manifest wires the `dsh-rollout` row into the profile automatically. To install by hand instead:

```bash
pnpm add dsh-rollout
```

then add a row to your profile `cordis.yml` (or `cordis.patch.yml`):

```yaml
- id: dsh-rollout
  name: dsh-rollout
```

Requires a DSH base of `0.1.1-rc.2` or newer (`peerDependencies` list `^0.1.1-rc.2`).

## Usage

Tell the agent to remember something, or do it yourself:

> "记住：这个项目的部署目标是 Windows，测试命令是 `pnpm test`。"

The agent writes a per-session draft with `memory_draft`, or a durable fact with `memory_remember`:

```
memory_draft(content="本会话结论：…", title="xxx")   # → rollout_summaries/<sessionId>.md
memory_remember(content="用户偏好…", tags=["pref"])   # → 长期记忆（带来源 sessionId）
memory_note(slug="fix-x", content="…")               # → 临时 note（用户显式要求时）
memory_integrate()                                    # → 幂等整合 summary/MEMORY.md
```

When context from an earlier session matters, the agent runs a quick memory pass: skim the injected summary → search `MEMORY.md` → open 1-2 relevant drafts → stop if no hits. `memory_recall(query="…")` is the explicit search entry.

### Configuration

The plugin exposes a schemastery config schema. The full parameter table:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `recallLimit` | int | 10 | Max entries returned by `memory_recall` |
| `injectLimit` | int | 8 | Kept for config compatibility; this build injects only the memory summary |
| `summaryTokens` | int | 2500 | Max chars of `memory_summary.md` injected |
| `maxQuickSteps` | int | 5 | Quick memory pass search-step budget |
| `memoryRoot` | string | `''` | Optional override of the memory root; empty = `<ds_home>/memories` |
| `autoTrigger` | `'sessionEnd'` \| `'off'` | `'sessionEnd'` | Auto-trigger mode: `sessionEnd` runs the pipeline on session dispose, `off` disables it (manual tools still work) |
| `minIdleHours` | number | 6 | Idle hours before a session becomes a pipeline candidate |
| `maxDraftAgeDays` | number | 10 | Skip candidate sessions whose draft is older than this (stale pruning) |
| `maxExtractPerTrigger` | number | 2 | Max candidate sessions drafted per pipeline run |
| `maxPipelineRunsPerDay` | number | 12 | Max pipeline runs per calendar day (runaway budget) |
| `precompactAuto` | boolean | `false` | Also drain on `compaction/start` when true |
| `extractProvider` | string | `''` | Provider route for LLM extraction; empty = harness default |
| `extractModel` | string | `''` | Provider model id for extraction; empty = harness default |
| `extractReasoningEffort` | string | `'low'` | Reasoning effort for extraction (adapter vocab) |
| `maxExtractTokens` | number | 8000 | Coarse input-token cap for the transcript fed to the LLM |
| `consolidationProvider` | string | `''` | Reserved for a later consolidation pass; not wired |
| `consolidationModel` | string | `''` | Reserved for a later consolidation pass; not wired |

```yaml
- id: dsh-rollout
  name: dsh-rollout
  config:
    summaryTokens: 3000
    maxQuickSteps: 5
```

The settings page can edit these at runtime (see below). Runtime edits are persisted to
`<ds_home>/dsh-rollout.settings.json` and re-applied on the next startup, taking precedence
over `cordis.patch.yml`. `memoryRoot` and the two reserved `consolidation*` fields are
read-only. Changes you make in the settings page affect the live process immediately.

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

## Browser page

Settings → 记忆库 (Memory). Browse summaries, the registry, per-session drafts, and notes; quick-add and delete. Hosted via the harness `webServer` service (`GET/POST /dsh-rollout/entries`, `/dsh-rollout/overview`).

The page also has a **Settings** block:

- **Config form** — read/edit the plugin config at runtime (`GET/POST /dsh-rollout/config`). Each editable field shows its current value and a "≠ 默认" marker when it differs from the schema default.
- **Export** — download the whole `memories/` tree (`memory_summary.md`, `MEMORY.md`, `rollout_summaries/`, `extensions/ad_hoc/notes/`, `.watermark`, …) plus the long-term entries table as a single JSON backup (`GET /dsh-rollout/export`).
- **Import** — restore a backup file. The existing memory root is copied to `<ds_home>/memories-backup-<timestamp>` first, then the bundle is unpacked into `memories/` and the entries table is restored. Import is intentionally replace-semantics: it backs up first, then imports (`POST /dsh-rollout/import`).

## Development

The plugin is one cordis package:

- `lib/index.js` — host half: domain, tools, prompt injection, integration
- `lib/client.js` — web half: settings page

Host-half changes need a **restart of `dsh web`** (Node caches the code); client-half
can hot-reload with `pnpm run dev:web`. After editing `lib/*.js`, sync the two extra
copies (`.dsh/plugins/dsh-rollout/` and `.dsh/profiles/web/node_modules/dsh-rollout/`)
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
