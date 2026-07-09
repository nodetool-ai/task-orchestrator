# Design: worker-spawned child runs as isolated Fly Machines

Status: proposed · Owner: infra · 2026-07-04

## Problem

Top-level runs get one Fly Machine + volume each (`FlyRunnerProvider`, one
`runner_instances` row per run). Runs **spawned by a worker** do not. When a
plan-executor run (`goal=<execute>`) calls `start_session` / `start_review`
from inside its worker, the child executes inside the executor's own Machine:

- `buildFlyWorkerEnv` (lib/runner/fly.ts) deliberately does not pass
  `FLY_API_TOKEN` / `TASK_ORCH_FLY_APP` / `TASK_ORCH_RUNNER` into workers.
- Inside the worker, `runs.create`'s launch branches see
  `detachedRunsEnabled() === true` (the worker env sets
  `TASK_ORCH_DETACHED_RUNS=1`) and call `dispatchRun` — but
  `runnerProviderKindFromEnv()` resolves to **`local`** (no
  `TASK_ORCH_RUNNER=fly`), `admissionEnabled()` is **false** (no
  `TASK_ORCH_WORKER_IMAGE` either), and `LocalRunnerProvider.create` falls
  through to `detachedSpawn`: a `tsx scripts/run-worker.ts <childId>`
  subprocess **in the parent's container**.

Consequences (observed in prod, 2026-07-04: run #7 `<execute>` spawned
reviews #8–#11): children get no `runner_instances` row, no per-child
volume/log, no admission accounting against `TASK_ORCH_MAX_MACHINES`, no
independent resource limits — and they share the parent Machine's fate. One
ECONNRESET killed the executor's process and took all four reviews down with
it.

## Goal

A run spawned inside a worker executes as its own Fly Machine — independent
failure, per-child volume/logs, admission-gated, sweep-managed — while the
in-process path stays the default for local dev and non-Fly deployments.
Nested dispatch must respect the global `TASK_ORCH_MAX_MACHINES` cap and must
not enable runaway fan-out. `start_session` / `start_review` /
`await_session` remain the tool interface, unchanged.

---

## Decision 1 — how a child Machine gets created: **Queue-via-DB (option C)**

The worker never talks to the Fly API and never learns how children execute.
It only *creates the child run row* in a dispatchable state; the web server —
which already owns the Fly token, the admission gate, the pending pump, and
the sweep — creates the Machine.

Concretely: in `runs.create`'s three launch branches (implement / review /
execute), when the process is a worker (`TASK_ORCH_INSIDE_WORKER=1`) **and**
the nested-dispatch policy says "isolate" (Decision 5), do not call
`dispatchRun`. Instead park the freshly inserted run at `status='pending'`
(after persisting any custom `initialPrompt` as its first user message,
exactly as the dispatch branch already does) and return. The server-side
pending pump (`lib/run-dispatch.ts pumpTick`) picks it up oldest-first,
`dispatchRun` runs the admission gate, `FlyRunnerProvider.create` provisions
volume + Machine, and the sweep manages its whole lifecycle — the identical
path every top-level run takes today. `await_session` keeps working
unmodified: it polls `agent_sessions.status` in the DB, which is
execution-location-agnostic.

### Why C over A (token in worker) and B (broker endpoint)

**A. Direct — inject a Machines token into each worker.** Rejected on trust
grounds. Workers run untrusted agent code. Fly Machines tokens cannot be
scoped to "create only machines belonging to run N"; the narrowest practical
scope is app-wide. A compromised worker could create/destroy arbitrary
Machines in the runner app, mount other runs' volumes, or launch Machines
with attacker-chosen env/image. It also forks the dispatch logic: admission
(`flyAdmit`), the claim protocol, and `runner_instances` bookkeeping would
have to run (and stay correct) inside every worker, or be skipped — skipping
is exactly today's bug. Latency is the only win (~0s vs. one pump interval),
and child runs live for minutes, so it buys nothing that matters.

