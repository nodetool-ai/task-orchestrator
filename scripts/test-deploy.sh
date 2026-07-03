#!/usr/bin/env bash
# =============================================================================
# Test deployment of the Dockerized stack (Postgres + server + ad-hoc workers).
# Fully isolated from prod: its own compose project, network, and THROWAWAY
# volumes. Does NOT touch the systemd services or any prod compose stack.
#
#   cp .env.test.example .env.test   # then fill in GH_TOKEN / TARGET_REPOS / CLAUDE_HOME
#   scripts/test-deploy.sh up        # build + start postgres+server + seed repo-cache
#   scripts/test-deploy.sh status    # services + any live worker containers
#   scripts/test-deploy.sh logs      # tail server logs (logs pipe|postgres for others)
#   scripts/test-deploy.sh psql "SELECT ..."   # query the test DB
#   scripts/test-deploy.sh down      # stop + REMOVE volumes (throwaway)
#
# See docs/test-deployment.md for prerequisites + the worker->PR acceptance test.
# =============================================================================
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJECT="${COMPOSE_PROJECT_NAME:-task-orch-test}"
ENV_FILE="${ENV_FILE:-.env.test}"
export COMPOSE_PROJECT_NAME="$PROJECT"
DC=(docker compose -p "$PROJECT" --env-file "$ENV_FILE")

need_env() {
  [[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found. Copy .env.test.example and fill it in."; exit 1; }
}
port() { grep -E '^SERVER_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ' | grep -E '^[0-9]+$' || echo 3005; }

cmd="${1:-up}"
case "$cmd" in
  build)
    need_env
    echo "--- building server image ---"; "${DC[@]}" build server
    echo "--- building worker image ---"; docker build -f Dockerfile.worker -t task-orchestrator-worker:latest .
    ;;
  up)
    need_env
    echo "--- building images ---"; "${DC[@]}" build server
    docker build -f Dockerfile.worker -t task-orchestrator-worker:latest .
    echo "--- starting postgres + server ---"; "${DC[@]}" up -d postgres server
    echo "--- seeding repo-cache (mirrors TARGET_REPOS) ---"; "${DC[@]}" run --rm repo-cache-init
    P="$(port)"
    echo "--- waiting for server health on :$P ---"
    ok=0
    for _ in $(seq 1 40); do
      code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$P" 2>/dev/null || true)"
      [[ "$code" == "307" || "$code" == "200" ]] && { ok=1; break; }
      sleep 2
    done
    if [[ "$ok" == 1 ]]; then
      echo "UP  ->  http://localhost:$P  (project: $PROJECT)"
      echo "next: docs/test-deployment.md 'Acceptance test' to drive a worker->PR run"
    else
      echo "server did not become healthy; recent logs:"; "${DC[@]}" logs --tail 40 server
      exit 1
    fi
    ;;
  down)
    need_env
    echo "--- stopping + removing volumes (throwaway) ---"; "${DC[@]}" down -v
    ;;
  logs)   need_env; "${DC[@]}" logs -f "${2:-server}" ;;
  status)
    need_env; "${DC[@]}" ps
    echo "--- live worker containers ---"
    docker ps --filter "name=run-" --format '  {{.Names}}  {{.Status}}' || true
    ;;
  psql)   need_env; "${DC[@]}" exec -T postgres psql -U taskorch -d taskorch ${2:+-c "$2"} ;;
  *) echo "usage: scripts/test-deploy.sh {build|up|down|logs [svc]|status|psql [sql]}"; exit 1 ;;
esac
