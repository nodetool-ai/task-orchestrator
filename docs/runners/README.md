# Workers and runners

This is the starting point for understanding **how Task Orchestrator actually
executes an agent run** — where the code checks out, where the model runs, and
how the system keeps track of it. No prior context is assumed.

If you only read one page about execution, read this one. The per-integration
pages go deeper:

- [Local / Docker](docker-local.md) — runs on your machine or one host
- [Fly.io](fly.md) — one micro-VM per run, in the cloud

---

## 1. The big picture: control plane and workers

Task Orchestrator is split into two kinds of process.

**The control plane** is the single web-server process (the Next.js app). It is
the brain and the source of truth. It owns:

- the Postgres database — every plan, task, run, message, and event;
- scheduling and admission — deciding *when* a run may start;
- the tool registry and all tool execution;
- the durable decision of when a run is *done*.

**A worker** is a small, disposable process that drives **exactly one run** to
completion and then exits. It owns almost nothing:

- a checkout of the target git repository;
- the model/agent subprocess (the Claude Agent SDK or the pi backend);
- the SDK's local session/resume files.

A worker has **no database access**, holds no cloud API tokens, and never calls
back into the control plane's HTTP API. Everything it needs to start is handed
to it once, and everything it wants to read or write during the run goes back
through a single connection to the control plane (see §4).

```
        user / scheduler / webhook
                   │
                   ▼
   ┌──────────────────────────────────────┐
   │            CONTROL PLANE              │   one always-on web process
   │  Postgres · scheduling · tools · UI   │
   │  decides run state, owns everything   │
   └───────────────┬──────────────────────┘
                   │  dials in, pushes the run,
                   │  serves tool calls  (one WebSocket per run)
                   ▼
   ┌──────────────────────────────────────┐
   │               WORKER                  │   one per run, disposable
   │  git checkout · model process         │
   │  no DB, no cloud tokens               │
   └──────────────────────────────────────┘
```

Why the split? Workers run **untrusted agent code** — a model deciding which
shell commands to run. Keeping database credentials and cloud API tokens *out*
of the worker means a misbehaving or compromised run can't read other runs'
data, delete infrastructure, or reach Postgres directly. The blast radius of
any single run is one checkout and one process.

---

## 2. The runner abstraction

Where a worker physically runs is pluggable. The control plane talks to one
**runner provider**, chosen at startup by the `TASK_ORCH_RUNNER` environment
variable:

| `TASK_ORCH_RUNNER` | Provider | A worker is… |
| --- | --- | --- |
| unset / `local` / anything else | **local** | a process or Docker container on the same host |
| `fly` | **Fly** | an ephemeral Fly Machine (micro-VM) + volume |

The value is matched by exact equality, so anything that isn't `fly`
(including the empty string) resolves to `local` — local is the default and the
catch-all (`lib/config.ts`, `runnerProviderKind()`).

Every provider implements the same small interface
(`lib/runner/provider.ts`, `RunnerProvider`):

| Method | Purpose |
| --- | --- |
| `admit(input)` | *May we start a run right now?* A capacity decision made **before** anything is provisioned. Returns `admit`, `defer`, `never-fits`, or `reject`. |
| `create(input)` | Provision and start the worker for an already-claimed run. Returns a handle (container name / Machine id) or `null` on failure. |
| `stop(handle)` | Best-effort hard stop — the fallback when a run is cancelled. |
| `sweep()` | Reconcile the database's picture of runs against the *real* state of the runners (catch deaths the live watcher missed). |
| `startMonitor()` | Start the process-wide watcher that reacts to runner lifecycle events. |

Because the interface is uniform, the scheduling machinery in
`lib/run-dispatch.ts` — admission, claiming, the retry pump, death recovery —
is written once and works for all three providers. The differences live behind
`create`/`stop`/`sweep`/`admit`.

Each running worker gets one row in the **`runner_instances`** table (keyed by
`run_id` — one row per run). That row records the provider, the provider-scoped
handle (container name, Machine id), the runner state, the channel
endpoint the control plane dials, and provider-specific bookkeeping. It's how a
*restarted* control plane rediscovers and reconnects to workers that are still
alive.

