# App-managed Box template provisioning — design

**Date:** 2026-07-17
**Closes:** [`BOX_TEMPLATE_UI_FEEDBACK_GAP.md`](../../../BOX_TEMPLATE_UI_FEEDBACK_GAP.md) (the whole story: this is the `ensureTemplate()` half; the feedback half landed as commits `04b25ec..b46c44a` per
[`2026-07-17-box-template-build-feedback-design.md`](2026-07-17-box-template-build-feedback-design.md)).

## Problem

Today the Box template is built out-of-band (`scripts/install-box-template.sh`)
and pinned via `TASK_ORCH_BOX_TEMPLATE_ID`. The app should own the template
lifecycle: on a box dispatch, build a template when none matches the current
worker build SHA, defer the triggering run with live feedback (already built),
then fork run boxes from the ready template. A pinned
`TASK_ORCH_BOX_TEMPLATE_ID` remains an explicit override that disables
app-managed provisioning.

## Shape

Templates are **deployment-global** (one per worker SHA), matching today's
single-pin reality. The agent repository baked into the template comes from
config, like the install script.

### 1. `box_templates` registry (migration 0020)

New table `box_templates`:

| column | type | notes |
| --- | --- | --- |
| `id` | serial PK | |
| `worker_sha` | text NOT NULL | control-plane worker build SHA |
| `repository` | text NOT NULL | owner/name baked into the manifest |
| `state` | text NOT NULL | `building` → `ready` \| `failed`; `superseded` when replaced |
| `box_id` | text | the template Box (set at fork time) |
| `triggering_run_id` | integer | run whose dispatch started the build (events target) |
| `error` | text | failure detail |
| `created_at` / `ready_at` | timestamptz | |

Partial unique index on `worker_sha` WHERE `state IN ('building','ready')` —
this is the single-flight lock: exactly one live build/template per SHA.

### 2. Worker SHA source — `lib/runner/worker-sha.ts`

`workerBuildSha(): Promise<string>` — `TASK_ORCH_WORKER_SHA` env override
first (deployed servers can be git-less), else `git rev-parse HEAD` in the
server checkout via `execFile`, cached per process. Throws a clear error when
neither is available.

### 3. Resolution — `lib/runner/box-template-registry.ts`

`resolveBoxTemplate({ runId })` returns one of:

