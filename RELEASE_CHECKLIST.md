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

- `artifacts/openclaw-aionis-memory-<version>.tgz`

## 3. Local install test (OpenClaw)

```bash
openclaw plugins install ./artifacts/openclaw-aionis-memory-<version>.tgz
openclaw plugins info openclaw-aionis-memory
```

## 4. Configure plugin (recommended: bootstrap command)

```bash
openclaw aionis-memory bootstrap
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
npm version patch
npm publish --access public
```

Install command after publish:

```bash
openclaw plugins install openclaw-aionis-memory
```
