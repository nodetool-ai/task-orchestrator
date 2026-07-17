# Local / Docker runner integration

The **local** provider runs workers on a single host — either as plain OS
processes or as Docker containers. It's the default (`TASK_ORCH_RUNNER` unset),
the one you use for development, and the one behind single-server deployments.

New here? Read [Workers and runners](README.md) first for the control-plane /
worker split, the run lifecycle, and the worker channel. This page assumes that
context.

Implementation: `lib/runner/local.ts` (a thin adapter) plus the bulk of the
logic in `lib/run-dispatch.ts`.

---

## 1. Three runtimes under one provider

"local" is not one execution model — it covers three, chosen at dispatch time.
This trips people up, so it's worth being explicit.

### (a) Lightweight in-process / child — the "light chat"

Cheap runs (a pi `<chat>`, a pi `<execute>` plan step) are marked
`runtime = "server"` and never get a full worker. Controlled by
`TASK_ORCH_LIGHTWEIGHT_ISOLATION`:

- **`inprocess`** — the turn runs *inside the web-server process itself*. Lowest
  overhead; used as a rollback/test escape hatch.
- **`child`** (default) — the turn runs in a small local Node child process with
  a hard V8 heap cap (`node --max-old-space-size=<MB>`). Crucially this child is
  **not a worker**: it keeps `DATABASE_URL` and talks to Postgres directly, and
  is *not* marked `TASK_ORCH_INSIDE_WORKER`. Moving the turn off the server's
  event loop means a runaway turn gets OOM-killed in isolation without taking
  the control plane down.

This tier has no container, no checkout of a separate machine, and no worker
channel. It exists so a busy chat workload doesn't pay container costs.

### (b) Detached host worker

When `TASK_ORCH_DETACHED_RUNS=1` **and** `TASK_ORCH_WORKER_IMAGE` is *unset*, a
worker is a plain detached `tsx scripts/run-worker.ts <id>` process on the host
(`detachedSpawn`). This *is* a real worker: it runs with
`TASK_ORCH_INSIDE_WORKER=1`, `DATABASE_URL` is stripped from its environment,
and it reaches the control plane only over the worker channel — here a **Unix
domain socket**.

Use it to exercise the real WebSocket worker on your dev box with zero container
overhead, borrowing the host's tooling and `node_modules`. No isolation, no
survival across a server restart — fine for development.

### (c) Docker worker container

When `TASK_ORCH_WORKER_IMAGE` *is* set, each run gets its own
`task-orchestrator-worker` container (`dockerSpawn`), launched over the mounted
Docker socket (Docker-out-of-Docker). Same worker entrypoint, same
credential-less channel — but the transport is TCP (`ws://…:8787`) and the run
gets a clean, resource-capped, consistently-tooled image.

**The switch between (b) and (c) is simply whether `TASK_ORCH_WORKER_IMAGE` is
set.** Its presence also arms the Docker monitor, the container sweep, and the
host-memory admission gate.

```
                     TASK_ORCH_RUNNER = local (default)
                                │
          ┌─────────────────────┼──────────────────────┐
   runtime = "server"?      DETACHED_RUNS=1 &&      DETACHED_RUNS=1 &&
          │                  no WORKER_IMAGE         WORKER_IMAGE set
          ▼                        │                      │
   (a) in-process / child    (b) host process        (c) Docker container
       "light chat"              (Unix socket)          (TCP :8787)
```

---

## 2. Architecture

`LocalRunnerProvider` (`lib/runner/local.ts`) is deliberately thin — it
delegates to `lib/run-dispatch.ts`:

- `create()` computes the worker's listen endpoint and calls `defaultSpawn`,
  which branches on `TASK_ORCH_WORKER_IMAGE`: set → `dockerSpawn`, unset →
  `detachedSpawn`.
- `stop()` → `stopWorkerContainer` (a best-effort `docker stop`; a no-op for
  host processes).
