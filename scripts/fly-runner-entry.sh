#!/usr/bin/env bash
set -euo pipefail

: "${RUN_ID:?RUN_ID required}"
SESSION_ROOT="${SESSION_ROOT:-/mnt/session}"

mkdir -p \
  "$SESSION_ROOT/repo" \
  "$SESSION_ROOT/claude-home/.claude" \
  "$SESSION_ROOT/cache/npm" \
  "$SESSION_ROOT/logs"
chown -R node:node "$SESSION_ROOT"

export SESSION_ROOT
export HOME="$SESSION_ROOT/claude-home"
export npm_config_cache="$SESSION_ROOT/cache/npm"
export TASK_ORCH_DETACHED_RUNS="${TASK_ORCH_DETACHED_RUNS:-1}"
export TASK_ORCH_INSIDE_WORKER="${TASK_ORCH_INSIDE_WORKER:-1}"

exec gosu node bash -lc 'set -o pipefail; npx tsx scripts/run-worker.ts "$RUN_ID" 2>&1 | tee -a "$SESSION_ROOT/logs/runner.log"'