**B. Broker — worker calls an authenticated server endpoint.** Strictly
better than A on secrets (token stays on the server) and gives synchronous
dispatch, but it adds a new authenticated control-plane surface: per-run
bearer tokens minted into worker env, an HTTP route that must enforce
parent↔child ownership, worker→server network reachability (Fly private
networking / flycast), and a new failure mode (server briefly down → child
creation fails inside an agent turn). Everything the endpoint would do —
admission, claim, create, record — already exists behind `dispatchRun`; the
broker is a synchronous doorbell in front of it. Not worth a new auth
surface for a latency improvement the workload can't feel. It remains the
natural evolution if sub-second nested dispatch is ever needed: option C's
worker-side change ("park as pending") is a subset of B's, so C → B is
additive, not a rewrite.

**C. Queue-via-DB.** The clincher is the trust model: **orchestrator state is
already the worker's interface**. A worker already creates child run rows
through the same `runs.create` path it uses for its own state — option C adds
*zero* new credential or network surface, and removes an execution capability
from the worker rather than adding one. It reuses the admission gate, the pump, boot
reconcile, and the sweep verbatim, so there is one dispatch code path for
every run in the system regardless of who asked for it. Costs, honestly
stated:

> **Update (2026-07):** this option was chosen when workers held
> `DATABASE_URL` and wrote child rows to Postgres directly. The worker-HTTP-API
> migration since withheld `DATABASE_URL` from workers — `runs.create` inside a
> worker now goes over `/api/worker/*` with a run-scoped HMAC token (see
> [worker-http-api.md](./worker-http-api.md)), landing on the *same* server-side
> dispatch path. The decision stands: the child row still flows through one
> orchestrator entry point, only the transport under it changed.

- *Latency*: up to one pump interval (`TASK_ORCH_PENDING_PUMP_MS`, default
  15s) before the child's Machine is even requested, plus Machine boot. For
  runs whose useful work is minutes of agent time, this is noise; the Fly
  deployment can set the pump to 5s if it ever isn't (each tick is one
  `listMachines` call + one indexed DB query).
- *Pump fairness for nested demand*: the pump must not starve children —
  addressed in Decision 2 below (it needs a fix regardless of A/B/C).
- *Control-plane dependency*: if the web server is down, pending children
  wait. That is already true for every top-level run, the pump is restarted
  by `instrumentation.ts` on boot, and a parked `pending` row is durable —
  strictly better than option A's "worker's Fly call failed mid-turn".

### Data flow / sequence

```
executor worker (Machine M-parent)                    web server                      Fly API
──────────────────────────────────                    ──────────                      ───────
start_review tool
  └ runs.create(goal=<review>, parentRunId=P)
      INSERT agent_sessions (child C, parent P)
      persist initialPrompt as first user message
      INSIDE_WORKER + policy=isolate
      └ UPDATE C SET status='pending'   ──────────►   (row is durable; nothing else)
await_session(C)                                      pump tick (≤15s later)
  └ poll C.status every 1.5s                            ├ sweep / reap stale leases
                                                        ├ listPendingRunIds → [C,…]
                                                        │   (children of live parents first)
                                                        └ dispatchRun(C)
                                                            ├ admission: flyAdmit()
                                                            │   over cap? parent P live → admit
                                                            │   (deadlock breaker, exists today)
                                                            ├ atomic claim (workerScope)
                                                            └ FlyRunnerProvider.create ────►  create volume vol_run_C
                                                                                              create machine (own env,
                                                                                               own guest limits, own volume)
child worker (Machine M-child)
  runs C's turn; heartbeats; logs to
  /mnt/session/logs/runner.log (own volume)
  lands terminal status on C  ────────────────────►   sweep sees idle → suspend→stop→destroy
await_session(C) sees terminal status
  └ returns verdict/pr_url/cost to executor
```

Parent and child are now two Machines with two volumes, two
`runner_instances` rows, independently swept, independently killable.

---

## Decision 2 — runaway and cost control

**Global cap is enforced by construction.** With option C, *every* Machine
creation funnels through server-side `dispatchRun` → `flyAdmit`, which
counts **all** active `runner_instances` rows (`creating|starting|running`)
— there is no per-dispatcher view to diverge. Today's in-worker
`detachedSpawn` children bypass admission entirely; C closes that hole.

**At the cap: defer, not reject** — `dispatchRun` already parks over-cap runs
at `pending` and the pump retries oldest-first. Rejection would surface
spurious tool errors to agents for a transient condition.

