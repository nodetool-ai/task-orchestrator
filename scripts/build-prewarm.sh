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
if ! git -c http.extraHeader="$AUTH_HEADER" \
      clone --depth 1 "${reference[@]}" \
      "https://github.com/${owner}/${name}.git" "$DEST"; then
  finish_ok "clone failed for $REPO"
fi

# SECURITY: never persist the token into the clone's on-disk config.
leaked="$(git -C "$DEST" config --local --get-all http.extraheader || true)"
if [ -n "$leaked" ]; then
  echo "[build-prewarm] FATAL: auth header persisted into $DEST config." >&2
  exit 1
fi
# Record which repo this prewarm belongs to; the runtime applier only links it
# into a checkout whose origin matches, so it can never bleed into another repo.
printf '%s\n' "$REPO" > "$DEST/.prewarm-repo"

cd "$DEST" || finish_ok "cannot cd into $DEST"

echo "[build-prewarm] npm ci (full workspace install)"
if ! npm ci --no-audit --no-fund; then
  # A partial node_modules is worse than none (broken resolution). Wipe it so the
  # runtime applier finds nothing to link and the run does its own clean install.
  echo "[build-prewarm] npm ci failed — wiping partial node_modules." >&2
  find . -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
  finish_ok "npm ci failed"
fi

# Build workspace packages so packages/*/dist is ready (best-effort — dist is not
# linked at runtime today, but building also runs postinstall/native steps).
if npm run --silent 2>/dev/null | grep -qE '^\s*build:packages'; then
  echo "[build-prewarm] npm run build:packages"
  npm run build:packages || echo "[build-prewarm] WARNING: build:packages failed — continuing." >&2
fi

# Playwright browser + OS deps into the image-global PLAYWRIGHT_BROWSERS_PATH.
# Chromium only: it is the sole project in the target's playwright config. If the
# repo doesn't use Playwright, the binary is absent and this is a no-op.
if [ -x node_modules/.bin/playwright ]; then
  echo "[build-prewarm] installing Playwright Chromium + OS deps"
  node_modules/.bin/playwright install --with-deps chromium \
    || echo "[build-prewarm] WARNING: playwright install failed — continuing." >&2
else
  echo "[build-prewarm] no local playwright binary — skipping browser install."
fi

echo "[build-prewarm] done: $(du -sh "$DEST" 2>/dev/null | cut -f1) baked at $DEST"
