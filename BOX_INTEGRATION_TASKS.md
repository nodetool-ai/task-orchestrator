# Box runner integration — implementation tasks

**Date:** 2026-07-14  
**Companion design:** [`BOX_INTEGRATION_DESIGN.md`](BOX_INTEGRATION_DESIGN.md)

## How to use this plan

Each item below is intentionally small enough for one focused implementation
session and one reviewable pull request. A task should change only the listed
surface unless a compile fix is unavoidable. Tests use injected fakes, so most
tasks can be completed without Box credentials.

Dependencies are explicit. Tasks with the same dependency level can be worked
in parallel. A task is complete only when its acceptance checks pass; do not
batch acceptance until the end of the project.

## Dependency graph

```text
B001 live spike (can run immediately)

B002 provider types ─┬─ B004 client boundary ─┬─ B008 provider skeleton
B003 config          │                        ├─ B005 error classification
                     │                        └─ B006 waiters
B007 schema ─────────┘

B009 env builder ────────────────┐
B010 repo-path override ─────────┼─ B012 initial fork ── B013 worker launch
B011 template manifest ──────────┘                         │
                                                          ├─ B014 checkpoint
                                                          ├─ B015 resume
                                                          └─ B016 credential refresh

B005 + B008 ── B017 admission
B014 + B015 ── B018 sweep/reconciliation
B014 ───────── B019 cancellation
B018 ───────── B020 retention/orphan cleanup
B007 + provider work ── B021 inventory/telemetry

B012..B021 ── B022 fake-client end-to-end tests
B001 + B022 ─ B023 live acceptance script
B011 + B014 ─ B024 template CLI
B003..B024 ── B025 docs/config rollout
B022..B025 ── B026 staging rollout

Optional follow-ups after MVP: B027 worker bundle distribution, B028 previews,
B029 desktop access.
```

---

## Track A — feasibility and foundations

### B001 — Prove detached execution and snapshots on a real Box

**Can start:** immediately  
**Depends on:** none  
**Parallel with:** B002, B003, B007, B009, B010

Create a disposable live test procedure or script. Fork the existing stopped
Box, wait for readiness, launch a detached process through the command endpoint,
modify two files, stop, verify a completed snapshot, resume, and verify both
files.

The two files should represent different persistence needs:

- a repository working-tree change;
- a fake agent-session marker under `/home/user/.pi` or
  `/home/user/.task-orchestrator`.

Also verify that the background process remains alive after the command request
returns and that it is gone after stop/resume.

**Deliverables**

- `scripts/box-feasibility.ts` or a documented one-off test under `docs/`.
- Recorded fork, ready, stop, snapshot, and resume timings.
- A clear decision: detached `nohup` is supported, or systemd bootstrap is
  required.

**Acceptance checks**

- [ ] The fork request uses `noEnv: true`.
- [ ] Commands are not sent before `ready` or `idle`.
- [ ] A detached process survives command completion.
- [ ] Stop reaches `archived` with `lastSnapshotStatus=completed`.
- [ ] Repository and session-marker files survive resume.
- [ ] Every disposable Box is stopped and deleted in `finally` cleanup.
- [ ] No API key or returned secret URL is printed.

---

### B002 — Extend provider-neutral runner types with `box`

**Can start:** immediately  
**Depends on:** none  
**Parallel with:** B001, B003, B007

Change only provider-neutral type definitions and exhaustive type consumers.
Do not instantiate a Box provider yet.

**Likely files**

- `lib/config.ts`
- `lib/runner/provider.ts`
- provider type tests

**Work**

- Extend `RunnerProviderKind` to `"local" | "fly" | "box"`.
- Extend `RunnerRef.provider` likewise.
- Add compile-safe exhaustive branches with a temporary explicit unsupported
  error where the provider factory does not yet have an implementation.
- Do not change default provider selection.

**Acceptance checks**

- [ ] Local remains the default.
- [ ] Fly selection remains unchanged.
- [ ] TypeScript accepts a Box `RunnerRef`.
- [ ] Unknown provider strings still fall back according to the documented
  configuration policy.
- [ ] Existing runner-provider tests pass.

---

### B003 — Add and validate Box configuration accessors

**Can start:** immediately  
**Depends on:** none  
**Parallel with:** B001, B002, B007

Add lazy Box configuration under the centralized `lib/config.ts` registry. Do
not call the Box SDK.

**Configuration**

