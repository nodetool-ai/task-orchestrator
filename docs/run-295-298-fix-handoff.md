# Worker containment and recovery fix for runs 295/298

Branch: `codex/fix-worker-containment-recovery`  
Base: `6158296` (`Instrument worker runs with local diagnostics`)  
Validation date: 2026-09-13

This change addresses the supplied incident evidence: nested verification
processes exhausted memory/swap and outlived their command; hibernation delayed
watchdogs; disconnected shutdown could wait indefinitely; Sprite inventory
retained `running`/PID 1452 after process exit; and v2 implement runs could have
their canonical branch only in `tasks.branch`.

No production service, Sprite, process, checkout, or database was changed as
part of this implementation. Manual recovery of runs 295/298 remains a separate
authorized operation.

## Resulting behavior

- Every new Sprite worker starts through a Linux cgroup-v2 supervisor. The
  aggregate default is the smaller of 6 GiB or 75% of RAM, 256 MiB swap, and 256
  tasks. Each command has a separate OOM group with runtime memory reserved.
  One shared command permit spans nested clients; native shell tools route to
  `worker_shell`, and Codex nested agents are bounded to two threads/one level.
  Command completion, cancellation, transport loss, and worker death reap
  descendants, including double-fork/setsid children. Backend success is
  recorded only after shell cleanup succeeds.
- Watchdog, idle, and disconnect deadlines check elapsed wall time after
  resume. Late SDK output cannot erase an expired deadline. Timer checks and
  transport heartbeats do not count as meaningful model progress.
- Controller loss records fsynced, incarnation-scoped `exit.json` evidence,
  aborts model work, and bounds worker shutdown to five seconds after its
  shutdown handler can execute. This infrastructure abort preserves the active
  logical turn and assigned/pending inputs. A replacement never replays the old
  incarnation's channel outbox.
- Liveness checks cached service state against a bounded procfs identity
  probe. An inaccessible/expired/uncertain observation stays `unknown`.
  Replacement of contained services also requires an empty containment scope.
  Both dead-worker recovery paths recognize `tasks.branch` when legacy run
  branch/worktree columns are null; existing generation/CAS fences remain.

## Validation

| Check | Result |
| --- | --- |
| Linux supervisor suite, root in disposable Docker VM container | 27 passed (14 portable, 13 kernel integration) |
| Same suite, ordinary user with noninteractive sudo delegation | 27 passed |
| Focused shutdown/channel/watchdog regression suite | 77 passed across 6 files |
| Final adapter/shell suite after cleanup-diagnostics correction | 48 passed across 4 files |
| Real installed Codex CLI with local mock Responses API | 4 passed, included in the adapter suite; no billable model API calls |
| Affected regression suite, serial retry | 927 passed across 85 files in 105.75 seconds |
| Standalone worker build | Passed |
| TypeScript, `tsc --noEmit --incremental false` | Passed |
| `git diff --check` | Passed |

The earlier two-worker affected run passed 925 tests and timed out in the
existing 1,000-fsync outbox compaction test at its 30-second limit. The final
retry passed with one worker; neither that test nor its timeout was changed.

Kernel coverage includes command-local and aggregate OOM, aggregate fork
limits, shared command serialization, cancellation, supervisor SIGKILL,
worker death during a command, orphan adoption/reaping, paused-supervisor
wall-clock catchup, nonroot cgroup entry, and bounded failure for simulated
kernel-stuck tasks. The real CLI test checks that the installed Codex binary
executes the replacement MCP shell with native shells disabled; the Linux
suite independently verifies the real containment mechanism.

Reproduction commands (use an isolated test database):

```bash
npm run build:worker:standalone
node_modules/.bin/tsc --noEmit --incremental false
DATABASE_URL=postgres://postgres@127.0.0.1:55439/postgres \
  node_modules/.bin/vitest run \
  __tests__/worker-*.test.ts __tests__/sprites-*.test.ts \
  __tests__/run-liveness.test.ts __tests__/reconcile-orphaned-runs.test.ts \
  __tests__/runner-*.test.ts __tests__/run-dispatch*.test.ts \
  __tests__/dispatch-takeover.test.ts __tests__/atomic-finalize.test.ts \
  __tests__/turn-watchdog.test.ts __tests__/agent-backend/*.test.ts \
  __tests__/delegation-guidance.test.ts __tests__/run-inputs.test.ts \
  --maxWorkers=1 --minWorkers=1 --cache=false
# Run in an isolated Linux cgroup-v2 VM/container, both as root and as a
# regular user with noninteractive sudo permission for the Python helper:
TASK_ORCH_TEST_CGROUP_ROOT=/sys/fs/cgroup/task-orch-regression-295-298 \
  python3 -B scripts/test-process-supervisor.py
```

Local logs retained outside the repository:

