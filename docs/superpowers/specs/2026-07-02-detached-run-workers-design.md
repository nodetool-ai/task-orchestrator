# Detached run workers — design

**Date:** 2026-07-02
**Status:** Implemented
**Goal:** A deploy / `systemctl restart` of the web service must never kill an
in-flight agent run.

## Problem

Agent runs execute *inside* the process that hosts them. Runs started via the
web API run in the Next server process: the turn-runner (the Node loop that
drives the backend `query()`, consumes the envelope stream, and writes
`agent_messages` / `agent_events` / terminal status) lives in-process, and the
backend's `claude-code` CLI subprocess is an OS child of that process.

On 2026-07-02 a deploy restarted `next-server` at 19:15:09. `systemctl`
SIGTERM'd the service cgroup, killing six in-flight runs' CLI children (exit
143 = SIGTERM); the dying parent recorded `failed` on the way down. The runs
were healthy — heartbeating normally until the instant they were killed. The
restart, not any run defect, ended them.

Even if the CLI child had survived, the turn-runner that records completion
would still have died with the web process, so no terminal status would be
written. Surviving the restart therefore requires detaching the **turn-runner**,
not just the CLI subprocess.

## What already supports this

The recovery half is already cross-process by design:

- **Incremental persistence.** `runOneTurn`'s `onEvent` (lib/runs.ts:1412-1446)
  writes each assistant/tool envelope to `agent_messages` *as it streams*, and
  status transitions to `agent_events`. The in-memory bus and the DB receive the
  same envelopes at the same granularity — DB-tailing loses no fidelity.
- **DB heartbeat lease.** A live turn bumps `heartbeat_at` every 20s
  (`HEARTBEAT_INTERVAL_MS`); `isLeaseLive` treats an active-status run with a
  fresh heartbeat as owned. This is process-agnostic.
- **`reconcileOrphanedRuns()`** already reaps active-status runs with a stale
  heartbeat and is safe to run concurrently across processes.

The missing pieces are only: (1) run the turn in a process whose lifecycle is
independent of the web server, spawned so a web restart can't signal it; and
(2) stream to clients from the DB instead of the in-memory bus.

## Architecture — C1: per-run detached worker

### Entry point

`scripts/run-worker.ts <runId>` — loads dotenv + DB (mirroring `scripts/pipe.ts`
and `cli.ts` env ordering), then calls the existing worker function for the run
(`runImplement` / `runExecute` / `runReview`, selected by the run's kind), and
exits when the turn completes. No turn logic is rewritten; it is relocated
behind an entry point.

### Dispatch

A single `dispatchRun(runId)` is the only place a worker is spawned. Three
callers use it: run creation, resume-on-append (idle run receives a message),
and boot recovery. The web/pipe processes stop executing turns in-process; they
dispatch and return.

`dispatchRun` is **idempotent** via a claim: in a single transaction it checks
the run is dispatchable (not already claimed and not holding a live lease),
moves it to `preparing`, and writes the worker marker (`worker_scope`, a
web-chosen unit name `run-<id>-<nonce>`; `worker_pid` is filled by the worker
once it starts). If the run is already claimed or leased, `dispatchRun` is a
no-op. This prevents create + a concurrent boot sweep from double-spawning one
run.

### Detach mechanism — M1 (`systemd-run --user --scope`)

Each worker is launched in its own transient systemd scope:

```
systemd-run --user --scope --collect --unit=run-<id>-<nonce> -- \
  <node> <tsx> scripts/run-worker.ts <id>
```

The scope is a separate cgroup, so `systemctl restart` (or `stop`) of the web
`--user` unit cannot signal the worker. `--collect` garbage-collects the scope
unit once the worker exits.

**Prerequisite (prod):** the service account needs a running user systemd
manager with lingering enabled (`loginctl enable-linger <user>`) so
`systemd-run --user` works outside an active login session. Verified as part of
rollout phase 5.

**Dev / non-systemd fallback:** `spawn(cmd, args, { detached: true,
stdio: "ignore" }).unref()`. Nobody runs `systemctl restart` in dev, so escaping
the cgroup is unnecessary there; the fallback only needs to detach from the
parent's controlling terminal.

The spawn strategy is selected at runtime: prefer `systemd-run` when present and
`--user` manager is reachable, else fall back to detached spawn, else (last
resort, logged loudly) in-process execution.

### Worker identity

New nullable columns on `agent_runs` record the worker so the web side can
observe liveness and force-kill a wedged run: `worker_scope` (the transient unit
name) and `worker_pid`. Populated by `dispatchRun` / the worker at start,
cleared on terminal status.

## Streaming — DB tail, two cursors (option a)

`app/api/runs/[id]/events/route.ts` drops `runs.subscribe()` (in-memory bus) and
tails the DB:

```
cursorMsg = clientCursorMsg ?? 0
cursorEvt = clientCursorEvt ?? 0
loop:
  msgs = agent_messages where run_id=? and id > cursorMsg order by id
  evts = agent_events   where run_id=? and id > cursorEvt order by id
  emit interleaved by created_at (id as tiebreak); advance both cursors
  if a terminal-status event was emitted: send final frame, close
  else sleep(pollInterval)   # ~150ms active, back off toward ~1s when idle
```

Properties:

- **Cross-process by construction** — watcher and worker share only the DB file.
- **Unifies replay + live** — collapses today's "replay past events, then
  subscribe" into one loop and removes the bus race documented at
  `app/api/runs/[id]/events/route.ts:14`.
- **Restart-proof for viewers** — a reconnecting browser resends its cursor and
  resumes; a web-server restart mid-stream is invisible.
- **Monotonic PK ⇒ no gaps or dupes**; correctness does not depend on
  wall-clock timestamps (they are used only to interleave the two streams for
  display).

The two id sequences are polled independently (two cursors) and interleaved by
`created_at`. Status events are sparse, so interleaving is trivial. A unified
`run_stream` table (single cursor) was considered and deferred as an optional
future cleanup.

WAL mode plus a `(run_id, id)` index on both tables keeps each poll a cheap
indexed range scan.

## Cross-process control (cancel / abort)

The in-process `AbortController` in the `runners` map cannot reach a detached
worker. Cancel becomes DB-mediated: the web side sets `cancel_requested` on the
run; the worker polls it at heartbeat cadence and drives its local
`AbortController`, ending the turn and writing terminal status normally.
Force-killing the worker's scope (`systemctl --user stop run-<id>-<nonce>` or
SIGTERM to `worker_pid`) remains a fallback for a wedged worker that stops
polling.