```text
BOX_API_KEY
TASK_ORCH_BOX_BASE_URL
TASK_ORCH_BOX_TEMPLATE_ID
TASK_ORCH_BOX_TEMPLATE_VERSION
TASK_ORCH_BOX_REPO_PATH
TASK_ORCH_BOX_IDLE_STOP_MS
TASK_ORCH_BOX_POLL_MS
TASK_ORCH_BOX_READY_TIMEOUT_MS
TASK_ORCH_BOX_RETENTION_MS
TASK_ORCH_BOX_MAX_ACTIVE
```

**Work**

- Add typed lazy getters.
- Add a pure `validateBoxConfig()` result or throwing validator.
- Require API key, template ID, worker API URL, and worker-token signing secret
  only when Box is selected.
- Validate Box ID shape and non-negative timing/count values.
- Add keys to the configuration guard allowlist/source of truth.

**Acceptance checks**

- [ ] Importing config without Box variables does not throw.
- [ ] Selecting Box with missing required values produces actionable errors.
- [ ] Tests can mutate environment between cases and see fresh values.
- [ ] Secrets are absent from config snapshots or are redacted.
- [ ] Existing config guard tests pass.

---

### B004 — Introduce an injectable Box client boundary

**Can start:** after B002  
**Depends on:** B002  
**Parallel with:** B005, B007, B009, B010

Wrap `@asciidev/box-sdk` behind a narrow project-owned interface. The generated
SDK must not be mocked directly in provider tests.

**New file**

- `lib/runner/box-client.ts`

**Interface should cover**

- `limits`
- `boxes`
- `get`
- `update`
- `fork`
- `resume`
- `stop`
- `remove`
- `command`
- `getLatestBoxSnapshot`

Expose only fields the provider needs. Add `makeBoxClient()` for production and
a structural fake-friendly interface for tests.

**Acceptance checks**

- [ ] Base URL defaults to `https://ascii.dev/api/box/v1`.
- [ ] API key is read from configuration and never logged.
- [ ] Tests instantiate a fake without importing SDK internals.
- [ ] TypeScript compiles against the installed SDK version.
- [ ] A response mapper tolerates additional API fields.

---

### B005 — Classify Box API errors without provider side effects

**Can start:** after B004  
**Depends on:** B004  
**Parallel with:** B006, B007, B009, B010

Create pure error normalization so admission and lifecycle code receive stable
project-level categories.

**Suggested categories**

```text
unauthorized
billing-required
capacity
rate-limited
not-found
conflict
transient
invalid-request
unknown
```

Preserve redacted status, Box error code, message, and request ID.

**Acceptance checks**

- [ ] 401 maps to `unauthorized`.
- [ ] 402 maps to `billing-required`.
- [ ] 404 maps to `not-found`.
- [ ] 429 maps to `rate-limited` or `capacity` as appropriate.
- [ ] 5xx maps to `transient`.
- [ ] Error serialization cannot include bearer tokens or secret URLs.
- [ ] Tests cover SDK `ResponseError` and unknown thrown values.

---

### B006 — Implement pure Box state mapping and polling waiters

**Can start:** after B004  
**Depends on:** B004  
**Parallel with:** B005, B007, B009, B010

Build reusable, abortable waiters independent of the provider class.

**New file suggestion**

- `lib/runner/box-waiters.ts`

**Functions**

- `boxStateToRunnerState(state)`
- `waitForBoxReady(client, boxId, options)`
- `waitForBoxCheckpoint(client, boxId, requestedAt, options)`

Readiness accepts only `ready` or `idle`. Checkpoint requires archived state and
a completed snapshot newer than the request.

**Acceptance checks**

- [ ] Provisioning states normalize to `starting`.
- [ ] `ready`, `idle`, and Box `running` normalize to runner `running`.
- [ ] `archived` normalizes to `stopped`.
- [ ] Waiters use bounded timeout and abort signals.
- [ ] Error state fails with Box context.
- [ ] Checkpoint waiter rejects a stale prior snapshot.
- [ ] Fake-clock tests do not sleep in real time.

---

### B007 — Add Box columns to `runner_instances`

**Can start:** immediately  
**Depends on:** none  
**Parallel with:** B001–B006

Create one additive migration and update Drizzle schema. Do not alter existing
Fly columns or semantics.

**Columns**

