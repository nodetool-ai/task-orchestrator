# Fly.io runner integration

The **Fly** provider runs each agent run in its own ephemeral cloud VM. Select
it with `TASK_ORCH_RUNNER=fly`. Use it when you want per-run isolation and
horizontal scale across a cloud without managing a host.

New here? Read [Workers and runners](README.md) first. This page assumes the
control-plane / worker split, the run lifecycle, and the worker channel.

Implementation: `lib/runner/fly.ts` (the provider) and `lib/runner/fly-client.ts`
(the Fly Machines API client). Operator guide:
[fly-deployment.md](../fly-deployment.md).

---

## 1. What Fly.io is

Fly.io is a public cloud whose core primitive is the **Fly Machine**: a
fast-booting Firecracker micro-VM (boots in a few seconds) that you create,
start, suspend, stop, and destroy individually through a REST API. A Machine can
mount a **Fly Volume** — a persistent, region-pinned disk that survives the
Machine being stopped or destroyed independently. Fly apps talk to each other
over a private IPv6 network (**6PN**, the `.internal` addresses), so the database
and the workers are never exposed publicly.

**Task Orchestrator's model: one ephemeral Machine + one Volume per run.** A
run's Machine checks out the repo, runs the agent session, pushes a branch,
opens/updates a PR, then suspends → stops → is destroyed as it goes idle.
Durable state lives in Postgres; the Machine is disposable.

A Fly deployment is three apps:

- **`task-orchestrator`** — the control plane (the web app), one always-on
  Machine. Holds the Fly API token, the admission gate, the pump, and the runner
  monitor.
- **`task-orchestrator-runners`** — the runner pool. It declares *no* public HTTP
  service and is never `fly deploy`-ed as a running app; the deploy only builds
  and pushes its image. The control plane creates and destroys the actual run
  Machines at runtime.
- **`task-orchestrator-db`** — Fly Postgres.

---

## 2. Architecture

`FlyRunnerProvider` (`lib/runner/fly.ts`) implements the `RunnerProvider`
interface (`kind = "fly"`). It's built with a `FlyClient` — a thin typed wrapper
over the Fly Machines REST API (`lib/runner/fly-client.ts`) with a bearer token,
a 30s request timeout, and errors surfaced as `FlyApiError`. The client covers
volumes (`createVolume` / `destroyVolume` / `listVolumes`) and machines
(`createMachine` / `getMachine` / `startMachine` / `suspendMachine` /
`stopMachine` / `destroyMachine` / `listMachines`).

`buildFlyMachineConfig` assembles each Machine: the worker image, the worker
env (§4), a single mount of the run's volume at `/mnt/session`, a shared-CPU
guest sized from config, and an `on-failure` restart policy. A guard
(`assertValidSharedMachineResources`) rejects a memory/CPU pairing outside Fly's
256–2048 MB-per-vCPU band *before* the API would, turning a class of failed
provisions into a clear config error.

---

## 3. Runner lifecycle & sequence

### Admission

The Fly gate (`flyAdmit`) counts active `runner_instances` rows in states
`creating`/`starting`/`running` and defers when the count reaches
`TASK_ORCH_MAX_MACHINES`. Setting it to `0` disables the gate. A deferred run
parks in `pending`; the pump retries oldest-first. Unlike the local provider,
**Fly admission never looks at memory** — capacity is a Machine count.

### Provisioning (`FlyRunnerProvider.create`)

1. If a `runner_instances` row with a volume already exists → this is a resume;
   delegate to `resume`.
2. Resolve the region (`TASK_ORCH_FLY_REGION`, default `ams`).
3. **Create the volume** — named `vol_run_<runId>`, either *forked from a prewarm
   seed* volume (warm dependencies, §5) or blank at
   `TASK_ORCH_RUNNER_VOLUME_GB`.
4. **Create the Machine** (`buildFlyMachineConfig`) — name = the run's scope. It
   mounts the volume at `/mnt/session` and boots the worker image.
5. **Resolve the private IP** — the Machine's 6PN IPv6. This *throws* rather than
   fall back to any public address; workers are only reachable privately.
