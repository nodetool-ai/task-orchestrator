#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Task Orchestrator — one-command Fly.io deploy (server + runners + database)
#
# Brings the WHOLE app up on Fly.io from scratch:
#   1. a web/control-plane app        (Next.js server, this repo's Dockerfile.server)
#   2. a runner app                   (per-run Fly Machines + Volumes, Dockerfile.fly-runner)
#   3. a Postgres database            (Fly Postgres, or bring your own DATABASE_URL)
#
# and wires the secrets that connect them (DATABASE_URL, AUTH_SECRET, a Fly API
# token so the server can spawn runner Machines, model/GitHub credentials).
#
# Usage:
#   ./scripts/fly-deploy.sh                    # interactive: prompts for secrets
#   FLY_APP=my-orch FLY_REGION=iad \
#     GH_TOKEN=ghp_... ANTHROPIC_API_KEY=sk-... \
#     ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... \
#     ./scripts/fly-deploy.sh                  # non-interactive
#
# Re-runnable: every step is idempotent, so re-running redeploys with the same
# apps/database and only re-applies what changed.
#
# Prerequisites: `flyctl` installed (https://fly.io/docs/flyctl/install) and
# logged in (`fly auth login`). A Fly org with a payment method on file.
# -----------------------------------------------------------------------------
# Configuration (override any of these via the environment):
#   FLY_APP           web app name              (default: task-orchestrator)
#   FLY_RUNNER_APP    runner pool app name      (default: ${FLY_APP}-runners)
#   FLY_PG_APP        Fly Postgres app name     (default: ${FLY_APP}-db)
#   FLY_REGION        primary region            (default: ams)
#   FLY_ORG           Fly organization slug     (default: personal)
#   DATABASE_URL      bring-your-own Postgres   (skips Fly Postgres provisioning)
#   NEXTAUTH_URL      public origin             (default: https://${FLY_APP}.fly.dev)
#   AUTH_SECRET       session-signing secret    (default: generated)
#   GH_TOKEN                  GitHub token for clone/push + `gh pr create`
#   ANTHROPIC_API_KEY        Claude API key  (or ...)
#   CLAUDE_CODE_OAUTH_TOKEN  ...claude.ai subscription token (`claude setup-token`)
#   OPENAI_API_KEY / GEMINI_API_KEY / ...  pi-backend provider keys (staged when set)
#   NOTE: Codex (ChatGPT) is NOT staged here — sign in from Settings once deployed
#   and the token is stored in the DB (codex_credentials), surviving redeploys.
#   ADMIN_EMAIL / ADMIN_PASSWORD   first dashboard login to create
#   FLY_PIPE=1        also deploy the Discord bridge (fly.pipe.toml) as a
#                     separate app; implied when FLY_PIPE_APP is set
#   FLY_PIPE_APP      Discord pipe app name     (default: ${FLY_APP}-pipe)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

APP="${FLY_APP:-task-orchestrator}"
RUNNER_APP="${FLY_RUNNER_APP:-${APP}-runners}"
PG_APP="${FLY_PG_APP:-${APP}-db}"
REGION="${FLY_REGION:-ams}"
ORG="${FLY_ORG:-personal}"
NEXTAUTH_URL="${NEXTAUTH_URL:-https://${APP}.fly.dev}"
RUNNER_IMAGE="registry.fly.io/${RUNNER_APP}:latest"
# The Discord bridge is OPT-IN: a deployment with no persona bots should not pay
# for a Machine that refuses to boot. Naming FLY_PIPE_APP implies the opt-in.
PIPE_APP="${FLY_PIPE_APP:-${APP}-pipe}"
DEPLOY_PIPE=0
[[ -n "${FLY_PIPE_APP:-}" || "${FLY_PIPE:-0}" == "1" ]] && DEPLOY_PIPE=1
# Step count in the progress headers; the pipe adds one.
TOTAL=6
(( DEPLOY_PIPE )) && TOTAL=7

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# `fly` or `flyctl` — accept either.
FLY="$(command -v fly || command -v flyctl || true)"
[[ -n "$FLY" ]] || die "flyctl not found. Install it: https://fly.io/docs/flyctl/install"

# ── Preflight ────────────────────────────────────────────────────────────────
bold "=== Task Orchestrator → Fly.io ==="
"$FLY" auth whoami >/dev/null 2>&1 || die "Not logged in. Run: $FLY auth login"
info "Logged in as: $("$FLY" auth whoami 2>/dev/null)"
info "Web app:    $APP      (region $REGION, org $ORG)"
info "Runner app: $RUNNER_APP"
(( DEPLOY_PIPE )) && info "Pipe app:   $PIPE_APP  (Discord bridge)"

