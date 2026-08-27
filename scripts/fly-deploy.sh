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

if ! "$FLY" apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
  "$FLY" apps create "$APP" --org "$ORG"
fi
sed -i.bak "s/^primary_region = .*/primary_region = \"$REGION\"/" fly.toml
# The worker-bundle URL every sprite curls at bootstrap must point at THIS app.
sed -i.bak "s|^  TASK_ORCH_PUBLIC_URL = .*|  TASK_ORCH_PUBLIC_URL = \"$NEXTAUTH_URL\"|" fly.toml
rm -f fly.toml.bak

if [[ -n "${DATABASE_URL:-}" ]]; then
  "$FLY" secrets set -a "$APP" --stage DATABASE_URL="$DATABASE_URL"
elif ! "$FLY" secrets list -a "$APP" 2>/dev/null | grep -qw DATABASE_URL; then
  if ! "$FLY" apps list 2>/dev/null | awk '{print $1}' | grep -qx "$PG_APP"; then
    "$FLY" postgres create --name "$PG_APP" --org "$ORG" --region "$REGION" --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 10
  fi
  "$FLY" postgres attach "$PG_APP" --app "$APP" || true
fi

# AUTH_SECRET signs every worker channel credential baked into a sprite (and
# every browser session). Rotating it on each deploy silently invalidates all
# existing sprites (401 on dial, 2026-08-27). Set it only when the caller
# supplies one or the app has none yet.
secrets=(NEXTAUTH_URL="$NEXTAUTH_URL")
if [[ -n "${AUTH_SECRET:-}" ]]; then
  secrets+=(AUTH_SECRET="$AUTH_SECRET")
else
  # Read the list into a variable: `list | grep -q` under pipefail fails when
  # grep closes the pipe early, which minted a new secret (2026-08-27).
  existing_secrets="$("$FLY" secrets list -a "$APP" 2>/dev/null || true)"
fi
if [[ -z "${AUTH_SECRET:-}" ]] && ! grep -qw AUTH_SECRET <<<"${existing_secrets:-}"; then
  secrets+=(AUTH_SECRET="$(openssl rand -base64 32)")
fi
# Optional pi-backend provider keys (TASK_ORCH_AGENT_BACKEND=pi): whatever the
# web app holds is forwarded into each worker's env by the server
# (lib/agent-backend/provider-env.ts, AGENT_CREDENTIAL_ENV_KEYS). Stage any set.
for key in GH_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN GITHUB_WEBHOOK_SECRET SPRITES_TOKEN \
           OPENAI_API_KEY GEMINI_API_KEY GROQ_API_KEY CEREBRAS_API_KEY XAI_API_KEY \
           OPENROUTER_API_KEY ZAI_API_KEY MISTRAL_API_KEY DEEPSEEK_API_KEY FIREWORKS_API_KEY; do
  [[ -n "${!key:-}" ]] && secrets+=("$key=${!key}")
done
"$FLY" secrets set -a "$APP" --stage "${secrets[@]}"
# --ha=false: ONE web Machine — the pending-run pump and the sprites sweep are
# process-wide singletons; a second machine would double-dispatch runs.
"$FLY" deploy --config fly.toml --app "$APP" --ha=false

if [[ -n "${ADMIN_EMAIL:-}" && -n "${ADMIN_PASSWORD:-}" ]]; then
  # ${var@Q}: shell-quote — the -C string is re-parsed by the remote shell.
  "$FLY" ssh console -a "$APP" -C "npm run task -- user add ${ADMIN_EMAIL@Q} --password=${ADMIN_PASSWORD@Q}" \
    || echo "Could not create the admin user automatically; run: $FLY ssh console -a $APP -C \"npm run task -- user add you@example.com --password=...\"" >&2
else
  echo "No ADMIN_EMAIL/ADMIN_PASSWORD set. Create a login with: $FLY ssh console -a $APP -C \"npm run task -- user add you@example.com --password=...\""
fi
echo "Deployed control plane: $NEXTAUTH_URL"
