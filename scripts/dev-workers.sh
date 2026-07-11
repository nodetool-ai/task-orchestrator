#!/usr/bin/env bash
# =============================================================================
# Docker worker support for LOCAL dev.
#
# `npm run dev` runs the Next.js server on the host. By default agent runs
# execute in a detached `tsx` host process. This script flips dev to spawn each
# run as an ad-hoc Docker worker container instead (the same dockerSpawn path
# the compose/test-deploy stack uses), so a run gets a clean, isolated,
# consistently-tooled worker environment without littering the host with tsx
# processes.
#
# It does three things:
#   1. builds the worker image (task-orchestrator-worker:dev) — re-run after
#      changing worker/lib code so the container carries your edits
#   2. seeds/refreshes a named repo-cache volume so workers clone fast from a
#      local mirror instead of hitting GitHub per run
#   3. prints the env block to drop into .env.local
#
# The server itself keeps running on the host (hot reload, your editor, etc).
# Only the per-run workers move into containers.
#
#   scripts/dev-workers.sh                 # build image + seed cache + print env
#   scripts/dev-workers.sh --build         # force an image rebuild
#   scripts/dev-workers.sh --refresh-cache # re-fetch the mirror (new commits)
#   scripts/dev-workers.sh --no-build      # assume the image is current
#
# Prereqs: Docker + `docker compose` v2, GH_TOKEN with `repo` scope on the
# target repo(s), and ~/.claude authenticated (Claude Code login) so workers
# inherit the session.
# =============================================================================
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

IMAGE="task-orchestrator-worker:dev"
VOLUME="task-orch-dev-repo-cache"

# --- repo list to mirror ----------------------------------------------------
# TARGET_REPOS (space-separated owner/repo, same convention as docker-compose.yml)
# wins; otherwise derive it from this repo's own `origin` remote so dev against
# the orchestrator's own source works with zero config.
default_repos() {
  local url
  url="$(git -C . config --get remote.origin.url 2>/dev/null || true)"
  # ssh git@github.com:owner/repo.git OR https://github.com/owner/repo(.git)
  local re='github.com[:/]([^/]+/[^/]+)$'
  if [[ "$url" =~ $re ]]; then
    local r="${BASH_REMATCH[1]}"
    r="${r%.git}"
    echo "$r"
  fi
}

TARGET_REPOS="${TARGET_REPOS:-$(default_repos)}"
if [[ -z "${TARGET_REPOS// /}" ]]; then
  echo "ERROR: could not determine target repo(s)." >&2
  echo "Set TARGET_REPOS=\"owner/repo\" (space-separated) in .env.local or the env." >&2
  exit 1
fi

BUILD=1
REFRESH=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --no-build) BUILD=0 ;;
    --refresh-cache) REFRESH=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# --- 1. worker image --------------------------------------------------------
image_exists=0
if docker image inspect "$IMAGE" >/dev/null 2>&1; then image_exists=1; fi
if [[ "$BUILD" == 1 || "$image_exists" == 0 ]]; then
  echo "--- building worker image $IMAGE ---"
  docker build -f Dockerfile.worker -t "$IMAGE" .
else
  echo "--- worker image $IMAGE already built (use --build to rebuild) ---"
fi

# --- 2. repo-cache volume + mirror ------------------------------------------
docker volume inspect "$VOLUME" >/dev/null 2>&1 || docker volume create "$VOLUME" >/dev/null

seed() {
  # Mirror/refresh each TARGET_REPOS into the named volume at
  # /<owner>_<repo>.git — the exact path lib/runs.ts containerCheckoutAt looks
  # up for `git clone --reference`. Auth header via `git -c` so the token never
  # lands in the mirror's stored config.
  for repo in $TARGET_REPOS; do
    d="/${repo//\//_}.git"
    echo "  $repo -> $VOLUME:$d"
    # Only send an Authorization header when GH_TOKEN is set: a header built
    # from an empty token makes GitHub return 401 even for public repos,
    # breaking the anonymous-clone fallback the warning below promises.
    if docker run --rm --entrypoint sh -v "$VOLUME:/cache" -e GH_TOKEN="${GH_TOKEN:-}" alpine/git \
        -c "set -e; \
               d='/cache${d}'; \
               if [ -n \"\$GH_TOKEN\" ]; then \
                 AUTH='Authorization: basic '\$(printf 'x-access-token:%s' \"\$GH_TOKEN\" | base64 | tr -d '\n'); \
                 if [ -d \"\$d\" ]; then \
                   git -c http.extraHeader=\"\$AUTH\" -C \"\$d\" fetch --prune origin '+refs/heads/*:refs/heads/*'; \
                 else \
                   git -c http.extraHeader=\"\$AUTH\" clone --mirror \"https://github.com/$repo\" \"\$d\"; \
                 fi; \
               else \
                 if [ -d \"\$d\" ]; then \
                   git -C \"\$d\" fetch --prune origin '+refs/heads/*:refs/heads/*'; \
                 else \
                   git clone --mirror \"https://github.com/$repo\" \"\$d\"; \
                 fi; \
               fi"; then
      :
    else
      echo "  WARNING: mirror of $repo failed — runs will fall back to a full clone." >&2
    fi
  done
}

# Seed when the volume is empty, or when explicitly refreshing.
populated="$(docker run --rm --entrypoint sh -v "$VOLUME:/cache" alpine/git -c 'ls -A /cache 2>/dev/null | head -1 || true')"
if [[ -z "$populated" || "$REFRESH" == 1 ]]; then
  echo "--- seeding repo-cache volume ($VOLUME) for: $TARGET_REPOS ---"
  if [[ -z "${GH_TOKEN:-}" ]]; then
    echo "WARNING: GH_TOKEN is unset — mirror clone will be anonymous and fail on private repos." >&2
  fi
  seed
else
  echo "--- repo-cache volume already seeded (use --refresh-cache to re-fetch) ---"
fi

# --- 3. env block -----------------------------------------------------------
CLAUDE_HOME_HOST="${TASK_ORCH_CLAUDE_HOME_HOST:-$HOME/.claude}"
PORT="${SERVER_PORT:-3000}"

cat <<EOF

============================ add to .env.local ============================
# Docker workers for local dev (see scripts/dev-workers.sh)
TASK_ORCH_DETACHED_RUNS=1
TASK_ORCH_WORKER_IMAGE=$IMAGE
TASK_ORCH_WORKER_API_URL=http://host.docker.internal:$PORT
TASK_ORCH_CLAUDE_HOME_HOST=$CLAUDE_HOME_HOST
TASK_ORCH_REPO_CACHE_HOST_VOLUME=$VOLUME
# (GH_TOKEN + your agent backend creds are already in .env.local — the server
#  forwards them into each worker container.)
==========================================================================

Then \`npm run dev\` and trigger a run: each one spawns a \`run-<id>-*\`
container. Watch with:

  docker ps --filter name=run- --format '{{.Names}}\t{{.Status}}'

Rebuild the image after changing worker/lib code:

  scripts/dev-workers.sh --build

Refresh the repo mirror after upstream commits land:

  scripts/dev-workers.sh --refresh-cache

To revert to host tsx workers, just unset TASK_ORCH_WORKER_IMAGE in .env.local.
EOF
