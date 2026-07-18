# Box runner integration

The **Box** provider runs each agent run in a managed remote "box" (a cloud
computer on [ascii.dev](https://ascii.dev)) forked from a filesystem snapshot.
Select it with `TASK_ORCH_RUNNER=box`. Use it for managed remote execution with
the least infrastructure — the only required setting is one API key, and the app
builds and maintains the run template for you.

New here? Read [Workers and runners](README.md) first for the control-plane /
worker split, the run lifecycle, and the worker channel.

Implementation: `lib/runner/box.ts` (provider), `lib/runner/box-client.ts` (API
adapter), `lib/runner/box-template-*.ts` (the app-managed template system),
`lib/runner/box-waiters.ts` (readiness/checkpoint polling). Operator guide:
[box-deployment.md](../box-deployment.md).

---

## 1. What Box is

Box (ascii.dev) provides **cloud computers** through a REST API. The primitives
this integration uses:

- **Create** a fresh blank box (`POST /boxes`).
- **Fork** an existing box into a new one — near-instant, because it starts from
  the parent's filesystem snapshot rather than a cold install.
- **Command** — run a shell command inside a box.
- **Stop / archive** — freeze a box to a persistent snapshot.
- **Resume** — wake an archived box from its snapshot.

Task Orchestrator's model: keep one stopped, validated **template** box that
already contains the worker runtime and the agent repository, and **fork a fresh
run box from it for each run**. Forking is what makes per-run isolation cheap —
a run box boots from a warm snapshot in seconds instead of installing everything.

The control plane stays authoritative: it owns the database, scheduling, tools,
and run state. A box supplies one run's machine and its persistent filesystem.

---

## 2. Two lifecycles: the template, and the run

Box has two distinct flows. Understand them separately.

```
   ┌─ TEMPLATE lifecycle (once per worker build SHA) ──────────────┐
   │  create blank box → clone worker@sha → npm ci → build worker  │
   │  → clone agent repo → npm ci → write manifest → archive       │
   │  result: a stopped template box, recorded in environments     │
   └───────────────────────────────────────────────────────────────┘
                             │ fork
                             ▼
   ┌─ RUN lifecycle (once per run) ────────────────────────────────┐
   │  fork template → wait ready → read manifest → launch worker    │
   │  → host the channel → execute → checkpoint on idle → resume    │
   └───────────────────────────────────────────────────────────────┘
```

---

## 3. The template lifecycle (app-managed)

A template must contain the exact worker build the control plane expects (keyed
by the **worker build SHA**) plus the agent repository. Task Orchestrator builds
and maintains this itself — **app-managed provisioning is the default**. You do
*not* pre-provision anything: with just `BOX_API_KEY` set and no pinned template
id, the first box dispatch builds a template on demand.

### How a build runs

`resolveBoxTemplate()` (`lib/runner/environments.ts`) is consulted on
every box dispatch. It returns one of:

- **pinned** — `TASK_ORCH_BOX_TEMPLATE_ID` is set; app-managed builds are
  disabled and that box is used as the template.
- **ready** — a template matching the current worker SHA already exists; fork
  from it.
- **building** — a build is in progress (this run started it, or another run
  did); the run defers.

Templates are tracked in the **`environments`** table (rows with
`provider = 'box'`). A *partial unique index* on `(provider, worker_sha)` for
live (`building`/`ready`) rows is the **single-flight lock**:
exactly one build runs per worker SHA, no matter how many runs dispatch at once.
The losers of the insert race simply observe the winner's row and defer behind
it. When a new worker SHA produces a new ready template, older ready rows are
marked `superseded`.

### Environments page

Box templates are one kind of **environment** — the execution artifact a runner
provider launches from (alongside the docker worker image and the fly runner
image). The `/environments` page lists all of them, grouped by provider and
versioned by worker SHA, and can trigger a box template build in-app ("Build
template" — a manual build with no triggering run, progress polled from the
`detail` column). The registry is the shared `environments` table (it replaced
`box_templates` in migration 0021).

### The build itself

`runBoxTemplateBuild()` (`lib/runner/box-template-builder.ts`) **creates its own
fresh blank box** (`client.create`, `POST /boxes`) — there is no
operator-provided base box — and runs these steps over the Box command API:

1. `cloning-worker` — verify the blank box has git/node/npm, then clone the
   worker repo and check out the exact SHA.
2. `installing-deps` — `npm ci` in the worker checkout.
3. `building-worker` — `npm run build:worker` and confirm the artifact.
4. `cloning-agent-repo` — clone the agent repository.
5. `installing-agent-deps` — `npm ci` in the agent checkout.
6. `writing-manifest` — write `/home/user/.task-orchestrator/template.json`
   (build SHA, protocol version, repository, repository path).
7. `archiving` — stop the box and wait for a completed snapshot.

The build is slow — a clone, two `npm ci` runs, a worker build, and a snapshot
archive — on the order of **10–15 minutes** the first time (and again whenever
the worker SHA drifts). Later dispatches with a ready template skip straight
through.

### Live feedback

A first dispatch would otherwise look like a run hung in `pending` for 15
minutes, so the build is fully surfaced:

- The builder emits lifecycle events (`runner_box_template_building`,
  `…_step`, `…_ready`, `…_failed`) keyed to the triggering run, over the same
  event stream the run view already tails.
- The deferred run's `pending_reason` reads *"Building box template…"* (and
  runs deferred behind someone else's build read *"Waiting for box template
  build (started by run #N)"*).
- The run view renders a build **stepper** — a checklist of the steps above with
  per-step elapsed time, an honest "usually 10–15 minutes, later runs skip this"
  note, and a failed state that points at re-dispatch to retry.

A failed build marks its row `failed` and does not block: the next dispatch
starts a fresh build. A build orphaned by a control-plane restart mid-build is
detected by a staleness check and retried.

---

## 4. The run lifecycle

Once a ready template exists, dispatching a run is fast.

### Admission

`BoxRunnerProvider.admit()` runs a **template gate first**: if the template is
still building, the run defers with the reason above. If a template is ready (or
pinned), it falls through to the capacity check — a probe of the **remote Box
account's** limits (`boxAdmissionDecision`). Unlike local (host RAM) or Fly
(Machine count), Box capacity is "does my account have room for another active
box", and it can also reject up front for billing/auth problems.

### Provisioning (`BoxRunnerProvider.create`)

1. Resolve the template (pin or the ready registry row).
2. **Fork** the template box with `noEnv: true` and a tightly scoped worker
   environment (`buildBoxWorkerEnv`) — the fork inherits *none* of the account's
   dashboard environment or secret files.
3. Record the `runner_instances` row and wait for the fork to become ready.
4. Read and validate the template **manifest** (`template.json`) — the build SHA
   and repository path must match what the control plane expects.
5. Launch the worker inside the box and host its channel (below).

### The worker channel over the ascii.dev `host` proxy

Box has no private control-plane-to-box network like Fly's 6PN, so the channel
is exposed through Box's built-in tunnel. The worker binds
`tcp:0.0.0.0:8787` inside the box and runs `host 8787`, which publishes a
token-gated public WebSocket URL (`wss://…on.ascii.dev/worker/channel`). The
control plane dials *that* URL to reach the worker. As with every provider, the
worker holds no `DATABASE_URL` and no `BOX_API_KEY`; it learns everything from
the pushed `run.start` snapshot and calls back over the channel.

The resolved endpoint is persisted on `runner_instances.channel_endpoint`, so a
restarted control plane reconnects to a still-running box.

### Idle: checkpoint and resume

A box holds a **persistent filesystem snapshot**, so a run's state survives
between turns. When a run goes idle, the provider **checkpoints** it: stop the
box and wait for a completed snapshot (`waitForBoxCheckpoint`). A follow-up turn
**resumes** the archived box from that snapshot — the checkout, node_modules,
and SDK session files are all still there. Stopped boxes are retained per
`TASK_ORCH_BOX_RETENTION_MS`.

### Runner state

The provider maps Box states onto the shared `RunnerState`
(`creating`/`starting`/`running`/`suspended`/`stopped`/`gone`) and reconciles
them on its monitor/sweep, capturing box-side errors onto the run.

---

## 5. Security model

The trust boundary is strict because a box runs untrusted agent code:

- **`BOX_API_KEY` is a control-plane secret.** It is never placed in a template
  box, a fork's environment, a repository, a shell profile, a worker log, or an
  agent prompt. The provider forks with `noEnv: true` so account/dashboard
  environment never leaks into a run.
- A worker receives **neither `BOX_API_KEY` nor `DATABASE_URL`**. It makes no
  outbound control-plane request and cannot fork or destroy boxes.
- The channel credential is derived from `TASK_ORCH_WORKER_CHANNEL_SECRET`
  (falling back to `AUTH_SECRET`) and scoped to the run.

---

## 6. Key environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `TASK_ORCH_RUNNER=box` | — | Select the Box provider (control plane only). |
| `BOX_API_KEY` | — | Account-level control-plane credential. **The only required Box setting.** |
| `TASK_ORCH_BOX_BASE_URL` | `https://ascii.dev/api/box/v1` | Box API endpoint. |
| `TASK_ORCH_BOX_TEMPLATE_ID` | — | **Optional pin.** Set it to use a hand-published template and *disable* app-managed builds. Leave unset for the default app-managed flow. Ignored while `TASK_ORCH_BOX_PROVISION=blank` (the default) — set `TASK_ORCH_BOX_PROVISION=template` to restore it; a warning is logged once per process when both are set. |
| `TASK_ORCH_BOX_REPO_PATH` | — | Path the agent repo is checked out to inside the box (also baked into app-built templates). |
| `TASK_ORCH_BOX_WORKER_REPO_URL` / `_REF` | task-orchestrator repo / `main` | Worker repo the template build clones. |
| `TASK_ORCH_BOX_AGENT_REPO_URL` / `TASK_ORCH_BOX_AGENT_REPO` | nodetool repo / `nodetool-ai/nodetool` | Agent repo the template build clones + records. |
| `TASK_ORCH_BOX_BUILD_STEP_TIMEOUT_S` | `900` | Per-step timeout for template build commands. |
| `TASK_ORCH_WORKER_SHA` | — | Pins the worker build SHA. Otherwise it's resolved from the **remote** worker ref (`git ls-remote <workerRepoUrl> <workerRepoRef>`) so the template is always buildable — the control plane's local HEAD may be unpushed. |
| `TASK_ORCH_BOX_BUILD_RETRY_COOLDOWN_S` | `120` | Cooldown after a failed template build before another is attempted for the same SHA (prevents a doomed build from burning a Box every pump tick). |
| `TASK_ORCH_BOX_IDLE_STOP_MS` | `30000` | Grace before checkpointing an idle box. |
| `TASK_ORCH_BOX_RETENTION_MS` | 30 days | Archived-box retention. |
| `TASK_ORCH_BOX_MAX_ACTIVE` | `0` (account limit) | Optional app-level cap on active boxes. |
| `TASK_ORCH_WORKER_CHANNEL_SECRET` | `AUTH_SECRET` | Source of the channel credential. |

Minimal config for app-managed mode is genuinely just:

```text
TASK_ORCH_RUNNER=box
BOX_API_KEY=...
```

The first dispatch builds the template from a blank box (with the live stepper),
and every run forks from it thereafter.

---

## Related

- [Workers and runners](README.md) — the overview
- [Box operations guide](../box-deployment.md) — the operator guide
- [Worker WebSocket protocol](../worker-websocket-protocol.md)
- App-managed template design specs live under
  [docs/superpowers/specs/](../superpowers/specs/) (`2026-07-17-box-app-managed-template-design.md`, `2026-07-17-box-template-build-feedback-design.md`).