## Boot / reconcile

On web boot, **nothing is killed**:

- Run with a **live** heartbeat → owned by a still-running scope; leave it. SSE
  tails it.
- Run with a **stale** heartbeat (worker genuinely died — host reboot, OOM) →
  if resumable (worktree present + `sdkSessionId` set) **re-dispatch** a resume
  worker; otherwise mark `failed`.

This extends today's `reconcileOrphanedRuns()`, which unconditionally marks
non-chat orphans `failed`. Re-dispatch reuses the idempotent claim in
`dispatchRun`, so a boot sweep racing a manual resume cannot double-spawn.

## Error handling

- **Worker crash before terminal status** → stale heartbeat → handled by boot /
  periodic reconcile (re-dispatch or fail).
- **Spawn failure** (`systemd-run` missing / user manager unreachable) →
  fall back per the strategy ladder; if all fail, mark the run `failed` with a
  clear message. Logged.
- **SSE for a run that never produces rows** (spawn died instantly) → the poll
  loop surfaces the run's current status and closes on terminal; a bounded
  idle timeout guards against an indefinitely `preparing` row.
- **No global queue in v1** (YAGNI — runs are human-initiated and low-volume).
  A concurrency cap via a periodic dispatcher promoting `queued` runs is a noted
  follow-up, explicitly out of scope here.

## Testing

- **Unit** — cursor-tail interleave/close logic against an in-memory DB (given
  rows across both tables, assert ordered emission and close on terminal).
- **Unit** — `dispatchRun` idempotency/claim; the reconcile resumable→dispatch
  vs failed decision (spawn mocked).
- **Integration** — run `run-worker.ts` against a real DB row with the existing
  fake backend; assert messages land incrementally and terminal status is set.
- **Acceptance (manual)** — start a run, `systemctl restart` the web unit
  mid-turn, confirm the run continues and the browser SSE reattaches with no
  visible gap. This is the feature's acceptance criterion.

## Rollout — phased, flag-gated `TASK_ORCH_DETACHED_RUNS`

1. **SSE DB-tail.** Works even with in-process execution; low-risk; ship first.
2. **`run-worker.ts` + `dispatchRun`**, behind the flag.
3. **DB-mediated cancel.**
4. **reconcile re-dispatch.**
5. **systemd-run / unit wiring + prod verification** (the restart acceptance
   test; confirm lingering + `--user` manager).

Flag off ⇒ today's in-process behavior, so rollback is instant.

## Schema changes

Nullable additions to `agent_runs`:

- `worker_scope TEXT` — transient systemd scope unit name (M1).
- `worker_pid INTEGER` — worker OS pid, for liveness/kill fallback.
- `cancel_requested INTEGER` — DB-mediated cancel flag (0/1).

Plus `(run_id, id)` indexes on `agent_messages` and `agent_events` if not
already present, and WAL mode confirmed enabled.

## Out of scope

- Concurrency cap / global run queue / dispatcher (follow-up).
- Unified `run_stream` table (optional future cleanup of the two-cursor tail).
- Token-level streaming finer than the current per-envelope granularity.
- Migrating the `pi` backend path (design is backend-agnostic; the active
  backend is `claude`, but nothing here depends on which backend runs).
