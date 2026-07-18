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

### 1. The control plane uploads its own bundle

The control plane ships `dist/run-worker.standalone.js` in its own deployment
(`Dockerfile.server` builds it; local dev builds it with
`npm run build:worker:standalone`) and **uploads it into the box** at
provision time: base64 chunks of 6MB via the box files API
(`PUT /boxes/:id/files`, `BoxClient.writeFile`), reassembled on the box from
an explicitly-ordered part list and verified against the sha256 the control
plane computed from the exact bytes it uploaded.

- **Why upload, not download:** a download URL was the system's only
  box→control-plane connection — impossible for a localhost control plane,
  and it needed its own auth (run-scoped HMAC), an HTTP route, and a
  URL-configuration story. Upload works identically for every control plane,
  needs no route and no credential beyond the Box API key the control plane
  already holds, and keeps the worker version-locked to the server driving
  it by construction. (An earlier iteration shipped the authed
  `GET /api/worker-bundle` route + curl pull; it was removed in favor of
  upload-only.)
- **Identity:** the manifest's `workerBuildSha` prefers the
  `dist/run-worker.standalone.js.sha` sidecar baked at build time
  (`ARG GIT_SHA` in `Dockerfile.server`, git HEAD locally), falling back to
  `workerBuildSha()`.
- **Cost:** ~31MB of base64 through the box API per provision (4 chunked
  PUTs), a few seconds — accepted; provisioning is per-run frequency.

**Status**: upload-only blank provisioning landed; template mode remains behind `TASK_ORCH_BOX_PROVISION=template`.

### 2. Blank provisioning replaces the template fork

`BoxRunnerProvider.create()` in blank mode:

1. `client.create({ env, noEnv: true })` — same blank image the template
   builder already uses; `env` = `buildBoxWorkerEnv(...)`. Then the chunked
   bundle upload (§1).
2. One **provision command** (detached setsid + `.rc` polling, the template
   builder's proven pattern, budget `config.box.provisionTimeoutSeconds`,
   default 300):
   - reassemble the uploaded parts to `/home/user/worker/run-worker.js` and
     verify the interpolated sha256 with `sha256sum`;
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
| Upload/clone flake at launch | provision command is detached + polled with tail-on-failure evidence; a failed provision clears the mapping's boxId so retry provisions a fresh box; failure is per-run, never a shared cooldown |
| Server deployed without the bundle | dispatch fails before any box is created, naming `npm run build:worker:standalone`; Dockerfile builds it unconditionally |
| GH_TOKEN exposure during clone | token never enters the clone URL or argv — it rides a git credential.helper that expands `$GH_TOKEN` from the box env; clone-failure log tails stay token-free |
| Blank image drifts (loses git/node/claude) | provision command verifies tools first and fails legibly (same guard as the template builder's cloning-worker step) |

## Out of scope

- Deleting the template/environments machinery and the CI warm job.
- Caching the bundle or repo objects across runs (a future warm-pool or
  content-addressed cache can layer on top).
- Fly/Docker adoption of fetch-at-launch.
