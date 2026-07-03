#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Task Orchestrator Deploy (Docker Compose)
#
# Pulls latest code, (re)builds the server + worker images, and brings the
# compose stack up (postgres + server + pipe + ad-hoc workers). Called by the
# webhook runner on push to main. No sudo required — everything is `docker
# compose` — so unlike the old systemd flow this can run unattended.
#
# Usage:
#   ./deploy.sh              # Full deploy
#   ./deploy.sh --logs       # Tail server logs
#   ./deploy.sh --status     # Show stack status + health
#   ./deploy.sh --rollback   # Roll back server+worker to the previous images
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DC="docker compose"
SERVER_URL="http://localhost:${SERVER_PORT:-3000}"
HEALTH_TIMEOUT=180   # image build already happened; this covers boot + migrate
HEALTH_INTERVAL=3

health_check() {
  # 307 -> /login (unauthenticated root) counts as healthy.
  curl -fs "$SERVER_URL/api/health" >/dev/null 2>&1 || curl -fs -o /dev/null "$SERVER_URL"
}

ACTION=""
while (( $# )); do
  case "$1" in
    --logs)     ACTION="logs";     ;;
    --status)   ACTION="status";   ;;
    --rollback) ACTION="rollback"; ;;
    --help|-h)  sed -n '4,22p' "$0" | sed 's/^# \?//'; exit 0 ;;
  esac
  shift
done

case "$ACTION" in
  logs)
    exec $DC logs -f server
    ;;
  status)
    $DC ps
    echo ""
    echo "=== Health Check ($SERVER_URL) ==="
    if health_check; then echo "Healthy"; else echo "UNHEALTHY"; fi
    exit 0
    ;;
  rollback)
    echo "Rolling back server+worker to :prev images..."
    for svc in server worker; do
      if docker image inspect "task-orchestrator-$svc:prev" >/dev/null 2>&1; then
        docker image tag "task-orchestrator-$svc:prev" "task-orchestrator-$svc:latest"
      else
        echo "ERROR: no task-orchestrator-$svc:prev image to roll back to"; exit 1
      fi
    done
    $DC up -d --no-build server pipe
    exit 0
    ;;
esac

# ── Preflight ────────────────────────────────────────────────────────
if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  echo "ERROR: compose .env not found in $SCRIPT_DIR (see .env.docker.example)"
  exit 1
fi
command -v docker >/dev/null || { echo "ERROR: docker not found"; exit 1; }

echo "=== Task Orchestrator Deploy (compose) ==="
echo ""

# ── Pull ─────────────────────────────────────────────────────────────
git fetch --prune origin
git reset --hard origin/main
SHA=$(git rev-parse --short HEAD)
echo "Commit: $SHA — $(git log -1 --pretty=%s | head -c 120)"
echo ""

# ── Build (tag current images as :prev for rollback first) ───────────
echo "--- Building images ---"
for svc in server worker; do
  docker image inspect "task-orchestrator-$svc:latest" >/dev/null 2>&1 \
    && docker image tag "task-orchestrator-$svc:latest" "task-orchestrator-$svc:prev" || true
done
$DC --profile build build server worker

# ── Deploy ───────────────────────────────────────────────────────────
echo ""
echo "--- Refreshing repo-cache mirror ---"
# One-shot; fetches TARGET_REPOS into the repo-cache volume. Must not fail the deploy.
$DC up --no-log-prefix repo-cache-init || echo "WARN: repo-cache refresh failed"

echo ""
echo "--- Bringing up the stack ---"
# Recreates changed services (server/pipe); postgres keeps its volume + data. The
# server's instrumentation runs migrations (initDb) on boot.
$DC up -d --remove-orphans postgres server pipe

# ── Health check ─────────────────────────────────────────────────────
echo ""
echo "Waiting for health (timeout: ${HEALTH_TIMEOUT}s)..."
elapsed=0
HEALTHY=0
while (( elapsed < HEALTH_TIMEOUT )); do
  if health_check; then HEALTHY=1; break; fi
  sleep "$HEALTH_INTERVAL"; (( elapsed += HEALTH_INTERVAL ))
done

if [[ "$HEALTHY" == "1" ]]; then
  echo "Healthy (${elapsed}s)."
  echo ""
  echo "=== Deploy Complete ==="
  echo "  Commit: $SHA"
  echo "  Status: ./deploy.sh --status   Logs: ./deploy.sh --logs"
else
  echo "ERROR: Health check failed after ${HEALTH_TIMEOUT}s — recent server logs:"
  $DC logs --tail 40 server || true
  echo ""
  echo "Roll back with: ./deploy.sh --rollback"
  exit 1
fi
