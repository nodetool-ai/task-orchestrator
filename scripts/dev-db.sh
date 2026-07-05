#!/usr/bin/env bash
#
# dev-db.sh — bring up a throwaway local Postgres for development and tests.
#
# The app and the Vitest suite both expect a Postgres reachable at the default
#   DATABASE_URL = postgres://postgres:devpw@localhost:5433/taskorch
# (see vitest.setup.ts, which hard-codes this as the fallback). This script
# provisions exactly that, using whichever backend is available:
#
#   • docker  — a `postgres:16-alpine` container named `taskorch-pg-dev`
#               (matches the README quick-start; the developer-laptop default)
#   • local   — the host's apt `postgresql-16` cluster, reconfigured to :5433
#               (used where the Docker daemon isn't reachable, e.g. CI or the
#               Claude Code web sandbox)
#
# Usage:
#   scripts/dev-db.sh up       # start Postgres (idempotent), wait until ready
#   scripts/dev-db.sh down      # stop it
#   scripts/dev-db.sh reset     # drop + recreate the `taskorch` database
#   scripts/dev-db.sh status    # is it up?
#   scripts/dev-db.sh wait      # block until it accepts connections
#   scripts/dev-db.sh url       # print the DATABASE_URL to use
#
# Force a backend with TASK_ORCH_DB_DRIVER=docker|local (default: auto-detect).
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD_="${TASK_ORCH_DB_PASSWORD:-devpw}"
PGDATABASE="${PGDATABASE:-taskorch}"
DATABASE_URL_VALUE="postgres://${PGUSER}:${PGPASSWORD_}@${PGHOST}:${PGPORT}/${PGDATABASE}"

CONTAINER="taskorch-pg-dev"
PG_IMAGE="postgres:16-alpine"
CLUSTER_VER="16"
CLUSTER_NAME="main"

log() { printf '  \033[0;36m›\033[0m %s\n' "$*" >&2; }
err() { printf '  \033[0;31m✗ %s\033[0m\n' "$*" >&2; }

docker_up() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }
local_up()  { command -v pg_ctlcluster >/dev/null 2>&1; }

pick_driver() {
  case "${TASK_ORCH_DB_DRIVER:-auto}" in
    docker) echo docker ;;
    local)  echo local ;;
    auto)
      if docker_up; then echo docker
      elif local_up; then echo local
      else echo none
      fi ;;
    *) echo none ;;
  esac
}

# Does *something* already answer on the target host:port with our creds?
db_ready() {
  PGPASSWORD="$PGPASSWORD_" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" \
    -d "$PGDATABASE" -tAc 'select 1' >/dev/null 2>&1
}

wait_ready() {
  local tries="${1:-60}"
  for _ in $(seq 1 "$tries"); do
    db_ready && return 0
    sleep 1
  done
  return 1
}

