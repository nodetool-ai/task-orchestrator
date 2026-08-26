# Agent caveats — hard-won debugging lessons

Accumulated from real debugging sessions (fly runs #131–145, and the
worker-WS migration). Read this before debugging a
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
  133/137/140/144.)
- **Error text can lie.** The Claude Agent SDK's "native binary … exists but
  failed to launch / libc mismatch" message fires on ANY spawn syscall failure
  when the binary file exists. The actual cause in every observed case was a
  **cwd that doesn't exist in the worker** (Node reports spawn-ENOENT against
  the executable, not the cwd). Verify the cwd before suspecting the binary.
- `runner_instances` uses column `state` (not `status`).

## cwd / repository resolution

- `validateCwd()` (lib/runs.ts) exists precisely to catch the misleading
  SDK spawn error. The **ws-worker turn driver now validates cwd too**:
  `lib/worker-runtime/context.ts` runs it before falling back to the
  snapshot's `repository.localPath`, so a **control-plane path** (e.g.
  `/Users/mg/dev/...`) that does not exist inside a fly worker is caught
  before spawn instead of surfacing as a misleading SDK error. Any cwd
  handed to a backend must be validated *inside the worker that will spawn
  from it*.
- **A repository with no `remote` cannot run on a remote runner** (fly):
  the worker has nothing to clone. Check `repositories.remote` first when a
  remote run is rejected for a "local" repo.
- `followUp()` (CI-autofix turns) executes **in the control-plane process**,
  which on deployed servers has no git/SESSION_ROOT → `git worktree add`
  exit 128 / `spawn git ENOENT`, retried every 2 min by the autofix poller.

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
- The `worker-websocket-e2e` "wakes on a follow-up input" test was
  deterministically red in isolation for days and misfiled as a flake: it
  asserted a user row the worker is deliberately forbidden to write (the
  control plane persists run.input BEFORE bridging it). Fixed 2026-07-19 by
  persisting first, like `sendMessageToRun`. Lesson: a "flake" that fails in
  isolation but passes in a full file is usually a real contract bug masked
  by sibling-test side effects — run it alone before writing it off.

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
  external machine; the user must run the copy (or `claude login` there).

## Fly runners

- Park/suspend/resume races: a machine can resume and be idle-suspended
  ~64 ms later ("heartbeat lost, scope none"); waking a suspended machine
  can 409 "machine exited abruptly" — treat as retryable.
- `npm run trace-run -- <id> --fly` is the fastest way to reconstruct a
  fly run tree.
