# Box runner integration — design

**Date:** 2026-07-14  
**Status:** proposed  
**Scope:** use [Box](https://docs.ascii.dev/box/platform-guide) as a managed runner and filesystem-snapshot service for Task Orchestrator

## Summary

Add Box as a third managed runner provider beside the existing local/Docker and
Fly implementations. Task Orchestrator remains the control plane and continues
to run its own `scripts/run-worker.ts` inside the remote machine. Box supplies
the machine, persistent filesystem, stop/resume lifecycle, and snapshots; it
does not replace the orchestrator's agent backend, worker protocol, database,
or task state machine.

The core lifecycle is:

1. Prepare and stop a clean template Box containing the worker runtime and the
   already-selected repository.
2. Fork that template with `noEnv: true` and explicit run-scoped environment.
3. Wait until the fork is `ready` or `idle`.
4. Start the existing Task Orchestrator worker as a detached process.
5. Let the worker communicate with the control plane through `/api/worker/*`.
6. After the worker releases its claim, stop the Box. Stopping produces the
   final filesystem snapshot and pauses billing.
7. On a later turn, resume the archived Box, relaunch the worker, and continue
   from the restored repository and agent session files.

No Docker daemon or Docker image is needed for this provider.

## Goals

- Run normal Task Orchestrator agent runs inside Box machines.
- Preserve uncommitted files, Git state, installed packages, caches, and agent
  session data across turns.
- Use Box stop/resume snapshots instead of Docker volumes or Fly volumes.
- Reuse the existing worker HTTP/SSE protocol so remote workers never receive
  `DATABASE_URL`.
- Keep the Box account API key in the control plane only.
- Create every user/run Box with `noEnv: true`.
- Support capacity admission, cancellation, reconciliation, retention, and
  useful provider telemetry.
- Keep local, Docker, and Fly behavior unchanged.

## Non-goals

- Using `POST /boxes/{id}/prompt` as Task Orchestrator's agent engine.
- Moving the Task Orchestrator database or web application into Box.
- Running Docker inside a Box.
- Replacing the existing Pi or Claude agent backends.
- Shipping preview hosting or desktop streaming in the first milestone.
- Supporting several selected repositories in one run in the first milestone.
- Downloading and reconstructing snapshots during normal resume operations.

## Existing architecture to preserve

The existing system already has the right remote-worker boundary:

```text
scripts/run-worker.ts
        │
        ▼
lib/runs.ts
        │
        ▼
runTransport()
        │ HTTP + SSE
        ▼
/api/worker/*
        │
        ▼
Task Orchestrator DB and server-side tools
```

A Box worker must use this path. It receives a run-scoped worker token and
never receives database credentials. Agent events, heartbeats, cancellation,
task transitions, plan tools, and child-run dispatch therefore continue to use
the same implementation as Docker and Fly workers.

Box is a `RunnerProvider`, not an `AgentBackend`:

```text
Task Orchestrator control plane
        │
        ├── LocalRunnerProvider
        ├── FlyRunnerProvider
        └── BoxRunnerProvider
                 │
                 └── @asciidev/box-sdk
```

## Primary design decisions

### 1. One Box per run

Each remotely placed run has at most one current Box. A Box contains that run's
checkout and agent session state. Runs do not share a writable Box.

This matches the current `runner_instances` one-row-per-run model, avoids
cross-run filesystem contamination, and makes a Box snapshot an unambiguous
checkpoint for one run.

### 2. Fork a template for the first turn

A new run forks a stopped template instead of provisioning a blank Box. The
template contains:

- a compatible Task Orchestrator worker runtime;
- installed Node dependencies;
- the selected target repository under `/home/user/<repository-name>`;
- any safe, non-secret build caches;
- a template version marker.

The template is never used directly for user work. It stays stopped except
while an operator publishes a new template version.

### 3. Resume the run Box for later turns

Once a run has a successfully archived Box, subsequent turns resume that Box.
This preserves work that may not yet exist on GitHub, including uncommitted
files and agent session transcripts.

Forking the original template again on every turn is incorrect because it would
discard run-local state. Forking the archived run Box is reserved for credential
rotation or recovery where replacement per-Box environment is required.

### 4. Stop is the checkpoint operation

Box automatically takes periodic snapshots, but there is no documented
"snapshot now" endpoint. `POST /boxes/{boxId}/stop` takes the final snapshot and
archives the Box. Therefore a durable checkpoint is complete only after:

- `GET /boxes/{boxId}` reports `state === "archived"`;
- `lastSnapshotStatus === "completed"`;
- `snapshotCompletedAt` is at least as new as the checkpoint request; and
- `getLatestBoxSnapshot()` returns a snapshot.

If the final snapshot fails, Box aborts the stop and leaves the machine running.
The provider must record the failure and retry; it must not delete the Box or
claim that the run is safely archived.

The Box ID is the normal restoration handle. The latest snapshot ID is stored
for diagnostics, browsing, and auditing, not as a prerequisite for `resume()`.

### 5. Stop promptly after a turn

A stopped Box retains its snapshot without compute billing. Once a worker has
released its live claim, the provider waits a short configurable grace period
and stops the Box. A default around 30 seconds avoids stop/resume churn from a
small burst of related events while still controlling cost.

Unlike Fly, Box does not need a separate suspend-then-stop-then-destroy sequence.
Archival is the normal idle state. Deletion is a separate retention decision.

### 6. Start the existing worker, not a Box agent prompt

The Box command endpoint has a maximum timeout of 60 seconds. It cannot host a
whole agent turn synchronously. The provider issues a short command that starts
the worker detached and returns its PID:

```bash
mkdir -p "$SESSION_ROOT/logs"
nohup node /home/user/task-orchestrator/dist/run-worker.js "$TASK_ORCH_RUN_ID" \
  >>"$SESSION_ROOT/logs/runner.log" 2>&1 </dev/null &
echo $!
```

No secret appears in the command. The process inherits per-Box environment.
This behavior must be proven against a real Box before implementation proceeds.
If Box command execution does not reliably leave detached processes running, a
generic systemd launcher will be installed in the template instead.

## Security model

### Account credentials

`BOX_API_KEY` is a control-plane credential. It is read only by
`BoxRunnerProvider` and is never sent to a worker.

Every initial fork uses both:

```ts
{
  noEnv: true,
  env: runEnvironment,
}
```

`noEnv: true` is mandatory, not configurable. It prevents dashboard secrets,
secret files, SSH identity, GitHub credentials, and model credentials belonging
to the Box account from leaking into user-run machines.

### Explicit per-run environment

Only values needed by that run are passed explicitly. Expected values include:

```text
TASK_ORCH_INSIDE_WORKER=1
TASK_ORCH_WORKER_API_URL=<control-plane URL>
TASK_ORCH_WORKER_TOKEN=<run-scoped token>
TASK_ORCH_RUN_ID=<run id>
TASK_ORCH_REPO_ID=<repository id>
TASK_ORCH_INSTANCE_ID=<deployment id>
TASK_ORCH_NESTED_DISPATCH=isolate
TASK_ORCH_RUNNER_REPO_PATH=/home/user/<repository-name>
TASK_ORCH_TEMPLATE_VERSION=<version>
SESSION_ROOT=/home/user/.task-orchestrator/session
GH_TOKEN=<GitHub credential when required>
<selected model-provider credentials>
```

The worker environment must not contain:

- `BOX_API_KEY`;
- `DATABASE_URL`;
- unrelated dashboard secrets;
- credentials for other tenants or runs.

Environment size must remain within Box's limit of 100 variables and 64 KB.

### Tokens and rotation

The current worker token defaults to a seven-day lifetime. A Box may be resumed
months later, while the documented Box resume API does not replace per-Box
`env`. The runner mapping therefore records a credential generation and token
expiry.

When the stored credentials are still valid, resume the same Box. When they are
expired or have been rotated:

1. Verify that the current run Box is archived with a completed snapshot.
2. Fork the archived run Box with `noEnv: true` and replacement `env`.
3. Wait until the replacement is ready.
4. Atomically make the replacement the current Box.
5. Keep the old Box as rollback protection until the replacement has completed
   one successful checkpoint.
6. Delete the old Box after that checkpoint.

This changes credentials without losing the filesystem. The same mechanism can
upgrade immutable per-Box configuration.

### Logging and redaction

The provider must never log:

- Box API keys;
- worker bearer tokens;
- provider credentials;
- desktop URLs or preview URLs containing `_token`;
- command payloads containing secrets.

Structured Box API errors may be logged after redaction, including HTTP status,
stable error code, and `requestId`.

## Provider contract

`RunnerProviderKind` and `RunnerRef.provider` become:

```ts
type RunnerProviderKind = "local" | "fly" | "box";
```

The existing provider contract can support basic Box creation and stopping, but
capacity should be made provider-owned:

```ts
interface RunnerProvider {
  readonly kind: RunnerProviderKind;
  admit(runId: number): Promise<"admit" | "defer" | "never-fits">;
  create(input: CreateRunnerInput): Promise<RunnerRef | null>;
  stop(handle: string): Promise<void>;
  sweep(): Promise<void>;
  startMonitor(): void;
}
```

Local and Fly adapters retain their current behavior behind `admit()`. Box uses
`box.limits()` and provider errors:

- `canStart === false`: defer when temporary, fail when account setup or billing
  makes progress impossible;
- active Box cap reached: defer;
- HTTP 429: defer with jitter;
- HTTP 402: fail with an actionable billing message;
- transient 5xx: retry idempotent reads, then defer;
- invalid template or authentication: fail configuration immediately.

A provider-specific capacity condition must not become a generic
`spawn-failed` run.

## Configuration

Add lazy configuration accessors in `lib/config.ts`:

```text
TASK_ORCH_RUNNER=box
BOX_API_KEY=<secret>
TASK_ORCH_BOX_BASE_URL=https://ascii.dev/api/box/v1
TASK_ORCH_BOX_TEMPLATE_ID=bx_...
TASK_ORCH_BOX_TEMPLATE_VERSION=<worker/template version>
TASK_ORCH_BOX_REPO_PATH=/home/user/<repository-name>
TASK_ORCH_BOX_IDLE_STOP_MS=30000
TASK_ORCH_BOX_POLL_MS=5000
TASK_ORCH_BOX_READY_TIMEOUT_MS=120000
TASK_ORCH_BOX_RETENTION_MS=2592000000
TASK_ORCH_BOX_MAX_ACTIVE=0
```

`TASK_ORCH_BOX_MAX_ACTIVE=0` means use the account limit without an additional
application cap. All configuration is validated before the first fork.

## Persistence model

Add Box-specific columns to `runner_instances` while retaining existing Fly
columns:

```text
box_id                    current Box id
box_template_id           initial template Box id
box_source_id             prior archived Box during replacement fork
snapshot_id               latest verified completed snapshot id
snapshot_completed_at     completion time reported by Box
checkpoint_requested_at   start of the current stop/checkpoint attempt
last_checkpoint_at        last fully verified checkpoint
credentials_version       per-Box credential generation
credentials_expires_at    worker credential expiry
worker_version            worker build/protocol version
last_provider_error       latest redacted lifecycle error
```

Do not overload `machine_id` with a Box ID. Explicit fields keep Fly inventory
and cleanup safe during migration.

`runner_instances.state` remains a normalized state:

```text
creating | starting | running | suspended | stopped | gone
```

Box maps to it as follows:

| Box state | Normalized state |
|---|---|
| `init`, `provisioning`, `provisioned`, `cloning` | `starting` |
| `ready`, `idle`, `running` | `running` |
| `archiving` | `starting` until a dedicated `stopping` state is introduced |
| `archived` | `stopped` |
| `error` | recover first; `gone` only when unrecoverable |
| missing/deleted | `gone` |

Box's `idle` and `running` states reflect work submitted through Box's own
prompt API, not the custom process. The orchestrator heartbeat remains the
source of truth for worker liveness.

## Provisioning sequence

For a run without a current Box:

1. Acquire the existing dispatch claim.
2. Validate Box configuration and call `limits()`.
3. Fork `TASK_ORCH_BOX_TEMPLATE_ID` with `noEnv: true` and explicit `env`.
4. Immediately persist the returned new Box ID and `state=starting`.
5. Give it an orchestrator-owned name such as
   `task-orch-run-<runId>-<nonce>`.
6. Poll until `ready` or `idle`; fail on `error` or timeout.
7. Validate the template version marker and repository path.
8. Run the detached worker bootstrap command.
9. Replace the temporary `worker_scope` claim with the Box ID only if this
   dispatch still owns the claim.
10. Emit `runner_box_ready` and `runner_spawned` events.

If provisioning fails after the fork, stop the Box to preserve diagnostics and
mark it for cleanup. Do not leave an unreferenced active Box billing forever.

## Repository handling

Box-selected repositories are cloned under `/home/user` using the repository
name. Add a provider-neutral override:

```text
TASK_ORCH_RUNNER_REPO_PATH=/home/user/<repository-name>
```

`lib/runs.ts` should prefer this path over `$SESSION_ROOT/repo`. Checkout
preparation must:

1. verify the path is a valid Git checkout;
2. verify or repair the `origin` URL;
3. fetch the remote;
4. check out the task's canonical branch for a new run;
5. preserve local changes and the current branch on resume;
6. avoid recloning when the Box already contains a usable checkout.

A resumed run must never hard-reset its repository to the remote branch merely
because the machine restarted. The filesystem snapshot, not GitHub, is the
source of truth for uncommitted run state.

For the first milestone each template declares one repository path. Supporting
multiple target repositories can later derive the path from the resolved remote
and validate it against a template manifest.

## Agent-session persistence

Snapshot coverage includes `/home/user`, so the Box preserves:

- `.pi/sessions` data under the checkout;
- Claude configuration and transcripts under the Box user's home;
- Git metadata and uncommitted changes;
- package installations and caches;
- worker diagnostic logs.

`agent_sessions.sdk_session_id` can therefore remain valid across stop/resume or
a fork of the archived run Box. It is cleared only when the Box and all usable
snapshots are known to be gone, not merely because a process exited.

## Checkpoint and resume

### Checkpoint

When no live worker claim remains and the idle grace period has elapsed:

1. Write `checkpoint_requested_at` before calling Box.
2. Call `box.stop({ boxId })`.
3. Poll `get()` while state is `archiving`.
4. Confirm `archived` and a new completed snapshot.
5. Read `getLatestBoxSnapshot()`.
6. Persist the snapshot ID, completion timestamp, and `last_checkpoint_at`.
7. Set normalized state to `stopped`.
8. Emit `runner_checkpoint_completed`.

Repeated stop/checkpoint attempts are idempotent. A failed final snapshot leaves
the Box active and schedules another attempt with backoff.

### Resume

For a run with a stopped Box and current credentials:

1. Write a wake intent before the API call.
2. Call `box.resume({ boxId, resumeRequest: { noEnv: true } })`.
3. Poll until `ready` or `idle`.
4. Relaunch the worker; hand-run processes do not survive stop/resume.
5. Let the worker's first heartbeat clear the wake intent.

The existing wake-intent protection must apply to Box so a lifecycle sweep does
not stop a Box between readiness and the worker's first heartbeat.

## Cancellation

Normal cancellation continues through the worker control SSE channel. The
worker aborts, acknowledges cancellation, and releases its claim.

If the worker is unresponsive, `BoxRunnerProvider.stop(handle)` calls Box stop,
not delete. This terminates the process, takes a final snapshot, and pauses
billing while preserving forensic state. Deletion occurs only through explicit
retention cleanup or operator action.

## Reconciliation and cleanup

`BoxRunnerProvider.sweep()` reconciles database mappings with `box.boxes()` and
`box.get()`:

- provisioning Box with a fresh wake intent: leave alone;
- ready Box with a live claim: leave alone;
- ready Box without a live claim past the grace period: checkpoint and stop;
- archived Box mapped as running: mark stopped and verify its snapshot;
- archived Box with a newly dispatchable run: dispatch will resume it;
- error Box: record the error and attempt bounded recovery;
- missing Box: mark gone and clear session resume state only if no replacement
  or snapshot remains;
- stale archiving Box: inspect snapshot attempt status and retry/report;
- Box created by this deployment but absent from the DB: stop first, then delete
  after a safety window.

Orphan cleanup must require both an orchestrator-owned naming convention and
absence from `runner_instances`. It must never delete arbitrary account Boxes.

Recommended events:

```text
runner_box_forking
runner_box_ready
runner_box_resumed
runner_box_rotated
runner_checkpoint_requested
runner_checkpoint_completed
runner_checkpoint_failed
runner_box_deleted
runner_failed
```

## Template publication

The existing repository Box can become the first template after it is made
clean and versioned. Store a manifest at:

```text
/home/user/.task-orchestrator/template.json
```

Example:

```json
{
  "workerBuildSha": "<git sha>",
  "workerProtocolVersion": 1,
  "repository": "owner/repo",
  "repositoryPath": "/home/user/repo"
}
```

Publication procedure:

1. Resume the template in no-env mode.
2. Update and build the Task Orchestrator worker runtime.
3. Install dependencies and verify the target repository.
4. Remove logs, temporary tokens, user branches, and secret files.
5. Require a clean target-repository worktree.
6. Run the normal startup path once to warm Box's read-order prefetching.
7. Stop the template.
8. Verify the completed snapshot.
9. Record the template ID and manifest version in deployment configuration.

A later CLI should automate validation and publication, but manual publication
is acceptable for the first milestone.

## Worker-version strategy

A snapshot can outlive the control-plane deployment that created it. The worker
HTTP protocol already rejects incompatible major versions, but a stale worker
still needs an upgrade path.

Milestone one requires operators to update the template before deploying an
incompatible control plane. Existing archived run Boxes keep their worker
runtime and can resume while the protocol remains compatible.

A later improvement should publish a versioned worker bundle from the control
plane. A stable bootstrap in the Box would download the expected bundle over a
run-scoped authenticated endpoint, cache it in the snapshot, and launch it.
That removes the need to rebuild every historical run Box during worker-only
upgrades.

## Preview and desktop support

These are follow-up capabilities, not prerequisites for worker execution.

- A dev server can bind `0.0.0.0` and use `host <port> --private`.
- Hosting the same port after resume returns the same private URL/token.
- Preview URLs must be treated as secrets.
- Desktop streaming can use `box.desktop()` and must also redact returned URLs.
- Production preview traffic should eventually be published to a static host or
  CDN rather than keeping the Box running continuously.

## Failure handling

| Failure | Required behavior |
|---|---|
| Box auth/config invalid | Fail fast with a configuration error. |
| Account capacity reached | Defer the run; retry through the pending pump. |
| Fork rate limited | Defer with jitter; do not fail the run. |
| Fork succeeds, DB write fails | Reconcile by orchestrator-owned Box name; stop the orphan. |
| Readiness timeout | Stop the Box, retain diagnostics, and retry/fail explicitly. |
| Worker bootstrap fails | Capture command output, stop/checkpoint, fail the attempt. |
| Heartbeat disappears | Reconcile Box state, then relaunch or resume according to existing orphan policy. |
| Snapshot fails | Leave Box active and retry; never delete. |
| Box is missing | Clear mapping only after confirming 404; report possible filesystem loss. |
| Credentials expired | Fork archived run Box with replacement environment. |
| Worker protocol mismatch | Checkpoint, refresh worker runtime, and redispatch. |

## Testing strategy

### Unit tests

Use an injected `BoxClient` interface rather than mocking the generated SDK
directly. Cover:

- Box-state normalization;
- no-env request construction;
- environment allowlisting and redaction;
- admission decisions;
- readiness and checkpoint waiters;
- idempotent stop/resume;
- credential-refresh fork selection;
- sweep reconciliation;
- capacity and error classification;
- repository-path selection;
- configuration validation.

### Integration tests with a fake client

Exercise `dispatchRun()` through `BoxRunnerProvider` with a deterministic fake:

- initial template fork;
- worker launch;
- claim ownership race;
- checkpoint after claim release;
- resume and relaunch;
- failed snapshot retry;
- cancellation;
- orphan cleanup.

### Live Box acceptance test

A gated script using a real `BOX_API_KEY` must verify:

1. fork from the configured template;
2. mandatory no-env behavior;
3. detached worker/process survival after the command returns;
4. repository and session-marker persistence after stop/resume;
5. final snapshot verification;
6. credential-refresh fork from an archived run Box;
7. cleanup of every Box created by the test.

The live suite must not run in normal CI.

## Rollout

1. Land provider-neutral type, config, schema, and test changes with Box disabled.
2. Run the live feasibility test against a disposable template.
3. Enable `TASK_ORCH_RUNNER=box` in staging with one active Box maximum.
4. Compare dispatch latency, checkpoint latency, failure rate, and cost with Fly.
5. Exercise resume, cancellation, control-plane restart, and credential rotation.
6. Increase staging concurrency.
7. Enable production for selected repositories or users.
8. Keep Fly as an immediate rollback provider until Box has completed a full
   retention and recovery cycle.

## Success criteria

The integration is complete when:

- a new run forks a no-env template and starts the existing worker;
- no Box worker receives `BOX_API_KEY` or `DATABASE_URL`;
- events and cancellation flow through the existing worker protocol;
- uncommitted repository changes and agent session state survive stop/resume;
- a successful stop is backed by a verified completed snapshot;
- later turns resume and relaunch without recloning or resetting work;
- capacity exhaustion queues work rather than failing it;
- cancellation stops billing while preserving a checkpoint;
- orphaned provider resources are reconciled safely;
- local, Docker, and Fly behavior and tests remain intact.