**Deadlock avoidance.** A parent blocked in `await_session` holds a Machine
(an admission slot) for its whole turn; if every slot is held by executors,
their children would defer forever. `dispatchRun` already contains the
breaker (see the "Deadlock breaker (M1)" block): a deferred run whose
`parentRunId` points at a run with a **live worker claim** is admitted over
the cap — the parent's slot is blocked on this very child. The bounded
overshoot this permits is capped by the tree limits below.

**Starvation fix (required).** The pump loop stops at the first `deferred`
result. A deferred *root* run at the head of the queue would therefore block
the pump from ever reaching a *child* behind it — even though the child
qualifies for the breaker — livelocking the tree until `TASK_ORCH_MAX_DEFER_MS`
(default 30 min) fails things. Fix: `listPendingRunIds` orders **children of
live-claim parents first**, then the rest oldest-first. Breaker-eligible
children never return `deferred` (they admit or fail-spawn), so
break-on-first-defer semantics are preserved for the root-run tail. This is
a one-query change plus tests.

**Tree limits (new, enforced at creation).** Two env knobs, checked in
`runs.create` when `parentRunId` is set, walking the parent chain (recursive
CTE on `agent_sessions.parent_run_id`):

- `TASK_ORCH_MAX_RUN_DEPTH` (default **3**): root executor → implement/review
  children → one more level of headroom. Exceeding depth **rejects** the
  create (tool error back to the model) — depth overflow is a logic bug or
  an attack, never a transient condition.
- `TASK_ORCH_MAX_TREE_RUNS` (default **32**): total runs (any status) sharing
  the same root. Exceeding **rejects** with an error naming the limit, so an
  executor that loops (retry → re-review → retry…) hits a wall with a clear
  message instead of a bill.

These checks run inside the worker (friendly, synchronous errors), and are
**re-verified server-side in `dispatchRun`** before spawn as defense in
depth: a worker that writes rows directly (bypassing `runs.create`) still
cannot get a Machine past the server-side check. A parent awaiting a child
that got *rejected* cannot deadlock: the tool call fails synchronously, so no
child row exists to await. A parent awaiting a *deferred* child is covered by
the breaker; a deferred child whose parent has died is de-prioritized but
still served oldest-first, and bounded by `TASK_ORCH_MAX_DEFER_MS` (whose
error message should be generalized — on Fly it's a machine-cap wait, not
"insufficient host memory").

## Decision 3 — idle parent while awaiting children

**Phase 1: stay warm.** An awaiting executor is a `shared-cpu` Machine doing
a 1.5s DB poll — single-digit cents per hour, small against the model spend
of the children it is waiting on. It cannot be suspended by the sweep today
anyway: `await_session` runs inside the parent's turn, so the run sits at a
lease status (`running`) with a live heartbeat, which
`isEligibleForLifecycleAction` correctly treats as untouchable.

**Phase 3 (opt-in, after transient-retry lands): suspend-while-awaiting.**
Sketch, so the door stays open: `await_session` (worker side) flips the run
to a new non-lease status `waiting` while blocked; the sweep's
`nextLifecycleAction` then suspends the Machine (Fly suspend snapshots RAM,
so the blocked poll loop survives); when a child lands a terminal status,
the server resumes the parent via `FlyRunnerProvider.resume(parentRunId)`;
the woken poll sees the terminal child and flips back to `running`. Two
prerequisites make this explicitly *not* Phase 1: (a) `waiting` must be
excluded from every lease-status set (`LEASE_STATUSES`, orphan reconcile) or
the suspended parent gets reaped as stale; (b) resume severs the worker's
TCP connections — its next Postgres call gets **ECONNRESET, the exact crash
class that motivated this design** — so it hard-depends on the separate
transient-network-retry work. Until then, warm parents are the cheap, boring
choice.

## Decision 4 — failure containment and resume

- **Child crashes** (OOM, host loss, agent fatal): its Machine dies alone.
  The Fly sweep already detects the corpse (`machineById` miss →
  `handleWorkerDeath`) and applies the existing death policy — fail or
  re-dispatch if resumable. The parent's Machine is untouched; its
  `await_session` poll simply observes `status='failed'` and returns it. The
  executor persona already retries a failed implement child once via
  `append_message` and blocks the task after that — that loop is the
  parent-side reaction and needs no change.
