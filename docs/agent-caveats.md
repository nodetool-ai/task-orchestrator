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

- Run 188 was an idle chat, but recovery sent six `run.start` snapshots with
  no pending input or inbox events. The worker treated each bootstrap as a
  request to continue and burned model turns after the last human message.
  Transport adoption is not a model-turn trigger: require actual input, an
  event, or an explicit kickoff. Preserve legitimate event-only wakes.
  Its Sprite also retained the original worker bundle after the repository
  checkout fix shipped. A restarted process is not proof that its bundle was
  refreshed; recovery must retain checkout/SDK state while replacing stale
  worker code with the proper generation and channel identity.
- Stopping a Sprite service and destroying a Sprite are different operations.
  Idle chat cleanup must stop the exact service while preserving the Sprite's
  filesystem. `stopRunner()` is terminal resource cleanup and can delete the
  Sprite and clear the SDK session. Check durable inputs and generation
  ownership when stopping an idle service so a racing follow-up survives.
- Chat backend errors must publish `run.failed` and complete the channel
  commit handshake. Logging and exiting alone leaves a run marked `running`:
  run 188 hit Claude's session limit twice, restarted, and kept that stale
  status. Cancellation still owns its separate `run.cancelled` outcome.

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

- Sprite's cgroup namespace root contains provider init/exec processes, so
  enabling its child memory controller fails with `EBUSY`. Sprite dispatch and
  bootstrap explicitly select the supervisor's namespace-root mode: memory,
  swap and task caps apply at that isolated root, while core child cgroups
  retain descendant cleanup and the shared command permit. Never migrate
  provider processes to make controller delegation work: future provider execs
  still attach at the root. This mode has no command-local OOM isolation or
  protected runtime reserve; an aggregate OOM may kill the worker too. Existing
  provider limits are only tightened, and the root must keep OOM grouping off.
  Test this layout with `--cgroupns=private`, including an ordinary user with
  sudo. Host-namespace Docker tests alone do not reproduce it.
- Retained pooled Sprites need the same bundle refresh as cold Sprites during
  resume. Refresh worker files without restoring their original baseline; a
  baseline restore would erase unpublished changes. All orphan reapers,
  including the legacy `lib/agent.ts` startup handler, must recognize the
  canonical task branch when run-level branch/path fields are still null.
- Runs 295/298 combined nested-agent verification fan-out, exhausted swap, and
  orphaned compiler/test processes. A shell's parent exiting is not proof its
  descendants exited. Sprite services now start through `process-supervisor.py`:
  cgroup v2 bounds the aggregate workload to the smaller of 6 GiB or 75% of RAM,
  256 MiB swap and 256 tasks; supervisors remain outside that workload. Each
  `worker_shell` invocation shares one cross-agent execution permit and reaps
  its entire cgroup on completion, cancellation or parent loss, including
  double-fork/setsid descendants. Native shell tools are disabled on this path.
  Assign full-repository checks to one agent and bound test-runner workers.
  Resource limits are configurable via `TASK_ORCH_PROCESS_MEMORY_MAX_BYTES`,
  `TASK_ORCH_PROCESS_SWAP_MAX_BYTES`, and `TASK_ORCH_PROCESS_PIDS_MAX`.
  Each command reserves the smaller of 1 GiB or one quarter of the memory
  budget for the runtime; a command-local OOM kills that command group while
  allowing the worker to report the failure. The aggregate limit is the backstop.
- Bootstrap runs a real supervisor preflight. Python 3.9+, cgroup v2 memory/pids,
  `cgroup.kill`/pidfds, and noninteractive sudo for delegation are required;
  unsupported images fail closed. The helper is included in the worker bundle
  digest, so replacing Node code alone is insufficient. Kernel-uninterruptible
  tasks can survive pending SIGKILL; a bounded cleanup failure must retain its
  scope and be investigated, never reported as successful reaping.
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

- Sprite service inventory is cached supervisor metadata, not process evidence.
  Runs 295/298 still reported `running`, PID 1452 and the original start time
  after their workers had exited. Exact-service inspection now checks procfs
  with a bounded non-login probe; missing/replaced process identity proves
  death, while API failures, inaccessible procfs and uncertain process state
  remain `unknown`. The probe may wake a hibernated Sprite. Never print raw
  service inventories or `/proc/*/environ`: both can contain credentials.
