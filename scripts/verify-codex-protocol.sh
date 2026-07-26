#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
protocol_tmp_dir=$(mktemp -d /tmp/codexplatform-protocol-verify.XXXXXX)

cleanup() {
  rm -rf "$protocol_tmp_dir"
}
trap cleanup EXIT

cd "$repo_root"
pnpm exec codex app-server generate-ts --out "$protocol_tmp_dir" --experimental
diff -qr apps/api/src/infra/codex/generated "$protocol_tmp_dir"