- **Parent crashes**: children keep running — they are their own Machines
  with their own claims; nothing ties their lifetime to the parent's process
  anymore (that is the point). The parent run itself goes through the same
  death policy: sweep detects the dead Machine, `handleWorkerDeath` →
  resumable → re-dispatch. The re-dispatched executor re-enters `runExecute`,
  which re-derives plan state from the DB (task states, existing sessions,
  PR urls); `start_review`'s active-review guard prevents it stacking a
  duplicate reviewer on a child that survived it, and `await_session` on a
  still-running child id attaches cleanly since it is only a DB poll.
- **Transient network blips** (the original ECONNRESET): now confined to one
  run's Machine instead of five runs' shared process. Making the *worker
  itself* survive the blip is the separate transient-network-retry work;
  this design bounds the blast radius while that lands.
- **Cancellation**: `cancel_session` → `stopRunner` → `FlyRunnerProvider.stop`
  destroys exactly the child's Machine+volume. Cancelling a parent does not
  auto-cancel children (unchanged semantics); the UI tree (Decision 6) makes
  orphaned-but-running children visible, and bulk tree-cancel can be a
  follow-up.

## Decision 5 — backward compatibility: a policy switch, not a hardcode

One new env knob, read where the launch branches decide:

```
TASK_ORCH_NESTED_DISPATCH = isolate | inline
```

- The **server** resolves the default: `isolate` when
  `runnerProviderKindFromEnv() === "fly"`, else `inline`.
- The resolved value is passed to workers via `buildFlyWorkerEnv` (a policy
  string — still no credentials in worker env). Docker/local workers don't
  get it and default to `inline`, preserving today's behavior off-Fly
  (in-container `detachedSpawn` children for docker workers, in-process for
  dev).
- Inside `runs.create`'s launch branches the decision becomes: worker +
  `isolate` → park `pending`; worker + `inline` → current behavior; server →
  current behavior (`dispatchRun` / in-process per `detachedRunsEnabled()`).

Rollback is `TASK_ORCH_NESTED_DISPATCH=inline` on the web app + restart — no
schema or code revert. (Runs already parked `pending` at flip time are still
dispatched by the pump; that path predates this design.)

## Decision 6 — observability

Free by construction: a child dispatched through `FlyRunnerProvider.create`
gets its own `runner_instances` row (machine id, volume id, region, state),
its own volume with `logs/runner.log` (the entry script tees the worker
there), and the existing `runner_*` agent events
(created/suspended/resumed/destroyed) on its own run. Two small additions:

- Emit a `runner_deferred` event when a worker parks a child `pending`
  (payload: parent run id, reason `nested_isolate`), so the gap between
  "tool returned session id" and "machine created" is visible in the run's
  event tail.
- UI: the runs list already has `parentRunId`; group children under their
  parent (indent or tree affordance) and show each child's runner state chip
  from `runner_instances`. No schema change needed.

## Follow-up turns (2026-07-06)

Child *creation* deferral (Decision 1) alone was not enough: a parent
executor's `spawn__append_message` to a finished child used to fall into the
in-process append path inside Fly workers, because `remoteRunnerEnabled()`
could not see the worker context (workers get neither `TASK_ORCH_RUNNER` nor
`TASK_ORCH_WORKER_IMAGE`). The child's follow-up turn then ran inside the
parent's Machine — one child's typecheck OOM wedged the parent and every
in-flight sibling (incident 2026-07-05, runs #40/#41 and #43/#50/#57/#58).

Now: `remoteRunnerEnabled()` is true inside isolate-mode workers, and
`sendMessageToRun` in a worker parks the target run at `pending`
(`deferRunForServerDispatch`) — the same "pending row is the dispatch
request" contract as creation. The server's pump claims it and resumes the
child's own Machine (suspended Machines resume; destroyed ones re-clone from
the pushed branch and fall back to a fresh SDK session).

---

## Phased rollout

**Phase 0 — prep (no behavior change).** Pump ordering fix
(children-of-live-parents first), tree-limit checks in `runs.create` +
server-side re-verify in `dispatchRun`, generalize the `MAX_DEFER_MS` error
message, `runner_deferred` event. All inert while nested dispatch stays
inline.

