#!/usr/bin/env bash
set -euo pipefail

# Deploy the Task Orchestrator control plane to Fly.io. Workers use the local
# or Sprites providers; this script never creates a Fly runner app or token.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APP="${FLY_APP:-task-orchestrator}"
PG_APP="${FLY_PG_APP:-${APP}-db}"
REGION="${FLY_REGION:-ams}"
ORG="${FLY_ORG:-personal}"
NEXTAUTH_URL="${NEXTAUTH_URL:-https://${APP}.fly.dev}"
FLY="$(command -v fly || command -v flyctl || true)"
[[ -n "$FLY" ]] || { echo "flyctl not found" >&2; exit 1; }
"$FLY" auth whoami >/dev/null

if ! "$FLY" apps list | awk '{print $1}' | grep -qx "$APP"; then
  "$FLY" apps create "$APP" --org "$ORG"
fi
sed -i.bak "s/^primary_region = .*/primary_region = \"$REGION\"/" fly.toml
rm -f fly.toml.bak

if [[ -n "${DATABASE_URL:-}" ]]; then
  "$FLY" secrets set -a "$APP" --stage DATABASE_URL="$DATABASE_URL"
elif ! "$FLY" secrets list -a "$APP" | grep -qw DATABASE_URL; then
  if ! "$FLY" apps list | awk '{print $1}' | grep -qx "$PG_APP"; then
    "$FLY" postgres create --name "$PG_APP" --org "$ORG" --region "$REGION" --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 10
  fi
  "$FLY" postgres attach "$PG_APP" --app "$APP" || true
fi

AUTH_SECRET="${AUTH_SECRET:-$(openssl rand -base64 32)}"
secrets=(AUTH_SECRET="$AUTH_SECRET" NEXTAUTH_URL="$NEXTAUTH_URL")
for key in GH_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN GITHUB_WEBHOOK_SECRET SPRITES_TOKEN; do
  [[ -n "${!key:-}" ]] && secrets+=("$key=${!key}")
done
"$FLY" secrets set -a "$APP" --stage "${secrets[@]}"
"$FLY" deploy --config fly.toml --app "$APP" --ha=false
echo "Deployed control plane: $NEXTAUTH_URL"