```text
box_id
box_template_id
box_source_id
snapshot_id
snapshot_completed_at
checkpoint_requested_at
last_checkpoint_at
credentials_version
credentials_expires_at
worker_version
last_provider_error
```

Add an index on `box_id` if inventory/reconciliation queries use it.

**Acceptance checks**

- [ ] Migration filename follows the next migration number.
- [ ] Migration applies to an existing database.
- [ ] Existing Fly rows remain valid and unchanged.
- [ ] Drizzle insert/select types expose every new field.
- [ ] Schema and migration use matching names and nullability.
- [ ] Database/schema tests pass.

---

## Track B — safe request construction and Box-local filesystem

### B008 — Add a no-side-effect `BoxRunnerProvider` skeleton

**Can start:** after B002, B004, and B007  
**Depends on:** B002, B004, B007  
**Parallel with:** B009–B011

Create `lib/runner/box.ts` and wire the provider factory, but leave provisioning
methods as explicit unsupported errors. This isolates factory/config changes
from lifecycle work.

**Acceptance checks**

- [ ] `TASK_ORCH_RUNNER=box` returns `BoxRunnerProvider`.
- [ ] Provider kind is `box`.
- [ ] Local and Fly provider caching still works.
- [ ] Test reset switches among all three kinds safely.
- [ ] No API request occurs during import or provider construction.

---

### B009 — Build the allowlisted Box worker environment

**Can start:** after B003  
**Depends on:** B003  
**Parallel with:** B004–B008, B010, B011

Create a pure function that builds the environment for one Box fork. Start from
an allowlist; do not copy `process.env` wholesale.

**Required behavior**

- Include worker HTTP URL/token from `workerDispatchEnv(runId)`.
- Include run/repo/instance/template tags.
- Include `TASK_ORCH_INSIDE_WORKER=1`, `SESSION_ROOT`, repository path, and the
  resolved nested-dispatch policy.
- Include only configured agent credential keys and `GH_TOKEN`.
- Explicitly exclude `BOX_API_KEY` and `DATABASE_URL`.
- Validate Box's variable-count and byte-size limits.

**Acceptance checks**

- [ ] Fork environment never contains `BOX_API_KEY`.
- [ ] Fork environment never contains `DATABASE_URL`.
- [ ] Unrelated control-plane secrets are not copied.
- [ ] Every fork request consumer must pass `noEnv: true` separately.
- [ ] Over 100 variables or over 64 KB fails before the API request.
- [ ] Test snapshots redact all secret values.

---

### B010 — Add a provider-neutral existing-repository path override

**Can start:** immediately  
**Depends on:** none  
**Parallel with:** B001–B009

Teach checkout preparation to use an already-present repository without
changing Box provisioning.

**Likely files**

- `lib/runs.ts`
- focused checkout tests

**Work**

- Add `TASK_ORCH_RUNNER_REPO_PATH` handling.
- Prefer it over `$SESSION_ROOT/repo` when set.
- Validate it with the existing cwd guard.
- For a first turn, create/check out the canonical task branch.
- For a resumed turn, preserve local modifications and do not hard reset.
- Keep current Fly (`SESSION_ROOT`) and Docker (`REPO_CACHE_DIR`) paths intact.

**Acceptance checks**

- [ ] Existing repository is reused without `git clone`.
- [ ] First-turn branch setup works.
- [ ] A dirty resumed checkout remains dirty after preparation.
- [ ] Wrong/missing path produces an actionable error.
- [ ] Fly and container checkout tests remain unchanged.

---

### B011 — Define and validate the template manifest

**Can start:** after B003  
**Depends on:** B003  
**Parallel with:** B008–B010

Add a small parser for:

```text
/home/user/.task-orchestrator/template.json
```

The parser should be independent of Box API calls and accept text supplied by a
future command/read operation.

**Manifest fields**

- worker build SHA
- worker protocol major
- repository owner/name
- absolute repository path
- template format version

**Acceptance checks**

- [ ] Invalid JSON and missing fields fail clearly.
- [ ] Repository path must be under `/home/user`.
- [ ] Worker protocol incompatibility is reported before launch.
- [ ] Unknown fields are tolerated for forward compatibility.
- [ ] Parser tests cover valid, old, malformed, and path-escape manifests.

---

## Track C — core lifecycle

### B012 — Implement initial template fork and readiness

**Can start:** after B006, B008, B009, and B011  
**Depends on:** B006, B008, B009, B011  
**Parallel with:** B017 after its prerequisites

