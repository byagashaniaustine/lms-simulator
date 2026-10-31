#!/usr/bin/env bash
# Convenience launcher. Kills any stale instance on the configured port and
# starts the sim with its .env loaded.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${SIM_PORT:-8010}"
PID="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
if [[ -n "$PID" ]]; then
  echo "Killing stale sim on :$PORT (pid $PID)"
  kill "$PID" || true
  sleep 0.5
fi

exec deno run \
  --allow-net \
  --allow-read \
  --allow-env \
  --env-file=.env \
  server.ts
