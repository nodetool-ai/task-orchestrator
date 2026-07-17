# Environments — design

**Date:** 2026-07-18
**Supersedes:** the `box_templates` table (specs
`2026-07-17-box-app-managed-template-design.md` — semantics carry over).

## Problem

Each runner provider has an execution artifact runs launch from — a Docker
image, a Fly runner image, a Box template snapshot — but only Box's is modeled
(as `box_templates`); docker/fly live in env vars with no visibility, and there
is no UI for any of them. Introduce **environments**: one first-class concept
covering all three, one page listing them, and a build area. `box_templates`
is killed; environments is the only registry.

An environment row = one build/artifact of the worker for one provider,
versioned by worker SHA. Dispatch resolves the provider's current environment
automatically (no per-run selection in v1).

## 1. Schema — migration 0021

Create `environments`; copy `box_templates` rows over
(`provider='box'`); drop `box_templates`.

| column | type | notes |
| --- | --- | --- |
| `id` | serial PK | |
| `provider` | text NOT NULL | `docker` \| `fly` \| `box` |
| `worker_sha` | text NOT NULL | worker build the artifact contains |
| `state` | text NOT NULL default `building` | `building → ready \| failed`; `superseded` when replaced |
| `box_id` | text | box artifact (archived template box) |
| `image` | text | docker/fly artifact (image tag / registry ref) |
| `detail` | text | current build step (manual builds poll this) |
| `error` | text | failure detail |
| `triggering_run_id` | integer | run whose dispatch started a box build (null for manual/page builds) |
| `created_at` / `ready_at` | timestamptz | |

Partial unique index `environments_live_idx` on `(provider, worker_sha)`
WHERE `state IN ('building','ready')` — the single-flight lock, per provider.
`environments_state_idx` on `state`.

The old `repository` column is dropped (it lives in the box manifest; nothing
read it from the registry).

## 2. Registry module — `lib/runner/environments.ts`

`box-template-registry.ts` generalizes and renames. Exports:

- `resolveBoxTemplate({ runId })` — name and contract unchanged (box dispatch's
  seam); reads `environments` with `provider = 'box'`. Cooldown, orphan flip,
  insert-race single-flight, `setTemplateBuildStarter` — all verbatim.
- `markEnvironmentReady(id, artifact: { boxId } | { image })` /
  `markEnvironmentFailed(id, error)` — generalized `markTemplateReady/Failed`;
  supersede applies within the same provider only.
- `setEnvironmentDetail(id, step)` — updates `detail` (manual-build progress).
- `listEnvironments()` — all rows, newest first, for the page.
- `registerConfiguredEnvironments()` — upserts a `ready` row for docker
  (`TASK_ORCH_WORKER_IMAGE`, `worker_sha` = current) and fly
  (`FLY_RUNNER_IMAGE`) when configured and no live row exists for that
  provider+sha, so configured images appear on the page without a build.
  Called by the page loader.

`box-template-builder.ts` and `box-template-state.ts` switch to the new module
and table; the builder additionally calls `setEnvironmentDetail` per step so
manual builds are observable without run events. Event emission
(`emitTemplateBuildLifecycle`) is unchanged and only wired when
`triggering_run_id` is set.

## 3. Docker build — `lib/runner/docker-image-build.ts`

`runDockerImageBuild({ environmentId, image })`:

1. Uses dockerode's `buildImage` with the repo root as context,
   `dockerfile: "Dockerfile.worker"`, `t: image`.
2. Streams progress; on each meaningful phase writes `setEnvironmentDetail`.
3. Success → `markEnvironmentReady(id, { image })`; failure → row `failed`
   with the error tail. Never throws (fire-and-forget like the box builder).

Single-flight comes from the same live index (an insert claims the build).
The image tag defaults to `TASK_ORCH_WORKER_IMAGE`; building without it
configured fails the row with an actionable error.

## 4. `/environments` page + build area

- Top-nav entry "Environments" (site-header + mobile-nav).
- Server page (`app/environments/page.tsx`): calls
  `registerConfiguredEnvironments()` then `listEnvironments()`; renders
  provider-grouped sections (box / docker / fly). Each row: state pill
  (reusing the existing pill styling), artifact (image or box id), short
  worker SHA, created/ready relative times, `detail` while building, error on
  failed.
- Client refresh: the list polls every 5s while any row is `building`
  (plain `router.refresh()` interval component; no SSE needed in v1).
- Build area per provider:
  - **Box**: "Build template" button → POST `/api/environments/build`
    `{ provider: "box" }`. The route inserts the building row (single-flight;
    409 if one is live) and fire-and-forgets `runBoxTemplateBuild` with
    `triggeringRunId: null` — progress via `detail`. Run-triggered builds keep
    the full run-view stepper as today.
  - **Docker**: "Build image" button → same route with
    `{ provider: "docker" }` → `runDockerImageBuild`.
  - **Fly**: info card — image ref, last state, and the copyable build/push
    command from `docs/fly-deployment.md`. No in-app build.
- The route requires an authenticated session (same guard as other app APIs).

## 5. Consumers updated

- `lib/runner/telemetry.ts` + `/api/metrics`: gauge renamed to
  `task_orch_environments{service,provider,state}` (replaces
  `task_orch_box_templates`).
- `box-template-state.ts` (run-view stepper seed): reads `environments`
  (`provider='box'`).
- Builder `runBoxTemplateBuild`: `triggeringRunId` becomes nullable; event
  emission skipped when null; `setEnvironmentDetail` per step always.
- Tests renamed/extended (see §7). Docs: `docs/runners/box.md`,
  `docs/runners/README.md`, `box-deployment.md` gain an environments note.

## 6. Error handling

- Manual build with a live building/ready row for (provider, sha) → API 409
  with the row's state ("already building" / "already ready — rebuild only
  after SHA drift"). Frontend disables the button while a live building row
  exists.
- Docker daemon unreachable → row `failed` with the connection error.
- All box failure semantics (cooldown, orphan threshold) unchanged.
- Migration copies only `box_templates` rows in states
  `ready`/`superseded`/`failed`; `building` rows are dead by definition at
  migration time and are dropped.

## 7. Testing

- Registry: existing box-template-registry tests ported to `environments`
  (+ new: a docker `building` row does NOT block a box build for the same
  SHA — provider-scoped single-flight).
- Docker build: fake dockerode seam — success marks ready with the image,
  stream error marks failed, missing TASK_ORCH_WORKER_IMAGE fails the row.
- `registerConfiguredEnvironments`: upserts once, no duplicate on re-call,
  respects a live building row.
- Build API route: 409 on live row; inserts + kicks for box and docker.
- Page loader (`listEnvironments`) ordering/grouping.
- Migration: a `ready` box_templates row appears as a
  `provider='box'` environments row post-migration; `building` rows dropped.

## Out of scope

Per-run/per-repo environment selection, named/user-defined environments,
in-app fly builds, deleting superseded box snapshots.