Implement only the first-run path for a run with no `box_id`. Do not launch the
worker yet.

**Work**

- Call admission/config validation.
- Fork the configured template with replacement env and `noEnv: true`.
- Persist the returned Box ID immediately.
- Rename it to the orchestrator naming convention.
- Wait for ready/idle.
- Read and validate the template manifest.
- On failure, record a redacted provider error and stop the fork best-effort.

**Acceptance checks**

- [ ] The source is exactly the configured template ID.
- [ ] `noEnv: true` is unconditional.
- [ ] `env` replaces inherited environment.
- [ ] Mapping is persisted before readiness polling.
- [ ] A readiness timeout does not leave an untracked active Box.
- [ ] Retry does not create a second Box when a usable mapping already exists.
- [ ] Fake-client tests cover success, error state, timeout, and DB retry.

---

### B013 — Launch and claim the worker inside a ready Box

**Can start:** after B001 and B012  
**Depends on:** B001, B012  
**Parallel with:** B017

Implement the short bootstrap command selected by B001. Keep this task limited
to launch and claim ownership; do not implement checkpointing.

**Work**

- Issue the detached bootstrap command with a timeout below 60 seconds.
- Use a relative Box command cwd where required by the SDK.
- Parse and validate the returned PID/success result.
- Update `worker_scope` from the temporary claim to `box_id` only if the
  original claim is still owned.
- If claim ownership was lost, stop the newly launched Box best-effort.

**Acceptance checks**

- [ ] No secret value is embedded in the command string.
- [ ] Non-zero exit, timeout, and malformed output fail clearly.
- [ ] A claim race cannot produce two owners.
- [ ] Successful launch emits `runner_box_ready` and `runner_spawned`.
- [ ] Worker log path is under the snapshotted session root.
- [ ] Tests cover ownership lost after command success.

---

### B014 — Implement verified stop/checkpoint

**Can start:** after B006, B007, and B008  
**Depends on:** B006, B007, B008  
**Parallel with:** B012, B013, B015

Add an idempotent provider method/helper that checkpoints one mapped Box. Do not
wire it into the sweep yet.

**Work**

- Persist `checkpoint_requested_at` before the stop call.
- Call `stop` and wait for a new completed snapshot.
- Read the latest Box snapshot.
- Persist snapshot ID/timestamps and normalized stopped state atomically where
  practical.
- Emit requested/completed/failed events.
- Leave the mapping and Box intact on failure.

**Acceptance checks**

- [ ] A stale earlier snapshot cannot satisfy the checkpoint.
- [ ] Calling checkpoint twice is safe.
- [ ] Already archived Box is accepted only with a valid completed snapshot.
- [ ] Snapshot failure does not call delete.
- [ ] Transient polling failures retry within a bound.
- [ ] Tests cover stop accepted, already archiving, already archived, and failed
  final snapshot.

---

### B015 — Implement resume and worker relaunch

**Can start:** after B006, B013, and B014  
**Depends on:** B006, B013, B014  
**Parallel with:** B016, B017

Implement the path for a run with an archived current Box and valid credentials.

**Work**

- Stamp wake intent before `resume()`.
- Request `noEnv: true` on resume.
- Wait for ready/idle.
- Revalidate repository and worker/template compatibility.
- Relaunch the worker through B013's helper.
- Let the worker heartbeat clear wake intent through existing transport code.

**Acceptance checks**

- [ ] Archived run resumes the same Box ID.
- [ ] No new template fork occurs.
- [ ] Worker is explicitly relaunched after resume.
- [ ] Fresh wake intent prevents an immediate lifecycle stop.
- [ ] Resume conflict/state races are idempotent.
- [ ] Error/timeout retains the Box mapping for reconciliation.

---

### B016 — Implement credential-refresh fork from an archived run Box

**Can start:** after B009, B014, and B015  
**Depends on:** B009, B014, B015  
**Parallel with:** B017–B019

Implement environment replacement without losing the run filesystem.

**Work**

- Detect expired token or changed credential generation.
- Require a verified current checkpoint.
- Fork the archived run Box, not the original template.
- Pass `noEnv: true` and newly built replacement env.
- Store old Box as `box_source_id` and new Box as `box_id` atomically.
- Keep the source until the replacement completes its first checkpoint.
- Roll back the mapping if replacement provisioning fails.

**Acceptance checks**