- `/private/tmp/task-orch-295-298-linux-final.log`
- `/private/tmp/task-orch-295-298-shutdown-tests.log`
- `/private/tmp/task-orch-295-298-final-adapters.log`
- `/private/tmp/task-orch-295-298-affected-final.log` (two-worker run)
- `/private/tmp/task-orch-295-298-affected-serial.log` (final retry)

## Rollout limits and remaining recovery work

- The actual production Sprite image was not exercised. Bootstrap now runs a
  real supervisor preflight and fails closed unless Python 3.9+, cgroup v2
  memory/pids, Linux `cgroup.kill`/pidfds, and noninteractive sudo delegation
  work. The helper is included in the worker bundle digest and refresh path.
- This deliberately reduces command parallelism. `worker_shell` defaults to
  120 seconds and accepts explicit timeouts up to 1,800 seconds. Background
  servers do not survive the command that created them. Resource overrides
  are `TASK_ORCH_PROCESS_MEMORY_MAX_BYTES`,
  `TASK_ORCH_PROCESS_SWAP_MAX_BYTES`, and `TASK_ORCH_PROCESS_PIDS_MAX`.
- Resource containment is not a security boundary against a malicious
  workload with sudo access. Uninterruptible kernel tasks can survive pending
  SIGKILL; cleanup reports failure and retains the populated scope instead of
  declaring it safe to replace. No userspace timer can run while the VM or
  event loop itself is stopped; deadline checks catch up on resumption.
- Process probes can wake hibernated Sprites and therefore affect wakeup
  cost. Probe output contains only a categorical verdict; never dump service
  environments or procfs environment contents into diagnostics.
- Deploying this code does not retroactively contain old descendants from
  runs 295/298. Before their separately authorized recovery, preserve
  unpublished checkout changes and canonical branches, inspect the exact old
  worker/descendants, and establish quiescence before replacement. The normal
  dispatcher must own generation advancement and input recovery. Do not repair
  those runs by directly consuming inputs, reusing old channel identities,
  destroying checkout state, or blindly trusting cached service PIDs.

## Exact changed files

Runtime and backend integration:

- `lib/agent-backend/worker-shell.ts` — supervised shell scope and cancellation.
- `lib/agent-backend/codex-backend.ts` — shell routing, nested-agent limits, cleanup.
- `lib/agent-backend/claude-backend.ts` — shell routing, MCP timeout, cleanup.
- `lib/agent-backend/pi-backend.ts` — shell routing and native bash guard.
- `lib/agent-backend/codex-mcp-bridge.ts` — session-scoped request cancellation and disconnect cleanup.
- `lib/agent-backend/types.ts` — optional invocation abort signal.
- `lib/delegation-guidance.ts` — shared command budget and verification ownership.
- `lib/worker-runtime/turn-watchdog.ts` — elapsed wall-clock catchup.
- `lib/worker-runtime/wall-clock-timeout.ts` — shared wall-clock deadline helper.
- `lib/worker-runtime/worker-shutdown.ts` — durable exit evidence and bounded drain.
- `lib/worker-runtime/context.ts` — preserve work on infrastructure abort.
- `lib/worker-channel/worker-server.ts` — disconnect/idle shutdown ownership.
- `lib/worker-channel/worker-session.ts` — recoverable disconnect abort.
- `scripts/run-worker.ts` — process-owned bounded shutdown sequence.
- `scripts/process-supervisor.py` — cgroup resource limits, permits, guardians, reaping.

Provider, recovery, and packaging:

- `lib/runner/sprites-process-probe.ts` — bounded process identity/scope observation.
- `lib/runner/sprites.ts` — supervised service launch and quiescence fencing.
- `lib/runner/sprites-baseline.ts` — helper digest and Python verification.
- `lib/runner/sprites-bootstrap.ts` — real containment preflight.
- `lib/runs.ts` — canonical task branch in both recovery paths.
- `lib/worker-bundle.ts` — package and hash the supervisor helper.
- `scripts/build-worker-standalone.mjs` — copy helper into standalone output.

Regression coverage:

- `scripts/test-process-supervisor.py`
- `__tests__/worker-shell.test.ts`
- `__tests__/worker-shutdown.test.ts`
- `__tests__/sprites-process-probe.test.ts`
- `__tests__/agent-backend/claude-backend-guards.test.ts`
- `__tests__/agent-backend/codex-backend-guards.test.ts`
- `__tests__/agent-backend/codex-cli-integration.test.ts`
- `__tests__/agent-backend/codex-mcp-bridge.test.ts`
- `__tests__/reconcile-orphaned-runs.test.ts`
- `__tests__/sprites-baseline.test.ts`
- `__tests__/sprites-provider.test.ts`
- `__tests__/turn-watchdog.test.ts`
- `__tests__/worker-channel-server.test.ts`
- `__tests__/worker-runtime-context.test.ts`
- `__tests__/worker-standalone-bundle.test.ts`
- `__tests__/worker-websocket-e2e.test.ts`

Documentation:

- `docs/agent-caveats.md`
- `docs/run-295-298-fix-handoff.md`
