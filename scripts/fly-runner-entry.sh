#!/usr/bin/env bash
set -euo pipefail

: "${RUN_ID:?RUN_ID required}"
SESSION_ROOT="${SESSION_ROOT:-/mnt/session}"

mkdir -p \
  "$SESSION_ROOT/repo" \
  "$SESSION_ROOT/claude-home/.claude" \
  "$SESSION_ROOT/cache/npm" \
  "$SESSION_ROOT/logs"

# First-boot-only chown. On a resumed / cold-recovered volume with a full
# checkout the recursive chown is O(files) and wasted — everything under
# $SESSION_ROOT was created as node. Gate it on a marker so we pay it once.
if [ ! -e "$SESSION_ROOT/.fly-runner-initialized" ]; then
  chown -R node:node "$SESSION_ROOT"
  touch "$SESSION_ROOT/.fly-runner-initialized"
  chown node:node "$SESSION_ROOT/.fly-runner-initialized"
fi

# Seed shared agent config onto a fresh volume only. If /opt/claude-seed has any
# entries and the volume's claude-home/.claude is still empty, copy it in; a
# populated volume is never overwritten.
if [ -n "$(ls -A /opt/claude-seed 2>/dev/null || true)" ] \
   && [ -z "$(ls -A "$SESSION_ROOT/claude-home/.claude" 2>/dev/null || true)" ]; then
  cp -a /opt/claude-seed/. "$SESSION_ROOT/claude-home/.claude/"
  chown -R node:node "$SESSION_ROOT/claude-home/.claude"
fi

export SESSION_ROOT
export HOME="$SESSION_ROOT/claude-home"
export npm_config_cache="$SESSION_ROOT/cache/npm"
export TASK_ORCH_DETACHED_RUNS="${TASK_ORCH_DETACHED_RUNS:-1}"
export TASK_ORCH_INSIDE_WORKER="${TASK_ORCH_INSIDE_WORKER:-1}"

# Run the pre-bundled worker via plain node (no tsx transpile at boot). Fall back
# to the tsx path if the bundle is somehow absent (rollout safety for an old
# image-layer combination).
if [ -f /app/dist/run-worker.js ]; then
  exec gosu node bash -lc 'set -o pipefail; node dist/run-worker.js "$RUN_ID" 2>&1 | tee -a "$SESSION_ROOT/logs/runner.log"'
else
  exec gosu node bash -lc 'set -o pipefail; npx tsx scripts/run-worker.ts "$RUN_ID" 2>&1 | tee -a "$SESSION_ROOT/logs/runner.log"'
fi