# Keep the fly.toml primary_region in sync with FLY_REGION so the web + runner +
# pipe apps land where the database does. No-op when FLY_REGION is the default.
sed -i.bak "s/^primary_region = .*/primary_region = \"$REGION\"/" fly.toml fly.runner.toml fly.pipe.toml \
  && rm -f fly.toml.bak fly.runner.toml.bak fly.pipe.toml.bak
[[ -n "${DATABASE_URL:-}" ]] && info "Database:   (bring-your-own DATABASE_URL)" \
                             || info "Database:   $PG_APP (Fly Postgres)"
echo ""

# ── Prompt for any still-missing credentials (interactive runs only) ─────────
prompt_secret() {  # var_name  human_label
  local var="$1" label="$2" val="${!1:-}"
  if [[ -z "$val" && -t 0 ]]; then
    read -rsp "  $label: " val; echo ""
    printf -v "$var" '%s' "$val"
  fi
}
prompt_secret GH_TOKEN "GitHub token (repo+workflow scope, for clone/push + PRs) [enter to skip]"
if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  prompt_secret ANTHROPIC_API_KEY "Anthropic API key (or leave blank to use a claude.ai OAuth token)"
  [[ -z "${ANTHROPIC_API_KEY:-}" ]] && prompt_secret CLAUDE_CODE_OAUTH_TOKEN "claude.ai OAuth token (claude setup-token)"
