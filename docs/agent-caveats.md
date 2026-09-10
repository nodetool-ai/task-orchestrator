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

- A parked chat can be alive yet unable to resume: run 219 accumulated 1,566
  messages and its persisted `run.start` exceeded the 1 MiB JSON frame limit.
  Resume snapshots with an SDK session now bound only the redundant consumed
  transcript copy; full DB/SDK history, pending inputs, and receipt manifests
  stay intact. The controller also handles already-persisted oversized starts
  at replay time. Do not fix these by deleting history, editing command IDs or
  payloads in place, or raising the transport limit without a bound.

- Git delivery belongs to the agent. Run 224 finished its model turn while
  run 223 had advanced the same task branch; an automatic terminal push then
  failed with `fetch first`. Implementation prompts must tell the agent to
  fetch, reconcile, push, open/update the PR, and record it before reporting
  success. Worker finalization only persists the result; it must not commit
  leftovers or perform another push. The same rule applies to local turns
  and CI follow-ups.

- Replacement run lineage is not supervision. A retry must keep the failed
  run's `parent_run_id` and record the predecessor in `resume_of`. Run 221's
  Sprites 502 led another root (218) to start replacement 222 under itself,
  leaving the actual supervisor (219) unable to observe it across trees.
  `start_session` now preserves supervision after a failed task session and
  accepts `resume_of` for explicit replacements. For an existing misplaced
  leaf, `scripts/repair-run-supervision.ts` defaults to a dry run and atomically
  repairs the parent plus durable subscription with current-state replay.

- Each replacement worker needs a **fresh channel instanceId**. Transport
  state lives under `SESSION_ROOT/workers/<instanceId>/channel`; restarting
  the same incarnation reuses its spool. Keep `SESSION_ROOT` stable to preserve
  the repository and SDK sessions. Explicit `outboxRoot` overrides must also
  be isolated per incarnation.
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

## Codex on Sprite

- Sprite's base-image Node version floats. Run 220 received Node 24/npm 12
  despite the repository requiring Node 22, and `npm install` failed with
  `EALLOWREMOTE` for the SheetJS URL dependency (npm 12 defaults remote
  tarball fetching to disabled). Bootstrap now installs Node 22.22.3/npm
  10.9.8 and sets Sprite's NVM default; warm baselines install the exact Node
  release in their manifest. Verify in a fresh `bash -lc` invocation: an
  exec-local `nvm use` does not change subsequent services or shells.
- MCP initialization and MCP execution need separate checks. A required server
  can initialize successfully but reject every call: `approvalPolicy: "never"`
  does not approve MCP tools. The run's bridge needs
  `default_tools_approval_mode: "approve"`; authorization still happens through
  its interceptors and the worker channel.
- The Sprite image can reject Codex's nested Linux sandbox with
  `bwrap: Unexpected capabilities but not setuid, old file caps config?`.
  Sprite dispatch defaults Codex to `danger-full-access` inside the isolated VM
  and forwards `TASK_ORCH_CODEX_SANDBOX` overrides. Local runs retain
  `workspace-write`.
- Exercise a real CLI tool call when changing MCP configuration. An SDK mock
  plus a direct MCP-client test does not cover Codex's tool approval policy.
  See [codex-integration.md](codex-integration.md) for the integration decision
  and verification contract.

## Liveness

- Turn progress and worker liveness are separate. The default watchdog aborts
  after 30 minutes without observed SDK progress, not 30 minutes since turn
  start. `TASK_ORCH_TURN_TIMEOUT_MS` is now an opt-in hard cap (default `0`);
  explicit run budgets still apply. Raw Codex item updates, Pi tool output, and
  Claude nested-agent output must reach `onProgress` even when omitted from
  transcript mapping. Do not reset it on transport heartbeats or elapsed-time
  tool messages: a live process can still be stuck. Intentionally silent long
  operations need an adjusted `TASK_ORCH_TURN_IDLE_TIMEOUT_MS`.

- There is no heartbeat and no stale window. "Is the worker alive" is
  `resolveLiveness(runId)`: the provider's `inspect()` plus an incarnation
  compare. `unknown` (API down, no credentials in this process) means
  "leave it alone", never "reap".
- A missing Sprite service is the exception once `worker_incarnation` exists:
  that durable value proves the exact generation previously ran, so a service
  404 is `dead/runner-gone`, not another bootstrap window. Without an
  incarnation the same 404 remains `unknown` (the run-184 guard).
- `agent_runs.pending_since` and `claimed_at` are bookkeeping (defer bound,
  claim age), not liveness inputs.
