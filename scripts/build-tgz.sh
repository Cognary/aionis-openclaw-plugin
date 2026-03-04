#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/release-preflight.sh

mkdir -p artifacts
TGZ_NAME="$(npm pack | tail -n 1)"
mv -f "$TGZ_NAME" "artifacts/$TGZ_NAME"

echo "Built: artifacts/$TGZ_NAME"