- `{ kind: "pinned", boxId }` — `config.box.templateId` is set; registry untouched.
- `{ kind: "ready", boxId }` — a `ready` row matches the current worker SHA.
- `{ kind: "building", builderRunId }` — a `building` row exists (another
  run's build, or the one this call just started).

On miss (no building/ready row for the SHA — including after a `failed` row),
it INSERTs a `building` row with `triggering_run_id = runId`; a unique-index
conflict means another dispatch won the race and this call re-reads and
returns that row. If the insert wins, it fire-and-forgets
`runBoxTemplateBuild()` (void, error-logged) and returns
`{ kind: "building", builderRunId: runId }`.

`markTemplateReady(id, boxId)` also flips any other `ready` rows to
`superseded` (old-SHA templates stop being forked from; their Boxes are left
for the operator/retention sweep — explicit non-goal to delete them here).

### 4. Build — `lib/runner/box-template-builder.ts`

`runBoxTemplateBuild(client, { registryId, runId, workerSha })`, wrapped in
`emitTemplateBuildLifecycle` (already built + contract-tested) with
`emit = (type, payload) => emitBoxEvent(runId, type, payload)` (`emitBoxEvent`
gets exported from `lib/runner/box.ts`). Steps (each a `client.command` with
`config.box.buildStepTimeoutSeconds`, default 900):

1. `cloning-worker` — full clone of `config.box.workerRepoUrl` at
   `workerRepoRef`, then `git checkout <workerSha>` (fails clearly when the
   SHA isn't on the remote — push before dispatching).
2. `installing-deps` — `npm ci` in the worker checkout.
3. `building-worker` — `npm run build:worker` + artifact check
   (`dist/run-worker.js`), same as the install script.
4. `cloning-agent-repo` — clone `config.box.agentRepoUrl` (depth 1, default ref).
5. `installing-agent-deps` — `npm ci` in the agent checkout.
6. `writing-manifest` — write `/home/user/.task-orchestrator/template.json`
   with `workerBuildSha = workerSha`, `repository = config.box.agentRepo`,
   `repositoryPath = config.box.repoPath`.
7. `archiving` — `client.stop(boxId)` + `waitForBoxCheckpoint` (completed
   snapshot required before the row turns ready).

Before step 1 it forks `config.box.baseBoxId` (a plain stopped Box with
git/node/npm — new required config for app-managed mode) with `env: {}` and
`noEnv: true`, then `waitForBoxReady`. On any failure: registry row → `failed`
with the error, the lifecycle driver has already emitted
`runner_box_template_failed`, and the box (if forked) is stopped best-effort.
The two new step names get entries in `STEP_LABELS`
(`lib/runner/box-template-events.ts`): "Cloning agent repo",
"Installing agent dependencies".

**Retry policy:** a `failed` row does not block; the next dispatch inserts a
fresh `building` row. The pump's retry cadence bounds the loop and
`TASK_ORCH_MAX_DEFER_MS` eventually hard-fails runs if builds keep failing.
(Known v1 caveat: repeated failing builds spend Box compute; acceptable, logged.)

### 5. Provider wiring — `lib/runner/box.ts`

`BoxRunnerProvider.admit()` gains a template gate *before* the limits probe
(skipped entirely when pinned):

- `building` and `builderRunId === input.runId` → defer, reason
  `"Building box template…"`.
- `building` otherwise → defer, reason
  `"Waiting for box template build (started by run #<builderRunId>)"`.
- `ready`/`pinned` → fall through to the existing limits logic.

These reasons flow into `pending_reason` via the wiring that landed today, so
the run list and stepper light up with zero further work.

`create()` replaces the hard `TASK_ORCH_BOX_TEMPLATE_ID` requirement: template
id = pin ?? ready-row `box_id` (re-resolved; a defensive error if neither —
admission should have deferred). `templateVersion` passed to
`buildBoxWorkerEnv` becomes the template's `workerSha` when app-managed.

### 6. Config (`lib/config.ts`)

New under `config.box` (all inert unless `TASK_ORCH_RUNNER=box`):

- `baseBoxId` — `TASK_ORCH_BOX_BASE_ID` (blank base Box to fork).
- `workerRepoUrl` — `TASK_ORCH_BOX_WORKER_REPO_URL`, default
  `https://github.com/nodetool-ai/task-orchestrator.git`.
- `workerRepoRef` — `TASK_ORCH_BOX_WORKER_REPO_REF`, default `main`.
- `agentRepoUrl` — `TASK_ORCH_BOX_AGENT_REPO_URL`, default
  `https://github.com/nodetool-ai/nodetool.git`.
- `agentRepo` — `TASK_ORCH_BOX_AGENT_REPO`, default `nodetool-ai/nodetool`.
- `buildStepTimeoutSeconds` — `TASK_ORCH_BOX_BUILD_STEP_TIMEOUT_S`, default 900.

`validateBoxConfig()`: requires `BOX_API_KEY` plus **either**
`TASK_ORCH_BOX_TEMPLATE_ID` (pinned) **or** `TASK_ORCH_BOX_BASE_ID`
(app-managed).

### 7. Metrics (gap doc item 4)

`/api/metrics` adds `box_templates` counts grouped by state alongside the
existing `runner_instances` report.

### 8. Docs / env

- `.env.example` Box section: document the new keys and the pin-vs-managed
  choice; `.env.local`: switch to `TASK_ORCH_BOX_BASE_ID` (blank) instead of
  requiring a template id.
- `docs/box-deployment.md`: app-managed lifecycle section (pin = override).
- `BOX_TEMPLATE_UI_FEEDBACK_GAP.md`: status → closed with pointers.

## Error handling

- Build step failure / timeout / fork failure → row `failed`, `failed` event
  with step + error (driver), best-effort stop of the partial Box.
- Server restart mid-build: the `building` row is orphaned. Staleness guard:
  a `building` row older than 2× the total step budget
  (`7 × buildStepTimeoutSeconds`) is treated as failed by `resolveBoxTemplate`
  (flipped to `failed`, error "build orphaned by restart") so a fresh build can
  start. No heartbeat machinery in v1.
- SHA not pushed to the worker repo remote → step 1 fails with the git error
  in the failed event; the fix (push) is user-visible in the stepper.

## Testing

All against the structural `BoxClient` fake (the established pattern in
`box-provider-e2e.test.ts` / `box-waiters.test.ts`) and the real test DB:

- worker-sha: env override, git fallback, cache, missing-both error.
- registry: pinned short-circuit; ready hit; single-flight insert race (two
  concurrent resolves → one building row, same builder); failed-row retry;
  supersede on ready; orphaned-row staleness flip.
- builder: happy path emits the full lifecycle + writes ready row with boxId;
  step failure marks row failed and stops the box; command payloads include
  the SHA checkout and manifest JSON.
- provider admit: three defer shapes + fall-through to limits when ready.
- create(): forks the resolved registry template when no pin is set.
- validateBoxConfig: pin-or-base requirement matrix.
- metrics: box_templates rows appear grouped by state.
