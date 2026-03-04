# Aionis Clawbot Plugin - Full Usage Flow

This guide is for end users who want local-first setup with one-click style commands.

## 1. Prerequisites

- Docker running locally
- OpenClaw installed

## 2. Install plugin from npm

```bash
openclaw plugins install @aionis/openclaw
```

## 3. One-command bootstrap (recommended)

```bash
openclaw aionis-memory bootstrap
```

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
```

Expected output contains:

```json
{
  "overall_status": "pass"
}
```

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
  - Aionis replay strict/guided requires local executor policy and allowlisted command tools
  - use `--mode simulate` first to validate API path
- `500 internal_error`:
  - avoid running multiple standalone containers with the same data volume
  - keep one standalone container for one data volume