- [ ] Source of the fork is the archived run Box.
- [ ] New environment replaces old environment.
- [ ] Old Box is not deleted during provisioning.
- [ ] Failed replacement leaves the old Box resumable.
- [ ] New Box becomes current only after readiness validation.
- [ ] Source deletion is deferred to retention/cleanup after a successful new
  checkpoint.

---

## Track D — scheduling, lifecycle automation, and operations

### B017 — Add Box capacity admission

**Can start:** after B005 and B008  
**Depends on:** B005, B008  
**Parallel with:** B012–B016

Move the provider decision into a testable admission method and wire Box into
`dispatchRun()` without changing lifecycle behavior.

**Work**

- Call `limits()` before starting/forking/resuming.
- Respect `canStart`, `activeBoxes`, `maxActiveBoxes`, and optional application
  cap.
- Return `defer` for temporary capacity and rate limits.
- Return a permanent actionable error for auth, account setup, or billing.
- Keep the pending-pump maximum wait behavior.

**Acceptance checks**

- [ ] Capacity exhaustion leaves run `pending`.
- [ ] 429 defers instead of marking `failed`.
- [ ] 402 produces a billing-specific error.
- [ ] Application cap can be lower than account cap.
- [ ] Concurrent admissions cannot exceed the selected cap within one server.
- [ ] Existing local/Fly admission tests pass.

---

### B018 — Reconcile Box state in the provider sweep

**Can start:** after B014 and B015  
**Depends on:** B014, B015  
**Parallel with:** B019, B021

Implement reconciliation only for mapped Box rows. Orphan account resources are
handled separately in B020.

**Work**

- Read current Box state for each Box runner row.
- Normalize and persist provider state.
- Protect live claims and fresh wake intents.
- Checkpoint ready Boxes with no live claim after idle grace.
- Repair archived/stopped mappings and verify snapshots.
- Handle missing/error Boxes with bounded recovery.
- Prevent overlapping sweeps.

**Acceptance checks**

- [ ] Live worker is never stopped.
- [ ] Fresh wake intent is never stopped.
- [ ] Idle grace is measured from current run/runner activity.
- [ ] One row's API failure does not abort the whole sweep.
- [ ] Missing Box does not clear SDK session state until filesystem loss is
  established.
- [ ] Sweep is idempotent and cannot overlap itself.

---

### B019 — Make cancellation preserve the Box checkpoint

**Can start:** after B014  
**Depends on:** B014  
**Parallel with:** B016–B018, B021

Implement provider-aware hard-stop semantics for Box.

**Work**

- Keep existing SSE cancellation as the primary path.
- Make `BoxRunnerProvider.stop(handle)` request Box stop/checkpoint.
- Release the claim only when ownership still matches the Box.
- Do not delete the Box on cancellation.
- Preserve worker logs and snapshot metadata.

**Acceptance checks**

- [ ] Responsive worker cancellation still follows existing acknowledgment.
- [ ] Unresponsive worker fallback stops the Box.
- [ ] Cancellation never calls `remove()`.
- [ ] Cancelled run retains a resumable/inspectable checkpoint until retention.
- [ ] A stale cancel cannot stop a replacement Box.

---

### B020 — Add safe Box retention and orphan cleanup

**Can start:** after B018  
**Depends on:** B018  
**Parallel with:** B021, B024

Implement deletion as a distinct retention operation. Do not mix it into normal
checkpointing.

**Work**

- Delete mapped archived Boxes only after configured retention and run policy
  permit it.
- Delete `box_source_id` only after the replacement Box has completed a
  checkpoint.
- Find account-level orphan Boxes by strict orchestrator naming convention.
- Require absence from all current/source mappings and a safety age.
- Stop an active orphan before deleting it.

**Acceptance checks**

- [ ] Normal idle stop never deletes.
- [ ] Unmapped arbitrary Box names are never touched.
- [ ] Current and rollback source Boxes are protected.
- [ ] Deletion clears Box/snapshot/session metadata consistently.
- [ ] Repeated cleanup is idempotent.
- [ ] Dry-run inventory shows intended deletion before destructive mode.

---

### B021 — Extend runner inventory, telemetry, and metrics for Box

**Can start:** after B007 and B008  
**Depends on:** B007, B008  
**Parallel with:** B018–B020

Make Box resources visible without adding lifecycle behavior.

**Likely files**

