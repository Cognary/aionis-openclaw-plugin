#!/usr/bin/env bash
set -euo pipefail

echo "[1/4] install deps"
npm ci

echo "[2/4] typecheck"
npm run -s typecheck

echo "[3/4] build"
npm run -s build

echo "[4/4] npm pack dry-run"
npm pack --dry-run >/dev/null

echo "release preflight passed"
