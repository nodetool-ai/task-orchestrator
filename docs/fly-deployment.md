# Deploying the whole app on Fly.io

This runs the **entire** Task Orchestrator on Fly — web UI, REST API, agent
runners, and the database — in one command. It's the cloud analog of the
Docker Compose stack in [`test-deployment.md`](test-deployment.md), with the
per-run workers running as ephemeral **Fly Machines** instead of local Docker
containers.

## Topology

```
                          ┌─────────────────────────────┐
   browser / API / CLI ──▶│  task-orchestrator  (web)   │   Next.js server
                          │  Dockerfile.server          │   • dashboard + REST + MCP
                          │  1 always-on Machine        │   • migrations on boot
                          └───────┬──────────────┬──────┘   • run lifecycle pumps
                                  │              │
             DATABASE_URL (6PN)   │              │  Fly Machines API (FLY_API_TOKEN)
                                  ▼              ▼
                     ┌────────────────┐   ┌──────────────────────────────┐
                     │ task-orch…-db  │   │ task-orchestrator-runners     │
                     │ Fly Postgres   │   │ Dockerfile.fly-runner         │
                     └────────────────┘   │ 1 Machine + Volume per run,   │
                                          │ created/suspended/destroyed   │
                                          │ on demand (lib/runner/fly.ts) │
                                          └──────────────────────────────┘
```

Three Fly apps in one org:

| App | Role | Machines |
| --- | --- | --- |
| `task-orchestrator` | Control plane: serves the app, owns the DB schema, spawns runs. | 1, always on |
| `task-orchestrator-runners` | Holds the runner image; hosts one Machine + Volume per agent run. | 0..N, ephemeral |
| `task-orchestrator-db` | Postgres. | 1 (Fly Postgres) |

The web app never executes an agent turn in its own process
(`TASK_ORCH_DETACHED_RUNS=1`) and never runs Docker — with `TASK_ORCH_RUNNER=fly`
it asks the Fly Machines API to create a fresh Machine + persistent Volume per
run, then suspends/stops/destroys it as the run idles (see the lifecycle policy
in `lib/runner/lifecycle.ts`). Each run's checkout, npm cache, and Claude session
store live on its Volume, so a resumed run keeps its state. State that must
survive a redeploy (tasks, plans, transcripts, attachments) lives in Postgres,
so the web Machine itself is stateless.

## One-command deploy

Prerequisites: [`flyctl`](https://fly.io/docs/flyctl/install) installed and
logged in (`fly auth login`), and a Fly org with a payment method.

```bash
cp .env.fly.example .env.fly       # fill in GH_TOKEN, a Claude credential, admin login
set -a; . ./.env.fly; set +a
./scripts/fly-deploy.sh
```

Or fully inline / non-interactive:

```bash
FLY_APP=my-orch FLY_REGION=iad \
  GH_TOKEN=ghp_… ANTHROPIC_API_KEY=sk-ant-… \
  ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='…' \
  ./scripts/fly-deploy.sh
```

The script is idempotent — it:

1. creates the `web` and `runner` apps (skips ones that exist);
2. provisions a Fly Postgres and attaches it (or stages your own `DATABASE_URL` —
   e.g. Supabase or Fly Managed Postgres — if you set one);
3. builds + pushes the runner image to the runner app's registry
   (`--build-only --push`, no machine released);
4. mints a Fly API token scoped to the runner app and stages every secret the
   server needs (`AUTH_SECRET`, `FLY_API_TOKEN`, `FLY_APP_NAME`,
   `FLY_RUNNER_IMAGE`, model/GitHub creds);
5. deploys the server (migrations apply on boot);
6. creates your first dashboard login.

Re-run it any time to redeploy; nothing is recreated that already exists.

## What the deploy wires up

`fly.toml` (web) sets the runner backend and keeps the Machine always-on so the
background run-lifecycle pumps keep ticking:

```toml
[env]
  TASK_ORCH_RUNNER = "fly"
  TASK_ORCH_DETACHED_RUNS = "1"
  TASK_ORCH_MAX_MACHINES = "4"     # concurrent-run cap; raise for more parallelism
[http_service]
  auto_stop_machines = "off"
  min_machines_running = 1
```

Secrets staged on the web app by the script (inspect with `fly secrets list -a <app>`):

| Secret | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres over the org's private network (set by `fly postgres attach`). |
| `AUTH_SECRET` | Signs session JWTs. |
| `NEXTAUTH_URL` | Public origin (`https://<app>.fly.dev` unless overridden). |
| `FLY_API_TOKEN` | Lets the server drive the Machines API for the runner app. |
| `FLY_APP_NAME` | The runner app the server creates Machines in. |
| `FLY_RUNNER_IMAGE` | `registry.fly.io/<runner-app>:latest`. |
| `GH_TOKEN` | Passed to each runner for clone/push + `gh pr create`. |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | Claude auth, passed to each runner. |

## Day-2 operations

```bash
fly status -a task-orchestrator            # web health
fly logs -a task-orchestrator              # server logs
fly machine list -a task-orchestrator-runners   # live/suspended run Machines
fly secrets set -a task-orchestrator GH_TOKEN=ghp_…   # rotate a credential (redeploys)
fly ssh console -a task-orchestrator -C "npm run task -- user add teammate@example.com"
```

Tuning knobs (set as `fly secrets`/`env` on the web app):

- `TASK_ORCH_MAX_MACHINES` — max concurrently-active runner Machines (cost cap).
- `TASK_ORCH_FLY_CPUS` / `TASK_ORCH_FLY_MEMORY_MB` — per-run Machine size.
- `TASK_ORCH_RUNNER_VOLUME_GB` — per-run Volume size (default 20).
- `TASK_ORCH_RUNNER_SUSPEND_MS` / `TASK_ORCH_RUNNER_STOP_MS` — idle windows before
  a run's Machine is suspended, then stopped/destroyed.
- `TASK_ORCH_FLY_REGION` — region for run Machines/Volumes (defaults to the web region).

See `.env.docker.example` for the full list of runner env vars.

## Custom domain

Point DNS at the app and add the cert, then update the origin secret:

```bash
fly certs add tasks.example.com -a task-orchestrator
fly secrets set -a task-orchestrator NEXTAUTH_URL=https://tasks.example.com
```

## GitHub webhooks

For real-time PR/CI feedback, add a repo webhook to
`<NEXTAUTH_URL>/api/github/webhook` and set `GITHUB_WEBHOOK_SECRET` (the deploy
script stages it if you export it). See the "GitHub webhooks" section of the
[README](../README.md).