- VM hibernation pauses Node's timer clock. Turn, idle and disconnect checks
  catch up against `Date.now()` after resume; late SDK output cannot erase a
  deadline that already expired. Local deadline checks are not progress or
  transport heartbeats. Controller loss is infrastructure shutdown, not user
  cancellation: keep the active logical turn and assigned inputs recoverable.
  Worker shutdown writes fsynced, incarnation-scoped `workers/<instance>/exit.json`
  before a bounded drain. This is forensic evidence, not authority to recover
  while the supervisor is still alive, and the old instance's outbox must never
  be replayed under a new channel identity.
- Remote v2 implement recovery uses the task's canonical `tasks.branch` even
  when `agent_runs.branch` and `worktree_path` are null. A new generation owns
  recovery of the active turn and pending follow-ups under the existing CAS
  fences. For the pre-fix 295/298 Sprites, preserve unpublished checkout changes
  and inspect remaining descendant processes before recovery; deploying this
  code does not retroactively contain those old processes. Manual cleanup or
  service replacement is a separate authorized production operation.

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

## Repository readiness on Sprite baselines

- Run 276's apparent native-addon postinstall hang was a VM filesystem stall:
  npm, Codex, and even a fresh login shell had threads blocked in ext4 journal
  or buffer waits; loop-device completions were frozen and I/O pressure was
  about 99%. Inspect thread wait channels and disk counters before diagnosing
  native compatibility. A zombie process leader can still have blocked threads.
  Use a non-login shell for procfs diagnostics, preserve unpublished work before
  VM recovery, and do not treat a partial dependency tree as ready. See
  [run 276 evidence and recovery](run-276-sprite-storage-stall.md).

Repository dependency baselines can opt into project-specific preparation and
readiness through `TASK_ORCH_SPRITE_POOL_BASELINES`. The dependency manifest
accepts `setupCommands`, `buildCommands`, `readinessCommands`,
`minimumGitHistoryDepth`, and `baseRef`. Setup runs before `npm ci`; builds run
after installation and again when a retained checkout needs dependency repair.
Readiness checks run before a baseline is sealed and whenever its dependency
tree is reused. They verify configured history/merge-base requirements,
declared `typescript`/`tsx`/`vitest` resolution, `better-sqlite3` native loading,
declared workspace `dist/` entry points, and every configured readiness command.

Dependency baselines always check declared tools, native bindings, and workspace
outputs; repository-specific services still need explicit readiness commands.
Input-scoped reuse (`reusePolicy: "inputs"`) requires audited install-script
inputs and a `.npmrc` hash or absence assertion. It keeps dependencies across
ordinary source changes and refreshes source-dependent builds separately. Legacy
profiles retain conservative revision-based installation invalidation. Use
`npm run sprite:baseline` to hash a pinned commit and generate a validated profile;
see the [warm-pool guide](runners/sprite-warm-pool.md). Prefer repository-owned
commands and the persistent baseline npm cache. For a
repository whose tests require Postgres, a bounded probe can be configured as:

```json
{
  "readinessCommands": [
    "node -e \"const n=require('net').connect({host:'127.0.0.1',port:5433});n.setTimeout(5000);n.once('connect',()=>{n.end();process.exit(0)});n.once('timeout',()=>process.exit(1));n.once('error',()=>process.exit(1))\""
  ]
}
```

Keep probes non-destructive and bounded. Failures retain only the final 2 KiB
of command output in the diagnostic, which is enough to identify the missing
service or tool without flooding the durable runner history.

## Reusable Sprite fences

- Runs 283/285/286 exposed mount-relative swap reporting: `/proc/swaps` can
  report `/task-orchestrator.swap` while the same file is accessed at
  `/tmp/task-orchestrator.swap`. Resolve the mount root or file identity before
  resizing/enabling swap. Accept `swapon` failure only after confirming the
  expected file is active. Never remove a file whose `swapoff` failed.
- Checkpoint restore and creation are streaming operations; allow the complete
  operation deadline without a shorter HTTP header/body idle timeout.
- With `TASK_ORCH_SPRITE_POOL_REUSE=1`, Sprite names are no longer run identities.
  Stop by run, generation and channel instance; an old physical handle may
  already belong to another run. Service and remote-command names include run IDs.
- Recycling requires clean published Git work, then a stopped-service checkpoint
  restore and baseline verification. Publish `ready` and clear the old mapping in
  one transaction. Failed restoration stays unclaimable in `recycling`.
- Follow-ups arriving after the recycling fence remain queued. Dispatch waits
  for the Sprite lifecycle lock, then creates the next generation from the
  published branch with a fresh SDK session; it must not resume the restored
  filesystem under the old channel identity.
