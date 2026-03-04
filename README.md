# OpenClaw Aionis Memory Plugin

Independent OpenClaw memory plugin that uses Aionis as the memory and policy backend.

This project is intentionally separate from the Aionis core repository so it can evolve independently.

## What it does

- Auto-recall on `before_agent_start` via `POST /v1/memory/context/assemble`
- Auto-capture on `agent_end` via `POST /v1/memory/write`
- Auto policy feedback on successful turns via `POST /v1/memory/tools/feedback`
- Policy loop calls:
  - `POST /v1/memory/tools/select`
  - `POST /v1/memory/tools/feedback`
- Manual tools available in agent runtime:
  - `aionis_memory_search`
  - `aionis_memory_store`
  - `aionis_memory_context`
  - `aionis_policy_select`
  - `aionis_policy_feedback`

## 10-second mem0 comparison

- `mem0`: auto recall/capture (conversation memory)
- `aionis`: auto recall/capture + layered context + policy loop
- `aionis`: local auditable chain (`commit_id` / `decision_id`)

## 30-second setup

```bash
openclaw plugins install openclaw-aionis-memory && \
openclaw aionis-memory bootstrap && \
openclaw aionis-memory selfcheck --scope clawbot:selfcheck
```

## Quick start (local standalone)

1. Start local Aionis standalone:

```bash
./bootstrap-local-standalone.sh
```

If `3001` is occupied, the script auto-falls back to `3002-3010`.
You can also force a port manually:

```bash
AIONIS_PORT=3002 ./bootstrap-local-standalone.sh
```

Optional: set a dedicated Docker volume name (recommended when running multiple standalone containers):

```bash
AIONIS_DATA_VOLUME=aionis-local-data ./bootstrap-local-standalone.sh
```

This script writes the generated API key to:

- `~/.openclaw/plugins/aionis/aionis.env`
- `~/.openclaw/plugins/aionis/clawbot.env`

2. Build plugin:

```bash
npm install
npm run build
```

3. Install into OpenClaw from local path:

```bash
openclaw plugins install /Users/lucio/Desktop/aionis-openclaw-plugin
```

Or install from a packaged tarball:

```bash
npm run -s release:tgz
openclaw plugins install ./artifacts/openclaw-aionis-memory-0.1.0.tgz
```

4. Configure plugin automatically (no manual JSON editing):

```bash
openclaw aionis-memory bootstrap
```

If `3001` is occupied:

```bash
openclaw aionis-memory bootstrap --port 3002
```

Manual JSON equivalent:

```json
{
  "plugins": {
    "entries": {
      "openclaw-aionis-memory": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:3001",
          "apiKey": "<your-memory-api-key>",
          "tenantId": "default",
          "scopeMode": "project",
          "scopePrefix": "clawbot",
          "preset": "compact",
          "autoRecall": true,
          "autoCapture": true,
          "autoPolicyFeedback": true
        }
      }
    }
  }
}
```

## Config keys

- `baseUrl`: Aionis API base URL
- `apiKey`: API key sent as `x-api-key`
- `tenantId`: tenant id
- `scope`: default scope
- `scopeMode`: `fixed`, `session`, or `project`
- `scopePrefix`: prefix used for session/project derived scopes
- `preset`: `compact` (default), `policy-first`, or `custom`
- `autoRecall`: inject memory context before each turn
- `autoCapture`: store dialogue summary after successful turn
- `autoPolicyFeedback`: write `tools/feedback` after successful turn and emit policy update logs
- `includeShadow`: include shadow rules in policy calls
- `strictTools`: strict mode for `tools/select`
- `recallLimit`: default limit for recall/context
- `captureMessageLimit`: max recent messages captured
- `contextCharBudget`: clip injected context size
- `debug`: verbose plugin logs

## Presets

- `compact` (default): lower token budget, lower recall fan-out.
- `policy-first`: larger context and stricter routing defaults for tool stability.
- `custom`: disable preset defaults and use explicit numeric settings.

## Notes

- This plugin targets Aionis endpoints with `/v1/memory/*` paths.
- If you see `404 Route ... not found`, check `baseUrl` and Aionis version.
- If you see `400 invalid_request`, verify payload shape and required fields.
- On auto feedback, logs include:
  - `policy switch reduced` or `policy switch detected`
  - `rule confidence updated (updated_rules=...)`

## Release flow

```bash
npm run -s release:preflight
npm run -s release:tgz
```

Full checklist: `RELEASE_CHECKLIST.md`

User-facing full setup flow: `USAGE_FULL.md`