6. Compute the channel dial endpoint — `ws://[<ipv6>]:8787/worker/channel` — and
   upsert the `runner_instances` row with `state: "starting"`, the machine id,
   volume id, region, and channel endpoint.
7. On any failure: best-effort force-destroy the Machine and volume, then rethrow.

### Boot + channel

The Machine's entrypoint mounts the volume and runs the pre-built worker
(`node dist/run-worker.js <RUN_ID>`), which binds the channel port **8787**. The
control plane dials into it over 6PN and pushes the `run.start` snapshot. The
worker holds no DB credentials and learns everything from that snapshot.

### The wake-window race

Between "Machine started" and "worker wrote its first heartbeat" there is no
live claim, and a sweep tick would otherwise mistake a just-woken Machine for an
idle one and suspend it out from under the boot (this actually happened — the
run-139 incident). `resume` stamps a `wake_requested_at` marker on the row
*before* telling Fly to start, and the lifecycle logic treats a fresh wake
marker as "leave it alone". Warm wakes retry Fly 409s; an unrecoverable
conflict destroys the corpse and **cold-recovers** a fresh Machine on the same
intact volume.

### Idle lifecycle (`sweep` → `applyLifecycle`)

Every `TASK_ORCH_FLY_POLL_MS` the monitor lists Machines, reconciles each row's
state, and decides a lifecycle action. Before executing a suspend/stop it
**re-reads the row** and bails if the run became active or was heartbeated or
wake-stamped since the snapshot. Actions:

- **suspend** — keep the volume, fastest resume;
- **stop** — stop the Machine;
- **archive-and-destroy** — destroy Machine *and* volume.

Roughly: a terminal or idle run suspends after inactivity, stops after ~24h, and
is destroyed after longer (see the policy table in
[fly-deployment.md](../fly-deployment.md)). A **missing** Machine → the row goes
`gone` and, if the run was still active, the death policy runs. The sweep also
reaps leaked `vol_run_*` volumes (after a grace window).

### Hard cancel (`stop`)

Force-destroys the Machine, destroys the volume immediately (no future resume),
releases the claim, marks the row `gone`, clears the SDK session token.

### Runner state machine

Fly Machine states map to the shared `RunnerState`:

| Fly state | RunnerState |
| --- | --- |
| `started` / `running` | `running` |
| `suspended` | `suspended` |
| `stopped` | `stopped` |
| `destroyed` / `destroying` | `gone` |
| `created` / `creating` / `starting` / `stopping` / `suspending` / unknown | `starting` (conservative — the death policy only fires on a genuinely *missing* Machine) |

---

## 4. What the worker gets — and deliberately doesn't

`buildFlyWorkerEnv` builds the Machine's environment. It **includes**: the GitHub
token, the agent credentials (Claude auth + pi provider keys), model/backend
settings, `TASK_ORCH_INSIDE_WORKER=1`, `SESSION_ROOT=/mnt/session`, the repo
cache dir, the *resolved* nested-dispatch policy, and — once the channel is
provisioned — the per-run channel identity, credential, and listen endpoint.

It **deliberately omits**:

- **`DATABASE_URL`** — the protocol is WebSocket-only; workers hold no Postgres
  credentials. Every read/write flows over the channel the control plane dials.
  Runner Machines run untrusted agent code, so keeping DB creds off them bounds
  the blast radius.
- **`FLY_API_TOKEN` / `TASK_ORCH_FLY_APP` / `TASK_ORCH_RUNNER`** — workers cannot
  reach the Fly API at all. Fly Machine tokens can't be scoped narrower than
  app-wide, so a compromised worker holding one could create or destroy any
  Machine or mount another run's volume. They are never handed out. This is the
  core of the nested-dispatch trust model (§7).

Because workers never see `TASK_ORCH_RUNNER`, the nested-dispatch policy is
passed down as an already-*resolved* string (`TASK_ORCH_NESTED_DISPATCH`), since
the raw Fly default couldn't be resolved inside a credential-less worker.

---

## 5. Cold-start latency & the warm repo cache

A Machine boots in seconds, but a naive worker would then spend 20+s on
transpile, a full `git clone`, and a recursive `chown`. Four mitigations, each
degrading gracefully when absent:

