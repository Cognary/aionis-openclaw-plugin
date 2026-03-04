#!/usr/bin/env bash
set -euo pipefail

IMAGE="${AIONIS_IMAGE:-ghcr.io/cognary/aionis:standalone-v0.2.5}"
CONTAINER_NAME="${AIONIS_CONTAINER_NAME:-aionis-local}"
PORT="${AIONIS_PORT:-3001}"
ENV_DIR="${AIONIS_ENV_DIR:-$HOME/.openclaw/plugins/aionis}"
AIONIS_ENV_FILE="${AIONIS_ENV_FILE:-$ENV_DIR/aionis.env}"
CLAWBOT_ENV_FILE="${CLAWBOT_ENV_FILE:-$ENV_DIR/clawbot.env}"
DEFAULT_VOLUME_NAME="$(echo "${CONTAINER_NAME}" | tr -c 'a-zA-Z0-9_.-' '-')-data"
DATA_VOLUME="${AIONIS_DATA_VOLUME:-$DEFAULT_VOLUME_NAME}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing command: $1" >&2
    exit 1
  }
}

need_cmd docker
need_cmd openssl
need_cmd curl
need_cmd lsof

mkdir -p "$ENV_DIR"

if [[ ! -f "$AIONIS_ENV_FILE" ]]; then
  API_KEY="$(openssl rand -base64 36 | tr -d '\n' | tr '/+' '_-' | cut -c1-48)"
  ADMIN_TOKEN="$(openssl rand -base64 48 | tr -d '\n' | tr '/+' '_-' | cut -c1-64)"
  cat > "$AIONIS_ENV_FILE" <<EOT
NODE_ENV=production
APP_ENV=prod
AIONIS_MODE=service
PORT=3001
TRUST_PROXY=false
MEMORY_AUTH_MODE=api_key
MEMORY_API_KEYS_JSON={"$API_KEY":{"tenant_id":"default","agent_id":"clawbot"}}
ADMIN_TOKEN=$ADMIN_TOKEN
CORS_ALLOW_ORIGINS=
CORS_ADMIN_ALLOW_ORIGINS=
EMBEDDING_PROVIDER=fake
EOT
  chmod 600 "$AIONIS_ENV_FILE"
  echo "Created $AIONIS_ENV_FILE"
fi

API_KEY_CURRENT="$(grep '^MEMORY_API_KEYS_JSON=' "$AIONIS_ENV_FILE" | sed -E 's/^MEMORY_API_KEYS_JSON=\{"([^"]+)".*/\1/' || true)"
if [[ -z "$API_KEY_CURRENT" ]]; then
  echo "failed to parse MEMORY_API_KEYS_JSON in $AIONIS_ENV_FILE" >&2
  exit 1
fi

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if [[ -n "${AIONIS_PORT:-}" ]]; then
    echo "Port 127.0.0.1:${PORT} is already in use. Stop the conflicting service or choose another AIONIS_PORT." >&2
    exit 1
  fi
  FOUND=""
  for candidate in 3002 3003 3004 3005 3006 3007 3008 3009 3010; do
    if ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
      FOUND="$candidate"
      break
    fi
  done
  if [[ -z "$FOUND" ]]; then
    echo "Port 127.0.0.1:${PORT} is in use and no fallback port in 3002-3010 is available." >&2
    exit 1
  fi
  echo "Port 127.0.0.1:${PORT} is busy. Auto-switching to 127.0.0.1:${FOUND}."
  PORT="$FOUND"
fi

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "127.0.0.1:${PORT}:3001" \
  --env-file "$AIONIS_ENV_FILE" \
  -v "${DATA_VOLUME}:/var/lib/postgresql/data" \
  "$IMAGE" >/dev/null

echo "Waiting for health endpoint..."
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null

cat > "$CLAWBOT_ENV_FILE" <<EOT
AIONIS_BASE_URL=http://127.0.0.1:${PORT}
AIONIS_API_KEY=${API_KEY_CURRENT}
AIONIS_TENANT_ID=default
AIONIS_SCOPE_PREFIX=clawbot
EOT
chmod 600 "$CLAWBOT_ENV_FILE"

echo
 echo "Aionis standalone is running: http://127.0.0.1:${PORT}"
echo "Aionis env file: $AIONIS_ENV_FILE"
echo "Clawbot env file: $CLAWBOT_ENV_FILE"
echo "Data volume: ${DATA_VOLUME}"
 echo
 echo "Plugin config snippet (openclaw.json):"
 cat <<JSON
{
  "plugins": {
    "entries": {
      "openclaw-aionis-memory": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:${PORT}",
          "apiKey": "${API_KEY_CURRENT}",
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
JSON
