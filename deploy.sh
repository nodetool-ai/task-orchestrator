#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Task Orchestrator Deploy
#
# Pulls latest code, builds the Next.js app, and restarts the systemd service.
# Intended to be called by the webhook runner on push to main.
#
# Usage:
#   ./deploy.sh              # Full deploy
#   ./deploy.sh --logs       # Tail service logs
#   ./deploy.sh --status     # Show service status
#   ./deploy.sh --rollback   # Rollback to previous build (if .next.prev exists)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="task-orchestrator"
PIPE_SERVICE="task-orchestrator-pipe"
# Account that runs the web + pipe units. The deploy itself runs as this user
# (the pipe restart below uses `systemctl --user`), so the current login user is
# the service user.
SERVICE_USER="$(id -un)"
HEALTH_TIMEOUT=60
HEALTH_INTERVAL=2

# Restart the Discord pipe bridge if its unit is installed. It's a user-level
# systemd service (linger keeps it alive without a login session), so no sudo —
# just point at the runtime dir in case this runs from a non-login context.
# Separate unit, no HTTP health check; a failure here must not fail the deploy.
restart_pipe() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if systemctl --user cat "$PIPE_SERVICE" >/dev/null 2>&1; then
    echo "--- Restarting $PIPE_SERVICE (user unit) ---"
    # Clear any prior crash-loop failure so `restart` actually starts it.
    systemctl --user reset-failed "$PIPE_SERVICE" 2>/dev/null || true
    if ! systemctl --user restart "$PIPE_SERVICE"; then
      echo "WARN: $PIPE_SERVICE restart command failed"
      return
    fi
    # Don't silently declare success — a unit that can't find node will exit
    # 127 and auto-restart, leaving the bridge dead while the deploy looks fine.
    sleep 3
    if systemctl --user is-active --quiet "$PIPE_SERVICE"; then
      echo "$PIPE_SERVICE is active."
    else
      echo "WARN: $PIPE_SERVICE is not active after restart — recent logs:"
      journalctl --user -u "$PIPE_SERVICE" --no-pager -n 20 || true
    fi
  fi
}

# The systemd units source nvm.sh and select the `default` alias. nvm does not
# create that alias on its own, and a clean `systemctl restart` runs with a bare
# PATH — so a missing alias lands `npm: not found` (status=127) and crash-loops.
# Re-assert it on every deploy (pointing at the latest installed node) so both
# the app service and the pipe survive a restart regardless of prior state.
ensure_nvm_default() {
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    nvm alias default node >/dev/null 2>&1 || true
  fi
}

# Detached run workers (TASK_ORCH_DETACHED_RUNS) launch each run in its own
# transient `systemd-run --user --scope` unit so a `systemctl restart` of the
# web service cannot signal it. Those `--user` units require a user systemd
# manager that outlives the deploying login session, so enable lingering for the
# service account. Idempotent; a safe no-op when already enabled or when
# loginctl is unavailable, so it must never fail the deploy.
ensure_linger() {
  loginctl enable-linger "$SERVICE_USER" 2>/dev/null || true
}

ACTION=""
while (( $# )); do
  case "$1" in
    --logs)   ACTION="logs";   ;;
    --status) ACTION="status"; ;;
    --rollback) ACTION="rollback"; ;;
    --help|-h)
      sed -n '3,15p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
  esac
  shift
done

case "$ACTION" in
  logs)
    sudo journalctl -u "$SERVICE_NAME" -f
    exit 0
    ;;
  status)
    systemctl status "$SERVICE_NAME" --no-pager
    echo ""
    echo "=== Health Check ==="
    if curl -fs "http://localhost:3000/api/health" 2>/dev/null || curl -fs "http://localhost:3000" 2>/dev/null; then
      echo "Healthy"
    else
      echo "UNHEALTHY"
    fi
    exit 0
    ;;
  rollback)
    if [[ ! -d "$SCRIPT_DIR/.next.prev" ]]; then
      echo "ERROR: No rollback build found (.next.prev)"
      exit 1
    fi
    echo "Rolling back to previous build..."
    rm -rf "$SCRIPT_DIR/.next"
    mv "$SCRIPT_DIR/.next.prev" "$SCRIPT_DIR/.next"
    ensure_nvm_default
    sudo systemctl restart "$SERVICE_NAME"
    restart_pipe
    exit 0
    ;;
esac

# ── Preflight ────────────────────────────────────────────────────────

if [[ ! -f "$SCRIPT_DIR/.env.local" ]]; then
  echo "ERROR: .env.local not found in $SCRIPT_DIR"
  exit 1
fi

# The systemd units source nvm.sh themselves; make sure they can resolve a node
# version when restarted from a clean environment (see ensure_nvm_default).
ensure_nvm_default

# Keep the user systemd manager alive across deploys so detached run workers
# (systemd-run --user) survive a web-service restart (see ensure_linger).
ensure_linger

echo "node: $(command -v node || echo missing) | npm: $(command -v npm || echo missing)"
echo ""

# ── Pull ─────────────────────────────────────────────────────────────

echo "=== Task Orchestrator Deploy ==="
echo ""

cd "$SCRIPT_DIR"
git fetch --prune origin
git reset --hard origin/main

SHA=$(git rev-parse --short HEAD)
MSG=$(git log -1 --pretty=%s | head -c 200)

echo "Commit: $SHA"
echo "Message: $MSG"
echo ""

# ── Build ────────────────────────────────────────────────────────────

echo "--- Installing dependencies ---"
npm ci

echo ""
echo "--- Building ---"
# Save previous build for rollback
rm -rf "$SCRIPT_DIR/.next.prev"
if [[ -d "$SCRIPT_DIR/.next" ]]; then
  cp -a "$SCRIPT_DIR/.next" "$SCRIPT_DIR/.next.prev"
fi

npm run build

# ── Deploy ───────────────────────────────────────────────────────────

echo ""
echo "--- Restarting service ---"
sudo systemctl restart "$SERVICE_NAME"
restart_pipe

# ── Health check ─────────────────────────────────────────────────────

echo ""
echo "Waiting for health (timeout: ${HEALTH_TIMEOUT}s)..."
elapsed=0
HEALTHY=0
while (( elapsed < HEALTH_TIMEOUT )); do
  if curl -fs "http://localhost:3000/api/health" 2>/dev/null || curl -fs "http://localhost:3000" 2>/dev/null; then
    HEALTHY=1
    break
  fi
  sleep "$HEALTH_INTERVAL"
  (( elapsed += HEALTH_INTERVAL ))
done

if [[ "$HEALTHY" == "1" ]]; then
  echo "Healthy (${elapsed}s)."
  echo ""
  echo "=== Deploy Complete ==="
  echo "  Service: $SERVICE_NAME"
  echo "  Commit:  $SHA"
  echo "  Logs:    ./deploy.sh --logs"
  echo "  Status:  ./deploy.sh --status"
  echo ""
else
  echo "ERROR: Health check failed after ${HEALTH_TIMEOUT}s"
  sudo journalctl -u "$SERVICE_NAME" --no-pager -n 30
  exit 1
fi