- `sweep()` → reconcile containers and clean up abandoned sockets.
- `startMonitor()` → subscribe to Docker lifecycle events.

**Docker container shape** (`buildWorkerContainerConfig`):

- Name = the run's scope (`run-<id>-<nonce>`); the container command is the run
  id; the image entrypoint is `tsx scripts/run-worker.ts`.
- Environment: `GH_TOKEN`, the agent credentials, model/backend settings,
  `SESSION_ROOT=/work`, `REPO_CACHE_DIR=/repo-cache`,
  `TASK_ORCH_INSIDE_WORKER=1`, and the per-run channel identity —
  **`DATABASE_URL` is deliberately absent.**
- Mounts: the host `~/.claude` config (so Claude session/resume survives
  ephemeral containers) and the repo-cache volume at `/repo-cache`.
- Port `8787/tcp` is *exposed but never published to the host* — the control
  plane dials it internally, not through a host port.
- No auto-remove (so the monitor can capture logs + exit code before removal),
  bounded logs, cgroup limits from `TASK_ORCH_WORKER_*`, and
  `host.docker.internal` wired to the host gateway.

**Reaching the worker** (`resolveDockerDialHost`): the worker binds
`tcp:0.0.0.0:8787`; the control plane dials it. On a named Docker network (the
compose stack) it dials the container *by name*; on Docker Desktop host-dev it
inspects the container and dials its private bridge IP. After `container.start()`
resolves, dispatch still runs a bare TCP probe of `:8787`
(`waitForDockerPortReady`, 30s deadline) because "process launched" is not the
same as "listener bound".

> `host.docker.internal:host-gateway` is the *reverse* direction — it lets the
> worker reach a host-run server during `npm run dev`. In the compose stack it's
> inert.

---

## 3. Lifecycle & sequence (Docker worker)

1. **Provision channel** — mint a channel identity, create the
   `runner_instances` row (`provider: "local"`), reserve endpoints.
2. **Admit + claim** under the admission lock: check host memory (§4), then
   atomically flip the run to `preparing` with an ownership token. On `defer`
   the run parks in `pending`; the pump retries it.
