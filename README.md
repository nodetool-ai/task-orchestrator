# Task Orchestrator

Task Orchestrator is a web app for getting coding work done by AI agents.
You describe the work — a plan, broken into tasks, each with a checklist
that defines "done" — then hand a task to a Claude agent. The agent writes
the code on its own branch, opens a pull request on GitHub, and reports
back. You watch its progress live, review the result, and merge.

## How it works

1. **Plan.** Create a plan and split it into tasks. Give each task
   acceptance criteria — a plain checklist of what must be true when
   the work is finished.
2. **Delegate.** Press "Run agent" on a task (or use the API or command
   line). A Claude agent picks it up and starts coding in an isolated
   copy of your repository, so it never touches your working files.
3. **Watch.** Follow the agent's activity as it happens: every action,
   the checklist filling in, and what the run is costing.
4. **Review.** The agent pushes its branch and opens a pull request.
   You review it like any teammate's work. Merging it marks the task done.

Everything ships as one self-contained system: the web dashboard, a REST
API, and a `npm run task` command-line tool all share the same code and a
single Postgres database.

## Learn more

- **[SCHEMA.md](SCHEMA.md)** — DB schema, state machines, REST surface
- **[AGENTS.md](AGENTS.md)** — workflow contract for humans and agents
- **[docs/fly-deployment.md](docs/fly-deployment.md)** — one-command deploy of the
  whole app (server + agent runners + database) to Fly.io
- **[docs/test-deployment.md](docs/test-deployment.md)** — full containerized
  stack (Postgres + server + Docker workers) for validating the run → PR loop

## Run

The app needs a Postgres instance reachable via `DATABASE_URL`. For local
dev, a throwaway container is enough — schema migrations apply automatically
on boot (`instrumentation.ts` → `initDb()`), there's no separate migrate step.

```bash
# 1. Start a dev Postgres (matches the default DATABASE_URL below)
docker run -d --name taskorch-pg-dev -p 127.0.0.1:5433:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=devpw -e POSTGRES_DB=taskorch \
  postgres:16-alpine

# 2. Configure .env.local (copy from .env.example and fill in)
cp .env.example .env.local
# then add:
#   DATABASE_URL=postgres://postgres:devpw@localhost:5433/taskorch
#   AUTH_SECRET=<openssl rand -base64 32>

npm install
npm run dev        # http://localhost:3000 — applies migrations + seeds on boot
npm run db:seed    # demo plan + tasks (idempotent, optional)
```

Migrations live under `db/migrations/` (Drizzle SQL); `npm run db:generate`
regenerates them after a `db/schema.ts` change. There's no `db:migrate`
script — applying is folded into `initDb()`, called from `instrumentation.ts`
on every server boot (dev and prod) and from `vitest.setup.ts` for tests
(each test file gets its own Postgres schema via `TASK_ORCH_PG_SCHEMA` for
parallel isolation). To apply migrations without booting the full server:

```bash
DATABASE_URL=postgres://postgres:devpw@localhost:5433/taskorch \
  npx tsx -e "import('./db/index').then(m => m.initDb())"
```

If you're moving data from an older SQLite-backed deployment, use the two
one-shot ETL scripts (config tables, then run transcripts):

```bash
SOURCE_SQLITE_DB=/path/to/data.db DATABASE_URL=<postgres-url> \
  npx tsx scripts/migrate-sqlite-to-pg.ts
SOURCE_SQLITE_DB=/path/to/data.db DATABASE_URL=<postgres-url> \
  npx tsx scripts/migrate-transcripts-sqlite-to-pg.ts
```

Both are idempotent (`--dry-run` to preview) and only relevant for that
one-time cutover — a fresh dev setup doesn't need them.

Set `TASK_ORCH_TARGET_REPO=/path/to/your/repo` to point agent sessions at
a different checkout. All `git worktree` operations and `gh pr create`
calls run against that repo; if unset, the orchestrator works on its own
source tree.

HTTP access is gated by email + password sign-in (Auth.js v5, Credentials
provider). User accounts live in the `users` table with bcrypt password
hashes. Set:

- `AUTH_SECRET` — random string for signing session JWTs (`openssl rand -base64 32`)
- `NEXTAUTH_URL` — public origin in production (e.g. `https://orch.example.com`)

