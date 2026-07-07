#!/usr/bin/env bash
# Build-time dependency pre-warmer for the Fly runner image.
#
# Bakes a ready-to-go checkout of the primary target repo so an agent run never
# pays a cold `npm ci` + `npx playwright install` on a fresh volume:
#   1. clone <repo> into <dest> (reusing the blobless mirror in REPO_CACHE_DIR as
#      a --reference when present, so this only fetches the delta)
#   2. `npm ci` (the full workspace install — root + every nested node_modules)
#   3. `npm run build:packages` if that script exists (populates packages/*/dist)
#   4. `playwright install --with-deps chromium` into PLAYWRIGHT_BROWSERS_PATH
#
# At run time lib/prewarm.ts symlinks <dest>'s node_modules tree into the per-run
# checkout (only when the checkout's origin matches <repo>), and the baked
# browser is found globally via PLAYWRIGHT_BROWSERS_PATH. Chromium adds only a
# few hundred MB — negligible next to the multi-GB npm install — so it is baked
# too rather than paid on demand.
#
# Never fatal: a missing repo/token, or any failed step, leaves the image usable
# (runs just pay the cold install as before). Mirrors build-repo-cache.sh.
#
# Usage: build-prewarm.sh <dest-dir> <owner/repo>
# The GitHub token is read from $GH_TOKEN_FILE (default /run/secrets/gh_token) —
# a BuildKit secret mount, never baked into a layer.
set -uo pipefail

DEST="${1:-}"
REPO="${2:-}"
GH_TOKEN_FILE="${GH_TOKEN_FILE:-/run/secrets/gh_token}"
REPO_CACHE_DIR="${REPO_CACHE_DIR:-/opt/repo-cache}"

if [ -z "$DEST" ]; then
  echo "[build-prewarm] usage: build-prewarm.sh <dest-dir> <owner/repo>" >&2
  exit 2
fi

# Never let a prewarm failure fail the image build — the runner must still boot.
finish_ok() { echo "[build-prewarm] $1 — skipping prewarm (runs pay the cold install)."; exit 0; }

if [ -z "$REPO" ]; then finish_ok "no PREWARM_REPO set"; fi
if ! printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  finish_ok "malformed PREWARM_REPO '$REPO'"
fi

TOKEN=""
if [ -f "$GH_TOKEN_FILE" ]; then TOKEN="$(cat "$GH_TOKEN_FILE")"; fi
# Runtime fallback: when this runs inside a Machine (the seed-volume job) rather
# than a BuildKit build, there is no secret-mount file — take the token from the
# GH_TOKEN env the machine already carries.
if [ -z "$TOKEN" ] && [ -n "${GH_TOKEN:-}" ]; then TOKEN="$GH_TOKEN"; fi
if [ -z "$TOKEN" ]; then finish_ok "no gh_token secret"; fi

owner="${REPO%%/*}"
name="${REPO##*/}"
mirror="$REPO_CACHE_DIR/${owner}_${name}.git"
AUTH_HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"

reference=()
if [ -d "$mirror" ]; then
  reference=(--reference "$mirror" --dissociate)
  echo "[build-prewarm] using mirror $mirror as clone reference"
fi

echo "[build-prewarm] cloning $REPO -> $DEST"
rm -rf "$DEST"
# --filter=blob:none is REQUIRED, not just an optimization: the repo-cache
# mirror we borrow via --reference is itself blobless (build-repo-cache.sh
# clones it with --filter=blob:none). A full clone + --dissociate would try to
# localize every borrowed object, hit a blob the mirror never had, and abort
# with "unable to read <oid> / cannot repack to clean up". A partial clone
# leaves absent blobs promised (lazily fetched on checkout), so dissociate
# succeeds. This mirrors the runtime per-run checkout in lib/runs.ts.
if ! git -c http.extraHeader="$AUTH_HEADER" \
      clone --filter=blob:none "${reference[@]}" \
      "https://github.com/${owner}/${name}.git" "$DEST"; then
  finish_ok "clone failed for $REPO"
fi

# SECURITY: never persist the token into the clone's on-disk config.
leaked="$(git -C "$DEST" config --local --get-all http.extraheader || true)"
if [ -n "$leaked" ]; then
  echo "[build-prewarm] FATAL: auth header persisted into $DEST config." >&2
  exit 1
fi
cd "$DEST" || finish_ok "cannot cd into $DEST"

echo "[build-prewarm] npm ci (full workspace install)"
if ! npm ci --no-audit --no-fund; then
  # npm ci is strict: it aborts outright when package-lock.json has drifted from
  # package.json — a common transient state on a fast-moving target repo (e.g. a
  # dep bumped without regenerating the lock). A prewarm only wants a warm
  # node_modules, not lockfile reproducibility, so fall back to `npm install`,
  # which reconciles the lock and installs. The per-run checkout does its own
  # install anyway; this is just a cache.
  echo "[build-prewarm] npm ci failed (likely lock drift) — retrying with npm install." >&2
  if ! npm install --no-audit --no-fund; then
    # A partial node_modules is worse than none (broken resolution). Wipe it so
    # the runtime applier finds nothing to link and the run cold-installs.
    echo "[build-prewarm] npm install also failed — wiping partial node_modules." >&2
    find . -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
    finish_ok "npm install failed"
  fi
fi

# Record which repo this prewarm belongs to — written only AFTER a successful
# install, so the marker's presence is a true "deps are ready" sentinel (the
# seed-volume job keys success on it). The runtime applier links it only into a
# checkout whose origin matches, so it can never bleed into another repo.
printf '%s\n' "$REPO" > ".prewarm-repo"

# Build workspace packages so packages/*/dist is ready (best-effort — dist is not
# linked at runtime today, but building also runs postinstall/native steps).
if npm run --silent 2>/dev/null | grep -qE '^\s*build:packages'; then
  echo "[build-prewarm] npm run build:packages"
  npm run build:packages || echo "[build-prewarm] WARNING: build:packages failed — continuing." >&2
fi

# Playwright browsers are intentionally NOT baked: they add size/build time and
# most runs don't need a browser. A run that does need one installs it on demand
# into PLAYWRIGHT_BROWSERS_PATH (set in Dockerfile.fly-runner).
echo "[build-prewarm] skipping Playwright browser install (not baked by design)."

echo "[build-prewarm] done: $(du -sh "$DEST" 2>/dev/null | cut -f1) baked at $DEST"
