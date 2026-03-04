# OpenClaw Aionis Memory Plugin

[![npm version](https://img.shields.io/npm/v/%40aionis%2Fopenclaw.svg)](https://www.npmjs.com/package/@aionis/openclaw)
[![npm downloads](https://img.shields.io/npm/dm/%40aionis%2Fopenclaw.svg)](https://www.npmjs.com/package/@aionis/openclaw)
[![GitHub release](https://img.shields.io/github/v/release/Cognary/aionis-openclaw-plugin)](https://github.com/Cognary/aionis-openclaw-plugin/releases)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://github.com/Cognary/aionis-openclaw-plugin/blob/main/LICENSE)

Most agent memory plugins only store chat history.

Aionis goes further.

It turns memory into an execution loop:

`Memory -> Policy -> Action -> Replay`

Your agent does not just remember.
It learns how to act better over time.

Aionis is production memory infrastructure for agents.

This plugin brings Aionis into OpenClaw/Clawbot and turns memory into an executable loop:

`Memory -> Policy -> Action -> Replay`

## Why Aionis

Most memory stacks stop at retrieval. Production teams still need:

- auditable and replayable writes
- reliable write paths decoupled from embedding availability
- policy loops that can influence runtime behavior
- operational guardrails for long-running systems

Aionis is designed as a long-running memory kernel to address those requirements.

## Core strengths

1. Verifiable write chain
- Every write can be traced with `commit_id` and `commit_uri`.

2. URI-first object model
- Nodes, edges, commits, and decisions are referenceable via stable URIs across API/SDK/Ops.

3. Layered context orchestration
- Context is assembled in explicit layers: `facts / episodes / rules / decisions / tools / citations`, with budget controls.

4. Memory to policy loop
- Memory can affect routing and execution using `tools/select` and `tools/feedback`.

5. Production evidence and gates
- Readiness is validated through reproducible checks, runbooks, and benchmark artifacts.

6. Sandbox interfaces (experimental in Aionis core)
- Controlled sandbox APIs can be linked to policy/replay lineage.

## What this plugin does

- Auto recall on `before_agent_start` with `POST /v1/memory/context/assemble`
- Auto capture on `agent_end` with `POST /v1/memory/write`
- Auto policy feedback on successful turns with `POST /v1/memory/tools/feedback`
- Exposes policy actions: `POST /v1/memory/tools/select`, `POST /v1/memory/tools/feedback`
- Exposes replay actions:
  - record: `POST /v1/memory/replay/run/start`, `step/before`, `step/after`, `run/end`
  - query/compile: `POST /v1/memory/replay/runs/get`, `playbooks/compile_from_run`, `playbooks/get`
  - lifecycle/run: `POST /v1/memory/replay/playbooks/promote`, `playbooks/repair`, `playbooks/repair/review`, `playbooks/run`
- Manual tools:
  - memory/policy: `aionis_memory_search`, `aionis_memory_store`, `aionis_memory_context`, `aionis_policy_select`, `aionis_policy_feedback`
  - replay: `aionis_replay_run_start`, `aionis_replay_step_before`, `aionis_replay_step_after`, `aionis_replay_run_end`, `aionis_replay_run_get`, `aionis_replay_playbook_compile`, `aionis_replay_playbook_get`, `aionis_replay_playbook_promote`, `aionis_replay_playbook_repair`, `aionis_replay_playbook_repair_review`, `aionis_replay_playbook_run`

## 30-second setup

```bash
openclaw plugins install @aionis/openclaw && \
openclaw aionis-memory bootstrap && \
openclaw aionis-memory selfcheck --scope clawbot:selfcheck
```

Replay path selfcheck:

```bash
openclaw aionis-memory replay-selfcheck --scope clawbot:selfcheck --mode simulate
```

## Project isolation in Clawbot

This plugin isolates memory by `tenant_id + scope`.

Default mode is `scopeMode=project`:

- It derives workspace path from OpenClaw context (`workspace/cwd`).
- It generates project scope as: `scopePrefix + ":" + basename(workspacePath) + "-" + sha1(workspacePath)[0:8]`.
- All write/recall/policy calls use that scope, so different projects do not mix memories.

Other modes:

- `fixed`: one global scope
- `session`: one scope per session
- `project`: one scope per workspace/repo (recommended)

## Security and contract

- Tenant isolation: `tenant_id + scope`
- Memory auth: API key and bearer-token modes in Aionis core
- Admin interface: separate token channel in Aionis core
- Public API contracts: stable `/v1/memory/*` shapes documented in Aionis docs

## Quick start (local standalone)

1. Start local Aionis standalone:

```bash
./bootstrap-local-standalone.sh
```

If `3001` is occupied, the script auto-falls back to `3002-3010`.
You can also force a port:

```bash
AIONIS_PORT=3002 ./bootstrap-local-standalone.sh
```

This script writes:

- `~/.openclaw/plugins/aionis/aionis.env`
- `~/.openclaw/plugins/aionis/clawbot.env`

2. Install plugin (from npm):

```bash
openclaw plugins install @aionis/openclaw
```

3. Bootstrap plugin config automatically:

```bash
openclaw aionis-memory bootstrap
```

4. Verify end-to-end path:

```bash
openclaw aionis-memory selfcheck --scope clawbot:selfcheck
openclaw aionis-memory replay-selfcheck --scope clawbot:selfcheck --mode simulate
```

## Configuration

- `baseUrl`: Aionis API base URL
- `apiKey`: API key (`x-api-key`)
- `tenantId`: tenant id
- `scope`: default fallback scope
- `scopeMode`: `fixed`, `session`, `project`
- `scopePrefix`: prefix for derived scopes
- `preset`: `compact` (default), `policy-first`, `custom`
- `autoRecall`: inject memory context before each turn
- `autoCapture`: persist dialogue summary after successful turn
- `autoPolicyFeedback`: write `tools/feedback` after successful turn
- `includeShadow`: include shadow rules in policy calls
- `strictTools`: strict mode for `tools/select`
- `recallLimit`: recall/context limit
- `captureMessageLimit`: max recent messages captured
- `contextCharBudget`: max injected context size
- `debug`: verbose logs

## Presets

- `compact` (default): lower token budget and lower recall fan-out
- `policy-first`: larger context and stricter routing defaults
- `custom`: disable preset defaults and use explicit values

## Troubleshooting

- `404 Route ... not found`: verify Aionis version and `baseUrl`
- `400 invalid_request`: verify payload and required fields
- Policy feedback logs include: `policy switch reduced` or `policy switch detected`, and `rule confidence updated (updated_rules=...)`

## License

Apache License 2.0. See [LICENSE](./LICENSE).

## Release

```bash
npm run -s release:preflight
npm run -s release:tgz
```

Reference:

- [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md)
- [USAGE_FULL.md](./USAGE_FULL.md)
