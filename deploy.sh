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
HEALTH_TIMEOUT=60
HEALTH_INTERVAL=2

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
    sudo systemctl restart "$SERVICE_NAME"
    exit 0
    ;;
esac

# ── Preflight ────────────────────────────────────────────────────────

if [[ ! -f "$SCRIPT_DIR/.env.local" ]]; then
  echo "ERROR: .env.local not found in $SCRIPT_DIR"
  exit 1
fi

# Use nvm if available, otherwise assume node is on PATH
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
if command -v nvm >/dev/null 2>&1; then
  nvm use --silent 2>/dev/null || nvm use default --silent 2>/dev/null || nvm use node --silent 2>/dev/null || true
fi

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
