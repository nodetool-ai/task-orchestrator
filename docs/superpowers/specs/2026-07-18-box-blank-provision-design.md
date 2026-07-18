# Box blank provisioning — worker fetched at launch, no template snapshot

**Date:** 2026-07-18
**Relates to:** `2026-07-18-standalone-worker-bundle-design.md` (§6 — this is
its second half), `2026-07-18-environments-design.md` (the template registry
this bypasses).

## Problem

Even with the standalone bundle, a Box run still depends on a **template
snapshot**: dispatch forks a pre-built, archived Box whose only meaningful
contents are now (a) a 23MB bundle file and (b) a `--depth 1` clone of one
fixed agent repo. That coupling costs:

- a template build (minutes) on every worker SHA change, on the critical path
  when no warm template exists;
- environment identity pinned to the worker commit (`environments` rows,
  sha-drift, cooldowns, the warm-template CI job);
- one fixed agent repository baked at build time, when admission already
  requires each run's repo to have a clonable GitHub remote.

A blank Box (`client.create`) is ready in seconds and ships git/node/npm and
`/usr/local/bin/claude`. Everything else a run needs can be fetched at
launch: the bundle is 23MB, the clone is ~8s.

## Design

### 1. The control plane serves its own bundle

New route `GET /api/worker-bundle` serving `dist/run-worker.standalone.js`
from the server's own deployment.

- **Why the control plane, not the CI artifact:** the served worker is
  *version-locked to the server driving it* — no skew window, no GitHub
  Actions API dance from inside a box, no token-scope roulette with
  `GH_TOKEN` (artifacts need `actions:read`; clones don't). The CI artifact
  (`worker-bundle-<sha>`) remains provenance/debugging, not the runtime
  source.
- **Auth:** `Authorization: Bearer <channel credential>` + `X-Run-Id`
  header, verified statelessly via `verifyChannelCredential` — the same
  HMAC credential the box already holds
  (`TASK_ORCH_WORKER_CHANNEL_CREDENTIAL`). Run-scoped, no session, no API
  token in the box.
- **Integrity/identity headers:** `X-Bundle-Sha256` (verified by the box
  after download) and `X-Worker-Sha` (`workerBuildSha()`).
- **Missing file** (dev server that never built the bundle) → 503 naming
  `npm run build:worker:standalone`.
- `Dockerfile.server`'s build stage runs `npm run build:worker:standalone`
  and the runtime stage copies `dist/`.

Trade-off, accepted: the box env gains a control-plane URL
(`TASK_ORCH_BUNDLE_URL`), which `workerChannelDispatchEnv` deliberately
avoided. The credential it could pair with is run-scoped and
single-purpose, and the URL is public anyway; the worker still learns
everything else from the pushed `run.start` snapshot.

**Status**: route and blank provisioning landed; template mode remains behind `TASK_ORCH_BOX_PROVISION=template`.

### 2. Blank provisioning replaces the template fork

`BoxRunnerProvider.create()` in blank mode:

1. `client.create({ env, noEnv: true })` — same blank image the template
   builder already uses; `env` = `buildBoxWorkerEnv(...)` plus
   `TASK_ORCH_BUNDLE_URL`.
2. One **provision command** (detached setsid + `.rc` polling, the template
   builder's proven pattern, budget `config.box.provisionTimeoutSeconds`,
   default 300):
   - `curl` the bundle to `/home/user/worker/run-worker.js`, dump headers,
     verify `X-Bundle-Sha256` with `sha256sum`;
   - `git clone --depth 1` **the run's own repository** (its GitHub remote,
     which admission guarantees) to `TASK_ORCH_RUNNER_REPO_PATH`, using
     `GH_TOKEN` from the box env;
   - write the standard manifest
     (`/home/user/.task-orchestrator/template.json`: `workerBuildSha` =
     the server's `workerBuildSha()`, `repository` = the run's
     `owner/repo`, `repositoryPath`, `workerEntryPath`).
3. Hand off to the existing `readyAndLaunch` **unchanged** — it already
   cats/validates the manifest and the bootstrap already probes
   `/home/user/worker/run-worker.js` first.

Writing the standard manifest is the load-bearing trick: everything
downstream of provisioning (manifest parse, `runnerInstances.repoPath`/
`workerVersion`, bootstrap, park/resume) works identically for
blank-provisioned and template-forked boxes.

Per-run cost: box create + ready wait + ~23MB download + shallow clone —
tens of seconds, vs. a snapshot fork's seconds. Accepted: it buys zero
template builds, zero sha-drift, and per-run repositories.

### 3. Admission and mode flag

- `TASK_ORCH_BOX_PROVISION` = `blank` (default) | `template`.
- Blank mode: `admit()` skips `resolveBoxTemplate` entirely (no
  building/cooldown defers); the repo-viability and limits gates remain.
  `create()` skips template resolution; `boxTemplateId` stays null.
- Template mode: today's behavior, kept as the rollback path. The
  `environments` machinery, `/environments` page, and the CI
  warm-box-template job stay wired to it; removing them is follow-up work
  once blank mode has soaked.

### 4. Unchanged

- Park/resume **run-state** snapshots (stop → archive → resume): those are
  per-run state preservation, not templates, and stay exactly as they are.
- Fly and Docker providers.
- The repo-viability admission gate (now the thing that guarantees the
  provision clone can succeed).

## Risks

| risk | mitigation |
| --- | --- |
| Bundle route abused / credential replay | HMAC is run+instance-scoped; route additionally checks the run exists and is active; 23MB static bytes, no state |
| Download/clone flake at launch | provision command is detached + polled with tail-on-failure evidence, normal dispatch retry applies; failure is per-run, never a shared cooldown |
| Server deployed without the bundle | route 503s with the build command; Dockerfile builds it unconditionally |
| GH_TOKEN in clone URL visible in box process list momentarily | box is single-tenant per run and already holds the token in env; noted, accepted |
| Blank image drifts (loses git/node/claude) | provision command verifies tools first and fails legibly (same guard as the template builder's cloning-worker step) |

## Out of scope

- Deleting the template/environments machinery and the CI warm job.
- Caching the bundle or repo objects across runs (a future warm-pool or
  content-addressed cache can layer on top).
- Fly/Docker adoption of fetch-at-launch.
