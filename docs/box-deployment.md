# Operating Box managed runners

Box is an optional remote runner provider. Task Orchestrator remains the
control plane: it owns the database, scheduling, worker tokens, agent backend,
and task state. A Box supplies one run's machine and its persistent filesystem
snapshot.

This guide is for operators. The worker protocol is WebSocket-only
([worker-websocket-protocol.md](worker-websocket-protocol.md)); the control
plane dials each worker's private listener. **Box has no private
control-plane-to-worker ingress, so Box dispatch is currently rejected with an
unsupported-provider error until its ingress section lands** — this guide
describes the intended Box operation once that ships.

## Configuration registry

The canonical list of Box environment keys, defaults, and short descriptions
is the **Box managed runners** section of [`.env.example`](../.env.example).
Set those values on the control-plane deployment, then select Box with:

```text
TASK_ORCH_RUNNER=box
```

`BOX_API_KEY` is an account-level control-plane credential. Store it only in
the control plane's secret manager. Do not add it to a template Box, a fork
environment, a repository, shell profile, worker log, or agent prompt. The
provider forks with `noEnv: true`, so account/dashboard environment and secret
files are never inherited by a run.

Each fork receives only the run-scoped worker environment: the worker API URL,
a run-scoped channel identity + credential, run and repository identifiers,
selected model and Git credentials, and the repository/session paths it needs.
In particular, workers receive neither `BOX_API_KEY` nor `DATABASE_URL`, and
make no outbound control-plane request.

The channel credential is derived from `TASK_ORCH_WORKER_CHANNEL_SECRET`,
falling back to `AUTH_SECRET`; configure one of them before enabling Box.

## Template lifecycle

Use one stopped, validated template Box for the selected repository. It should
contain the compatible Node runtime, the bundled worker executable, installed
dependencies, the repository at `TASK_ORCH_BOX_REPO_PATH`, and the template
manifest/version. It must not contain account keys, user credentials, active
agent processes, or uncommitted template-maintenance changes.

To publish a template update:

1. Start from the current stopped template or build a fresh disposable Box.
2. Update the worker runtime, dependencies, repository checkout, and manifest.
3. Validate the worker executable, manifest/protocol, repository path and
   origin, clean status, lack of known secret files, and absence of active
   workers.
4. Stop it and verify a completed snapshot before recording its Box ID and
   version in the control-plane configuration.
5. Keep the previous stopped template until a replacement has succeeded in
   staging.

Changing `TASK_ORCH_BOX_TEMPLATE_ID` affects new runs. Existing runs continue
from their own archived Box, preserving uncommitted work and agent session
state.

### App-managed templates

Leave `TASK_ORCH_BOX_TEMPLATE_ID` unset (the default) and the app builds a
template itself instead of requiring a hand-published one. On the first
dispatch for a given worker build SHA, `ensureTemplate()` creates a fresh
blank box and runs it through the build steps in order — `cloning-worker`,
`installing-deps`, `building-worker`, `cloning-agent-repo`,
`installing-agent-deps`, `writing-manifest`, `archiving` — recording progress
in the `environments` registry table (rows with `provider = 'box'`, also
surfaced at `/api/metrics` as `task_orch_environments`). The build takes
roughly 10–15 minutes; the triggering run is deferred with live stepper
feedback in the run view while it completes, and any other run dispatched
against the same SHA in the meantime is deferred behind the same build.
`BOX_API_KEY` alone is enough — there is no base box to provision up front.
Once a template is `ready`, run boxes fork from it directly.

The `/environments` page lists every provider's execution artifact (docker
image, fly runner image, box template snapshots) versioned by worker SHA, and
can kick a box template build in-app without waiting for a run to trigger it.
The `environments` table replaced `box_templates` in migration 0021.

Set `TASK_ORCH_WORKER_SHA` on git-less control-plane deployments where `git
rev-parse HEAD` is unavailable — otherwise the SHA is read from the server
checkout automatically. A failed build is recorded as `failed`; the next
dispatch against that SHA retries the build on the normal pump cadence.

Pinning `TASK_ORCH_BOX_TEMPLATE_ID` disables app-managed builds entirely and
reverts to the manual publish flow described above.

## Run and snapshot lifecycle

For a first turn, the control plane forks the stopped template with
`noEnv: true` and the explicit per-run environment. It waits for `ready` or `idle`,
starts the Task Orchestrator worker as a detached process, and records the Box
mapping before the readiness wait completes.