**Phase 1 — isolate behind the flag.** Implement the `pending`-park branch
in `runs.create`; pass `TASK_ORCH_NESTED_DISPATCH` through
`buildFlyWorkerEnv`; set `isolate` **explicitly** on the prod Fly app (not
yet the provider default). Validate on the SEO plan: re-run the
executor-with-reviews shape that produced runs #7–#11 and confirm every
child has its own `runner_instances` row and Machine.

**Phase 2 — default on for Fly.** Make `isolate` the resolved default when
the provider is `fly`. `inline` remains the default everywhere else.

**Phase 3 (optional) — suspend-while-awaiting** per Decision 3, gated on the
transient-network-retry work.

**Risks & rollback.**
- *Pump starvation regression* (mis-ordered queue): caught by unit tests in
  Phase 0; symptom is children stuck `pending` — rollback is the flag.
- *Cap overshoot via the deadlock breaker*: bounded by
  `TASK_ORCH_MAX_TREE_RUNS`/depth; monitor `runner_instances` active count
  vs. `TASK_ORCH_MAX_MACHINES` during Phase 1.
- *Cost increase* (N machines instead of 1): bounded by the same caps; this
  is the product intent, not a leak — but watch the Fly bill during the SEO
  validation.
- *Rollback*: set `TASK_ORCH_NESTED_DISPATCH=inline` (web app) and restart.
  Already-parked children drain through the pump; already-running child
  Machines finish and are swept normally.

## Acceptance criteria

1. On a Fly deployment with the flag on, a run spawned via `start_session` /
   `start_review` from inside a worker has, before its first agent turn: its
   own `runner_instances` row (provider `fly`, distinct machine id, distinct
   volume id) and `worker_scope` equal to its own Machine, not its parent's.
2. Force-destroying a child's Machine mid-turn fails/re-dispatches only that
   child; the parent's `await_session` returns the child's terminal status
   and the parent's Machine and status are unaffected.
3. Force-destroying the parent's Machine mid-await leaves all child Machines
   running; boot/pump reconcile re-dispatches the parent, which resumes the
   plan without duplicating reviewers.
4. With `TASK_ORCH_MAX_MACHINES=N` and N executors each spawning children,
   active machines never exceed N + (breaker overshoot bounded by tree
   limits), no child waits past one pump interval while its parent holds a
   live claim, and no run tree deadlocks.
5. `TASK_ORCH_MAX_RUN_DEPTH` / `TASK_ORCH_MAX_TREE_RUNS` violations return a
   synchronous tool error naming the limit; no run row is left `pending`.
6. With the flag `inline` (or off-Fly), behavior is byte-identical to today
   (existing test suite green, no `pending` parking from workers).

## Test plan

**Unit (vitest, existing seams).**
- `runs.create` launch branches: worker+isolate parks `pending` and persists
  `initialPrompt` first; worker+inline and server paths unchanged
  (spy on `dispatchRun` as the reconcile tests already do).
- Admission: `flyAdmit` at/over cap with and without a live-claim parent
  (breaker admits child, defers root); `never-fits` unaffected.
- Pump ordering: pending set {old root (deferred), young child of live
  parent} → child dispatched first; break-on-defer still stops the root tail.
- Tree limits: depth/size walk over a synthetic parent chain; rejection at
  create and re-verification in `dispatchRun` (row inserted directly).

**Integration (fake FlyClient, real DB).**
- Executor-shaped flow: parent run holds a claim; a child created with
  `TASK_ORCH_INSIDE_WORKER=1` + `isolate` ends `pending`; a pump tick creates
  a distinct fake machine+volume and a `runner_instances` row for the child;
  `await_session`(child) unblocks when the child's row lands terminal.
- Child survives parent: mark the parent's machine gone in the fake client,
  run `sweep` — parent gets `handleWorkerDeath`, child's instance row and
  status untouched.

**Chaos (staging Fly app, scripted).**
- Re-create the #7–#11 shape (1 executor, 4 reviews). While all five are
  running: `fly machine destroy --force` one child → only that run fails and
  is retried by the executor; then destroy the parent → children finish,
  reviews record verdicts, reconcile resumes the executor. Assert from
  `runner_instances` + `agent_events` that no *other* run changed state
  within the blast window.

## Out of scope

GPU/local-model routing (nodetool); any change to the agent SDK or the
`start_session` / `start_review` / `await_session` tool surface; making the
worker itself survive transient network failure (separate work, referenced
in Decisions 3–4).
