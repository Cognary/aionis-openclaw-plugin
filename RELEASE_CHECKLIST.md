# Release Checklist

## 1. Preflight

```bash
./scripts/release-preflight.sh
```

Expected: `release preflight passed`

## 2. Build release tarball

```bash
./scripts/build-tgz.sh
```

Expected artifact path:

- `artifacts/aionis-openclaw-<version>.tgz`

## 3. Local install test (OpenClaw)

```bash
openclaw plugins install ./artifacts/aionis-openclaw-<version>.tgz
openclaw plugins info openclaw-aionis-memory
```

## 4. Configure plugin (recommended: bootstrap command)

```bash
openclaw aionis-memory bootstrap
```

Optional but recommended replay path check:

```bash
openclaw aionis-memory replay-selfcheck --scope clawbot:release-check --mode simulate
openclaw aionis-memory replay-selfcheck --scope clawbot:release-check --mode strict --backend local_process
openclaw aionis-memory replay-selfcheck --scope clawbot:release-check --mode guided --backend sandbox_sync --project-id clawbot-release
```

If you still need manual JSON, use:

```json
{
  "plugins": {
    "entries": {
      "openclaw-aionis-memory": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:3001",
          "apiKey": "<AIONIS_API_KEY>",
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

## 5. Publish to npm

```bash
# Choose one versioning strategy:
# - exact version: npm version <x.y.z> --no-git-tag-version
# - semver bump:   npm version patch|minor|major --no-git-tag-version
npm publish --access public
```

Install command after publish:

```bash
openclaw plugins install @aionis/openclaw-aionis-memory
```
