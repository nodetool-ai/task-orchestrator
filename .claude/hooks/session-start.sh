#!/usr/bin/env bash
#
# SessionStart hook — provisions the repo so Claude Code (esp. on the web) can
# build, test, typecheck, and lint immediately. Registered in .claude/settings.json.
#
# Runs synchronously: the session waits until this finishes, so dependencies and
# the database are guaranteed ready before the agent runs anything. Idempotent.
#
# What it does:
#   1. npm install (cached after first run in the web sandbox)
#   2. brings up the dev Postgres (scripts/dev-db.sh; uses the host pg cluster
#      when Docker isn't reachable, as in the web sandbox)
#   3. exports DATABASE_URL into the session (via $CLAUDE_ENV_FILE) so `npm test`
#      and CLI commands point at it
#   4. applies Drizzle migrations + seeds required personas
set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

# 1. Dependencies — `install` (not `ci`) so a warm node_modules is reused.
if [ ! -d node_modules ]; then
  npm install
fi

# 2. Database.
DB_URL="$(bash scripts/dev-db.sh up)"

# 3. Persist DATABASE_URL for the rest of the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export DATABASE_URL=\"${DB_URL}\"" >> "$CLAUDE_ENV_FILE"
fi
export DATABASE_URL="$DB_URL"

# 4. Migrate + seed (initDb applies migrations; both are idempotent).
npx tsx -e "import('./db').then(m => m.initDb()).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); })"
timeout 90 npm run db:seed >/dev/null 2>&1 || true

echo "Setup complete — DATABASE_URL=${DB_URL}"