- **Warm repo cache** — blobless bare mirrors of hot repos are baked into the
  image at `/opt/repo-cache` (build-time, using a BuildKit secret for the token
  so it's never persisted in a layer). Workers clone with
  `git clone --reference <mirror> --dissociate --filter=blob:none`, transferring
  only the delta; every turn still `git fetch`es, so a stale mirror is a seed,
  not a source of truth. Missing mirror → transparent full clone.
- **Prewarm seed volume** — a persistent volume holding a baked nodetool
  `npm ci`. `create()` *forks* it into each run's volume so the run boots with
  warm dependencies and skips the multi-GB cold install. (This lives on a volume
  rather than the image because a baked `npm ci` blew past Fly's image size cap.)
  No seed → cold install, never fatal.
- **Pre-built worker** — the image bundles `dist/run-worker.js`, so boot runs
  `node` rather than `tsx`. Falls back to `tsx` if absent.
- **First-boot-only volume trims** — the recursive `chown` and optional `.claude`
  seed run only on a volume's first boot (guarded by a marker file).

---

## 6. Key environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `TASK_ORCH_FLY_APP` | — | Runner-pool app name. Read *before* `FLY_APP_NAME` (which Fly reserves for the current Machine's own app). |
| `FLY_API_TOKEN` | — | Fly Machines API token. Required. |
| `TASK_ORCH_MAX_MACHINES` | `0` (gate off) | Max concurrent Machines; `>0` enables the admission gate. |
| `FLY_RUNNER_IMAGE` | `fly-runner:latest` | Worker image. |
| `TASK_ORCH_FLY_REGION` | `ams` | Region for Machines + volumes. |
| `TASK_ORCH_RUNNER_VOLUME_GB` | `10` | Blank-volume size (ignored on forks). |
| `TASK_ORCH_FLY_CPUS` | `4` | vCPUs per Machine (shared). |
| `TASK_ORCH_FLY_MEMORY_MB` | `4096` | Memory per Machine (256–2048 MB per vCPU enforced). |
| `TASK_ORCH_FLY_POLL_MS` | `10000` | Sweep / reap interval. |
| `TASK_ORCH_PREWARM_SEED_VOLUME` | `prewarm_seed` | Seed volume to fork; empty disables. |

Credentials (`GH_TOKEN`, `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`,
optional pi provider keys) are staged as Fly **secrets on the web app** and
passed through into each Machine's env by `buildFlyWorkerEnv`. See
[.env.fly.example](../../.env.fly.example) and
[fly-deployment.md](../fly-deployment.md).

---

## 7. Nested dispatch (worker-spawned runs)

A top-level run gets its own Machine. But a run *spawned by a worker* — a plan
executor calling `start_session` / `start_review` — historically executed
*inside the parent's Machine*, because the worker has no Fly token to create a
new one. One dropped connection could then kill the executor and take all its
children with it (a real prod incident).

The fix keeps the worker away from the Fly API entirely: when inside a worker
with `isolate` policy, `runs.create` parks the child run at `pending` instead of
dispatching it. The **control plane's** pump picks it up, runs `flyAdmit`, and
provisions a *distinct* Machine + volume + `runner_instances` row for the child —
the same path a top-level run takes. `await_session` just polls the child's
status in the database, which doesn't care where anything executes.

Bounds and safety: every Machine funnels through `flyAdmit`, so
`TASK_ORCH_MAX_MACHINES` holds; a **deadlock breaker** admits a child over the
cap when its parent is blocked waiting on it; `TASK_ORCH_MAX_RUN_DEPTH` and
`TASK_ORCH_MAX_TREE_RUNS` bound fan-out. A child crash now dies alone, and a
parent crash leaves its children running as independent Machines. Full design:
[nested-machine-dispatch.md](../nested-machine-dispatch.md).

---

## Related

- [Workers and runners](README.md) — the overview
- [Fly deployment guide](../fly-deployment.md) — the full operator guide
- [Nested machine dispatch](../nested-machine-dispatch.md)
- [Worker WebSocket protocol](../worker-websocket-protocol.md)
