# Worker HTTP + SSE protocol

How run workers talk to the orchestrator. Replaces "every worker holds
`DATABASE_URL` and writes Postgres directly" with a typed protocol that can run
over two transports; introduced 2026-07.

## Why

The worker ⇄ orchestrator conversation used to be implicit: scattered drizzle
calls inside `lib/runs.ts`, two LISTEN/NOTIFY channels, and a cancel flag
polled by heartbeat code. That worked, but:

1. **Cleanliness** — there was no single place to see what a worker is allowed
   to do to orchestrator state. Now there is: the `RunTransport` interface in
   `lib/worker/protocol.ts` *is* the protocol.
2. **Debuggability** — you can watch the entire conversation. Every worker API
   request logs one structured line server-side (`worker-api` component), and
   the HTTP client logs every call, retry, and reconnect worker-side. Set
   `TASK_ORCH_LOG_LEVEL=debug` on either end.
3. **Logging** — `lib/worker/log.ts` is a small leveled logger (text or JSON
   lines via `TASK_ORCH_LOG_FORMAT=json`) used across the worker entrypoint,
   both transports, and the API routes.
4. **External workers** — a worker with `TASK_ORCH_WORKER_API_URL` +
   `TASK_ORCH_WORKER_TOKEN` needs **no database access at all**. It can run on
   any machine that can reach the orchestrator over HTTPS: no Postgres
   exposure, no pooler limits, no LISTEN/NOTIFY requirements on the worker
   side.

## Architecture

```
             lib/runs.ts (turn driving, unchanged flow)
                          │
                 runTransport()  ←  lib/worker/index.ts (env-based selection)
                    ┌─────┴──────┐
             db-transport   http-transport
              (drizzle)      (fetch + SSE)
                    │              │
                Postgres      /api/worker/* ──► handleWorkerApi ──► db-transport
                                                (Next catch-all)      (server)
```

- `lib/worker/protocol.ts` — the `RunTransport` interface + wire types.
- `lib/worker/db-transport.ts` — direct Postgres. The default everywhere, and
  the **single implementation** backing the HTTP routes, so the two modes
  cannot drift.
- `lib/worker/http-transport.ts` — typed client for `/api/worker/*` with
  retry/backoff and an auto-reconnecting `/control` SSE consumer.
- `lib/worker/api-handlers.ts` + `app/api/worker/[...path]/route.ts` — the
  server surface (one catch-all route; handlers are unit-testable with plain
  `Request` objects).
- `lib/worker/token.ts` — run-scoped stateless bearer tokens, and
  `workerDispatchEnv()` used by the spawn paths.

### Transport selection

`runTransport()` picks once per process:

| Process | Selection |
| --- | --- |
| Web server / CLI / tests | `db` (always — it *is* the orchestrator) |
| Worker (`TASK_ORCH_INSIDE_WORKER=1`) without API env | `db` (legacy direct-Postgres worker, unchanged) |
| Worker with `TASK_ORCH_WORKER_API_URL` + `TASK_ORCH_WORKER_TOKEN` | `http` |

### Authentication

`Authorization: Bearer wt1.<runId>.<expEpochSec>.<hmac-sha256>` — minted per
run at dispatch (`workerDispatchEnv`), signed with
`TASK_ORCH_WORKER_API_SECRET` (falls back to `AUTH_SECRET`), default TTL 7
days. A token authorizes exactly one run: run-plane endpoints require the path
run to be the token run; task/plan writes additionally require the target to
be the run's own task/plan. `middleware.ts` bypasses the session gate for
`/api/worker/*`; the routes do their own auth.

### Endpoints

All JSON unless noted; dates travel as ISO-8601 and are revived client-side.

| Endpoint | Transport method | Notes |
| --- | --- | --- |
| `GET  runs/:id` | `getRun` | run row |
| `PATCH runs/:id` `{patch}` | `patchRun` | whitelisted columns only |
| `GET  runs/:id/messages` | `listMessages` | |
| `POST runs/:id/messages` `{role, content}` | `appendMessage` | fires `run_stream`/`run_input` triggers as before |
| `POST runs/:id/events` `{type, payload}` | `appendEvent` | `turn_done` markers etc. |
| `GET  runs/:id/events?type=` | `countEvents` | chat resume bookkeeping |
| `POST runs/:id/status` `{mode, status, set?, guard?, extra?}` | `applyStatus` / `setStatus` | named CAS guards (`not-terminal`, `not-cancelled-closed`); atomic status+event; child lifecycle events fire server-side |
| `POST runs/:id/heartbeat` | `heartbeat` | bumps the lease **and** returns `{cancelRequested}` — one beat, one answer |
| `POST runs/:id/cancel-ack` | `ackCancel` | acknowledges the `run.cancel_requested` control event after aborting |
| `POST runs/:id/release` `{lastProcessedUserMsgId, idleIfNonTerminal?}` | `releaseClaim` | claim release + optional idle landing + stranded-message re-dispatch, all server-side |
| `POST runs/:id/inbox/claim` | `claimInboxDigest` | claims pending inbox events, returns the rendered digest block |
| `POST runs/:id/log` `{tail}` | `writeWorkerLog` | worker log forensics into `agent_runs.worker_log` |
| `GET  runs/:id/repo` | `resolveRepo` | run repo → task repo → default chain |
| `GET  runs/:id/control` | `subscribeInput` | **SSE**: `{type:"input"}` on new user messages, `{type:"cancel"}` pushed on cross-process cancel; comment pings every 15s |
| `POST runs/:id/tools/call` `{tool, params, ctx}` | `callTool` | executes any of the 37 orchestrator tools server-side; `runId` comes from the token, never the body |
| `GET  tasks/:id` / `POST tasks/:id/transition` / `POST tasks/:id/notes` | `getTask` / `transitionTask` / `addTaskNote` | writes restricted to the run's own task |
| `GET  plans/:id` / `GET plans/:id/tasks` / `POST plans/:id/state` | `getPlan` / `listTasks` / `updatePlanState` | state write restricted to the run's own plan |
| `GET  personas/:id` | `getPersona` | |