Create the first user from the CLI:

```bash
npm run task -- user add you@example.com           # prompts for password
npm run task -- user add bot@example.com --password=...  # non-interactive
npm run task -- user list
npm run task -- user passwd you@example.com
npm run task -- user rm bot@example.com
```

Unauthenticated browser visitors are redirected to `/login`; API requests
get a 401. The CLI talks to the DB directly, so the gate doesn't apply
there.

## Deploy to Fly.io (whole app + database, one command)

Run the entire system — web UI, REST API, agent runners, and Postgres — on
Fly.io. Agent runs execute as ephemeral Fly Machines (one Machine + persistent
Volume per run) instead of local Docker containers, so no host with a Docker
socket is required.

```bash
cp .env.fly.example .env.fly       # fill in GH_TOKEN, a Claude credential, admin login
set -a; . ./.env.fly; set +a
./scripts/fly-deploy.sh            # creates apps + Postgres, wires secrets, deploys
```

The script provisions two Fly apps (the `task-orchestrator` server and a
`task-orchestrator-runners` pool) plus a Fly Postgres, stages every secret that
connects them (`DATABASE_URL`, `AUTH_SECRET`, a scoped `FLY_API_TOKEN` for the
Machines API, model/GitHub creds), and creates your first login. It's
idempotent — re-run it to redeploy. Full walkthrough + tuning knobs:
**[docs/fly-deployment.md](docs/fly-deployment.md)**.

## Production deployment (systemd + Docker Compose)

Production runs on `nodetool-api` at `https://tasks.nodetool.ai`. The
box listens on plain HTTP at `localhost:3000`; a Cloudflare Tunnel
(`nodetool-deploy`, remote-managed) routes the public hostname to it,
and Cloudflare's edge presents Universal SSL — no certs live on the
server.

Install as a systemd service (one-time, as root):

```bash
sudo bash scripts/install-service.sh
```

That creates `/var/lib/task-orchestrator/`, writes
`/etc/systemd/system/task-orchestrator.service`, and drops a scoped
sudoers file at `/etc/sudoers.d/claude-task-orchestrator` so the
service user can `systemctl start|stop|restart|enable|disable
task-orchestrator` and tail `journalctl -u task-orchestrator`
passwordless. The unit sources nvm (`. ~/.nvm/nvm.sh`) before invoking
`npm run start`.

Adding a new public hostname to the tunnel is a dashboard action:
Zero Trust → Networks → Tunnels → `nodetool-deploy` → Public Hostnames.

### Detached run workers (`TASK_ORCH_DETACHED_RUNS`)

By default an agent run executes inside the web-server process, so a
`systemctl restart` of the service kills every in-flight run. Set
`TASK_ORCH_DETACHED_RUNS=1` to relocate turn execution into a per-run
transient `systemd-run --user --scope` unit. The scope is a separate
cgroup, so restarting (or stopping) the web unit can no longer signal a
running worker — runs survive a redeploy and keep streaming to the run
view, which now tails the `agent_messages` / `agent_events` tables by
cursor rather than an in-process event bus. Cancel is DB-mediated
(`cancel_requested`), and on boot the web process reconciles orphaned
runs, re-dispatching resumable ones to fresh workers instead of failing
them.

Requirements on the host:

- `systemd-run --user` must work, which needs a running user systemd
  manager for the service account with **lingering** enabled
  (`loginctl enable-linger <user>`). `deploy.sh` enables this idempotently
  on every deploy; without a user manager the worker falls back to a plain
  detached `spawn` (fine for dev, but such a worker is not protected from a
  web restart).

The flag defaults **off**: unset (or `0` / `false`) keeps today's
in-process behavior, so rollback is instant. Enable it by adding
`TASK_ORCH_DETACHED_RUNS=1` to the web unit's environment (e.g. an
`Environment=` line in the `[Service]` section or `.env.local`) once the
lingering prerequisite is verified.

## CLI

`npm run task -- <cmd>` from the repo root:

