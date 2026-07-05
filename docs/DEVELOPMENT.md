# Development setup

Fast path from a fresh clone to a working build/test/dev loop. Written for
both humans and AI agents picking up work in this repo.

## TL;DR

```bash
npm run setup      # deps + Postgres + .env.local + migrations + personas
npm run dev        # http://localhost:3000
npm test           # Vitest suite
```

`npm run setup` is idempotent — re-run it anytime. Everything below is what it
does under the hood, plus the day-to-day commands.

## Prerequisites

- **Node 20+** (22 recommended — see [`.nvmrc`](../.nvmrc)). `nvm use` if you use nvm.
- **A Postgres 16** — the app and the tests need one. You don't have to install
  it by hand: `npm run setup` (and `npm run db:up`) provision a throwaway
  instance for you, using whichever is available:
  - **Docker** (developer-laptop default) — a `postgres:16-alpine` container
    named `taskorch-pg-dev` on `localhost:5433`.
  - **the host's apt `postgresql-16` cluster** — used automatically where the
    Docker daemon isn't reachable (CI, the Claude Code web sandbox). The helper
    reconfigures it to listen on `:5433` so the connection string is identical.

Either way you end up with the canonical dev database:

```
DATABASE_URL=postgres://postgres:devpw@localhost:5433/taskorch
```

This exact URL is the hard-coded fallback in [`vitest.setup.ts`](../vitest.setup.ts),
so tests work with no extra configuration once Postgres is up.

## One-command setup

```bash
npm run setup
```

Steps (each idempotent):

1. Verify Node ≥ 20.
2. `npm install` (only if `node_modules` is missing; `--reinstall` forces it).
   `.npmrc` sets `legacy-peer-deps=true` — the SDK's zod peer range is cosmetic.
3. Start Postgres via `scripts/dev-db.sh up`.
4. Write `.env.local` with a generated `AUTH_SECRET` (if it doesn't exist yet).
5. Apply Drizzle migrations (`initDb()`) and seed the required personas.

There is **no separate migrate step** in normal use: `initDb()` applies
`db/migrations/*.sql` on every server boot (`instrumentation.ts`) and before
every test file (`vitest.setup.ts`).

## The database helper

`scripts/dev-db.sh` (wrapped by npm scripts) manages the throwaway Postgres:

```bash
npm run db:up        # start it (idempotent), wait until it accepts connections
npm run db:down      # stop it
npm run db:status    # up / down
scripts/dev-db.sh reset   # drop + recreate the `taskorch` database
scripts/dev-db.sh url     # print the DATABASE_URL to use
```

Force a backend with `TASK_ORCH_DB_DRIVER=docker` or `=local` (default: auto).

## Everyday commands

```bash
npm run dev         # Next.js dev server, http://localhost:3000
npm run build       # production build
npm start           # run the production build

npm test            # Vitest suite (parallel; each file gets its own PG schema)
npm run test:watch  # watch mode
npm run typecheck   # tsc --noEmit — the primary static-analysis gate
npm run lint        # next lint (prompts to configure ESLint on first run)

npm run task -- list          # CLI (talks to the DB directly, no server needed)
npm run db:seed:demo          # optional demo plan + tasks
```

## Running the tests

```bash
npm run db:up   # once, if Postgres isn't already up
npm test
```

Each test file runs in its own fork and gets an isolated Postgres schema
(`TASK_ORCH_PG_SCHEMA`, set per-fork in `vitest.setup.ts`) so parallel files
never collide. To pin a single file:

```bash
npx vitest run __tests__/repo.test.ts
```

## Claude Code on the web

A [`SessionStart` hook](../.claude/hooks/session-start.sh) runs the same
provisioning automatically when a web session starts, so tests and linters
work immediately — no manual setup. It installs dependencies, brings up
Postgres, and exports `DATABASE_URL` into the session. It runs **synchronously**
(the session waits for it) to avoid race conditions; the trade-off is a slightly
slower session start. See [`.claude/settings.json`](../.claude/settings.json).

## Troubleshooting

- **`ECONNREFUSED 127.0.0.1:5433`** — Postgres isn't up. `npm run db:up`.
- **`AUTH_SECRET` errors on boot** — `.env.local` is missing or empty. Re-run
  `npm run setup`, or add `AUTH_SECRET=$(openssl rand -base64 32)`.
- **Auth / peer-dependency install failures** — ensure `legacy-peer-deps` is
  active (it's in `.npmrc`); try `npm run setup --reinstall`.
- **Migrations look stale** — `initDb()` applies them on every boot; to start
  from scratch run `scripts/dev-db.sh reset` then `npm run setup`.
- **Docker not available** — expected in some sandboxes; the helper falls back
  to the host Postgres cluster automatically. Nothing to do.

## Where to look next

- [AGENTS.md](../AGENTS.md) — the task workflow contract (states, CLI, sessions)
- [SCHEMA.md](../SCHEMA.md) — DB schema, state machines, REST surface
- [README.md](../README.md) — product overview, deployment, agent sessions