- `lib/runner/inventory.ts`
- `lib/runner/telemetry.ts`
- `app/api/metrics/route.ts`
- `cli.ts`
- runner UI/API types if necessary

**Display**

- Box ID and normalized/actual state
- template/version
- latest checkpoint age/status
- current/source relation
- estimated active duration where available
- last redacted provider error

**Acceptance checks**

- [ ] `npm run task -- runners --json` includes Box rows.
- [ ] Human output distinguishes Box IDs from Fly machine/volume IDs.
- [ ] Secret URLs and API data are redacted.
- [ ] Metrics label provider as `box`.
- [ ] Existing Fly inventory output remains compatible.

---

## Track E — templates, tests, and rollout

### B022 — Add fake-client end-to-end provider tests

**Can start:** after B012–B021 relevant paths are complete  
**Depends on:** B012, B013, B014, B015, B017, B018, B019  
**Parallel with:** B024

Add scenario tests that drive the real dispatch/provider code with an in-memory
fake Box client and test database.

**Scenarios**

1. Initial template fork to worker launch.
2. Claim race after a successful fork.
3. Worker release to verified checkpoint.
4. Later message to resume and relaunch.
5. Snapshot failure and retry.
6. Capacity defer and pending-pump retry.
7. Cancellation fallback.
8. Missing Box recovery.
9. Credential-refresh fork with rollback source.
10. Control-plane restart followed by sweep reconciliation.

**Acceptance checks**

- [ ] Tests assert every fork is no-env.
- [ ] Tests assert forbidden env keys are absent.
- [ ] Tests use fake time and no real network.
- [ ] Every scenario asserts final DB mapping and run status.
- [ ] Existing full test suite remains green.

---

### B023 — Create a repeatable live Box acceptance script

**Can start:** after B001 and B022  
**Depends on:** B001, B022  
**Parallel with:** B024, B025

Turn the feasibility spike into a gated operational acceptance test.

**Suggested command**

```bash
BOX_LIVE_TEST=1 npm run test:box-live
```

The script must use a unique prefix, track every created Box, and clean up in a
`finally` block. It must be skipped by default in CI.

**Acceptance checks**

- [ ] Verifies fork, worker launch, stop, snapshot, resume, and relaunch.
- [ ] Verifies repository and agent-session persistence.
- [ ] Verifies the worker cannot access another run through its token.
- [ ] Verifies credential-refresh fork preserves files.
- [ ] Cleans up after both success and injected failure.
- [ ] Never prints API keys, worker tokens, or private URLs.

---

### B024 — Add template validation and publication CLI commands

**Can start:** after B011 and B014  
**Depends on:** B011, B014  
**Parallel with:** B020, B022, B023

Add operator tooling without changing automatic run provisioning.

**Commands**

```bash
npm run task -- box template validate bx_...
npm run task -- box template publish bx_...
```

`validate` is read-only. `publish` may resume, run setup/warm commands, stop,
and verify the final snapshot.

**Validation checks**

- expected manifest and protocol
- worker executable and Node runtime
- expected repository path and origin
- clean repository status
- absence of known secret files
- no active worker process
- completed latest snapshot for a published template

**Acceptance checks**

- [ ] Validate never modifies the Box.
- [ ] Publish requires explicit confirmation or `--yes`.
- [ ] Publish stops and verifies a completed snapshot.
- [ ] Failure leaves the template recoverable and prints the Box request ID.
- [ ] Output contains no secrets.

---

### B025 — Document configuration, operations, and rollback

**Can start:** after provider configuration and lifecycle stabilize  
**Depends on:** B003, B014, B015, B017, B020, B024  
**Parallel with:** B023

Update operator-facing documentation and examples.

**Likely files**

- `.env.example`
- `.env.docker.example` if shared runner settings are documented there
- `README.md`
- new `docs/box-deployment.md`
- `docs/worker-http-api.md`

**Required content**

- Box API-key setup and storage
- mandatory no-env rule
- template creation/update
- Box worker configuration
- snapshot/checkpoint semantics
- capacity and cost behavior
- credential rotation
- inventory and cleanup
- troubleshooting
- switching back to Fly/local

**Acceptance checks**

- [ ] Documentation never suggests putting `BOX_API_KEY` inside a Box.
- [ ] Documentation explains that snapshots are automatic/finalized on stop.
- [ ] Every new env key is documented once in the canonical registry section.
- [ ] Rollback requires only provider/config changes, not schema rollback.
- [ ] Examples use placeholders and redact secret URLs.

