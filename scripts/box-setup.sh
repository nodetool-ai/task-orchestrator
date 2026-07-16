#!/usr/bin/env bash
#
# scripts/box-setup.sh — provision an ascii.dev Box running the task-orchestrator
# worker over the WebSocket channel, for end-to-end testing with a REAL Claude
# agent. This is the manual/dev counterpart to the production Box provider
# (lib/runner/box.ts): it does what a Box template + dispatch would do, but from
# your workstation and against a throwaway Box.
#
# What it does:
#   1. Create (or reuse) a Box.
#   2. Ship the worker source (current working tree via `git ls-files`, so local
#      uncommitted fixes are included) and run `npm ci` (Linux-native modules).
#   3. Install Node 22 (the repo's .nvmrc) inside the Box.
#   4. Copy YOUR Claude credentials into the Box's ~/.claude/.credentials.json so
#      the in-Box `claude` CLI (which the worker's agent backend spawns) is
#      authenticated. Reads the macOS keychain; the token never prints.
#   5. Launch the worker bound to tcp:0.0.0.0:8787 with a fresh channel identity.
#   6. Expose 8787 with `host` and print the WSS dial URL + credential + instance.
#
# Then drive a real agent turn with scripts/box-drive.mjs (printed at the end),
# or pass --goal "…" to drive one immediately.
#
# NOTE: step 4 moves a live credential to an external host. Claude Code's auto
# mode blocks an agent from doing this; run this script yourself in a normal
# shell. Alternatively skip --copy-creds and `claude login` inside the Box.
#
# Usage:
#   scripts/box-setup.sh [--box <id>] [--goal "<goal>"] [--no-copy-creds]
#
set -euo pipefail

BOX_BIN="${BOX_BIN:-$HOME/.ascii/bin/box}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION="v22.22.1"
RUN_ID="${RUN_ID:-$(( (RANDOM % 900000) + 100000 ))}"
BOX_ID=""
GOAL=""
COPY_CREDS=1

while [ $# -gt 0 ]; do
  case "$1" in
    --box) BOX_ID="$2"; shift 2 ;;
    --goal) GOAL="$2"; shift 2 ;;
    --no-copy-creds) COPY_CREDS=0; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;36m[box-setup]\033[0m %s\n' "$*"; }
box() { "$BOX_BIN" "$@"; }

# 1. Create or reuse the Box ────────────────────────────────────────────────
if [ -z "$BOX_ID" ]; then
  log "creating a new Box…"
  BOX_ID="$(box new --no-auto-stop --json 2>/dev/null | python3 -c 'import json,sys; print([json.loads(l)["id"] for l in sys.stdin if l.strip() and "id" in json.loads(l)][-1])')"
fi
log "Box: $BOX_ID"

# 2. Ship worker source + npm ci ────────────────────────────────────────────
log "shipping worker source (working tree)…"
SRC_TGZ="$(mktemp -t box-src.XXXXXX).tgz"
( cd "$REPO_ROOT" && { git ls-files; echo package-lock.json; } | sort -u | tar czf "$SRC_TGZ" -T - 2>/dev/null )
box scp "$SRC_TGZ" "$BOX_ID:/home/user/src.tgz" >/dev/null
box ssh "$BOX_ID" 'rm -rf /home/user/task-orchestrator && mkdir -p /home/user/task-orchestrator && tar xzf /home/user/src.tgz -C /home/user/task-orchestrator 2>/dev/null && echo ok' >/dev/null
rm -f "$SRC_TGZ"

# 3. Node 22 (idempotent) ───────────────────────────────────────────────────
log "ensuring Node $NODE_VERSION…"
box ssh "$BOX_ID" "
  set -e
  if [ ! -x /home/user/node22/bin/node ]; then
    cd /home/user
    ARCH=\$(uname -m); case \$ARCH in x86_64) N=x64;; aarch64) N=arm64;; esac
    F=node-$NODE_VERSION-linux-\$N
    curl -fsSL \"https://nodejs.org/dist/$NODE_VERSION/\$F.tar.xz\" -o node22.tar.xz
    tar xf node22.tar.xz && ln -sfn /home/user/\$F /home/user/node22
  fi
  /home/user/node22/bin/node -v
" >/dev/null

log "npm ci (Linux-native modules)…"
box ssh "$BOX_ID" 'cd /home/user/task-orchestrator && PATH=/home/user/node22/bin:$PATH npm ci --no-audit --no-fund >/dev/null 2>&1 && echo ok' >/dev/null