Box takes automatic snapshots while a Box runs. A durable Task Orchestrator
checkpoint is finalized by stopping the Box: the provider accepts the stop only
after the Box is `archived`, reports `lastSnapshotStatus=completed`, has a
snapshot completion time at or after the checkpoint request, and exposes a
latest snapshot. Stopping pauses compute billing while retaining the
filesystem. Do not treat a prior snapshot as proof that the latest turn was
saved.

A later turn resumes the run's archived Box instead of reforking the template.
That is what preserves its checkout, unpushed changes, caches, and agent
transcript. A failed final snapshot leaves the Box active for retry; it must
not be deleted as part of ordinary checkpointing or cancellation.

## Capacity and cost controls

Before provisioning, the provider checks Box account limits. Temporary account
capacity, provider capacity, and rate limiting defer a run to `pending`; the
normal pending pump retries it and still enforces its maximum wait policy.
Authentication, billing, and required account setup fail with an actionable
configuration error rather than a generic spawn failure.

`TASK_ORCH_BOX_MAX_ACTIVE` is an optional application cap. Set it lower than
the account limit to stage safely—for example, set it to `1` for the first
production exercise. `0` adds no application cap and uses the account limit.
The dispatcher serializes admission and run claims in one control-plane process
so concurrent dispatches cannot oversubscribe the selected cap.

Use `TASK_ORCH_BOX_IDLE_STOP_MS` to balance quick follow-up turns against idle
compute cost. Stopped Boxes retain snapshots; `TASK_ORCH_BOX_RETENTION_MS`
controls when archived, unmapped-or-expired run Boxes become eligible for
retention cleanup. Cleanup is distinct from normal stop/checkpoint behavior.

## Credential rotation and inventory

Worker tokens can expire while a Box is archived. When worker credentials or
immutable per-Box configuration rotate, the control plane verifies the current
checkpoint, forks the archived run Box with `noEnv: true` and replacement
environment, and keeps the original Box as rollback protection. The old Box is
deleted only after the replacement completes a verified checkpoint.

Regularly review Box inventory alongside `runner_instances`:

- A mapped active Box should have a current run claim or a recent wake intent.
- A mapped archived Box should have a completed latest snapshot before it is
  considered resumable.
- An account Box with no mapping is an orphan candidate; inspect its owner,
  age, state, and latest snapshot before retention cleanup.
- Never remove a Box merely because a worker failed. Preserve it until its
  checkpoint/retention policy has been evaluated.

## Troubleshooting

| Symptom | Check and response |
| --- | --- |
| Run remains `pending` | Check account capacity, `TASK_ORCH_BOX_MAX_ACTIVE`, and rate-limit telemetry. Pending capacity retries are expected; do not manually fork another Box. |
| Immediate authentication/billing failure | Verify the control-plane `BOX_API_KEY` and Box account setup. Do not copy the key into a Box to diagnose it. |
| Fork never becomes ready | Check the template ID/version, Box state, worker-compatible manifest, and `TASK_ORCH_BOX_READY_TIMEOUT_MS`. Keep the recorded Box for diagnosis; stop it if safe rather than deleting it. |
| Control plane cannot reach the worker | Verify the Box exposes its private WebSocket listener on the control-plane-dialable endpoint and the channel-signing secret is set. The worker never opens outbound connections and never touches the database directly. |
| Stop does not checkpoint | Inspect `lastSnapshotStatus`, `snapshotCompletedAt`, and the latest snapshot. A stale or failed snapshot is not a completed checkpoint; leave the Box available for retry. |
| Resume fails after a long pause | Check token expiry/rotation. The recovery path is a replacement fork of the archived run Box with fresh explicit environment, not a new template fork. |
| Unexpected active cost | Check for an active worker claim or wake intent, then the idle-stop grace. Do not delete a Box that may contain uncheckpointed work. |

Do not paste Box response URLs, bearer tokens, or raw API errors into tickets
or logs; redact them first.

## Rollback to Fly or local

Rollback changes provider configuration only; it does **not** require a schema
rollback. Stop scheduling new Box work, retain current archived Boxes until
their retention policy permits cleanup, then select either:

```text
TASK_ORCH_RUNNER=fly    # Fly runners (with the existing Fly configuration)
# or
TASK_ORCH_RUNNER=local  # local/Docker runner path
```

Leave Box-specific database columns and historical mappings in place for audit
and possible recovery. New runs use the selected provider; do not point a
local or Fly run at a Box filesystem. Re-enable Box only after its template,
capacity settings, worker reachability, and checkpoint behavior have been
verified in staging.
