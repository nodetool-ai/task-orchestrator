# Test deployment — Docker/Postgres stack

Stand up the full containerized stack (Postgres + server + ad-hoc Docker workers)
in isolation and validate the end-to-end **run → worker container → git checkout →
PR → live stream** loop that the unit tests can't cover. Nothing here touches the
prod systemd services or the prod SQLite DB.

Everything runs as a separate compose project (`task-orch-test`) with its own
network and **throwaway** volumes on a **non-conflicting port** (3005).

## Prerequisites

- Docker + `docker compose` v2 on the host.
- A **throwaway GitHub repo** to open test PRs against (e.g. `you/orch-sandbox`)
  with at least one commit on its default branch.
- A **GitHub token with `repo` scope** on that repo (`gh auth token`, or a PAT).
- `~/.claude` authenticated on the host (Claude Code login), so workers inherit
  the session for the agent turn.

## 1. Configure

```bash
cp .env.test.example .env.test
# edit .env.test:
#   AUTH_SECRET   = $(openssl rand -base64 32)
#   GH_TOKEN      = <scoped token>
#   TARGET_REPOS  = you/orch-sandbox          # space-separated owner/repo
#   CLAUDE_HOME   = /home/claude/.claude
#   SERVER_PORT   = 3005                        # keep non-conflicting
```

## 2. Bring up the stack

```bash
scripts/test-deploy.sh up
```

This builds both images, starts `postgres` + `server`, mirrors `TARGET_REPOS`
into the `repo-cache` volume, and waits for health. On success it prints
`http://localhost:3005`. The server runs `initDb()` on boot — migrations + seed
(R-default, personas, the `run_stream` trigger) apply to the fresh Postgres.

Sanity checks:

```bash
scripts/test-deploy.sh status            # services + any live worker containers
scripts/test-deploy.sh psql "\dt"        # tables exist
scripts/test-deploy.sh psql "SELECT id FROM repositories;"   # R-default seeded
```

## 3. Point the default repo at your sandbox + seed a task

The CLI talks to the DB directly and is run **inside the server container** (which
has `DATABASE_URL`, the source, and `docker.sock`). Set R-default's remote to your
sandbox so runs clone it, then create a plan + task:

```bash
DC="docker compose -p task-orch-test --env-file .env.test"

# point the default repo at the sandbox (matches TARGET_REPOS mirror name)
scripts/test-deploy.sh psql \
  "UPDATE repositories SET remote='git@github.com:you/orch-sandbox.git' WHERE id='R-default';"

# seed a plan + a trivial task
$DC exec server npx tsx cli.ts new plan --title="Test deploy $(date -u +%H%M)"
$DC exec server npx tsx cli.ts new task --plan=<PLAN_ID> \
  --title="Add a HELLO.md" \
  --body="Create a file HELLO.md containing 'hello from a worker container', commit it, and open a PR."
```

## 4. Acceptance test — dispatch a run through the containerized server

Dispatch the task's agent from inside the server container (this exercises the
real path: `runs.create` → `dispatchRun` → **`docker run` a worker container** via
the mounted socket):

```bash
$DC exec server npx tsx cli.ts agent <TASK_ID>
```

Then watch it work:

```bash
# a run-<id>-<nonce> worker container should appear:
watch -n1 'docker ps --filter name=run- --format "{{.Names}}\t{{.Status}}"'

# events/messages streaming into Postgres (proves the worker->PG path):
scripts/test-deploy.sh psql \
  "SELECT id, status, branch, pr_url FROM agent_runs ORDER BY id DESC LIMIT 1;"
scripts/test-deploy.sh psql \
  "SELECT count(*) FROM agent_messages; SELECT count(*) FROM agent_events;"

# worker container's own logs (if it fails, the error is here):
docker logs <run-container-name>
```

## 5. Pass criteria

- [ ] A `run-<id>-*` worker container starts (and exits `--rm` when done).
- [ ] The run goes `preparing → running` and `agent_messages`/`agent_events` grow.
- [ ] A **branch + PR appear on the sandbox repo** (`gh pr list -R you/orch-sandbox`).
- [ ] The run view streams live: open `http://localhost:3005/runs/<id>` (needs a
      signed-in user — create one with `$DC exec server npx tsx cli.ts user add you@x.com --password=...`)
      and confirm messages appear without polling.
- [ ] `docker compose restart server` mid-run → the worker container keeps running
      and the run completes (restart-survival).
- [ ] Cancel from the UI → the worker aborts within ~one heartbeat (20s) and/or the
      container is stopped.

## 6. Teardown

```bash
scripts/test-deploy.sh down      # stops everything + removes the pg + repo-cache volumes
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Run wedged in `preparing`, no worker container | Server can reach docker.sock: `$DC exec server ls -l /var/run/docker.sock`; worker image exists: `docker images task-orchestrator-worker`. |
| Worker container exits immediately | `docker logs <run-container>` — usually a missing env (DATABASE_URL/GH_TOKEN) or the repo-cache mirror absent. |
| Clone/PR fails with auth error | `GH_TOKEN` lacks `repo` scope on the sandbox, or the credential helper env didn't reach the worker. |
| `containerCheckout` "no GitHub remote" | The run's repository row has no `remote` (step 3). |
| No live stream in the run view | `run_stream` trigger present (`scripts/test-deploy.sh psql "SELECT tgname FROM pg_trigger WHERE tgname='agent_events_notify';"`) and the listener connected. |
| Agent turn fails with no API key | `~/.claude` not authenticated on the host, or `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` unset. |

## Notes / known gaps (see PR #57)

- `followUp` / CI-autofix still runs the host worktree path — not exercised here.
- `docker.sock` is mounted raw; put a least-privilege socket proxy in front before
  any non-local exposure.
- This is a *test* deploy. A prod cutover additionally needs `deploy.sh` rewritten
  for `docker compose up`, the ETL run into the prod Postgres, and repository
  remotes configured.
