#!/usr/bin/env bash
# Build-time repo-mirror seeder for the Fly runner image.
#
# Seeds <dest-dir> with bare, blobless (--filter=blob:none) --mirror clones of
# the listed repos. At run time lib/runs.ts's containerCheckoutAt does
# `git clone --reference <mirror> --dissociate` against these, so a per-run
# checkout only fetches the delta since the last image rebuild instead of the
# whole history. A missing/failed mirror is never fatal — the run just falls
# back to a full clone (slower first boot, correct result).
#
# Usage: build-repo-cache.sh <dest-dir> <repos>
#   <repos>  space- and/or comma-separated list of owner/repo entries.
# The GitHub token is read from the file named by $GH_TOKEN_FILE
# (default /run/secrets/gh_token), i.e. a BuildKit secret mount — it is never
# baked into an image layer, never placed in a clone URL, never git-config'd.
set -euo pipefail

DEST="${1:-}"
REPOS_RAW="${2:-}"
GH_TOKEN_FILE="${GH_TOKEN_FILE:-/run/secrets/gh_token}"

if [ -z "$DEST" ]; then
  echo "[build-repo-cache] usage: build-repo-cache.sh <dest-dir> <repos>" >&2
  exit 2
fi

# The dest dir must always exist so the ENV REPO_CACHE_DIR lookup never errors,
# even when we seed nothing.
mkdir -p "$DEST"

# Read the token from the secret mount (if any). Never echo it.
TOKEN=""
if [ -f "$GH_TOKEN_FILE" ]; then
  TOKEN="$(cat "$GH_TOKEN_FILE")"
fi

# Normalise the repo list: commas -> spaces, then word-split.
REPOS_NORM="${REPOS_RAW//,/ }"

if [ -z "${REPOS_NORM// /}" ] || [ -z "$TOKEN" ]; then
  echo "[build-repo-cache] no repos and/or no token — seeding nothing (runs fall back to full clones)."
  exit 0
fi

# Basic-auth header value (base64 of "x-access-token:<token>"). Passed only via
# `git -c http.extraHeader=...`, which does not persist into the on-disk config.
AUTH_HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"

for repo in $REPOS_NORM; do
  if ! printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
    echo "[build-repo-cache] WARNING: skipping malformed repo entry: $repo" >&2
    continue
  fi

  owner="${repo%%/*}"
  name="${repo##*/}"
  mirror="$DEST/${owner}_${name}.git"

  echo "[build-repo-cache] seeding $repo -> $mirror"
  if ! git -c http.extraHeader="$AUTH_HEADER" \
        clone --mirror --filter=blob:none \
        "https://github.com/${owner}/${name}.git" "$mirror"; then
    echo "[build-repo-cache] WARNING: clone failed for $repo — continuing (run will full-clone)." >&2
    rm -rf "$mirror"
    continue
  fi

  # SECURITY: prove the token did not leak into the mirror's persisted config.
  leaked="$(git --git-dir="$mirror" config --local --get-all http.extraheader || true)"
  if [ -n "$leaked" ]; then
    echo "[build-repo-cache] FATAL: auth header persisted into $mirror config — refusing to bake a token into the image." >&2
    exit 1
  fi
done

echo "[build-repo-cache] done."