---

## 3. The run lifecycle

A run is a row in the `agent_runs` table. Its `status` column walks a small
state machine. The vocabulary and legal transitions live in `lib/run-state.ts`.

```
  created
     │
     ▼
  pending ──────────────┐   admission said "not yet" (capacity/ template build);
     │                  │   waits here; the pending pump retries it
     │  admitted +      │
     │  atomically      ◄──┘
     │  claimed
     ▼
  preparing            worker is being provisioned and is booting
     │
     ▼
  running              the agent's turn is executing
     │
     ├──► completed / failed / cancelled / budget_exhausted   (terminal)
     ├──► idle                                                 (chat, resumable)
     └──► parked                                               (waiting on an event; resumable)
```

Key transitions and who makes them:

- **created → `pending`** — the default for a new run row.
- **`pending` → `preparing`** — the atomic *claim* (see §5). This is the moment
  a run is assigned to a worker slot.
- **`preparing` → `running`** — the worker has booted and signalled it's ready;
  the control plane writes the transition.
- **`running` → terminal / `idle` / `parked`** — decided by the control plane
  when a turn ends. `completed`/`failed`/`cancelled`/`budget_exhausted` are
  terminal. `idle` (a chat waiting for the next message) and `parked` (a run
  sleeping until some event arrives) are **resumable** — the same run can walk
  back to `preparing` for a follow-up turn.

