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
- **[docs/runners/](docs/runners/README.md)** — how runs actually execute:
  workers, the control-plane split, and the Local / Sprites integrations
  (start here for architecture)
- **[docs/mcp-server.md](docs/mcp-server.md)** — the hosted MCP server
  (`POST /api/mcp`): production setup, the bearer-token auth model, and
  client onboarding from Settings → API tokens
- **[docs/fly-deployment.md](docs/fly-deployment.md)** — deploy the control plane to Fly.io
- **[docs/test-deployment.md](docs/test-deployment.md)** — full containerized
  stack (Postgres + server + Docker workers) for validating the run → PR loop
- **[docs/tui.md](docs/tui.md)** — `orch`, the terminal cockpit: when to use
  it over the web app, the keyboard contract, and the CLI verbs
- **[docs/model-welfare.md](docs/model-welfare.md)** — seats, laurels
  (recognition delivered at agent startup), and the graceful handoff protocol
- **[Persona bots on Discord](#persona-bots-on-discord)** — one Discord bot per
  persona, `/link` identity, and the security posture behind them
  ([design](docs/superpowers/specs/2026-07-31-discord-personas-messaging-design.md),
  [PRD](docs/superpowers/specs/2026-07-31-discord-personas-messaging-prd.md))

## Run

The app needs a Postgres instance reachable via `DATABASE_URL`. For local
dev, a throwaway container is enough — schema migrations apply automatically
on boot (`instrumentation.ts` → `initDb()`), there's no separate migrate step.

```bash
# 1. Start a dev Postgres (matches the default DATABASE_URL below).
#    --shm-size matters: Docker's 64MB default fills up under the parallel
#    test suite and Postgres starts failing with "could not resize shared
#    memory segment ... No space left on device".
docker run -d --name taskorch-pg-dev --shm-size=1g -p 127.0.0.1:5433:5432 \
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

### Run workers in Docker (local dev)

By default a dispatched run executes in a detached `tsx` host process.
For a clean, isolated, consistently-tooled worker environment, flip dev to
spawn each run as an ad-hoc **Docker worker container** (the same `dockerSpawn`
path the compose/test-deploy stack uses — `docs/test-deployment.md`). The Next.js
server keeps running on the host with hot reload; only the per-run workers move
into containers.

```bash
# one command: build the worker image, seed/refresh a repo-cache mirror,
# and print the exact env block to drop into .env.local
scripts/dev-workers.sh
```

The printed block is:

```bash
TASK_ORCH_DETACHED_RUNS=1
TASK_ORCH_WORKER_IMAGE=task-orchestrator-worker:dev
TASK_ORCH_CLAUDE_HOME_HOST=/home/you/.claude                # mounted RW so resume survives
TASK_ORCH_REPO_CACHE_HOST_VOLUME=task-orch-dev-repo-cache   # mirror workers clone from
```

> The worker protocol is WebSocket-only (`docs/worker-websocket-protocol.md`);
> Docker channel provisioning lands in plan section 19, so
> `TASK_ORCH_WORKER_IMAGE` dispatch fails fast until then. Use a plain local
> detached run (leave `TASK_ORCH_WORKER_IMAGE` unset) to exercise the WebSocket
> worker on the host.

`GH_TOKEN` and your agent-backend credentials already in `.env.local` are
forwarded into each worker container by the server (workers hold no database
credentials — the control plane dials the worker over the WebSocket channel,
`docs/worker-websocket-protocol.md`).
Workers clone from the seeded mirror (`git clone --reference`) into `/work/<id>`
and push/PR with `GH_TOKEN`; resume re-clones from the mirror, so it survives
the ephemeral container dying.

Then `npm run dev` and trigger a run — watch the container appear:

```bash
docker ps --filter name=run- --format '{{.Names}}	{{.Status}}'
```

Rebuild the image after changing worker/lib code (the container carries a
baked `COPY . .` snapshot):

```bash
scripts/dev-workers.sh --build
```

Refresh the repo mirror after upstream commits land on the target repo:

```bash
scripts/dev-workers.sh --refresh-cache
```

Revert to host `tsx` workers any time by unsetting `TASK_ORCH_WORKER_IMAGE` in
`.env.local`. See `scripts/dev-workers.sh --help` (header) for prerequisites
(Docker, `GH_TOKEN` with `repo` scope, `~/.claude` authenticated) and the full
flag set.

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

## Deploy the control plane to Fly.io

Fly.io can host the web UI, REST API, and control plane. Agent runs use the
`sprites` or `local` runner provider; Fly is not a runner provider.

```bash
cp .env.fly.example .env.fly       # fill in GH_TOKEN, a Claude credential, admin login
set -a; . ./.env.fly; set +a
./scripts/fly-deploy.sh            # creates apps + Postgres, wires secrets, deploys
```

The script provisions the control-plane app and optionally Fly Postgres, stages
its application secrets, and creates your first login. Full walkthrough:
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

## MCP server (remote clients)

The whole tool registry is also served as a remote MCP server, so Claude
Code, Claude Desktop, Cursor, or VS Code can drive plans, tasks, and agent
runs against a deployment:

```
POST /api/mcp        # JSON-RPC 2.0 over Streamable HTTP
Authorization: Bearer tot_…
```

Onboarding lives in the app: **Settings → API tokens** issues a token
(shown once), fills the client snippets in with this deployment's origin
and that token, offers a one-click install for Cursor and VS Code plus a
`.mcp.json` download, and has a **Test connection** button that runs a real
`tools/list` and reports how many tools answered.

Tokens are `tot_`-prefixed, stored bcrypt-hashed, act as their owning user,
carry no expiry, and are revocable at any time — full production setup,
proxy requirements, and the 401 troubleshooting table are in
**[docs/mcp-server.md](docs/mcp-server.md)**.

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
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, …), `~/.pi/agent/auth.json`, and — for
  `openai-codex` models — the Codex credential stored in the orchestrator
  database. Sign in under **Settings → Codex** ("Sign in with ChatGPT"): this
  runs OpenAI's device-code OAuth flow (PKCE, redirecting to
  `https://auth.openai.com/deviceauth/callback`), which shows you an
  authorization code to paste back. Because nothing has to listen on a loopback
  port, it works when the server and your browser are on different machines — a
  hosted deployment included. `npm run task -- codex login` does the same from
  the CLI; `codex status` reports whether a login is present and `codex logout`
  revokes the token and clears the row. The external OpenAI Codex CLI is not
  required, and `~/.codex/auth.json` is no longer read. `CODEX_ACCESS_TOKEN` is
  accepted as an explicit override and is how the control plane hands the token
  to workers, which have no database access. On the containerized paths (Docker
  workers, Fly runner Machines) every recognized provider credential set on the
  server is forwarded into the run container, so either backend works there —
  see `lib/agent-backend/provider-env.ts` for the
  list.
- `gh` CLI installed and authenticated for PR creation
- A `main` branch on `origin` (override per-session via `baseBranch`)

Agents can also inspect their own PR and fetch CI results on demand via the
`gh_pr` / `gh_ci` tools (`ci_runs`, `ci_logs`, `ci_rerun`, `pr_view`, …).

## Worker WebSocket channel

Run workers talk to the orchestrator EXCLUSIVELY over a private WebSocket
channel — **workers have no database access, ever, and make no outbound
control-plane request**. The control plane dials each dispatched worker's
private listener and pushes the authoritative run snapshot, user input, and
cancels over the socket; `DATABASE_URL` is never passed, and a worker process
that tries to touch Postgres throws at the call site. Every orchestrator-state
tool an agent can call — the orchestrator tools, the event/timer tools,
planning gates, child-spawn, persona memory — executes control-plane-side via
the channel's `tool.invoke` command. Both ends emit structured logs
(`TASK_ORCH_LOG_LEVEL=debug`, `TASK_ORCH_LOG_FORMAT=json`) — frame metadata
only, never payloads or credentials — so the whole worker ⇄ server conversation
is observable. Full protocol design:
[docs/worker-websocket-protocol.md](docs/worker-websocket-protocol.md).

## Persona bots on Discord

`npm run pipe` bridges Discord to the same agent runtime the web UI drives:
**one Discord application (and bot token) per persona**, all running inside
that single process. A persona conversation is an `agent_runs` row with
`goal = '<chat>'` and `runtime = 'server'` — its turns execute *in the pipe
process*, with no container and no worktree — that spawns ordinary
containerized worker runs to do the actual repo work. Design and UX contract:
[design doc](docs/superpowers/specs/2026-07-31-discord-personas-messaging-design.md)
and [PRD](docs/superpowers/specs/2026-07-31-discord-personas-messaging-prd.md).

### Configure bots in Settings (preferred)

**Settings → Discord** is the supported way to add a persona bot: a guided
wizard picks the persona (flagging any whose tools profile or backend does not
qualify), links out to the Discord developer portal, **verifies the pasted bot
token server-side**, generates the OAuth2 invite URL with the right permission
bits, and stores the bot in the `discord_bots` table. Tokens are never returned
to the browser — the UI only ever sees the last four characters.

Who may talk to the bots is **self-service**: every person links their own
Discord user id in the same tab ("Your Discord account"), which writes a
`channel_identities` row — the same table `/link` uses for attribution. The
effective allowlist is the union of those linked ids and any legacy
`DISCORD_ALLOWED_USERS` env values; nobody curates a list of other people's
snowflakes. A bot nobody can reach is refused, as it always was.

The pipe reads its configuration **once at boot** and there is no live-reload
channel between the web server and that process, so restart `npm run pipe` after
changing anything here. The env vars below keep working and are merged in as a
fallback: a `discord_bots` row wins for its persona, env-only personas still
start.

### Create one Discord app per persona (env vars)

1. **Create the application + bot** at
   <https://discord.com/developers/applications> — one per persona you want on
   Discord. The bot's name and avatar are the persona's face.
2. **Enable the Message Content intent** (Bot → Privileged Gateway Intents →
   *Message Content*). It is privileged and off by default; without it the bot
   receives empty message bodies and answers nothing. The other intents the
   client requests are not privileged and need no portal switch: `Guilds`,
   `GuildMessages`, `DirectMessages`, `GuildMessageReactions`,
   `DirectMessageReactions` (the last two power 👍/👎/❌ as input). The client
   also registers `Partials.Channel / Message / Reaction`, which is what makes
   DMs and reactions on uncached messages arrive at all.
3. **Invite it** (OAuth2 → URL Generator) with the `bot` and
   `applications.commands` scopes and these permissions: *Send Messages*,
   *Read Message History*, *Create Public Threads*, *Send Messages in Threads*,
   *Add Reactions* (👀 acks and reaction input), and *Manage Threads* if you
   want the 🚧/🔍/✅/❌ thread-title status machine to rename threads.
4. **Set the env vars** and start the bridge with `npm run pipe`.

```bash
DISCORD_BOT_TOKEN_CONCIERGE=...   # persona id, upper-snake (planning-agent → PLANNING_AGENT)
DISCORD_APP_ID_CONCIERGE=...      # optional; enables slash-command registration for that bot
DISCORD_ALLOWED_USERS=...         # MANDATORY: comma-separated Discord user ids
DISCORD_ALLOWED_USERS_CONCIERGE=  # optional per-bot override (REPLACES the global list)
DISCORD_ALLOWED_CHANNELS=         # optional; empty = anywhere an allow-listed user can reach it
TASK_ORCH_PUBLIC_URL=https://tasks.example.com   # base for the deep links in every reply
```

Every `DISCORD_BOT_TOKEN_<PERSONA_ID>` must name a persona that exists in the
`personas` table; unknown suffixes, empty allowlists and non-qualifying personas
are **boot errors**, not warnings (see the posture below). The legacy
single-bot `DISCORD_BOT_TOKEN` still works and binds to `DISCORD_DEFAULT_PERSONA`.
A bot configured in Settings → Discord is validated the same way, but a failure
there **skips that bot with a warning** instead of stopping the process: it is
editable in the UI, and one bad save must not lock the operator out of a running
pipe. Settings flags the same problem per bot.

### The roster today

**Concierge** is the default, end-user-facing bot: intake, status, routing and
end-to-end "just ship it" orchestration. **Executor** is the other persona that
qualifies today (plan-driving). Adding a persona to Discord is normally *just*
adding its token — no new files — but a persona only qualifies if its tools
profile is **server-safe** (`lib/profiles.ts`) and its backend resolves to `pi`.

The PRD's `@Rex` (the `qa` persona) does **not** qualify as shipped: its profile
is `orchestrator,repo_read,gh_pr,gh_ci`, and `repo_read` and `gh_pr` are
server-unsafe — they would give a chat message filesystem reads and process
spawning inside the pipe process. Setting `DISCORD_BOT_TOKEN_QA` today makes the
pipe refuse to boot, by design and with that profile named in the error. Giving
QA a Discord voice means giving it an orchestration-only profile (it can still
*spawn* a containerized child that reads the repo and reviews the PR), not
loosening the server-safety rule.

### Linking your account (`/link`)

Talking to a bot works unlinked; linking is what attributes the work. Mint an
API token in the web UI, then **DM** the bot `/link <token>`. The token is
verified, **consumed immediately** (single-use — it is a one-time proof of
account ownership, not a standing credential), and only the resulting
association is stored in `channel_identities`. From then on runs, threads and
`user`-scoped memories carry your `users.id`. `/link` in a public channel is
refused (the token would be readable by everyone), and a token-shaped string in
any ordinary message is dropped before it can be persisted or sent to a model.

Command surface (also registered as slash commands when `DISCORD_APP_ID_<ID>` is
set): `/status`, `/new`, `/stop`, `/link`, `/whoami`, `/help` — plus 👍/👎 to
answer a question, ❌ to stop a turn or cancel a run, and 👀 meaning "working on
it". Everything else is just conversation.

### Security posture

- **No shell on the server runtime.** Persona turns run inside the pipe process,
  next to `DATABASE_URL` and the orchestrator's own checkout, so the tool surface
  *is* the sandbox: only server-safe profiles (orchestration, spawn, read-only
  PR/CI) may be mounted, and `runs.create` rejects the rest per run. Repo work
  happens in containerized children, which are isolated and branch-scoped.
- **Allowlists are mandatory.** A persona can spawn worker runs that *do* get
  `bypassPermissions` shells, so an open bot is an open shell one hop away. The
  pipe refuses to start without an explicit `DISCORD_ALLOWED_USERS`.
- **Tokens are secrets.** Bot tokens live only in the pipe's environment; the
  metrics listener below binds to loopback for the same reason.

### Operating it

**The pipe is load-bearing.** Since the progress relay landed, the control plane
*defers* wakes for mapped persona conversations to this process: their milestone
turns have to run where the Discord draft is. Inbox events for those runs are
durable and simply queue while the pipe is down — nothing is lost, but nothing is
narrated either. Run it as a supervised service, not by hand.

**Health signal.** Pending inbox events on a mapped conversation that are more
than ~10 minutes old mean the pipe is not draining them — i.e. it is down or
wedged. That is exported by the web app as
`task_orch_pipe_stale_pending_events{persona="…"}` on `/api/metrics`; anything
above 0 for a sustained period is the alarm.

**Metrics (PRD §11).** The messaging surface emits `task_orch_pipe_*` metrics —
time-to-first-PR per thread, user messages vs persona questions (clarify rate),
commands vs threads (zero-command sessions), `/status` digest latency,
breadcrumbs and wakes per persona — tagged by `persona` and, once linked, `user`.
The counters live in the process that emits them, which is the pipe, so
`/api/metrics` on the web app serves only the DB-derived ones
(`task_orch_pipe_creation_share`, `task_orch_pipe_stale_pending_events`). Set
`TASK_ORCH_PIPE_METRICS_PORT` to have the pipe expose the rest at
`http://127.0.0.1:<port>/metrics` in the same Prometheus format. Creation share
is reported for runs only — plans and tasks carry no creator column, so their
messaging-vs-web split is not derivable without a schema change.

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

The webhook is the fast path, but the 20s PR-state poller (`TASK_ORCH_PR_SYNC_MS`)
also drives the same capped autofix when it sees a PR with red CI — so a dropped
webhook delivery can't strand the fix loop. Both paths share the cap/debounce
guards (keyed to the same `github_autofix` events), so they never double-fire.

When the loop can't converge — CI is still red after `TASK_ORCH_CI_AUTOFIX_MAX`
attempts, or there's no resumable run left to fix in place — the task is escalated
to `blocked` (once, guarded by a `github_autofix_exhausted` event) so a human is
pulled in instead of the loop going silent.

### Proactive scheduler (`TASK_ORCH_AUTO_LAUNCH`)

The autofix loop above drives a task once a run exists. The **proactive
scheduler** closes the loop at the front: when enabled, it periodically scans
for `todo` tasks that are ready to be worked and auto-starts an agent session on
each — reusing the exact same start path as `POST /api/tasks/:id/sessions` and
`npm run task -- agent T-…` (worktree, branch, transition to `in_progress`,
dispatch) — so the orchestrator can run autonomously: agent acts → CI gates →
merge or block.

**Off by default.** Like autofix and detached runs, the whole feature is inert
unless explicitly enabled, and the poll interval is only armed when the flag is
on (zero overhead — no timer, no DB scan — when off).

A task is auto-launched only when **all** hold: its state is `todo`; its
assignee matches `TASK_ORCH_AUTO_LAUNCH_ASSIGNEE` (so it never grabs human-owned
work); all of its dependency tasks are `merged`; it has no active (non-terminal)
agent run already; and launching it keeps the count of currently-active
auto-launched runs at or below `TASK_ORCH_AUTO_LAUNCH_MAX_CONCURRENT`. Each tick
recomputes that budget from the DB and launches up to it, oldest task first.
Every auto-launched run is tagged with an `auto_launch` event so it's observable
and counts against the ceiling. Runaway is prevented three ways: a task with a
live run is never launched twice (checked here and again under the advisory lock
inside the start path), the concurrency ceiling is always respected, and only
`todo` tasks with the matching assignee are ever touched.

Env knobs (all safe defaults; feature off unless the master switch is on):

- `TASK_ORCH_AUTO_LAUNCH` — master switch. Off by default; `1`/`true`/`yes`/`on`
  enables it, unset/`0`/`false`/`no`/`off` disables it.
- `TASK_ORCH_AUTO_LAUNCH_INTERVAL_MS` — poll cadence (default `60000`).
- `TASK_ORCH_AUTO_LAUNCH_MAX_CONCURRENT` — ceiling on concurrently-active
  auto-launched runs (default `3`).
- `TASK_ORCH_AUTO_LAUNCH_ASSIGNEE` — only tasks with this assignee are eligible
  (default `claude`).
- `TASK_ORCH_AUTO_LAUNCH_PLAN` — optional plan id; when set, only tasks in that
  plan are eligible (default: all plans).

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