# ── docker backend ────────────────────────────────────────────────────────────
docker_start() {
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    log "container $CONTAINER already running"
  elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    log "starting existing container $CONTAINER"
    docker start "$CONTAINER" >/dev/null
  else
    log "launching $PG_IMAGE as $CONTAINER on :$PGPORT"
    docker run -d --name "$CONTAINER" \
      -p "127.0.0.1:${PGPORT}:5432" \
      -e POSTGRES_USER="$PGUSER" \
      -e POSTGRES_PASSWORD="$PGPASSWORD_" \
      -e POSTGRES_DB="$PGDATABASE" \
      "$PG_IMAGE" >/dev/null
  fi
}
docker_stop()  { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
docker_reset() {
  docker exec -e PGPASSWORD="$PGPASSWORD_" "$CONTAINER" \
    psql -U "$PGUSER" -d postgres -c "DROP DATABASE IF EXISTS ${PGDATABASE} WITH (FORCE);" >/dev/null
  docker exec -e PGPASSWORD="$PGPASSWORD_" "$CONTAINER" \
    psql -U "$PGUSER" -d postgres -c "CREATE DATABASE ${PGDATABASE};" >/dev/null
}

# ── local apt-cluster backend ─────────────────────────────────────────────────
as_postgres() { runuser -u postgres -- "$@"; }
CONF="/etc/postgresql/${CLUSTER_VER}/${CLUSTER_NAME}/postgresql.conf"

local_start() {
  # Pin the cluster to our port so the canonical DATABASE_URL just works.
  if [ -f "$CONF" ] && ! grep -qE "^\s*port\s*=\s*${PGPORT}\b" "$CONF"; then
    log "setting cluster $CLUSTER_VER/$CLUSTER_NAME port to $PGPORT"
    sed -i -E "s/^\s*#?\s*port\s*=.*/port = ${PGPORT}/" "$CONF"
    pg_ctlcluster "$CLUSTER_VER" "$CLUSTER_NAME" restart >/dev/null 2>&1 || true
  fi
  if ! pg_lsclusters -h 2>/dev/null | awk '{print $1"/"$2, $4}' \
        | grep -qx "${CLUSTER_VER}/${CLUSTER_NAME} online"; then
    log "starting cluster $CLUSTER_VER/$CLUSTER_NAME"
    pg_ctlcluster "$CLUSTER_VER" "$CLUSTER_NAME" start >/dev/null 2>&1 || true
  fi
  # Ensure our role has the expected password and the database exists.
  as_postgres psql -p "$PGPORT" -d postgres -tAc \
    "ALTER USER ${PGUSER} WITH PASSWORD '${PGPASSWORD_}';" >/dev/null 2>&1 || true
  if ! as_postgres psql -p "$PGPORT" -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname='${PGDATABASE}'" 2>/dev/null | grep -q 1; then
    log "creating database $PGDATABASE"
    as_postgres psql -p "$PGPORT" -d postgres -c "CREATE DATABASE ${PGDATABASE};" >/dev/null 2>&1 || true
  fi
}
local_stop()  { pg_ctlcluster "$CLUSTER_VER" "$CLUSTER_NAME" stop >/dev/null 2>&1 || true; }
local_reset() {
  as_postgres psql -p "$PGPORT" -d postgres -c \
    "DROP DATABASE IF EXISTS ${PGDATABASE} WITH (FORCE);" >/dev/null
  as_postgres psql -p "$PGPORT" -d postgres -c "CREATE DATABASE ${PGDATABASE};" >/dev/null
}

# ── dispatch ──────────────────────────────────────────────────────────────────
cmd="${1:-up}"
driver="$(pick_driver)"

case "$cmd" in
  url) echo "$DATABASE_URL_VALUE" ;;
  status)
    if db_ready; then echo "up   ($DATABASE_URL_VALUE)"; else echo "down ($DATABASE_URL_VALUE)"; fi ;;
  wait)
    wait_ready 60 || { err "Postgres never came up at $PGHOST:$PGPORT"; exit 1; } ;;
  up)
    if db_ready; then
      log "Postgres already reachable at $PGHOST:$PGPORT"
      echo "$DATABASE_URL_VALUE"; exit 0
    fi
    case "$driver" in
      docker) docker_start ;;
      local)  local_start ;;
      none)
        err "No Postgres backend available: Docker daemon unreachable and no apt postgresql cluster found."
        err "Start Postgres yourself and set DATABASE_URL, or install one of the two."
        exit 1 ;;
    esac
    log "using '$driver' backend; waiting for readiness…"
    wait_ready 60 || { err "Postgres never became ready"; exit 1; }
    log "ready → $DATABASE_URL_VALUE"
    echo "$DATABASE_URL_VALUE" ;;
  down)
    case "$driver" in
      docker) docker_stop ;;
      local)  local_stop ;;
    esac
    log "Postgres stopped" ;;
  reset)
    case "$driver" in
      docker) docker_start; wait_ready 60; docker_reset ;;
      local)  local_start;  wait_ready 60; local_reset ;;
      none)   err "No Postgres backend to reset"; exit 1 ;;
    esac
    log "database $PGDATABASE dropped + recreated" ;;
  *)
    err "unknown command: $cmd"
    echo "usage: scripts/dev-db.sh {up|down|reset|status|wait|url}" >&2
    exit 2 ;;
esac