3. **Spawn container** — create + start the worker container.
4. **Resolve + probe** — work out the dial host, TCP-probe `:8787` until ready.
5. **Worker boots** — the container runs `scripts/run-worker.ts`, which reads
   its channel identity from the environment (failing fast if it's missing) and
   binds the WebSocket listener.
6. **Dial + handshake** — the control plane dials with a retry ladder, completes
   the channel handshake, and pushes the `run.start` snapshot exactly once.
7. **Execute** — the worker checks out the repo (from the `/repo-cache` mirror
   where possible), runs the agent turn, pushes a branch, opens/updates a PR.
   All messages and events stream to Postgres *through the control plane* over
   the channel — never from the worker directly.
8. **Exit / reap** — the worker exits; the container dies.

**Heartbeats and reaping.** The claimed run carries a heartbeat the worker
refreshes (~20s). Two reapers catch a dead container:

- **`startWorkerMonitor`** subscribes to Docker `die`/`oom` events. On a death
  it captures `docker logs` + the exit code (137/`oom` flagged as OOM-killed)
  onto the run row, applies the death policy (redispatch / idle / fail), then
  removes the container — reacting in *seconds*. It self-reconnects if the event
  stream drops.
- **`sweepWorkerContainers`** (every pump tick) is the backstop for whatever the
  event stream missed after a server restart: it removes exited containers,
  stops strays whose run already finished, and declares dead any leased run
  whose container is gone — but only after ~30s of heartbeat silence, so a
  container still being created isn't reaped mid-boot.

---

## 4. The host-memory admission gate

Local is the only provider that admits by measuring **physical host RAM** — it's
asking "does one more worker fit on this box?". (Fly counts Machines; Box asks
its remote account.)

`readHostMemory()` reads `/proc/meminfo` for `MemAvailable`/`MemTotal`. Because
Docker doesn't namespace memory, those figures are host-wide even from inside
the server container — **provided the server has no memory limit set** (the
compose file explicitly warns never to give the server a `mem_limit`, or
`/proc/meminfo` would report container-local numbers and the gate would
misjudge). `admissionDecision()` then applies two bounds:

1. **Reservation** — `(total − reserve) − (in-flight × per-worker cap)` must
   still cover one more worker.
2. **Live floor** — current available RAM minus the reserve must clear one
   worker's cap.

Plus a hard `TASK_ORCH_MAX_WORKERS` backstop. A single worker whose cap exceeds
the whole budget is `never-fits` (a fatal misconfiguration, not a retry).
Lightweight children draw on the *same* budget, so the container tier and the
light-chat tier can't jointly oversubscribe the host.

The gate is only active when `TASK_ORCH_WORKER_IMAGE` is set — a
host-process-only or lightweight-only deployment skips it.

---

## 5. Key environment variables

| Variable | Effect |
| --- | --- |
| `TASK_ORCH_DETACHED_RUNS` | `1` runs turns out-of-process (real workers). Forced on for fly/box. |
| `TASK_ORCH_WORKER_IMAGE` | **The Docker switch.** Set → container workers; unset → host-process workers. Also arms the Docker monitor, sweep, and memory gate. |
| `TASK_ORCH_CLAUDE_HOME_HOST` | Host `~/.claude` mounted into each worker so Claude session/resume survives ephemeral containers. |
| `TASK_ORCH_REPO_CACHE_HOST_VOLUME` | Named Docker volume of bare repo mirrors, mounted at `/repo-cache`, so workers clone from a local mirror instead of hitting GitHub each run. |
| `TASK_ORCH_DOCKER_NETWORK` | Docker network for workers; when set, the control plane dials workers by container name. |
| `TASK_ORCH_WORKER_MEMORY_MB` | Per-worker hard cgroup cap **and** the per-worker charge in admission accounting. |
| `TASK_ORCH_HOST_MEMORY_RESERVE_MB` | RAM held back for the OS, server, Postgres. |
| `TASK_ORCH_MAX_WORKERS` | Hard concurrency backstop (`0` = memory-bound only). |
| `TASK_ORCH_LIGHTWEIGHT_ISOLATION` | `child` (default) or `inprocess` for the light-chat tier. |
| `TASK_ORCH_LIGHTWEIGHT_MEMORY_MB` / `_MAX_CHILDREN` | Heap cap and count cap for lightweight children. |
| `TASK_ORCH_PENDING_PUMP_MS` / `TASK_ORCH_MAX_DEFER_MS` | Pump interval; max time a run may sit in `pending` before it's failed. |

> **Obsolete:** `TASK_ORCH_WORKER_API_URL` no longer exists. Workers make no
> outbound control-plane HTTP request — the run is *pushed* to them over the
> WebSocket channel (`TASK_ORCH_WORKER_CHANNEL_ENDPOINT`, injected per run).
> Treat any doc mentioning `TASK_ORCH_WORKER_API_URL` as stale.

---

## 6. When to use which mode

- **Lightweight (`runtime = "server"`)** — cheap pi chat/executor turns.
  DB-attached, no container. `child` isolates a runaway turn; `inprocess` is the
  test/rollback path.
- **Detached host worker** (`DETACHED_RUNS=1`, no `WORKER_IMAGE`) — fastest way
  to run the *real* worker protocol on your dev machine. No isolation, no
  restart survival.
- **Docker worker** (`WORKER_IMAGE` set) — the production-shaped isolated
  worker: clean image, baked tooling, hard caps, externally-observable lifecycle
  (Docker events), repo-cache mirror, non-root. This is what
  `scripts/dev-workers.sh` and the compose stack in
  [test-deployment.md](../test-deployment.md) set up.

---

## Related

- [Workers and runners](README.md) — the overview
- [Local Docker stack / test deployment](../test-deployment.md) — the operator guide and compose stack
- [Worker WebSocket protocol](../worker-websocket-protocol.md)
