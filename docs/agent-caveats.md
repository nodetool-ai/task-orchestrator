# Agent caveats — hard-won debugging lessons

Accumulated from real debugging sessions (fly runs #131–145, box runs #26/27,
the worker-WS migration, box template work). Read this before debugging a
failed run or touching runner/worker code. Each entry is a trap that has
already cost real time once.

## Reading a failed run

- **Start with the event timeline, not the error text**:
  `SELECT created_at, type, payload FROM agent_events WHERE run_id=<id> ORDER BY created_at`.
  The `runner_*` events tell you which phase died and how long each took.
  Dev DB: `postgres://postgres:devpw@localhost:5433/taskorch`.
- **A sub-100ms `running` → `failed` transition means the agent never ran.**
  It's a spawn/infrastructure failure (bad cwd, missing binary, in-process
  execution on the wrong host) — not an agent error. (Seen on fly runs
  133/137/140/144 and box runs 26/27.)
- **Error text can lie.** The Claude Agent SDK's "native binary … exists but
  failed to launch / libc mismatch" message fires on ANY spawn syscall failure
  when the binary file exists. The actual cause in every observed case was a
  **cwd that doesn't exist in the worker** (Node reports spawn-ENOENT against
  the executable, not the cwd). Verify the cwd before suspecting the binary.
- `runner_instances` uses column `state` (not `status`); box mappings live
  there (`box_id`, `box_template_id`).

## cwd / repository resolution

- `validateCwd()` (lib/runs.ts) exists precisely to catch the misleading
  SDK spawn error — but the **ws-worker turn driver bypasses it**:
  `lib/worker-runtime/context.ts` falls back to the snapshot's
  `repository.localPath`, which is a **control-plane path** (e.g.
  `/Users/mg/dev/...`) that does not exist inside a box/fly worker.
  Runs 26/27 failed exactly this way. Any cwd handed to a backend must be
  validated *inside the worker that will spawn from it*.
- **A repository with no `remote` cannot run on a remote runner** (box/fly):
  the worker has nothing to clone. Admission does not reject this today —
  the run burns a full template build and then dies at spawn. Check
  `repositories.remote` first when a box run fails on a "local" repo.
- `followUp()` (CI-autofix turns) executes **in the control-plane process**,
  which on deployed servers has no git/SESSION_ROOT → `git worktree add`
  exit 128 / `spawn git ENOENT`, retried every 2 min by the autofix poller.

## ascii.dev Box runners

- Base image: **Ubuntu 24.04, glibc 2.39** (no musl anywhere), ~7.7 GB RAM,
  node via nvm, `claude` preinstalled at `/usr/local/bin/claude`,
  passwordless sudo, systemd 255.
- **Archive→fork is NOT racy.** Verified with a controlled repro (fork 10 s
  after checkpoint, 250 MB binary, identical sha256, execs fine). Don't
  blame snapshot propagation for exec failures — see the cwd caveat instead.
- The box `command` API has a hard per-call duration limit. Long steps must
  use the detached pattern: launch with `setsid sh -c '(cmd) > log 2>&1;
  echo $? > rc' </dev/null &`, then poll the `.rc` marker with short calls
  (see `lib/runner/box-template-builder.ts`).
- Processes backgrounded over plain `box ssh` die with the session. Durable
  processes need **systemd units** (snapshotted, restart on resume/fork) or
  the setsid-detach pattern via the command API.
- A **stopped box cannot receive commands**, but its checkpoint can be
  **forked** — that's how you do a postmortem on a failed run's exact
  filesystem. Fork readiness after a checkpoint can exceed 60 s; pass a
  longer `timeoutMs` to `waitForBoxReady`.
- First run with no warm template triggers an **inline template build
  (~11 min)** on the run's critical path (`reason:"no-template"`). CI warms
  templates; local dev may still hit cold builds.
- The build has a pre-archive `verifying-worker` step (execs the SDK native
  binary + `sync`) — a template whose binary can't launch fails at build
  time, not run time.
- Reusable live probes (all `BOX_LIVE_TEST=1`, fork disposables, remove in
  `finally`): `scripts/box-inspect-run26.ts` (template health),
  `scripts/box-inspect-run27-postmortem.ts` (fork a failed box),
  `scripts/box-fork-race-repro.ts` (archive→fork timing).
- `host` proxy dialing: dial the wss URL **without** the `?_token` query
  (it 302s); carry the token as a `Cookie: _port_auth=<t>` header plus the
  worker's own `Authorization: Bearer` credential.

## Worker channel

- Each worker instance needs a **fresh `SESSION_ROOT` and channel
  instanceId** — reusing them makes the durable spool replay the prior
  completed run.
- The worker verifies its channel credential by **exact string compare**
  (any opaque token works in harnesses; no HMAC secret needed worker-side).
- Unix socket paths must stay under the 108-char `sun_path` limit —
  cwd-derived paths pass locally (94 chars) and fail on CI runners
  (110 chars, `listen EINVAL`). Keep sockets in short tmp dirs.
- Workers must never touch Postgres directly (`TASK_ORCH_INSIDE_WORKER=1`
  guard). A worker log line "Direct database access attempted inside a run
  worker" means some code path fell back to direct DB — route it through
  the channel transport.
- Known pre-existing flake: `worker-websocket-e2e` "wakes on a follow-up
  input" fails on a clean tree too — don't chase it as a regression.

## Claude backend / SDK

- Spawn failures are retried in-process (bounded, settle delays; see
  `SPAWN_FAILURE_RE` in `lib/agent-backend/claude-backend.ts`,
  test seam `__test.setSpawnRetryDelays`). A persistent failure is
  rethrown flagged as an infrastructure fault.
- One resume-lost fallback per turn: "No conversation found with session
  ID" degrades to a fresh session with a context-loss note — it must never
  fail the turn.
- Claude OAuth credentials live in the **macOS keychain**
  (`security find-generic-password -s "Claude Code-credentials" -w`), not a
  file — mounting `~/.claude` into a container carries no token. The
  auto-mode classifier blocks an agent from copying that secret to an
  external box; the user must run the copy (or `claude login` in the box).

## Fly runners

- Park/suspend/resume races: a machine can resume and be idle-suspended
  ~64 ms later ("heartbeat lost, scope none"); waking a suspended machine
  can 409 "machine exited abruptly" — treat as retryable.
- `npm run trace-run -- <id> --fly` is the fastest way to reconstruct a
  fly run tree.