fi
[[ -n "${GH_TOKEN:-}" ]] || warn "No GH_TOKEN set — agents can't clone/push or open PRs until you add it."
[[ -n "${ANTHROPIC_API_KEY:-}" || -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] \
  || warn "No Claude credential set — agent runs will fail until you add ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN."

AUTH_SECRET="${AUTH_SECRET:-$(openssl rand -base64 32)}"

# ── 1. Apps ──────────────────────────────────────────────────────────────────
bold "--- 1/$TOTAL  Creating Fly apps ---"
create_app() {  # app_name
  # Exact-match on the NAME column: grep -qw treats '-' as a word boundary, so
  # "task-orchestrator" would false-positive on "task-orchestrator-runners".
  if "$FLY" apps list 2>/dev/null | awk '{print $1}' | grep -qx "$1"; then
    info "app $1 already exists"
  else
    "$FLY" apps create "$1" --org "$ORG" && info "created app $1"
  fi
}
create_app "$APP"
create_app "$RUNNER_APP"
(( DEPLOY_PIPE )) && create_app "$PIPE_APP"

# ── 2. Database ──────────────────────────────────────────────────────────────
bold "--- 2/$TOTAL  Provisioning database ---"
if [[ -n "${DATABASE_URL:-}" ]]; then
  info "Using supplied DATABASE_URL; staging it as a secret."
  "$FLY" secrets set -a "$APP" --stage DATABASE_URL="$DATABASE_URL" >/dev/null
elif "$FLY" secrets list -a "$APP" 2>/dev/null | grep -qw DATABASE_URL; then
  info "DATABASE_URL secret already present on $APP — leaving it."
else
  if ! "$FLY" apps list 2>/dev/null | awk '{print $1}' | grep -qx "$PG_APP"; then
    info "Creating Fly Postgres cluster $PG_APP (this takes a minute)..."
    "$FLY" postgres create \
      --name "$PG_APP" --org "$ORG" --region "$REGION" \
      --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 10
  else
    info "Postgres app $PG_APP already exists."
  fi
  info "Attaching $PG_APP to $APP (sets DATABASE_URL over the 6PN private network)..."
  "$FLY" postgres attach "$PG_APP" --app "$APP" \
    || warn "postgres attach reported an error (already attached?) — continuing."
fi

# The pipe is a second reader/writer of the SAME database — it shares runs,
# personas and discord_bots with the web app. Secrets can't be read back out of
# Fly, so the pipe gets its own DATABASE_URL: either the supplied one verbatim,
# or a second attach that mints a distinct PG role against the SAME database
# (`--database-name`, defaulted the way the server's attach names it). A fresh
# attach with no --database-name would create an empty `<pipe-app>` database and
# the bridge would migrate itself a private, useless schema.
if (( DEPLOY_PIPE )); then
  if [[ -n "${DATABASE_URL:-}" ]]; then
    info "Staging the supplied DATABASE_URL on $PIPE_APP."
    "$FLY" secrets set -a "$PIPE_APP" --stage DATABASE_URL="$DATABASE_URL" >/dev/null
  elif "$FLY" secrets list -a "$PIPE_APP" 2>/dev/null | grep -qw DATABASE_URL; then
    info "DATABASE_URL secret already present on $PIPE_APP — leaving it."
  else
    info "Attaching $PG_APP to $PIPE_APP (same database, its own role)..."
    "$FLY" postgres attach "$PG_APP" --app "$PIPE_APP" \
      --database-name "${APP//-/_}" --database-user "${PIPE_APP//-/_}" \
      || warn "postgres attach for $PIPE_APP reported an error (already attached?) — continuing."
  fi
fi

# ── 3. Runner image ──────────────────────────────────────────────────────────
# Build + push the runner image into the runner app's registry WITHOUT releasing
# a machine (the server creates run Machines on demand from this image).
bold "--- 3/$TOTAL  Building + pushing runner image ---"
"$FLY" deploy --config fly.runner.toml --app "$RUNNER_APP" \
  --dockerfile Dockerfile.fly-runner --build-only --push --image-label latest
info "Pushed $RUNNER_IMAGE"

# ── 4. Runner API token + secrets ────────────────────────────────────────────
bold "--- 4/$TOTAL  Wiring secrets ---"
# App-scoped token the server uses to create/destroy runner Machines + Volumes.
info "Minting a Fly API token scoped to $RUNNER_APP..."
# Grab only the token line (starts with "FlyV1 "); it has no internal newlines,
# so this is robust against any flyctl notice printed alongside it.
FLY_API_TOKEN="$("$FLY" tokens create deploy --app "$RUNNER_APP" --expiry 8760h --name task-orch-runner 2>/dev/null | grep -m1 '^FlyV1 ')"
[[ -n "$FLY_API_TOKEN" ]] || die "Failed to mint a Fly API token for $RUNNER_APP."

secret_args=(
  AUTH_SECRET="$AUTH_SECRET"
  NEXTAUTH_URL="$NEXTAUTH_URL"
  FLY_API_TOKEN="$FLY_API_TOKEN"
  # NB: use TASK_ORCH_FLY_APP, NOT FLY_APP_NAME — Fly's runtime reserves
  # FLY_APP_NAME and injects the web Machine's own app name over any secret,
  # which would point the runner client at the wrong app (403 unauthorized).
  TASK_ORCH_FLY_APP="$RUNNER_APP"
  FLY_RUNNER_IMAGE="$RUNNER_IMAGE"
  TASK_ORCH_FLY_REGION="$REGION"
)
# Model/GitHub credentials, kept in their own array: the pipe app needs exactly
# this subset too (its persona turns call the same providers and the same
# in-process GitHub client), while the app-identity secrets above are per-app.
cred_args=()
[[ -n "${GH_TOKEN:-}" ]]                 && cred_args+=( GH_TOKEN="$GH_TOKEN" )
[[ -n "${ANTHROPIC_API_KEY:-}" ]]        && cred_args+=( ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" )
[[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]  && cred_args+=( CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" )
# Optional pi-backend provider keys (TASK_ORCH_AGENT_BACKEND=pi): whatever the
# web app holds is forwarded into each runner Machine's env by the server
# (lib/agent-backend/provider-env.ts). Stage any that are set in the deploy env.
# CODEX_ACCESS_TOKEN is deliberately absent: the Codex credential is obtained
# through the device-code login in Settings and lives in the codex_credentials
# table, so it outlives a deploy and can be rotated without one. The server
# still forwards it to runner Machines as env — that is transport, not config.
for key in OPENAI_API_KEY GEMINI_API_KEY GROQ_API_KEY CEREBRAS_API_KEY XAI_API_KEY \
           OPENROUTER_API_KEY ZAI_API_KEY MISTRAL_API_KEY DEEPSEEK_API_KEY FIREWORKS_API_KEY; do
  [[ -n "${!key:-}" ]] && cred_args+=( "$key=${!key}" )
done
# ${arr[@]+"${arr[@]}"}: expand to nothing when empty rather than tripping `set -u`
# on bash 3.2 (still the system bash on macOS).
secret_args+=( ${cred_args[@]+"${cred_args[@]}"} )
# Webhook verification is server-only: GitHub delivers to the web app.
[[ -n "${GITHUB_WEBHOOK_SECRET:-}" ]]    && secret_args+=( GITHUB_WEBHOOK_SECRET="$GITHUB_WEBHOOK_SECRET" )
"$FLY" secrets set -a "$APP" --stage "${secret_args[@]}" >/dev/null
info "Staged ${#secret_args[@]} secrets on $APP."

if (( DEPLOY_PIPE )); then
  # The bridge dispatches the child worker runs its personas spawn, so it needs
  # its own runner credentials — a second, separately revocable token rather
  # than a copy of the server's.
  info "Minting a Fly API token scoped to $RUNNER_APP for $PIPE_APP..."
  PIPE_FLY_API_TOKEN="$("$FLY" tokens create deploy --app "$RUNNER_APP" --expiry 8760h --name task-orch-pipe 2>/dev/null | grep -m1 '^FlyV1 ')"
  [[ -n "$PIPE_FLY_API_TOKEN" ]] || die "Failed to mint a Fly API token for $PIPE_APP."
  pipe_secret_args=(
    FLY_API_TOKEN="$PIPE_FLY_API_TOKEN"
    TASK_ORCH_FLY_APP="$RUNNER_APP"
    FLY_RUNNER_IMAGE="$RUNNER_IMAGE"
    TASK_ORCH_FLY_REGION="$REGION"
    # Deep links the personas put next to every task/plan/run id point at the
    # dashboard, which is the WEB app's origin, not this one (PRD §8).
    TASK_ORCH_PUBLIC_URL="$NEXTAUTH_URL"
  )
  pipe_secret_args+=( ${cred_args[@]+"${cred_args[@]}"} )
  # DISCORD_* remain optional: Settings -> Discord stores bot tokens in the
  # discord_bots table, which this app already reads over DATABASE_URL. These
  # are the legacy env path, staged only when the deploy env carries them.
  for key in DISCORD_BOT_TOKEN DISCORD_DEFAULT_PERSONA DISCORD_ALLOWED_USERS DISCORD_ALLOWED_CHANNELS; do
    [[ -n "${!key:-}" ]] && pipe_secret_args+=( "$key=${!key}" )
  done
  "$FLY" secrets set -a "$PIPE_APP" --stage "${pipe_secret_args[@]}" >/dev/null
  info "Staged ${#pipe_secret_args[@]} secrets on $PIPE_APP."
fi

# ── 5. Deploy the server ─────────────────────────────────────────────────────
bold "--- 5/$TOTAL  Deploying the server ---"
# Migrations apply on boot (instrumentation.ts -> initDb) against the attached DB.
# The web Machine lands in fly.toml's primary_region (synced to FLY_REGION above).
# --ha=false: keep a SINGLE web Machine — the pending-run pump and Fly monitor are
# process-wide singletons, so a second HA machine would double-dispatch runs.
"$FLY" deploy --config fly.toml --app "$APP" --ha=false

# ── 5b. Deploy the Discord pipe ──────────────────────────────────────────────
if (( DEPLOY_PIPE )); then
  bold "--- 6/$TOTAL  Deploying the Discord pipe ---"
  # AFTER the server, so migrations have already been applied by the web app's
  # boot (the bridge's `import "../db"` runs them too, but ordering it second
  # keeps one process responsible for schema).
  #
  # --ha=false is not optional here, it is the correctness constraint: Discord
  # permits ONE gateway session per bot token, and a second Machine would make
  # every bot answer every message twice.
  "$FLY" deploy --config fly.pipe.toml --app "$PIPE_APP" --ha=false \
    || warn "Pipe deploy failed. If the bridge refused to boot, check '$FLY logs -a $PIPE_APP' — \
it exits when no Discord bot is configured yet. Add one in Settings -> Discord, then re-run."
fi

# ── 6. First user ────────────────────────────────────────────────────────────
bold "--- $TOTAL/$TOTAL  Admin account ---"
if [[ -n "${ADMIN_EMAIL:-}" && -n "${ADMIN_PASSWORD:-}" ]]; then
  info "Creating dashboard login $ADMIN_EMAIL..."
  # ${var@Q}: shell-quote the credentials — the -C string is re-parsed by the
  # remote shell, so an unquoted password with spaces/metacharacters would be
  # word-split or executed there.
  "$FLY" ssh console -a "$APP" -C "npm run task -- user add ${ADMIN_EMAIL@Q} --password=${ADMIN_PASSWORD@Q}" \
    || warn "Could not create the admin user automatically — create it manually (see below)."
else
  info "Set ADMIN_EMAIL + ADMIN_PASSWORD to auto-create a login, or run:"
  info "  $FLY ssh console -a $APP -C \"npm run task -- user add you@example.com --password=...\""
fi

echo ""
bold "=== Done ==="
info "Dashboard: $NEXTAUTH_URL"
info "Status:    $FLY status -a $APP        Logs: $FLY logs -a $APP"
info "Runners:   $FLY machine list -a $RUNNER_APP"
if (( DEPLOY_PIPE )); then
  info "Pipe:      $FLY logs -a $PIPE_APP     Restart: $FLY machine restart -a $PIPE_APP"
  info "           Add persona bots in Settings → Discord, then redeploy/restart it —"
  info "           the bridge reads its bot config once, at boot."
else
  info "Discord:   not deployed. Re-run with FLY_PIPE=1 to add the persona-bot bridge."
fi
