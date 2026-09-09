# Sprite warm pool and snapshot lifecycle — PRD

**Date:** 2026-09-09  
**Status:** Draft  
**Product:** Task Orchestrator  
**Related design:** [Sprites migration, Phase 5](../../sprites-migration-design.md#phase-5-implementation-requirements-snapshot-lifecycle)  
**Current behavior:** [Sprites runner](../../runners/sprites.md)

## 1. Product decision

Maintain a small, versioned pool of pre-bootstrapped Sprites. Each ready Sprite
has an immutable baseline checkpoint and is assigned to exactly one run for
that run's resumable lifetime. Assignment consumes a pool entry; the manager
refills asynchronously. A used Sprite is eventually destroyed, never recycled
to another run.

For frequently used repositories, the baseline includes verified project
dependencies. This removes repeated dependency installation from the first
turn when the requested revision has compatible dependency inputs.

Launch with baseline checkpoints and a configurable pool, initially off.
Failure snapshots and pre-turn rollback checkpoints are separate, optional
follow-on capabilities with bounded retention.

## 2. Problem

Current Sprite bootstrap installs the worker bundle and Codex, creates a
checkpoint keyed by worker bundle SHA, and skips project checkout and
dependency installation. Finding an existing checkpoint comment skips
bootstrap; it does not restore or verify the live filesystem. The pool-size
setting exists, but the warm pool is not implemented.

Consequently, successful worker bootstrap does not mean an agent can begin
useful work without a cold project installation. Runs 206–208 were reported
as examples of that problem; their timelines are context supplied for this
PRD, not an independently measured performance baseline.

The design assumes checkpoints remain scoped to their originating Sprite.
It therefore prepares multiple independent Sprites instead of depending on
cross-Sprite checkpoint cloning. Provider behavior must be verified during
implementation before rollout.

## 3. Users and outcomes

| User | Desired outcome |
| --- | --- |
| Person starting a run | The agent begins useful work quickly without manual environment preparation. |
| Person resuming a run | Existing files, unpushed changes and conversation state survive. |
| Operator | Idle capacity, storage use, environment versions and cleanup are observable and bounded. |
| Engineer investigating failure | Useful filesystem evidence can be retained briefly without checkpointing every successful turn. |

## 4. Goals and non-goals

### Goals

- Reduce dispatch latency through ready environments and avoid dependency
  installation on compatible repository-baseline hits.
- Preserve exclusive run ownership and the existing worker-generation fence.
- Recover predictably from control-plane crashes and provider failures.
- Bound unused capacity and snapshot retention.
- Support deployments with one frequent repository and deployments with varied
  repositories without creating an unbounded pool per lockfile.

### Non-goals for the initial release

- Pre-turn snapshots, automatic filesystem rollback or automatic replay of
  externally visible operations.
- Cross-Sprite cloning, cross-run reuse of agent-modified filesystems, or a
  shared writable dependency tree between runs.
- A new runner provider, scheduler, or snapshot-browser UI.
- Automatic prediction of which repositories or branches to prewarm.
- Guaranteed latency on a pool miss or during provider outages.

## 5. Scope and release sequence

| Release | Required capability | Enablement |
| --- | --- | --- |
| A: Baseline pool | Durable allocation, generic tool baselines, safe restore, refill, ownership and cleanup | Opt-in canary; pool size defaults to 0 |
| B: Dependency baselines | Repository-specific dependency manifests, installation reuse, mismatch fallback | Opt-in per configured repository; required for the dependency-latency objective |
| C: Failure evidence | Failure-only checkpoints, expiry, restricted inspection and deletion | Separate opt-in after retention behavior is verified |
| D: Rollback points | Quiescence barrier, one or two retained checkpoints, explicit rollback semantics | Separate design and validation gate; disabled by default |

Release A alone must not be described as eliminating cold project installs.
Releases A and B together deliver the primary product objective.

## 6. User and operator experience

Starting a run uses a matching ready Sprite automatically. The run remains
in its existing preparing state while the baseline is restored and the worker
connects. Only an authenticated handshake from the current generation makes
the runner eligible to report `running`.

When no matching Sprite is available, use the existing inline bootstrap path
and show a concise reason such as “Preparing environment.” Pool replenishment
does not block the requesting run. A dependency mismatch shows “Installing
project dependencies” while the requested checkout is prepared.

Resume uses the run's existing Sprite and preserves its files. It never
silently restores a clean baseline over prior work.

Operators can inspect counts by state and fingerprint, bound run IDs, last
preparation failure, and pending deletion through existing operational
surfaces or structured logs. Run events explain whether dispatch used a pool
hit, a miss, a rejected baseline, or a dependency reinstall. Do not expose
credentials in these records.

## 7. Functional requirements

### FR-1: Versioned immutable baselines

Each baseline has a recorded checkpoint ID, a canonical manifest, and a
fingerprint of that manifest. Identity includes a manifest schema version,
worker bundle digest, exact Node and Codex versions, platform/architecture,
and system-tool recipe version.

A repository baseline additionally includes repository identity, lockfile
contents, relevant package manifests, package-manager version, install
options, and inputs consumed by installation scripts. If those script inputs
cannot be determined reliably, invalidate conservatively on source changes
or use the generic baseline.

All installation and filesystem writes must finish before checkpointing.
Temporary checkout/registry credentials must be removed from persisted files,
git configuration and service definitions before sealing the baseline.
Baselines contain no run credentials or active run worker service. Private
repository baselines must be scoped to the appropriate access boundary;
repository identity alone does not authorize allocation to another user.

An entry becomes ready only after successful preparation, validation and
checkpoint persistence. A checkpoint comment is descriptive metadata, not
proof of readiness. Updating an environment creates a replacement entry.

### FR-2: Bounded warm capacity

Keep `TASK_ORCH_SPRITE_POOL_SIZE=0` as the default. An initial operator rollout
uses a total ready target of 2–4 across all configured fingerprints, not 2–4
for each repository or lockfile. Static per-fingerprint targets must fit
inside that total. Preparing entries count toward reserved refill capacity.

The manager reserves capacity atomically across replicas, refills with bounded
concurrency and retry backoff, and allows unused Sprites to hibernate. A
claimed Sprite no longer counts toward the ready target but still counts
toward the deployment's total Sprite resource limit. The manager must honor
any configured `TASK_ORCH_MAX_SPRITES` limit and reserve no new capacity when
that limit is reached. Pool work must not starve active-run provisioning.

Lowering the target drains excess unclaimed entries. Setting it to zero stops
refill and drains unused entries while preserving assigned runs.

### FR-3: Atomic allocation and run binding

Claim a ready entry with the requested fingerprint and persist its runner
binding in one transaction. Concurrent dispatches cannot claim the same
Sprite. Retries for the same run adopt its existing binding instead of
allocating a second Sprite.

Use unique provider names and durable ownership records. Lifecycle operations
must resolve ownership from those records rather than infer run IDs from
Sprite names. This includes cancellation, inspection and orphan cleanup.

No exact match is a pool miss. Release B may deliberately select a compatible
generic tool entry and install dependencies, but must report that as a
dependency miss; it must never treat another repository's tree as a match.

### FR-4: Safe first-assignment restore

The first assignment must perform this ordered protocol under the existing
lifecycle serialization and durable operation fence:

1. Stop worker services and confirm they cannot continue writing.
2. Allocate a fresh worker generation and invalidate the previous channel.
3. Restore the recorded baseline checkpoint.
4. Verify worker digest, expected tool versions, the baseline manifest, and
   filesystem readability/writability.
5. Define the generation-scoped worker service with fresh run credentials and
   a new channel instance ID.
6. Start it and require an authenticated current-generation channel handshake.

Provider restore behavior must not restart a saved service with stale
credentials between steps. Failed restore or verification removes the entry
from eligibility and records the reason. Any replacement attempt must safely
retire the failed binding under the same fencing rules before allocation.

An ordinary worker restart or resume is not a baseline restore. Rollback of
an assigned run is outside Releases A and B.

### FR-5: Dependency reuse at the actual worker checkout

Prepare repository baselines at a stable path compatible with the worker's
checkout process. After fetching and selecting the requested revision,
validate the dependency inputs again before agent execution.

On a match, reuse the installed dependencies without an unconditional
`npm ci`. On a mismatch, run the appropriate clean installation against the
requested revision and update run-local readiness only after success. Failed
installation must not be reported as a valid dependency baseline.

Generic environments use `/home/user/session/.npm-cache` as the persistent npm
content cache. This cache benefits that Sprite; a replacement Sprite receives
no cache benefit unless the baseline explicitly seeds it. Caching must not
be presented as equivalent to reusing a completed dependency tree.

### FR-6: Resumable ownership and retention

Keep the assigned Sprite for the whole resumable lifetime, including parked
and idle states. Preserve the existing terminal-retention policy, currently
configured through `TASK_ORCH_RUNNER_TERMINAL_MS` with a 24-hour default.
Explicit destructive cancellation may use the existing destruction policy.

After retention expires, destroy the Sprite and confirm provider deletion
before recording cleanup complete. A used entry never transitions back to
ready. Snapshot expiry must not prematurely destroy a resumable run.

### FR-7: Drift, outages and crash recovery

Environment changes drain incompatible unclaimed entries and trigger bounded
replacement. They must not reset, strand or overwrite an assigned run.

Persist enough operation identity and timestamps to reconcile crashes during
creation, preparation, claim, restore, service startup and destruction.
Recover expired preparation leases before issuing replacement work, and
account for orphaned provider resources. A provider inspection error is
unknown state, not evidence that a resource is gone.

Restarts and multiple control-plane replicas must preserve allocation and
capacity invariants. Cancellation racing with allocation or startup must
prevent a superseded worker from becoming authoritative.

### FR-8: Optional snapshot classes

Failure snapshots are limited to abnormal termination with useful filesystem
evidence, at most one per failed run initially. Proposed default expiry is
24 hours, configurable; retain no longer than the owning Sprite's retention.
Failure recording must succeed even if checkpoint creation fails. Access to
failure evidence follows the owning run's authorization because it may
contain run credentials or private files.

Pre-turn checkpoints require a worker-side barrier that stops turn admission
and waits for package managers, git operations and background writers to
quiesce through checkpoint completion. If quiescence cannot be established,
skip the optional checkpoint and record why. Retain one by default, with a
hard maximum of two per active run.

Do not enable these classes until individual checkpoint deletion and expiry
semantics are verified. Explicit rollback additionally requires a reviewed
policy for older SDK/filesystem state versus durable turn receipts and
external side effects. Generation fencing alone does not make replay safe.

## 8. Success metrics

Measure generic pool hits, dependency hits, misses and rejected restores
separately. Worker readiness and project readiness are distinct timestamps.

| Metric | Definition / release expectation |
| --- | --- |
| Dispatch-to-running | Dispatch admission to authenticated current-worker handshake; target p50 below approximately 15 seconds on warm hits, excluding scheduler capacity wait |
| Dispatch-to-project-ready | Dispatch admission to verified requested checkout and usable dependencies; compare p50/p95 against cold runs for the same repository and workload |
| Dependency reuse | Compatible baseline canary runs perform zero project dependency installs; mismatches reliably install |
| Pool hit rate | Eligible first assignments served from a matching ready entry divided by all eligible first assignments |
| Refill health | Preparation duration, failures, retry count and time below the ready target |
| Resource use | Preparing, ready, assigned and draining counts; checkpoint counts and available storage/cost measurements |
| Correctness | Zero double assignments, stale-generation handshakes accepted, cross-run reuse, or resume data loss in validation |
| Cleanup | Expired resources reconciled within two successful cleanup cycles; provider outages remain visible as pending cleanup |

The 15-second target is provisional. Record at least 30 warm-hit samples and
a comparable cold sample before expansion, report p95 as well as p50, and
investigate regressions in either readiness metric. Do not claim improvement
based only on checkpoint creation or restore duration.

## 9. Acceptance and release gates

- Simultaneous claims across replicas allocate distinct Sprites and obey
  capacity limits, including in-progress refill reservations.
- Fault injection after each external lifecycle step recovers the existing
  operation or drains it without double assignment or lost ownership.
- A restored worker cannot send accepted events with an old generation or
  channel credential; `running` waits for the current handshake.
- A baseline hit preserves usable dependencies at the actual execution path.
  Lockfile, install options and relevant script-input changes invalidate reuse.
- A resumed run retains a sentinel file, unpushed commit and SDK state and
  does not invoke baseline restore.
- Deployment fingerprint drift and pool disablement preserve assigned runs
  while draining unused capacity.
- Cancellation and terminal cleanup work for pool-generated names, and no
  agent-used Sprite becomes ready again.
- Provider outages do not trigger false deletion success or destructive
  liveness decisions; failed preparation retries are bounded.
- Baseline inspection confirms no saved run/bootstrap credentials or active
  worker service. Authorization tests reject cross-boundary allocation.
- Canary telemetry reports both readiness metrics, pool/dependency hit rates,
  and cleanup outcomes. Releases C and D pass separate retention and restore
  gates before enablement.

## 10. Rollout and rollback

First validate provider checkpoint/service semantics and recovery tests with
pooling disabled. Enable Release A for one deployment with two generic
entries, then Release B for one frequent repository. Measure cold and warm
cohorts before increasing total capacity to four or adding repositories.

Rollback sets the target to zero and disables new pool claims. New runs use
inline bootstrap; unused entries drain asynchronously. Continue ownership,
resume and cleanup support for already assigned pooled Sprites until their
retention ends. A code rollback that loses support for those bindings is not
a safe operational rollback.

## 11. Decisions required before implementation completion

- Verify provider restore/service restart behavior, checkpoint deletion and
  whether Sprite deletion removes all associated snapshot storage.
- Choose the first repository and stable dependency checkout path for Release B.
- Specify static fingerprint allocation and how preparation receives temporary
  private repository/registry access without retaining credentials.
- Set refill concurrency, retry limits and cleanup cadence from provider limits
  and canary measurements; expose resolved values to operators.
- Agree on the dispatch-to-project-ready improvement target after cold-path
  measurement. Release B must demonstrate a measurable improvement before
  broad rollout.

These decisions do not authorize enabling optional rollback or unbounded
snapshot retention.