Note that a worker **never sets run status itself**. It reports facts ("the
turn finished", "here is the result"); the control plane validates them and
writes the durable transition. This is what keeps the database authoritative
even though the actual work happens in a process it doesn't fully control.

---

## 4. The worker channel

Once a worker is provisioned, the control plane needs to talk to it. This is
the **worker channel**: one authenticated WebSocket connection per run.

The surprising-but-deliberate part: **the worker is the server and the control
plane is the client.** The worker binds a private WebSocket listener; the
control plane dials *into* it. Workers never open an outbound connection to the
control plane.

```
   control plane  ──────dials──────►  worker's private WS listener
   (WS client)                        (WS server, e.g. :8787)

   ── commands (run.start, user input, tool results) ──►
   ◄── events (messages, phase changes, tool invocations) ──
```

- The control plane pushes an authoritative **`run.start` snapshot** exactly
  once — everything the worker needs (the goal, the repo, model settings)
  travels in that message. The worker starts inert and does nothing until it
  arrives.
- During the run, whenever the agent needs to read or write domain state (load
  a task, append a message, open a PR record), it calls back over the *same*
  channel via `tool.invoke`; the control plane executes the tool against
  Postgres and returns the result. The worker itself never touches the database.
- The connection is authenticated with a per-run bearer credential derived by
  HMAC from a control-plane secret and the run's channel identity. A restarted
  control plane can reproduce it without storing plaintext.

**Where the worker listens** depends on the provider — this is the main thing
that differs between them:

| Provider | Worker listener | How the control plane dials it |
| --- | --- | --- |
| local (host process) | a Unix domain socket | `ws+unix://` to that socket path |
| local (Docker) | TCP `:8787` in the container | by container name (compose network) or private bridge IP |
| Fly | TCP `:8787` on the Machine | the Machine's private 6PN IPv6 address |

The resolved endpoint is stored on `runner_instances.channel_endpoint` so the
control plane can reconnect after a restart. Full protocol design:
[worker-websocket-protocol.md](../worker-websocket-protocol.md).

---

## 5. Dispatch, admission, and recovery

The single entry point for starting (or resuming) a run is `dispatchRun()` in
`lib/run-dispatch.ts`. It does three things in order.

**1. Placement.** Some runs (lightweight pi chats and plan executors) are marked
`runtime = "server"` and don't need a full worker at all — they run inside the
web-server process or in a small memory-capped local child. Everything else
takes the worker path below. (Details on the [Local / Docker](docker-local.md)
page.)

**2. Admission + atomic claim, under a lock.** Deciding whether a run fits and
then claiming it must be atomic, or two concurrent dispatches could both look at
the same free capacity and both say yes. `dispatchRun` serializes this in a
single in-process promise chain (`withAdmissionLock`). Inside it:

- The provider's admission gate runs. Each provider measures capacity
  differently — this is the other big provider difference:
  - **local** measures free host RAM (does one more worker fit in memory?);
  - **Fly** counts active Machines against `TASK_ORCH_MAX_MACHINES`.
- If the answer is `defer`, the run is parked back in `pending` with a
  human-readable `pending_reason` (e.g. *"Waiting for runner capacity."*),
  and the pump will retry it later.
- If the answer is `admit`, the run is **atomically claimed**: a guarded
  database UPDATE flips it to `preparing` and stamps a unique ownership token
  (`worker_scope`). Only one dispatch can win this UPDATE; the loser sees
  `already-claimed` and backs off.

The slow part — actually provisioning the worker via `provider.create()` — runs
*outside* the lock, so one slow boot doesn't block every other dispatch.

**3. The pending pump.** A background loop (`startPendingRunPump`, interval
`TASK_ORCH_PENDING_PUMP_MS`, default 15s) drives everything that can't happen at
the instant of dispatch: it retries `pending` runs oldest-first (stopping as
soon as one still doesn't fit), reconciles orphaned runs, fires due timers, and
wakes parked runs that have events waiting. A run stuck in `pending` past
`TASK_ORCH_MAX_DEFER_MS` (default 30 min) is failed rather than parked forever.

**Recovery when a worker dies.** Workers refresh a heartbeat on their run row
while a turn is active. Two mechanisms catch a dead worker:

- The provider's **monitor** reacts to lifecycle events immediately (Docker
  `die`/`oom` events, a missing Fly Machine) — deaths are caught in seconds.
- The **reaper** (`reconcileOrphanedRuns`, run every pump tick) is the backstop:
  any run still in a live status but whose heartbeat has gone stale
  (`HEARTBEAT_STALE_MS`, 5 min) is examined and, depending on whether it's
  resumable, either **redispatched**, set back to **idle**, or **failed**.

Every recovery write is a compare-and-set against the run still being an orphan
with the same ownership token, so a run that got re-claimed in the meantime is
never clobbered.

---

## 6. Choosing an integration

| | Local (host / Docker) | Fly |
| --- | --- | --- |
| **A worker is** | a process or container on one host | an ephemeral micro-VM + volume |
| **Isolation** | shared host / container cgroup | full VM per run |
| **Capacity gate** | free host RAM | Machine count |
| **State between turns** | host filesystem / repo cache | Fly volume (survives suspend) |
| **Setup** | Docker (or nothing) | Fly app + token + images |
| **Best for** | local dev, single-box deploys | horizontal cloud scale |

Rough guidance:

- **Local** — developing on your laptop, or a single-server deployment. The
  in-process "lightweight" tier also handles cheap chat turns with no container
  at all.
- **Fly** — you want each run in its own VM and to scale horizontally across a
  cloud without managing a host. See [fly-deployment.md](../fly-deployment.md)
  for the full operator guide.

## 7. Environments

Whatever the integration, a run launches from an **execution artifact** — a
Docker worker image or a Fly runner image — built for a specific worker build
SHA. These are first-class **environments**: the `/environments` page lists
them grouped by provider and versioned by SHA, and docker builds can be
triggered in-app (fly images are built out-of-app; the page shows the push
command). The shared `environments` registry table backs both.

---

## Related documents

- [Local / Docker integration](docker-local.md)
- [Fly.io integration](fly.md)
- [Worker WebSocket protocol](../worker-websocket-protocol.md) — the normative channel design
- [Fly deployment guide](../fly-deployment.md) · [Local Docker stack](../test-deployment.md)
- [Agent event system](../agent-events.md) — how parked runs are woken by events
- [Nested machine dispatch](../nested-machine-dispatch.md) — worker-spawned child runs
