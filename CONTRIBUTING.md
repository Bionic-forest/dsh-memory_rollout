# Contributing to dsh-memory_rollout

Thanks for wanting to help maintain or extend dsh-memory_rollout. This guide walks a new
maintainer (or a fork) through the whole thing so you can pick it up confidently.

## What this plugin is (30-second overview)

`dsh-memory_rollout` is a DeepSeek Harness plugin that gives each session a **memory
draft paper** and the agent a **persistent, layered memory**, inspired by the
Codex memory model. Two halves, one package:

- **Host half** (`lib/index.js`) — the server side: the `dsh_rollout` storage
  domain, the model tools (`memory_remember/recall/forget/draft/note/integrate/
  precompact`), the LLM extraction pipeline, the integration pass, and the HTTP
  routes for the settings page.
- **Client half** (`lib/client.js`) — the web side: the "记忆库 / Memory" page in
  Settings, with entry list, config editor, and import/export.

## Repo layout

```
dsh-memory_rollout/
├── package.json          # manifest + dsh.bundle (npm package = cordis bundle)
├── cordis.patch.yml      # the config layer applied when a profile lists this bundle
├── lib/
│   ├── index.js          # host half (all the logic)
│   └── client.js         # web half (settings page)
├── LICENSE               # MIT
├── NOTICE                # attribution (Codex Apache-2.0 + dsh-memory MIT)
├── README.md             # docs (zh, default)
├── README.en.md          # docs (en)
└── CONTRIBUTING.md       # this file
```

## How the memory model works (mental model)

Layered disclosure, general → specific:

```
<home>/memories/
├── memory_summary.md         # 总纲 (injected into prompt; first line `v1`)
├── MEMORY.md                 # searchable registry (by task group)
├── rollout_summaries/<sessionId>.md   # ONE DRAFT PER SESSION
├── extensions/ad_hoc/notes/  # user-requested temporary notes
└── .watermark                # idempotency watermark (no-op when unchanged)
```

Key invariants to preserve when you edit:

- **One session, one draft**: `rollout_summaries/<sessionId>.md` is keyed by
  session id, never re-keyed.
- **Restrained & passive**: memory is written only on explicit user request or an
  automatic trigger (session end / precompact), never passively on every turn.
- **Idempotent integration**: `integrate()` uses a fingerprint + watermark; if
  nothing changed it's a no-op (no wasted tokens).
- **克制的 LLM**: the extraction step calls `ctx.llm` only for durable Stage 1
  jobs and is throttled by `maxModelAttemptsPerDay`; failures retry through the
  persistent queue and never write a dirty literal snapshot as memory.

## How to run / test locally

This is a cordis bundle. To develop against your checkout:

```bash
# install into a profile (uses the checked-out code via file: link)
dsh plugin --profile web add ./dsh-memory_rollout
# or, to boot with a patch overlay without installing:
dsh web --patch ./path/to/cordis.patch.yml
```

Host-half changes need a **restart of `dsh web`** (Node caches the code).
Client-half changes can be hot-reloaded if you run `pnpm run dev:web`.

After a change, verify the three copies stay in sync (this repo is used via a
`file:` link, so the loaded copy lives in the profile, not here):

```bash
node --check lib/index.js && node --check lib/client.js
```

Then confirm the SHA of the three synced copies match (see the sync note below).

## Common edits you'll make (and where)

| What you want to change | Where |
| --- | --- |
| Add/adjust a model tool | `lib/index.js` — `defineTool({...})` + register in `apply` |
| Add an adjustable config field | `lib/index.js` — add to the `Config` schema + `CONFIG_FIELDS` (for the settings page) |
| Change the injected memory guidance | `lib/index.js` — `ctx.systemPrompt.section` (decision boundary / quick pass) |
| Change the extraction prompt | `lib/index.js` — `EXTRACT_SYSTEM_PROMPT` |
| Change memory layout / files | `lib/index.js` — `ensureLayout` / `dirs()` / `writeSessionDraft` |
| Tune the automatic pipeline | `lib/index.js` — `enqueueStage1JobIntoTable` / `drainStage1Jobs` / `phase2Integrate` + the `Config` throttle fields |
| Change the settings page UI | `lib/client.js` |

## Sync note (IMPORTANT)

This project is installed into a profile as a `file:../../plugins/dsh-memory_rollout`
dependency, so there are **two extra copies** that mirror `plugins/dsh-memory_rollout`:

- `.dsh/plugins/dsh-memory_rollout/` (the profile's plugin source root)
- `.dsh/profiles/web/node_modules/dsh-memory_rollout/` (the installed copy)

When you change `lib/*.js`, copy it to **both** of those so the running profile
picks it up, and confirm the three SHA-256 hashes match.

## How to ship a change

1. Edit the code (see table above).
2. Bump `version` in `package.json` (semver — patch for a fix, minor for a feature,
   major for a breaking change).
3. Sync the three copies.
4. Run `node --check` on `lib/index.js` and `lib/client.js`.
5. Update `README.md` / `README.en.md` if the behavior or config changed.
6. Add a line to `CHANGELOG-插件变更.md`.
7. Test the actual behavior (restart `dsh web`, trigger a session end, confirm the
   draft is written).

## License & attribution

- This plugin is MIT.
- Its memory model and extraction prompt are **inspired by / adapted from**
  `openai/codex` (Apache-2.0) — see `NOTICE`. Preserve `NOTICE` and the
  Acknowledgments in `README`. Do not remove attribution.
- It was also adapted from `flymysql/dsh-memory` (MIT).

If you fork, keep `NOTICE` (with your project name) and the Acknowledgments, and
adjust the copyright line to your name/org.
