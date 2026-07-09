# Deploying Task Orchestrator on Fly.io

A complete guide to running the **entire** Task Orchestrator on
[Fly.io](https://fly.io) — the web UI, REST/MCP API, autonomous agent runners,
and the Postgres database — provisioned and wired together with a single
command. This is the cloud counterpart of the local Docker Compose stack in
[`test-deployment.md`](test-deployment.md); the difference is that each agent
run executes as an ephemeral **Fly Machine** (its own VM + persistent volume)
instead of a Docker container on one host, so there is no Docker socket to mount
and no single box to size for peak concurrency.

- [1. What you get](#1-what-you-get)
- [2. Architecture](#2-architecture)
- [3. Prerequisites](#3-prerequisites)
- [4. Quick start](#4-quick-start)
- [5. Configuration reference](#5-configuration-reference)
- [6. What the deploy script does](#6-what-the-deploy-script-does)
- [7. Database options](#7-database-options)
- [8. The runner lifecycle](#8-the-runner-lifecycle)
- [9. Cold-start latency & the warm repo cache](#9-cold-start-latency--the-warm-repo-cache)
- [10. Manual / step-by-step deploy](#10-manual--step-by-step-deploy)
- [11. Day-2 operations](#11-day-2-operations)
- [12. Scaling & performance](#12-scaling--performance)
- [13. Custom domains & TLS](#13-custom-domains--tls)
- [14. GitHub webhooks](#14-github-webhooks)
- [15. Security model](#15-security-model)
- [16. Cost model](#16-cost-model)
- [17. Troubleshooting](#17-troubleshooting)
- [18. Upgrading & redeploying](#18-upgrading--redeploying)
- [19. Teardown](#19-teardown)
- [20. FAQ](#20-faq)

---

## 1. What you get

After `./scripts/fly-deploy.sh` completes you have a self-contained deployment:

- A public HTTPS dashboard at `https://<app>.fly.dev` (or your custom domain),
  gated by email + password sign-in.
- The full REST API, MCP endpoint, and GitHub webhook receiver on the same origin.
- Autonomous agent runs that each spin up an isolated Fly Machine, check out the
  target repo, run a Claude Agent SDK session, push a branch, open a PR, and then
  suspend/stop/destroy the Machine as they go idle.
- A managed Postgres database holding all durable state (plans, tasks, sessions,
  transcripts, attachments), so the web Machine itself is stateless and
  redeploys/restarts never lose data or kill in-flight runs.

Everything is idempotent and re-runnable — the script doubles as your redeploy
command.

---

## 2. Architecture

### Topology

```
                          ┌─────────────────────────────┐
   browser / API / CLI ──▶│  task-orchestrator  (web)   │   Next.js server
                          │  Dockerfile.server          │   • dashboard + REST + MCP
                          │  1 always-on Machine        │   • migrations on boot
                          └──────┬───────────┬────▲─────┘   • run-lifecycle pumps
                                 │           │    │           • Fly runner monitor
            DATABASE_URL (6PN)   │           │    │  /api/worker over 6PN
              (web app ONLY)     │           │    │  (run-scoped HMAC token)
                                 ▼           ▼    │
                    ┌────────────────┐   ┌────────┴─────────────────────┐
                    │ task-orch…-db  │   │ task-orchestrator-runners     │
                    │ Fly Postgres   │   │ Dockerfile.fly-runner         │
                    └────────────────┘   │ 1 Machine + Volume per run,   │
                                         │ created/suspended/stopped/    │
                Fly Machines API         │ destroyed on demand           │
                (FLY_API_TOKEN)          │ (lib/runner/fly.ts)           │
                                         └──────────────────────────────┘
```

> **Runner Machines hold no `DATABASE_URL`.** Since the worker-HTTP-API
> migration (2026-07) the orchestrator withholds Postgres credentials from
> runner Machines; every read/write a run needs flows through the web app's
> `/api/worker/*` endpoints, authenticated by a per-run HMAC token minted at
> dispatch (`lib/runner/fly.ts` `buildFlyWorkerEnv`; the DB guard in
> `db/index.ts` fails fast if a worker ever reaches Postgres directly). See
> **[worker-http-api.md](./worker-http-api.md)** for the protocol.

### The three apps

| App | Role | Machines | Image |
| --- | --- | --- | --- |
| `task-orchestrator` | **Control plane.** Serves the dashboard/API, owns the DB schema (migrates on boot), and drives run scheduling + lifecycle. | 1, always on | `Dockerfile.server` |
| `task-orchestrator-runners` | **Runner pool.** Its registry holds the runner image; it hosts one Machine + Volume per agent run. | 0..N, ephemeral | `Dockerfile.fly-runner` |
| `task-orchestrator-db` | **Database.** Postgres over the org's private network. | 1 (or an HA cluster) | Fly Postgres |

All three live in one Fly organization and talk over Fly's private **6PN**
network (`.flycast`/`.internal`), so the database is never exposed to the public
internet — only the web app's `http_service` is.

### Request & run flow

1. A user (or the API/CLI) starts an agent run on a task.
2. The web server claims the run in Postgres and, because `TASK_ORCH_RUNNER=fly`
   and `TASK_ORCH_DETACHED_RUNS=1`, calls the Fly Machines API to **create a
   Volume and a Machine** in the runner app (`lib/runner/fly.ts` →
   `FlyRunnerProvider.create`).
3. The runner Machine boots `Dockerfile.fly-runner`, mounts its Volume at
   `/mnt/session`, and runs `scripts/run-worker.ts` for that `RUN_ID`
   (`scripts/fly-runner-entry.sh`). It clones the repo, runs the agent turn,
   pushes, and opens/updates the PR — connecting back to Postgres over 6PN and
   streaming progress into the `agent_messages` / `agent_events` tables.
4. The web server **never executes the turn in-process**, so restarting or
   redeploying it cannot signal a running worker. On boot it reconciles orphaned
   runs and re-dispatches resumable ones (`instrumentation.ts`).
5. A background **monitor + pump** on the web server polls Fly state
   (`FlyRunnerProvider.sweep`, every `TASK_ORCH_FLY_POLL_MS`) and applies the
   [lifecycle policy](#8-the-runner-lifecycle): suspend an idle Machine, later
   stop it, later destroy it and its Volume.

### What lives where

| State | Location | Survives web redeploy? | Survives run Machine destroy? |
| --- | --- | --- | --- |
| Plans, tasks, sessions, notes, criteria, transcripts, attachments | Postgres | ✅ | ✅ |
| Per-run checkout, npm cache, Claude session store | run Machine's Volume (`/mnt/session`) | ✅ (it's not on the web Machine) | ❌ (destroyed with the Volume after the idle window) |
| Secrets (tokens, DB URL) | Fly secrets on the web app | ✅ | n/a |

Because durable state is entirely in Postgres, the web Machine is disposable and
you can redeploy it freely.

---

## 3. Prerequisites

- **flyctl** installed — <https://fly.io/docs/flyctl/install> — and logged in:
  ```bash
  fly auth login
  fly auth whoami        # confirms you're authenticated
  ```
- A **Fly organization** with a payment method on file (creating apps, Postgres,
  and Machines requires it). Find your org slug with `fly orgs list`.
- **Credentials** to hand to the agents (you'll be prompted for any you don't set):
  - `GH_TOKEN` — a GitHub token with `repo` **and** `workflow` scope, for
    clone/push over HTTPS and `gh pr create`. The `workflow` scope is required
    for any push whose diff touches `.github/workflows/*.yml`; without it GitHub
    rejects the push (classic PAT: check both boxes; fine-grained PAT: Contents +
    Workflows = Read and write).
  - A Claude credential — **either** `ANTHROPIC_API_KEY` **or** a claude.ai OAuth
    token from `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`).
- `openssl` on your machine (used to generate `AUTH_SECRET` if you don't supply one).

You do **not** need Docker locally — Fly builds the images remotely.

---

## 4. Quick start

```bash
# From the repo root
cp .env.fly.example .env.fly       # then fill it in (see the reference below)
set -a; . ./.env.fly; set +a       # export the vars for the script
./scripts/fly-deploy.sh
```

Or fully inline / non-interactive (good for CI):

```bash
FLY_APP=my-orch \
FLY_REGION=iad \
FLY_ORG=my-org \
GH_TOKEN=ghp_… \
ANTHROPIC_API_KEY=sk-ant-… \
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='a-strong-password' \
  ./scripts/fly-deploy.sh
```

The run takes a few minutes (most of it is the first Postgres provision and the
two image builds). When it finishes it prints your dashboard URL and the handy
status/log commands. Log in with the admin account you set (or create one — see
[First user](#first-user)).

To **redeploy** after changing code or secrets, just run the same command again.

---

## 5. Configuration reference

### 5.1 Deploy-script inputs

These are read by `scripts/fly-deploy.sh` from the environment. Names/infra
values have defaults; credentials are prompted for interactively if unset.
`.env.fly.example` is a ready-to-copy template.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FLY_APP` | `task-orchestrator` | Web app name. |
| `FLY_RUNNER_APP` | `${FLY_APP}-runners` | Runner pool app name. |
| `FLY_PG_APP` | `${FLY_APP}-db` | Fly Postgres app name (ignored if you bring your own `DATABASE_URL`). |
| `FLY_REGION` | `ams` | Primary region for all three apps. |
| `FLY_ORG` | `personal` | Fly organization slug. |
| `DATABASE_URL` | *(unset)* | Bring-your-own Postgres. If set, the script skips Fly Postgres and stages this instead. |
| `NEXTAUTH_URL` | `https://${FLY_APP}.fly.dev` | Public origin used for auth callbacks + webhook URLs. Set to your custom domain. |
| `AUTH_SECRET` | *(generated)* | Session-JWT signing secret. Auto-generated with `openssl rand -base64 32` if unset. |
| `GH_TOKEN` | *(prompted)* | GitHub token passed to every runner. |
| `ANTHROPIC_API_KEY` | *(prompted)* | Claude API key (or use the OAuth token below). |
| `CLAUDE_CODE_OAUTH_TOKEN` | *(prompted)* | claude.ai subscription token from `claude setup-token`. |
| `CODEX_ACCESS_TOKEN` | *(unset)* | Optional override for pi `openai-codex` models. Prefer a mounted `CODEX_HOME/auth.json` where possible because access tokens are short-lived. |
| `GITHUB_WEBHOOK_SECRET` | *(unset)* | If set, staged so the webhook endpoint verifies signatures. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | *(unset)* | If both set, the script creates this first dashboard login over SSH. |

### 5.2 Runtime secrets (staged on the web app)

Inspect with `fly secrets list -a <app>` (values are write-only). The script sets
these; you can rotate any of them later with `fly secrets set` (which triggers a
rolling redeploy).

| Secret | Set by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `fly postgres attach` (or your input) | Postgres connection over 6PN. |
| `AUTH_SECRET` | script | Signs session JWTs (Auth.js v5). |
| `NEXTAUTH_URL` | script | Public origin. |
| `FLY_API_TOKEN` | script (`fly tokens create deploy`) | Lets the server drive the Machines API for the runner app. |
| `TASK_ORCH_FLY_APP` | script | The runner app the server creates Machines in. (Not `FLY_APP_NAME` — Fly's runtime reserves that name and injects the web Machine's own app name, which would misdirect the Machines API and 403.) |
| `FLY_RUNNER_IMAGE` | script | `registry.fly.io/<runner-app>:latest`. |
| `GH_TOKEN` | script | Passed into each runner Machine's env. |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | script | Claude auth, passed into each runner Machine. |
| `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, `GEMINI_API_KEY`, … | script (if provided) | pi-backend provider keys/tokens; every recognized credential set on the web app is passed into each runner Machine (full list: `lib/agent-backend/provider-env.ts`). |
| `GITHUB_WEBHOOK_SECRET` | script (if provided) | Verifies inbound GitHub webhook HMAC. |

### 5.3 Runtime env (baked into `fly.toml`)

Non-secret configuration lives in the `[env]` block of `fly.toml`. Edit and
redeploy to change:

| Key | Value in `fly.toml` | Meaning |
| --- | --- | --- |
| `TASK_ORCH_RUNNER` | `fly` | Use the Fly Machines runner backend. |
| `TASK_ORCH_DETACHED_RUNS` | `1` | Never run a turn in the web process. |
| `TASK_ORCH_MAX_MACHINES` | `4` | Cap on concurrently-active runner Machines. `0` = unlimited. |
| `TASK_ORCH_AGENT_BACKEND` | `claude` | Agent backend (`claude` or `pi`). Runner Machines inherit it, so flipping it (plus staging the matching provider keys) switches what the run containers execute. |
| `TASK_ORCH_CHAT_MODEL` / `TASK_ORCH_AGENT_MODEL` | `anthropic/claude-opus-4-8` | Default models. |
| `AUTH_TRUST_HOST` | `true` | Trust Fly's forwarded host/proto behind the edge proxy. |
| `PORT` | `3000` | Internal listen port (matches `internal_port`). |

### 5.4 Runner tuning knobs

These control the per-run Machines. Set them as `fly secrets`/env on the **web
app** (the server reads them when creating Machines and running the lifecycle).
Full descriptions are in `.env.docker.example`.

| Variable | Default | Effect |
| --- | --- | --- |
| `TASK_ORCH_FLY_REGION` | web region | Region for run Machines + Volumes. |
| `TASK_ORCH_FLY_CPUS` | `2` | vCPUs per run Machine (shared). |
| `TASK_ORCH_FLY_MEMORY_MB` | `4096` | Memory per run Machine. |
| `TASK_ORCH_RUNNER_VOLUME_GB` | `10` | Volume size per run when no prewarm fork is used. With `prewarm_seed`, Fly forks inherit the seed volume size because `size_gb` is not allowed on fork requests, so keep `TASK_ORCH_PREWARM_SEED_GB` at least this large. `10` GB fits typical repos; bump for monorepos or heavy caches. |
| `TASK_ORCH_MAX_MACHINES` | `0` (fly gate off) | Max active Machines; `>0` also enables the admission gate that defers over-cap runs to `pending`. |
| `TASK_ORCH_FLY_POLL_MS` | `10000` | How often the server reconciles Fly state (and runs the orphan-volume reaper). |
| `TASK_ORCH_RUNNER_TERMINAL_MS` | `86400000` (24h) | Idle window before a **terminal** run's Machine + Volume is destroyed. Compute is still suspended immediately, but a `completed`/`failed`/`budget_exhausted` run is revivable (a follow-up turn or operator restart re-claims it), so its volume — warm checkout, unpushed work, SDK transcript — is kept for 24h rather than reclaimed after 1h. A shorter window strands a restart on a fresh, empty volume. |
| `TASK_ORCH_RUNNER_SUSPEND_MS` | `86400000` (24h) | Idle window before a suspended **resumable** run's Machine is stopped. |
| `TASK_ORCH_RUNNER_STOP_MS` | `604800000` (7d) | Idle window before a stopped **resumable** run's Machine + Volume is destroyed. Applies to idle/resumable runs (e.g. a chat waiting for the next message); terminal runs use `TASK_ORCH_RUNNER_TERMINAL_MS` instead. |
| `TASK_ORCH_CHAT_IDLE_MS` | `600000` (10m) | How long a long-lived chat runner waits warm for the next message. |
| `TASK_ORCH_ARCHIVE_R2` | *(unset)* | If set, cold Volumes are flagged for archival instead of being destroyed with data (archiver is a future component). |
| `TASK_ORCH_REPO_CACHE_DIR` | `/opt/repo-cache` | Where the runner image bakes its warm repo mirrors (see [§9](#9-cold-start-latency--the-warm-repo-cache)); passed into each run Machine's env as `REPO_CACHE_DIR`. Override only if you changed the bake path in `Dockerfile.fly-runner`. |

---

## 6. What the deploy script does

`scripts/fly-deploy.sh` runs six idempotent stages. Understanding them makes
troubleshooting and manual operation straightforward.

1. **Preflight** — resolves `fly`/`flyctl`, confirms you're logged in, prints the
   plan, and syncs `primary_region` in `fly.toml` / `fly.runner.toml` to
   `FLY_REGION`. Prompts for any missing `GH_TOKEN` / Claude credential.
2. **Apps** — `fly apps create` for the web and runner apps (skips existing ones).
3. **Database** — if `DATABASE_URL` is set it's staged as a secret; otherwise the
   script runs `fly postgres create` (single node, `shared-cpu-1x`, 10 GB) and
   `fly postgres attach`, which mints a DB + user and sets `DATABASE_URL` on the
   web app.
4. **Runner image** — `fly deploy --config fly.runner.toml --build-only --push`
   builds `Dockerfile.fly-runner` and pushes it to
   `registry.fly.io/<runner-app>:latest` **without releasing a machine** (the
   server creates run Machines from this image later). This image also bakes a
   warm repo cache and a pre-built worker to cut cold-start latency — see
   [§9](#9-cold-start-latency--the-warm-repo-cache).
5. **Secrets** — mints an app-scoped `FLY_API_TOKEN` for the runner app
   (`fly tokens create deploy`) and stages every secret from §5.2 on the web app.
6. **Server deploy** — `fly deploy --config fly.toml`; migrations apply on boot.
   If `ADMIN_EMAIL` + `ADMIN_PASSWORD` are set, it creates that login over
   `fly ssh console`.

Because every stage is a no-op when its resource already exists, re-running the
script is a safe redeploy.

---

## 7. Database options

The app needs Postgres reachable via `DATABASE_URL`. Migrations apply
automatically on server boot (`instrumentation.ts` → `initDb()`), so there's no
separate migrate step.

### Option A — Fly Postgres (default, zero config)

Leave `DATABASE_URL` unset and the script provisions and attaches a Fly Postgres
cluster for you. It's reachable from **both** the web app and the runner Machines
over 6PN. For production, scale it to HA and a larger volume:

```bash
fly postgres create --name my-orch-db --org my-org --region iad \
  --initial-cluster-size 2 --vm-size shared-cpu-2x --volume-size 40
```

### Option B — Bring your own (Supabase, Fly Managed Postgres, RDS, …)

Set `DATABASE_URL` before running the script and Fly-Postgres provisioning is
skipped. The app already handles TLS-required URLs (it auto-enables `ssl` for
`sslmode=require` / Supabase hosts — see `db/index.ts`).

> **Supabase note:** use the **SESSION** pooler on port **5432**, not the
> transaction pooler on `:6543`. The app relies on Postgres `LISTEN/NOTIFY` for
> run streaming and worker messaging, which the transaction pooler doesn't
> support; the app warns loudly if it detects a `:6543` URL.

> **Reachability note:** a bring-your-own database must be reachable from the
> runner Machines too, since each run connects directly. A public managed
> Postgres works everywhere; a private one must share the network with the runner
> app.

### Applying migrations manually (rarely needed)

```bash
fly ssh console -a my-orch -C \
  "npx tsx -e \"import('./db/index').then(m => m.initDb())\""
```

---

## 8. The runner lifecycle

Cost control is automatic. The web server's monitor sweeps Fly state every
`TASK_ORCH_FLY_POLL_MS` and applies this pure policy (`lib/runner/lifecycle.ts`):

The policy distinguishes a **terminal** run (done forever) from an **idle /
resumable** run (paused, may resume on the next message). One exception: a
**plan executor** (`goal='<execute>'`) lands `completed` after every turn but is
conversational — the operator steers it with follow-up messages — so its
`completed`/`failed`/`budget_exhausted` states are classified idle/resumable
(long windows), keeping its checkout and Claude session store warm for a
next-day "continue". Its `cancelled`/`closed` states stay terminal:

| Run state | Machine state | Idle time | Action |
| --- | --- | --- | --- |
| active (`pending`/`preparing`/`running`/`pushing`/`opening_pr`) or live worker claim | any | — | **none** (never touch a live run) |
| **terminal** (`completed`/`failed`/`cancelled`/`closed`/`budget_exhausted`) | `running` | < `TASK_ORCH_RUNNER_TERMINAL_MS` (24h) | **suspend** (stop paying for compute) |
| **terminal** | any | ≥ `TASK_ORCH_RUNNER_TERMINAL_MS` (24h) | **archive-and-destroy** (Machine + Volume) |
| idle / resumable | `running` | < `TASK_ORCH_RUNNER_SUSPEND_MS` (24h) | **suspend** (fast resume, keeps the Volume) |
| idle / resumable | `suspended`/`running` | ≥ `TASK_ORCH_RUNNER_SUSPEND_MS` (24h) | **stop** |
| idle / resumable | `stopped` | ≥ `TASK_ORCH_RUNNER_STOP_MS` (7d) | **archive-and-destroy** (Machine + Volume) |

Key properties:

- **Destroying a volume is lossless.** A run's `logs/runner.log` — the volume's
  only unique artifact — is streamed to Postgres (`agent_sessions.worker_log`,
  visible on the run detail page and `GET /api/runs/:id/worker-log`) incrementally
  during the run and flushed a final time at terminal. Everything else on the
  volume (checkout, npm cache, Claude session store) is reproducible or lives in
  Postgres, so a destroyed volume loses no debugging history.
- **Terminal runs are reclaimed fast.** Because destroy is lossless, a finished
  run's Machine + Volume are destroyed ~1h after it goes idle rather than kept for
  7 days. Only idle/resumable runs keep the long window (they can be restarted
  onto their existing Volume).
- **Resume keeps state.** A suspended or stopped Machine can be restarted onto its
  existing Volume, so a resumed run keeps its checkout, npm cache, and Claude
  session store. If the Machine is gone but the Volume remains, the server
  cold-recovers by creating a fresh Machine on that Volume.
- **Orphan-volume reaper.** Each sweep also destroys **leaked** volumes — a
  `vol_run_*` Volume with no attached Machine and no live/resumable run row (the
  residue of a crash or a missed destroy). It never touches a Volume attached to a
  Machine or referenced by a non-`gone` run, and skips volumes younger than a
  10-minute grace window so a just-created, not-yet-attached Volume is safe.
- **Crash detection.** If a Machine disappears while its run is still marked
  active, the sweep applies the death policy (`handleWorkerDeath`) so the run
  fails visibly instead of hanging — the boot reconcile + pending pump also cover
  this across restarts.
- **Concurrency cap.** With `TASK_ORCH_MAX_MACHINES > 0`, the admission gate defers
  over-cap runs to `pending` and a pump re-dispatches them oldest-first as slots
  free up.

**Inventory + cost.** `npm run task -- runners` lists live runner Machines +
Volumes with state, run id, age, and estimated monthly storage cost, plus totals
and an orphan marker. `npm run task -- runners --reap` destroys the orphan
Volumes it finds (the same predicate the sweep uses). Add `--json` for scripting.

**Tuning.** The defaults (destroy terminal runs after 24h; suspend resumable-idle
after 24h, destroy after 7d) keep a just-finished run's volume around long enough
to restart it the same day. Set a shorter terminal window on the **web app** for
tighter cost control if you never restart finished runs — e.g. back to 1h:

```bash
fly secrets set --app "$APP" \
  TASK_ORCH_RUNNER_TERMINAL_MS=3600000 \
  TASK_ORCH_RUNNER_SUSPEND_MS=43200000 \
  TASK_ORCH_RUNNER_STOP_MS=86400000 \
  TASK_ORCH_RUNNER_VOLUME_GB=10
```

Raise them if you frequently resume old runs. These are read by the server (the
control plane creates Machines and runs the lifecycle), not the runner pool.

---

## 9. Cold-start latency & the warm repo cache

A brand-new run's Fly Machine boots in ~6s, but historically the worker then
spent 20+ seconds before the agent could do useful work: `npx tsx` transpiling
the worker's TypeScript on boot, a full `git clone` of the target repo from
GitHub, and a recursive `chown` of the freshly-mounted session Volume. The
runner image now removes that overhead by baking a **warm repo cache** and a
pre-built worker into `Dockerfile.fly-runner`, so a cold start moves only the
delta since the image was built.

None of this changes correctness or needs any configuration to be *safe*: every
optimization degrades gracefully to today's behaviour when its inputs are
missing. What you configure affects only **how fast** a cold start is and **how
much data** it moves — never whether a run is correct.

### Warm repo cache

At image-build time `scripts/build-repo-cache.sh` clones each configured repo as
a bare, blobless mirror (`--filter=blob:none`) into
`/opt/repo-cache/<owner>_<repo>.git`. It is driven by the `REPO_CACHE_REPOS`
build arg (a space/comma-separated `owner/repo` list) and a `gh_token` BuildKit
build **secret** — the token is mounted only for that build step and is never
written into an image layer.

At run time the worker clones with
`git clone --reference <mirror> --dissociate --filter=blob:none`, reusing the
baked objects so a cold start transfers only the commits added since the image
was built plus the blobs it actually checks out. The mirror is a **seed, not a
source of truth**: every turn still runs `git fetch --prune origin` against
GitHub, so a stale image never affects correctness — it only makes that fetch
larger. If a repo has no mirror in the image (not listed in `REPO_CACHE_REPOS`,
the build step skipped, or the token missing), the worker transparently falls
back to today's full clone.

### Pre-built worker

The image also bundles the worker at build time with esbuild
(`npm run build:worker` → `dist/run-worker.js`), and the entrypoint runs
`node dist/run-worker.js` instead of `npx tsx scripts/run-worker.ts`. This drops
several seconds of on-boot TypeScript transpilation from every cold start. If
the bundle is somehow absent the entrypoint falls back to `tsx`.

### Entrypoint volume handling

`scripts/fly-runner-entry.sh` also trims two per-boot costs on the session
Volume (`$SESSION_ROOT`):

- The recursive `chown` of `$SESSION_ROOT` now runs **only on the first boot of
  a Volume**, guarded by the marker file
  `$SESSION_ROOT/.fly-runner-initialized`. A run resumed onto an existing Volume
  skips it.
- If the image ships an optional seed directory `/opt/claude-seed` (for shared
  agent config — e.g. a pre-provisioned `.claude` with settings and skills), it
  is copied into the Volume's `claude-home/.claude` **only when that directory is
  empty**. An existing Volume is never overwritten.

### Keeping the cache fresh

The baked mirror ages with the image, so a nightly workflow
(`.github/workflows/runner-image-nightly.yml`, cron `03:17 UTC` plus manual
`workflow_dispatch`) rebuilds and pushes the runner image with a fresh mirror
seed. The push-to-main deploy workflow passes the same inputs when they are
configured.

Configure these in the GitHub repo that hosts this project:

| GitHub setting | Kind | Purpose |
| --- | --- | --- |
| `REPO_CACHE_REPOS` | Actions **variable** | Space/comma-separated `owner/repo` list of the repos to pre-cache into the image. |
| `REPO_CACHE_GH_TOKEN` | Actions **secret** | Read-only *contents* token, used **only at build time** to clone the mirrors. |
| `FLY_RUNNER_API_TOKEN` | Actions **secret** | Existing token the workflow uses to push the image to the runner registry. |
| `TASK_ORCH_PREWARM_SEED_GB` | Actions **variable** | Optional seed volume size. Forked run volumes inherit this size, so set it to at least `TASK_ORCH_RUNNER_VOLUME_GB`. |
| `TASK_ORCH_RUNNER_VOLUME_GB` | Actions **variable** | Optional copy of the web app's run-volume size so the seed workflow can create a large-enough source volume. |

**Failure semantics.** If the nightly build fails — or you set none of the above
— nothing breaks: runs still work, cold starts just move more data (a larger
per-run `git fetch`, or a full clone for un-cached repos). A stale or failed
image is a performance degradation, never a correctness problem.

---

## 10. Manual / step-by-step deploy

If you'd rather not use the script (or want to understand it), here is the
equivalent by hand. Replace names/regions as needed.

```bash
APP=my-orch ; RUNNER=my-orch-runners ; DB=my-orch-db ; REGION=iad ; ORG=my-org

# 1. Apps
fly apps create $APP --org $ORG
fly apps create $RUNNER --org $ORG

# 2. Database
fly postgres create --name $DB --org $ORG --region $REGION \
  --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 10
fly postgres attach $DB --app $APP          # sets DATABASE_URL on $APP

# 3. Runner image (build + push only; no machine released)
fly deploy --config fly.runner.toml --app $RUNNER \
  --dockerfile Dockerfile.fly-runner --build-only --push --image-label latest

# 4. Runner API token
TOKEN=$(fly tokens create deploy --app $RUNNER --expiry 8760h --name task-orch-runner)

# 5. Secrets on the web app
fly secrets set -a $APP --stage \
  AUTH_SECRET="$(openssl rand -base64 32)" \
  NEXTAUTH_URL="https://$APP.fly.dev" \
  FLY_API_TOKEN="$TOKEN" \
  TASK_ORCH_FLY_APP="$RUNNER" \
  FLY_RUNNER_IMAGE="registry.fly.io/$RUNNER:latest" \
  TASK_ORCH_FLY_REGION="$REGION" \
  GH_TOKEN="ghp_…" \
  ANTHROPIC_API_KEY="sk-ant-…"

# 6. Deploy the server
fly deploy --config fly.toml --app $APP

# 7. First login
fly ssh console -a $APP -C "npm run task -- user add you@example.com --password=…"
```

---

## 11. Day-2 operations

### Status, logs, shell

```bash
fly status  -a my-orch                       # web app health + machine state
fly logs    -a my-orch                       # stream server logs
fly ssh console -a my-orch                    # shell into the web Machine
fly machine list -a my-orch-runners           # live/suspended/stopped run Machines
fly logs    -a my-orch-runners                # aggregated runner logs
fly volume  list -a my-orch-runners           # per-run Volumes
```

The web app also serves an unauthenticated **health probe** at `/api/health`
(`{ "status": "ok", "db": true, … }`), which Fly uses for its HTTP health check.

### First user

Auth is email + password (bcrypt, stored in Postgres). Manage users from the web
Machine:

```bash
fly ssh console -a my-orch -C "npm run task -- user add you@example.com --password=…"
fly ssh console -a my-orch -C "npm run task -- user list"
fly ssh console -a my-orch -C "npm run task -- user passwd you@example.com"
fly ssh console -a my-orch -C "npm run task -- user rm bot@example.com"
```

### Rotating a credential

```bash
fly secrets set -a my-orch GH_TOKEN=ghp_new…          # triggers a rolling redeploy
fly secrets unset -a my-orch GITHUB_WEBHOOK_SECRET     # remove one
```

New runner Machines pick up rotated secrets on their next creation; in-flight
runs keep the value they started with.

### Restarting / redeploying

```bash
fly apps restart my-orch          # restart the web Machine (runs reconcile on boot)
./scripts/fly-deploy.sh           # rebuild + redeploy everything (idempotent)
```

Because runs are detached onto their own Machines, restarting or redeploying the
web app never interrupts an in-flight run.

---

## 12. Scaling & performance

### Web app

State is in Postgres, but the web app runs **singleton background loops** (the
pending-run pump and the Fly monitor). Running more than one web Machine would
duplicate that work. Keep it at **one always-on Machine** (`min_machines_running
= 1`, `auto_stop_machines = "off"` in `fly.toml`) and scale **up** (bigger VM)
rather than out:

```bash
fly scale vm shared-cpu-4x --memory 4096 -a my-orch
```

### Run concurrency

Raise `TASK_ORCH_MAX_MACHINES` for more parallel runs (each is its own Machine,
so throughput scales horizontally without touching the web app):

```bash
fly secrets set -a my-orch TASK_ORCH_MAX_MACHINES=10
```

Set it against your Fly plan's Machine/quota limits and your model budget.

### Run Machine size

Heavier repos/builds want bigger runners:

```bash
fly secrets set -a my-orch TASK_ORCH_FLY_CPUS=4 TASK_ORCH_FLY_MEMORY_MB=8192 \
                           TASK_ORCH_RUNNER_VOLUME_GB=40
```

### Regions

Put the web app, database, and runners in the **same region** to minimize DB
latency (`FLY_REGION` does this for a fresh deploy; `TASK_ORCH_FLY_REGION`
overrides just the runners). Pick a region near your users and your GitHub
traffic.

---

## 13. Custom domains & TLS

Fly terminates TLS at its edge; `AUTH_TRUST_HOST=true` (already set) makes
Auth.js trust the forwarded host.

```bash
# 1. Point DNS at the app (Fly prints the exact records):
fly certs add tasks.example.com -a my-orch
fly certs show tasks.example.com -a my-orch      # DNS/verification status

# 2. Tell the app its public origin:
fly secrets set -a my-orch NEXTAUTH_URL=https://tasks.example.com
```

Update your GitHub webhook Payload URL to the new origin too (below).

---

## 14. GitHub webhooks

Beyond the built-in merge poller, the orchestrator accepts push-based GitHub
events for real-time PR/CI feedback (recorded on the session log; a merged PR
transitions its task to `done`; a red CI run can auto-fix when
`TASK_ORCH_CI_AUTOFIX=1`).

Configure a repo (or org) webhook in GitHub:

- **Payload URL:** `<NEXTAUTH_URL>/api/github/webhook`
- **Content type:** `application/json`
- **Secret:** a random string, also set as `GITHUB_WEBHOOK_SECRET`:
  ```bash
  fly secrets set -a my-orch GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
  ```
  The endpoint returns 503 until this is set and authenticates each delivery via
  the `X-Hub-Signature-256` HMAC.
- **Events:** Pull requests, Pull request reviews, Issue comments, Check runs,
  Check suites, Workflow runs (and/or Statuses).

The `/api/github/webhook` and `/api/mcp` routes are exempt from the login gate
(they authenticate via HMAC and bearer token respectively — see `middleware.ts`).

---

## 15. Security model

- **Database is private.** Only the web app's `http_service` is public; Postgres
  and the runners are reachable only over Fly's 6PN. Nothing binds Postgres to a
  public address.
- **No Docker socket.** Unlike the Compose deployment (which mounts
  `/var/run/docker.sock` into the server — host-root-equivalent), the Fly
  deployment gives the server only a **scoped Fly API token** for the runner app.
  It can create/stop/destroy Machines and Volumes in that one app and nothing else.
- **Least-privilege token.** The `FLY_API_TOKEN` is minted with
  `fly tokens create deploy --app <runner>` and an expiry (default 1 year). Rotate
  it with a fresh `fly tokens create deploy` + `fly secrets set FLY_API_TOKEN=…`.
- **Runner isolation.** Each run gets its own VM and Volume; runs never share a
  filesystem. Runners execute the agent as a non-root user.
- **Auth gate.** Every route except `/login`, `/api/auth/*`, `/api/health`,
  `/api/mcp` (bearer), and `/api/github/webhook` (HMAC) requires a signed-in
  session. Keep `AUTH_SECRET` secret and unique per deployment.
- **Secrets never in images.** All credentials are Fly secrets injected at
  runtime; `.dockerignore` excludes `.env*` from the build context.

To further harden, scope `GH_TOKEN` to only the repositories the agents work on,
and consider a fine-grained PAT.

---

## 16. Cost model

You pay Fly for, roughly:

- **Web Machine** — one small always-on VM (e.g. `shared-cpu-2x` / 2 GB).
- **Postgres** — one (or more) Machine + its volume.
- **Run Machines** — billed only while they exist. The lifecycle policy suspends
  idle Machines quickly (suspended Machines don't bill CPU), stops them after
  `TASK_ORCH_RUNNER_SUSPEND_MS`, and destroys them + their Volumes after
  `TASK_ORCH_RUNNER_STOP_MS`. Volumes bill until destroyed.

Plus your **model costs** (Anthropic) for the agent runs themselves, which
dwarf the infra for most usage.

Cost levers: lower `TASK_ORCH_MAX_MACHINES`, shrink `TASK_ORCH_FLY_*` sizes,
shorten the suspend/stop windows, and shrink `TASK_ORCH_RUNNER_VOLUME_GB`.
Inspect leftover resources with `fly machine list` / `fly volume list` on the
runner app.

---

## 17. Troubleshooting

| Symptom | Likely cause & fix |
| --- | --- |
| `flyctl not found` / `Not logged in` | Install flyctl; `fly auth login`. |
| App create fails with a billing error | The org needs a payment method (`fly orgs list`, add a card in the dashboard). |
| Server boots then crashes; logs mention `DATABASE_URL is not set` | Postgres wasn't attached. Re-run the script, or `fly postgres attach <db> --app <web>`, then `fly apps restart`. |
| Health check failing / deploy won't go healthy | Check `fly logs -a <web>`. Usually a bad `DATABASE_URL` or an unreachable DB. Confirm `/api/health` returns `db: true`. |
| Runs stay `pending` and never start | (a) `TASK_ORCH_MAX_MACHINES` too low — raise it. (b) `FLY_API_TOKEN` lacks Machines perms — mint a fresh `fly tokens create deploy --app <runner>` and reset the secret. (c) The runner image wasn't pushed — re-run stage 4. |
| Run fails immediately with a spawn error, or logs show `Fly API error 403: unauthorized` on `listMachines`/`create` | `TASK_ORCH_FLY_APP` or `FLY_RUNNER_IMAGE` wrong/missing on the web app (`fly secrets list`). The image must exist at `registry.fly.io/<runner>:latest`. Note: the runner app name must be `TASK_ORCH_FLY_APP`, **not** `FLY_APP_NAME` — Fly reserves `FLY_APP_NAME` and force-injects the web Machine's own app name, so the runner client would target the wrong app and 403. |
| Runner can't reach the database | Bring-your-own DB isn't reachable from the runner app's network, or a Supabase `:6543` URL — switch to the SESSION pooler `:5432`. |
| Agent can't clone/push or open PRs | Missing/invalid `GH_TOKEN`, or it lacks `repo` scope for the target repos. |
| Push rejected only when it touches `.github/workflows/*.yml` (`refusing to allow … without workflow scope`) | `GH_TOKEN` has `repo` but not `workflow` scope. Add `workflow` to the PAT and `fly secrets set -a <app> GH_TOKEN=…`; new runs pick it up. |
| Agent turns fail with an auth error | No `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` on the web app (they're passed into runners). |
| Webhook deliveries return 503 | `GITHUB_WEBHOOK_SECRET` not set. |
| Login loops / callback errors | `NEXTAUTH_URL` doesn't match the origin you're visiting; set it to the exact public URL and redeploy. |
| Leftover Machines/Volumes after runs | Normal within the idle windows; force-clean with `fly machine destroy … -a <runner>` and `fly volume destroy …`. |

Inspecting a specific run: the session detail page (`/sessions/<id>`) streams
events including `runner_created` / `runner_suspended` / `runner_destroyed`
lifecycle markers; the raw runner log is on the Machine at
`/mnt/session/logs/runner.log`.

---

## 18. Upgrading & redeploying

- **New app code:** pull/merge, then `./scripts/fly-deploy.sh` (rebuilds both
  images and redeploys). Migrations apply on boot.
- **Just the server:** `fly deploy --config fly.toml -a <web>`.
- **Just the runner image:** `fly deploy --config fly.runner.toml -a <runner>
  --dockerfile Dockerfile.fly-runner --build-only --push --image-label latest`.
  New runs use the new image; existing suspended runs keep their old image until
  destroyed. The nightly workflow rebuilds this image with a fresh warm-cache
  seed on its own ([§9](#9-cold-start-latency--the-warm-repo-cache)).
- **Config change (env in `fly.toml`):** edit and `fly deploy`.
- **Secret change:** `fly secrets set` (auto-redeploys).

Zero-downtime isn't guaranteed for the single web Machine during a redeploy, but
in-flight **runs** are unaffected because they're detached.

---

## 19. Teardown

Remove everything you created (irreversible — destroys the database):

```bash
# Destroy leftover run Machines + Volumes first (optional; app destroy also removes them)
fly machine list -a my-orch-runners
fly volume  list -a my-orch-runners

fly apps destroy my-orch-runners --yes
fly apps destroy my-orch-db       --yes     # deletes all data
fly apps destroy my-orch          --yes
```

To pause instead of destroy: `fly scale count 0 -a my-orch` (stops billing for
the web Machine) and let the lifecycle policy clean up idle runners.

---

## 20. FAQ

**Can the server and runners be the same app?**
Not recommended. Keeping them separate lets `fly deploy` manage the web Machine
without touching the API-created run Machines, and scopes the runner API token to
just the pool.

**Do I need a volume on the web app?**
No. All durable state is in Postgres; the web Machine is stateless.

**Can I run multiple web Machines for HA?**
Not as-is — the pending pump and Fly monitor are process-wide singletons and
would duplicate work across replicas. Scale the single Machine up instead. (The
code notes a `pg_advisory_xact_lock` as the drop-in upgrade path if replication
is ever needed.)

**How do I use Fly Managed Postgres (MPG) instead of the legacy Fly Postgres?**
Create it with `fly mpg create`, grab its connection string, and set
`DATABASE_URL` before running the script — provisioning is then skipped.

**Where do agent transcripts and attachments live?**
In Postgres (attachments as `bytea`, capped at 25 MiB each), so they survive
runner destruction and web redeploys.

**Is the Discord pipe supported on Fly?**
The core deploy covers the web server, runners, and database. The optional
Discord `pipe` service can be run as a separate Fly app from the same
`Dockerfile.server` image with `command = ["npm", "run", "pipe"]` and the
`DISCORD_*` secrets; it isn't part of the one-command script.

---

See also: [`README.md`](../README.md) · [`SCHEMA.md`](../SCHEMA.md) ·
[`docs/test-deployment.md`](test-deployment.md) · `.env.docker.example` (full
runner env reference).