# 4. Copy Claude credentials ────────────────────────────────────────────────
if [ "$COPY_CREDS" = 1 ]; then
  log "copying Claude credentials into the Box's ~/.claude…"
  CRED_TMP="$(mktemp -t box-creds.XXXXXX)"
  # Extract just the claudeAiOauth block (Linux Claude Code reads .credentials.json).
  security find-generic-password -s "Claude Code-credentials" -w \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); json.dump({"claudeAiOauth": d["claudeAiOauth"]}, open(sys.argv[1], "w"))' "$CRED_TMP"
  box ssh "$BOX_ID" 'mkdir -p /home/user/.claude && chmod 700 /home/user/.claude; [ -f /home/user/.claude.json ] || echo "{}" > /home/user/.claude.json'
  box scp "$CRED_TMP" "$BOX_ID:/home/user/.claude/.credentials.json" >/dev/null
  box ssh "$BOX_ID" 'chmod 600 /home/user/.claude/.credentials.json && echo ok' >/dev/null
  rm -f "$CRED_TMP"
else
  log "skipping credential copy (--no-copy-creds); run 'claude login' inside the Box"
fi

# 5. Launch the worker as a systemd service ─────────────────────────────────
# A hand-started background process over `box ssh` does NOT survive the session
# (per docs.ascii.dev/box/long-running); a systemd service does, and its unit
# lives under /etc which is snapshotted, so a resumed/forked Box restarts it
# automatically — matching how a real Box worker should run.
INSTANCE="wi_$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
CRED="boxe2e.$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')"
SESSION_ROOT="/home/user/.task-orchestrator/session-$INSTANCE"
log "installing worker systemd service (runId=$RUN_ID instance=$INSTANCE)…"
UNIT="$(mktemp -t box-unit.XXXXXX)"
cat > "$UNIT" <<EOF
[Unit]
Description=task-orchestrator worker channel
After=network.target

[Service]
User=user
WorkingDirectory=/home/user/task-orchestrator
Environment=PATH=/home/user/node22/bin:/usr/local/bin:/usr/bin:/bin
Environment=TASK_ORCH_INSIDE_WORKER=1
Environment=TASK_ORCH_DETACHED_RUNS=1
Environment=TASK_ORCH_AGENT_BACKEND=claude
Environment=TASK_ORCH_WORKER_INSTANCE_ID=$INSTANCE
Environment=TASK_ORCH_WORKER_CHANNEL_CREDENTIAL=$CRED
Environment=TASK_ORCH_WORKER_CHANNEL_ENDPOINT=tcp:0.0.0.0:8787
Environment=SESSION_ROOT=$SESSION_ROOT
ExecStartPre=/bin/mkdir -p $SESSION_ROOT
ExecStart=/home/user/task-orchestrator/node_modules/.bin/tsx scripts/run-worker.ts $RUN_ID
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
box scp "$UNIT" "$BOX_ID:/home/user/task-orch-worker.service" >/dev/null
rm -f "$UNIT"
box ssh "$BOX_ID" '
  sudo mv /home/user/task-orch-worker.service /etc/systemd/system/task-orch-worker.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now task-orch-worker >/dev/null 2>&1
  echo enabled
' >/dev/null 2>&1 || true

# Wait for the listener.
for i in $(seq 1 30); do
  if box ssh "$BOX_ID" 'ss -ltn 2>/dev/null | grep -q ":8787 " && echo up' 2>/dev/null | grep -q up; then break; fi
  sleep 1
done

# 6. Host the port ──────────────────────────────────────────────────────────
log "hosting port 8787…"
HOST_URL="$(box ssh "$BOX_ID" '/home/user/.ascii/host 8787 --title task-orch-worker-channel 2>&1' 2>/dev/null | grep -o 'https://[^ ]*' | head -1)"

if [ -z "$HOST_URL" ]; then
  echo "failed to host port 8787" >&2
  box ssh "$BOX_ID" 'sudo journalctl -u task-orch-worker -n 30 --no-pager 2>&1' >&2 || true
  exit 1
fi

echo
log "READY. Box $BOX_ID worker is listening and hosted."
echo "  hostUrl:    $HOST_URL"
echo "  credential: $CRED"
echo "  instance:   $INSTANCE"
echo "  runId:      $RUN_ID"
echo
echo "Drive a real agent turn (single-turn; relaunch the worker for another):"
echo "  node scripts/box-drive.mjs '$HOST_URL' '$CRED' '$INSTANCE' '$RUN_ID' 'Reply with exactly: box-ok'"
echo

if [ -n "$GOAL" ]; then
  log "driving goal: $GOAL"
  ( cd "$REPO_ROOT" && node scripts/box-drive.mjs "$HOST_URL" "$CRED" "$INSTANCE" "$RUN_ID" "$GOAL" )
fi
