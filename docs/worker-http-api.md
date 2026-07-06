# Worker HTTP + SSE protocol

How run workers talk to the orchestrator. Replaces "every worker holds
`DATABASE_URL` and writes Postgres directly" with a typed protocol; introduced
2026-07. **The HTTP protocol is a hard requirement for workers**: dispatch
never hands out `DATABASE_URL`, a worker process without worker-API
credentials refuses to start a transport, and any code path that would touch
Postgres from inside a worker throws. The db transport still exists — as the
orchestrator's own in-process implementation and the single implementation
backing the HTTP routes.

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
| Worker (`TASK_ORCH_INSIDE_WORKER=1`) with `TASK_ORCH_WORKER_API_URL` + `TASK_ORCH_WORKER_TOKEN` | `http` |
| Worker without those | **hard error** — direct-Postgres workers are not supported. (`TASK_ORCH_WORKER_ALLOW_DB=1` is a test-only escape hatch for suites that simulate a worker env inside the orchestrator process.) |

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
| `POST runs/:id/tools/call` `{tool, params, ctx}` | `callTool` | executes any server-registry tool (the 37 orchestrator tools + the event, planning, spawn, and persona-memory tools — `lib/worker/server-tools.ts`) server-side; `runId` comes from the token, never the body. Long-poll friendly: awaited child appends can hold this open for hours |
| `GET  repositories` | `listRepoRemotes` | repo remotes for gh_pr / gh_ci URL gating |
| `POST runs/:id/pr-lock` `{prUrl}` | `acquirePrLock` | the §5.2 `pr:<url>` resource lease for PR-mutating tools |
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

## Running workers

1. Set `TASK_ORCH_WORKER_API_URL` on the **server** to its own base URL as
   reachable from workers (compose service name, flycast address, or public
   https origin; `NEXTAUTH_URL` is used as a same-host dev fallback), and
   optionally `TASK_ORCH_WORKER_API_SECRET` (defaults to `AUTH_SECRET`).
   Dispatch fails with an actionable error when neither URL is set.
2. Every spawn path (docker container, Fly Machine, dev detached process)
   injects the URL + a freshly minted run token and **never passes
   `DATABASE_URL`**.
3. A hand-rolled external worker is: env `TASK_ORCH_INSIDE_WORKER=1`,
   `TASK_ORCH_WORKER_API_URL`, `TASK_ORCH_WORKER_TOKEN`, plus agent/git
   credentials, then `npx tsx scripts/run-worker.ts <runId>`.

Enforcement is belt-and-suspenders: `runTransport()` throws in a worker
process without API credentials, and `db/index.ts` (which constructs its
client lazily) throws on ANY direct DB access from a worker — a not-yet-routed
code path fails at its exact call site with an error naming this document.

## Agent tools in workers

Every tool that reads or writes orchestrator state executes **server-side**
through one registry (`lib/worker/server-tools.ts`), reached via
`transport.callTool` → `POST runs/:id/tools/call`:

- the 37 orchestrator tools (`lib/orchestrator-tools`),
- the always-on event tools (`report_result`, `raise`, `events__*`,
  `timer__*`, `ask_parent`, `answer_question`),
- the planning gate tools (`propose_spec`, `commit_spec_as_plan`,
  `propose_implementation_plan` — the stage interceptor stays worker-local and
  mirrors stage advances after successful calls),
- the spawn tools (`spawn__*` — child runs are created and dispatched on the
  orchestrator, which also retires the old in-worker nested-dispatch path),
- the persona-memory tools (+ the ambient memory text, loaded at mount via the
  internal `memory__load` registry entry).

The gh_pr / gh_ci tools are the deliberate hybrid: `gh` CLI shell-outs run
worker-local (against the worker's checkout), while their orchestrator-state
needs — repo-remote URL gating and the `pr:<url>` ownership lease — go through
`listRepoRemotes` / `acquirePrLock`.

Still orchestrator-side by nature (not workers at all): the Discord pipe and
the CLI.

## Debugging cheatsheet

- `TASK_ORCH_LOG_LEVEL=debug` on a worker: every API call with status +
  duration, every SSE reconnect.
- `TASK_ORCH_LOG_FORMAT=json`: machine-readable log lines.
- Server-side: grep the web logs for `[worker-api]` and a `runId=` to see one
  run's entire protocol conversation.
- Worker logs still land in `agent_runs.worker_log`
  (`GET /api/runs/:id/worker-log`), shipped over `POST runs/:id/log`.

## Compatibility

- No schema changes. No new NOTIFY channels.
- **Breaking for worker dispatch**: `TASK_ORCH_WORKER_API_URL` (or
  `NEXTAUTH_URL` on same-host dev) must be set — dispatch fails with an
  actionable error otherwise, and workers never receive `DATABASE_URL`.
  docker-compose defaults it to `http://server:3000`.
- The web server, CLI, and Discord pipe are unaffected (they are the
  orchestrator; the db transport is theirs).
- The status-event/`_eos` SSE contract of the run view is untouched.