### The /control SSE channel

Replaces both worker-side Postgres subscriptions:

- **input** — the server keeps the existing `run_input` LISTEN and forwards a
  `{type:"input"}` frame; the chat loop's `subscribeInput` is transport-backed.
- **cancel** — `cancel()` writes the `cancel_requested` flag and (as before)
  inserts a status event, whose `run_stream` NOTIFY wakes the control stream
  to re-check the flag; a 3s safety poll covers lost notifies. The client arms
  a latch so the *next* heartbeat answer aborts the turn even if the server
  read raced.

Cancel latency is therefore bounded by the heartbeat cadence (20s), same as
the previous flag-polling design, with the SSE push removing the extra DB
read per beat.

## Running external workers

1. Set `TASK_ORCH_WORKER_API_URL` on the **server** to its own base URL as
   reachable from workers (compose service name, flycast address, or public
   https origin), and optionally `TASK_ORCH_WORKER_API_SECRET` (defaults to
   `AUTH_SECRET`).
2. That's it for managed spawns: every spawn path (docker container, Fly
   Machine, dev detached process) injects the URL + a freshly minted run
   token and **withholds `DATABASE_URL`**.
3. A hand-rolled external worker is: env `TASK_ORCH_INSIDE_WORKER=1`,
   `TASK_ORCH_WORKER_API_URL`, `TASK_ORCH_WORKER_TOKEN`, plus agent/git
   credentials, then `npx tsx scripts/run-worker.ts <runId>`.

`db/index.ts` constructs the Postgres client lazily: an HTTP-mode worker boots
without `DATABASE_URL`, and any code path that still touches the DB directly
in that mode throws a descriptive error naming this document.

## Known phase-2 surface (still direct-DB)

These run inside the worker process and still require `DATABASE_URL` (i.e.
keep passing it, or avoid these features on HTTP-only workers). Each fails
loudly via the lazy-db guard if hit without it:

- **`lib/extensions/events.ts` — the always-on event tools** (`report_result`,
  `raise`, `events__poll`/`emit`, `timer__*`, `ask_parent`,
  `answer_question`). These mount in every turn and write
  `agent_runs`/`run_timers` directly, so this is the highest-priority phase-2
  item: an HTTP-only worker whose agent calls one of them fails that tool call
  (the turn itself survives; the tool returns the lazy-db error). Until they
  are routed server-side, pass `DATABASE_URL` to workers whose agents use the
  event system (executors and parent/child trees especially).
- `lib/extensions/planning.ts` (planning runs write plan/planning-stage rows),
- `lib/extensions/persona-memory.ts` (persona memory reads/writes),
- `lib/extensions/spawn.ts` + nested Machine dispatch (child runs dispatched
  *from inside* a worker; the server-side dispatch paths — pump, release,
  sendMessageToRun — are unaffected),
- the Discord pipe and CLI (they are orchestrator-side tools, not workers).

The intended next step for these is the same pattern used for the 37
orchestrator tools: execute server-side behind one endpoint.

## Debugging cheatsheet

- `TASK_ORCH_LOG_LEVEL=debug` on a worker: every API call with status +
  duration, every SSE reconnect.
- `TASK_ORCH_LOG_FORMAT=json`: machine-readable log lines.
- Server-side: grep the web logs for `[worker-api]` and a `runId=` to see one
  run's entire protocol conversation.
- Worker logs still land in `agent_runs.worker_log`
  (`GET /api/runs/:id/worker-log`) in both modes.

## Compatibility

- No schema changes. No new NOTIFY channels.
- Deployments that don't set `TASK_ORCH_WORKER_API_URL` behave exactly as
  before (db transport everywhere, `DATABASE_URL` passed to workers).
- The status-event/`_eos` SSE contract of the run view is untouched.
