# Aionis OpenClaw Plugin - Full Usage Flow

This guide is for end users who want a local-first setup with simple command-line steps.

## 1. Prerequisites

- Docker running locally
- OpenClaw installed

## 2. Install plugin from npm

```bash
openclaw plugins install @aionis/openclaw-aionis-memory
```

## 3. One-command bootstrap (recommended)

```bash
openclaw aionis-memory bootstrap
```

`bootstrap` defaults to `ghcr.io/cognary/aionis:standalone-v0.2.16` (override with `AIONIS_IMAGE` if needed).

If port `3001` is occupied, set an explicit port:

```bash
openclaw aionis-memory bootstrap --port 3002
```

`bootstrap` does three things:

1. Starts local Aionis standalone
2. Generates local API key env files
3. Auto-writes plugin config into `~/.openclaw/openclaw.json`

## 4. Restart OpenClaw gateway

Restart your OpenClaw/Clawbot process so the plugin reloads with new config.

## 5. Run selfcheck

```bash
openclaw aionis-memory selfcheck --scope clawbot:selfcheck
openclaw aionis-memory replay-selfcheck --scope clawbot:selfcheck --mode simulate
openclaw aionis-memory replay-selfcheck --scope clawbot:selfcheck --mode strict --backend local_process
openclaw aionis-memory replay-selfcheck --scope clawbot:selfcheck --mode guided --backend sandbox_sync --project-id clawbot-demo
```

Expected output contains:

```json
{
  "overall_status": "pass"
}
```

For strict/guided modes, also check `replay_status` in output to confirm execution replay result.
For v0.2.16+, replay selfcheck output may include `compile_usage_*` and `replay_usage_total_tokens` fields.
`compile_usage_*` is an estimate channel from Aionis compile telemetry (`estimated_char_based_v1`), not provider billing tokens.

`replay-selfcheck` validates:

1. replay run start
2. step before/after recording
3. run end
4. playbook compile from run
5. playbook run (simulate/strict/guided)

## 6. Start using in normal chat

With `autoRecall=true`, `autoCapture=true`, and `autoPolicyFeedback=true`, normal chat flow will automatically:

- recall memory before turn
- capture memory after successful turn
- write policy feedback after successful turn

Default scope mode can be:

- `project`: `scopePrefix + workspace-hash` (recommended for vibe coding)
- `session`: `scopePrefix + sessionKey`
- `fixed`: one static scope

## Troubleshooting

- `apiKey missing`:
  - rerun `openclaw aionis-memory bootstrap`
- `404 Route ... not found`:
  - check `baseUrl` and Aionis version
- `replay-selfcheck` fails on strict/guided:
  - Aionis replay strict/guided requires `allow_local_exec=true` and allowlisted command tools
  - `replay-selfcheck` auto-enables `allow_local_exec=true` for strict/guided modes
  - for sandbox backends, set `--project-id` and make sure sandbox budget/policy exists in Aionis
  - use `--mode simulate` first to validate API path
- `500 internal_error`:
  - avoid running multiple standalone containers with the same data volume
  - keep one standalone container for one data volume