---

### B026 — Run a staged production rollout

**Can start:** after B022–B025  
**Depends on:** B022, B023, B024, B025  
**Parallel with:** none

This is an operational task, not a code bundle.

**Steps**

1. Publish a staging template.
2. Enable Box with application cap `1`.
3. Run one implementation task through PR creation.
4. Stop/resume it with an uncommitted-file fixture.
5. Restart the control plane while the Box is active.
6. Exercise cancellation and snapshot retry.
7. Rotate credentials through replacement fork.
8. Raise concurrency gradually.
9. Compare Box and Fly latency/cost/error metrics.
10. Enable selected production repositories or users.

**Acceptance checks**

- [ ] At least one real task opens a PR from Box.
- [ ] A resumed task preserves uncommitted state and agent session continuity.
- [ ] Control-plane restart reconciles without duplicate Boxes.
- [ ] Capacity queues rather than failing work.
- [ ] Cancellation stops billing and preserves a snapshot.
- [ ] Fly remains a tested rollback until Box completes a retention cycle.

---

## Optional post-MVP tasks

### B027 — Distribute versioned worker bundles at resume time

**Depends on:** stable MVP and worker protocol  
**Purpose:** let historical run snapshots execute a newer compatible worker
without rebuilding each Box manually.

Create a run-scoped authenticated release endpoint and a stable Box bootstrap
that downloads, verifies, caches, and launches a bundle identified by build
SHA. Do not expose provider credentials in URLs.

**Acceptance checks**

- [ ] Bundle is authenticated and integrity-checked.
- [ ] Compatible cached bundle avoids a download.
- [ ] Failed upgrade leaves the prior bundle usable.
- [ ] Protocol-major mismatch stops before a turn starts.

---

### B028 — Add private preview lifecycle

**Depends on:** stable checkpoint/resume  
**Purpose:** expose a run's dev server using `host <port> --private`.

Store only an encrypted/redacted reference to the token-bearing URL. Relaunch
the dev server and hosting command after resume. Keep production traffic off the
Box.

**Acceptance checks**

- [ ] Preview URL is never logged unredacted.
- [ ] Same port resumes to the same URL/token when Box supports it.
- [ ] Preview liveness does not block cost-control stop unless explicitly pinned.

---

### B029 — Add desktop streaming access

**Depends on:** stable Box identity and authorization policy  
**Purpose:** allow authorized operators to inspect a live run.

Use `desktop()`/`waitForDesktop()` and proxy authorization through the Task
Orchestrator UI. Treat desktop URLs as short-lived secrets.

**Acceptance checks**

- [ ] Only authorized users can request a desktop URL.
- [ ] URL is not stored or logged unredacted.
- [ ] Provisioning is polled rather than exposed as an error.
- [ ] Archived Box offers resume before desktop access.

---

## Recommended execution batches

These batches maximize parallel work while keeping pull requests small.

### Batch 1 — no runtime behavior

- B001 feasibility spike
- B002 provider types
- B003 configuration
- B007 schema
- B010 repository path override

### Batch 2 — isolated primitives

- B004 client boundary
- B005 error classification
- B006 waiters
- B008 provider skeleton
- B009 environment builder
- B011 template manifest

### Batch 3 — provisioning lifecycle

- B012 initial fork
- B014 checkpoint
- B017 admission

### Batch 4 — worker continuity

- B013 worker launch
- B015 resume
- B016 credential refresh

### Batch 5 — operations

- B018 reconciliation
- B019 cancellation
- B020 cleanup
- B021 inventory/telemetry

### Batch 6 — confidence and rollout

- B022 fake end-to-end tests
- B023 live acceptance test
- B024 template CLI
- B025 documentation
- B026 staging rollout

## MVP completion gate

The Box provider is MVP-complete only when all of the following are true:

- B001 through B026 are complete, excluding explicitly optional B027–B029.
- Every user/run Box is created or forked with `noEnv: true`.
- A worker receives neither `BOX_API_KEY` nor `DATABASE_URL`.
- A task run can fork, execute, checkpoint, resume, and continue.
- A completed checkpoint is verified against a new Box snapshot.
- Capacity and rate limits defer work instead of losing it.
- Cancellation preserves a stopped snapshot.
- Cleanup cannot delete non-orchestrator Boxes.
- Local, Docker, and Fly test suites remain green.