```bash
npm run task -- list                                          # all tasks
npm run task -- list --state=todo
npm run task -- plans                                         # list plans
npm run task -- show T-20260511-0001                          # task detail
npm run task -- show P-2026-05-11-task-system                 # plan detail

npm run task -- new plan --title="Streaming exec"             # → P-2026-MM-DD-streaming-exec
npm run task -- new task --plan=P-... --title="Wire up SSE" \
    --assignee=claude --tags=backend,ssr \
    --criteria="endpoint returns 200,sse frames flush"

npm run task -- transition T-... in_progress --assignee=claude
npm run task -- transition T-... review
npm run task -- transition T-... done                         # gated by open criteria

npm run task -- note T-... --body="implementation choice X" --author=alice
npm run task -- crit add T-... --text="latency p95 < 50ms"
npm run task -- crit done <criterion-id>

npm run task -- attach add T-... ./mockup.png   # attach to a task (or P-... for a plan)
npm run task -- attach list T-...
npm run task -- attach get <attachment-id> --out=./out.png
npm run task -- attach rm <attachment-id>
```

The CLI imports `lib/repo.ts` directly — no HTTP server required.

## REST

The same operations, exposed for external clients such as agents:

```
GET    /api/plans
POST   /api/plans
GET    /api/plans/:id              # → plan + tasks + progress
PATCH  /api/plans/:id
DELETE /api/plans/:id

GET    /api/tasks?state=todo&plan=P-...
POST   /api/tasks
GET    /api/tasks/:id
PATCH  /api/tasks/:id
DELETE /api/tasks/:id
POST   /api/tasks/:id/transition   # { state, assignee?, note? }
POST   /api/tasks/:id/notes        # { author, body }
POST   /api/tasks/:id/criteria     # { text }
PATCH  /api/tasks/:id/criteria/:cid  # { done?, text? }
DELETE /api/tasks/:id/criteria/:cid

GET    /api/plans/:id/attachments        # list image/artifact metadata
POST   /api/plans/:id/attachments        # multipart `file`, or JSON {filename,mimeType,dataBase64}
GET    /api/tasks/:id/attachments        # list image/artifact metadata
POST   /api/tasks/:id/attachments        # multipart `file`, or JSON {filename,mimeType,dataBase64}
GET    /api/attachments/:id              # raw bytes (add ?download=1 to force save)
DELETE /api/attachments/:id

POST   /api/tasks/:id/sessions     # { model?, baseBranch? } — start agent
GET    /api/sessions[?active=true]
GET    /api/sessions/:id           # → session + full event log
GET    /api/sessions/:id/events    # SSE, ?since=<eventId> to resume
POST   /api/sessions/:id/cancel
```

## Agent sessions

Run an autonomous Claude Agent SDK session on any task — from the web
("Run agent" on the task detail page), from REST, or from the CLI:

```bash
npm run task -- agent T-20260511-0001 [--model=claude-sonnet-4-5]
npm run task -- agent list
npm run task -- agent cancel <session-id>
```

Each session:

1. Creates a fresh git worktree at `.worktrees/<sessionId>/` on a new branch
   `claude/agent-<sessionId>`, symlinking `node_modules` and the
   Turbopack/Next.js build cache (`.next`) back to the repo root so every
   worktree shares one install and one warm build cache. A worktree that
   needs its own dependencies or a clean build can opt out with
   `npm run isolate-env`, which swaps the shared symlinks for a private
   `node_modules` and `.next` and reinstalls. To preview the branch in a
   browser, `npm run worktree-dev` starts the Next.js dev server on a stable
   per-worktree port bound to loopback (behind the app's login); add
   `-- --tunnel` for a secure HTTPS Cloudflare URL
2. Transitions the task to `in_progress` (assignee `claude-agent`)
3. Runs the SDK with `permissionMode: "bypassPermissions"`, the task
   body and acceptance criteria as the prompt, and the worktree as cwd
4. Pushes the branch and opens a PR via `gh pr create`
5. Transitions the task to `review` (or `blocked` on failure) and adds
   a note linking the PR

Sessions run in parallel. The live event stream is served at
`GET /api/sessions/[id]/events` (SSE) and rendered on
`/sessions/[id]`. Cancel via `POST /api/sessions/[id]/cancel`.
Resume a failed or cancelled session with the same SDK conversation
via `POST /api/sessions/[id]/resume` (or `npm run task -- agent resume
<id>`).

While running, the agent has an in-process MCP server with tools
scoped to its task:

```
mcp__task_orch__add_note(body)
mcp__task_orch__check_criterion(criterion)     # match by id or text substring
mcp__task_orch__uncheck_criterion(criterion)
mcp__task_orch__add_criterion(text)
mcp__task_orch__list_criteria()
mcp__task_orch__list_attachments()             # images/artifacts on the task or plan
mcp__task_orch__get_attachment(id)             # image → viewable block; text → decoded
mcp__task_orch__add_attachment(filename, text|content_base64)
mcp__task_orch__delete_attachment(id)
```

Attach images and other files to any plan or task — from the dashboard,
via REST, or by an agent. The agent sees the attachment roster in its
prompt and fetches the bytes with `get_attachment`: images come back as
viewable image blocks, text-like artifacts (logs, JSON, source, SVG) as
decoded text. Bytes live inline in the Postgres bytea store, capped at 25 MiB
per file.

Each tool call hits the same `lib/repo.ts` the web UI uses, so
progress is visible live. Every run's `total_cost_usd` and token
counts are captured and surfaced on the session detail page.

Requires:
- Agent-backend auth. The `claude` backend resolves it like the Claude Code CLI:
  `ANTHROPIC_API_KEY` when set, otherwise the claude.ai subscription (`claude login`,
  or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` for headless hosts). The
  default `pi` backend reads per-provider keys (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) or `~/.pi/agent/auth.json`. On the
  containerized paths (Docker workers, Fly runner Machines) every recognized
  provider key set on the server is forwarded into the run container, so either
  backend works there — see `lib/agent-backend/provider-env.ts` for the list.
- `gh` CLI installed and authenticated for PR creation
- A `main` branch on `origin` (override per-session via `baseBranch`)

Agents can also inspect their own PR and fetch CI results on demand via the
`gh_pr` / `gh_ci` tools (`ci_runs`, `ci_logs`, `ci_rerun`, `pr_view`, …).

## GitHub webhooks (PR & CI feedback)

Beyond the 60s merge poller, the orchestrator accepts push-based GitHub events
so PR and CI feedback reaches the relevant session in real time.

Configure a **repo (or org) webhook** in GitHub settings:

- **Payload URL**: `<NEXTAUTH_URL>/api/github/webhook`
- **Content type**: `application/json`
- **Secret**: a random string, also set as `GITHUB_WEBHOOK_SECRET` in the
  server env (deliveries are authenticated via the `X-Hub-Signature-256` HMAC;
  the endpoint returns 503 until this is set)
- **Events**: Pull requests, Pull request reviews, Issue comments, Check runs,
  Check suites, Workflow runs (and/or Statuses)

Each delivery is matched to runs by PR url or by head branch + repository, then:

- **recorded** on the session event log — visible live on `/sessions/[id]`
  (SSE) and to the agent;
- a **merged PR** transitions its task to `done` instantly (the poller is the
  fallback);
- a **CI failure** or **"changes requested"** review adds a note to the task,
  and — when `TASK_ORCH_CI_AUTOFIX=1` — resumes the agent on the same branch to
  fix it and re-push (re-triggering CI). Auto-fix is capped
  (`TASK_ORCH_CI_AUTOFIX_MAX`, default 3) and debounced
  (`TASK_ORCH_CI_AUTOFIX_DEBOUNCE_MS`, default 120s) per run; it is off by
  default since it spends model budget unattended.

## Tests

`npm test` runs the Vitest suite against a throwaway Postgres (each test
file gets its own schema for parallel isolation — see `vitest.setup.ts`).
Coverage focuses on `lib/repo.ts`: state machine transitions, criteria
gating, dependency validation, sequential task-ID minting, plan progress.

## Tech

- **Next.js 15** (App Router, dynamic SSR)
- **Drizzle ORM** + **Postgres** (`postgres-js` driver)
- **Zod** request validation
- **Claude Agent SDK** for autonomous task execution
- **Vitest** for the repo-layer test suite
- **shadcn-style** UI (no Radix dep) + Tailwind v3 + Linear-style status glyphs
