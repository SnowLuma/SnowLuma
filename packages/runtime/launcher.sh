#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Prefer bundled node when present; fall back to $PATH.
if [[ -x "./node" ]]; then
  NODE_BIN="./node"
else
  NODE_BIN="$(command -v node || true)"
  if [[ -z "$NODE_BIN" ]]; then
    echo "error: 'node' not found on PATH and no bundled ./node; install Node.js 22.13+ (Node 23 requires 23.4+)." >&2
    exit 127
  fi
fi

"$NODE_BIN" ./check-node-version.cjs
exec "$NODE_BIN" ./index.mjs "$@"
