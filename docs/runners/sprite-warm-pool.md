# Sprite warm pool

This implements Releases A and B of the
[warm-pool PRD](../superpowers/specs/2026-09-09-sprite-warm-pool-prd.md).
It is off by default. Failure snapshots and pre-turn rollback are not enabled
or implemented by this release.

## Enable a canary

Apply the normal database migrations (including `0043_sprite_pool`) and ship a
fresh standalone worker bundle. Set `TASK_ORCH_SPRITE_POOL_SIZE=2` and provide
`TASK_ORCH_SPRITE_POOL_BASELINES` as a JSON array. The total of its `target`
values must not exceed the pool size. Start with one generic baseline:

```json
[
  {
    "target": 2,
    "manifest": {
      "schemaVersion": 1,
      "nodeVersion": "v22.22.3",
      "codexVersion": "0.153.4",
      "platform": "linux",
      "architecture": "x64",
      "systemToolsVersion": "sprite-base-v1"
    }
  }
]
```

Bootstrap installs the exact Node version in the manifest using Sprite’s NVM
and makes it the default for services and new shells. The deployment pins
Node 22.22.3 (bundled npm 10.9.8), matching the repository’s Node 22 requirement. Architecture uses Node's `x64`/`arm64` names. Codex uses its numeric
version, without the `codex-cli` prefix. The v1 system recipe checks the base
image's git, curl, tar and npm; custom system package installation is not part
of this recipe. Worker SHA is filled from the shipped bundle. An explicit
`workerBundleSha` is accepted only if it matches that bundle.

Preparation verifies the actual worker file digest and runtime versions. A
bad version or failed install leaves a failed preparation, never a ready
entry. Inspect `sprite_pool_entries.last_error` and server pool logs when a
configuration produces no ready capacity.

The provider requests maintenance after create and during existing sweeps.
Preparation runs asynchronously, with two local preparation slots and a
30-minute reservation lease renewed while preparation is active. A lost or
expired lease cannot publish a ready checkpoint. PostgreSQL reserves the total and per-fingerprint
unused targets across replicas and accounts for existing Sprite runner rows
against the configured `TASK_ORCH_MAX_SPRITES` cap. Failed preparation retains
a retry timestamp; expired preparation and failed rows are drained. Unused
Sprites naturally hibernate after preparation; the manager does not poll them
with exec calls to keep them awake.

Every new pool Sprite enables the configured swap before dependency installation.
Swap is kernel state, so the run also enables it after restoring a checkpoint.
This reduces preparation memory pressure; it does not repair a VM whose backing
storage has already stalled.

## Add an npm dependency baseline

For a frequent repository, add a spec with `repositoryId`, a nonempty
`allowedUserIds` list, and a `manifest.dependency` object:

```json
{
  "repository": "https://github.com/example/project",
  "revision": "<full 40-character commit SHA>",
  "lockfile": { "path": "package-lock.json", "sha256": "<64-character SHA-256>" },
  "packageManifests": [
    { "path": "package.json", "sha256": "<64-character SHA-256>" }
  ],
  "packageManager": "npm",
  "packageManagerVersion": "10.9.8",
  "installOptions": ["--no-audit", "--no-fund"]
}
```

Replace placeholders and the npm version with measured values. Hash file bytes
at the pinned revision. Include workspace package manifests and any declared
install-script inputs in `installScriptInputs`, each as `{path, sha256}`.
Paths must remain inside the checkout. Only npm/package-lock.json is supported
initially. Install flags are validated against the supported configuration
schema; scripts run unless `--ignore-scripts` is explicitly selected.

By default, `reusePolicy: "revision"` is deliberately conservative: a different
revision or tracked local source change invalidates the installation receipt.
For audited repositories, `reusePolicy: "inputs"` separates installed dependencies
from source-dependent build outputs. Commit and source changes then rerun
`buildCommands` without running `npm ci` when dependency inputs still match.
Lockfile, workspace package manifests, install options, setup commands, declared
install-script inputs, repository `.npmrc`, and install runtime changes still
invalidate installed dependencies. Native dependencies must match the target
Node version, Linux platform and architecture.

Baseline and repair installs ignore user/global npm configuration and inherited
`NPM_CONFIG_*` and `NODE_ENV` overrides. Set installation behavior in the checked
repository `.npmrc` or the manifest's supported install options.

Input-scoped reuse requires an explicit `installScriptInputs` list and
`npmConfig` hash (or `null` when `.npmrc` is absent). Audit repository lifecycle
scripts before opting in: include every file whose contents affect installation.
An empty list asserts there are no additional repository source inputs. Move
source-dependent compilation into `buildCommands` where possible. Third-party
package contents are already pinned by the lockfile; repository scripts and
local package source are not. External services and mutable inputs cannot be
made reproducible by hashing the lockfile.

Build commands are startup prerequisites, including when a replacement worker
resumes a checkout with unfinished edits. A failed build prevents that worker's
agent from starting. For the canary, limit these commands to required artifact
generation that tolerates unfinished task work; leave general compilation and
tests to the agent when they could prevent a recovery turn.

### Generate a baseline from a pinned checkout

The generator reads committed git blobs and discovers local workspace manifests
from package-lock v2/v3. It hashes `.npmrc` and the declared script inputs and
validates the resulting specification with the production parser. It does not
install packages, execute recipe commands, fetch remote code, or change the
checkout. Uncommitted edits are excluded; commit the desired dependency inputs
before generating. Symlinks and missing/untracked input files are rejected.

Create a recipe JSON file, replacing the repository and user IDs with the
registered values and choosing commands appropriate for that repository:

```json
{
  "repositoryId": "R-project",
  "repository": "https://github.com/example/project.git",
  "allowedUserIds": [7],
  "target": 1,
  "nodeVersion": "v22.22.3",
  "architecture": "x64",
  "packageManagerVersion": "10.9.8",
  "reusePolicy": "inputs",
  "installScriptInputs": [],
  "buildCommands": ["npm run build"],
  "readinessCommands": ["npm run check:ready"]
}
```

Only use the empty `installScriptInputs` above after auditing lifecycle scripts.
Otherwise list paths, such as `scripts/install.mjs` and any source/configuration
it reads, or retain `reusePolicy: "revision"`. `packageManagerVersion` must be the
npm version installed with the chosen Sprite Node runtime, not the generator
machine's npm version.

```sh
npm run sprite:baseline -- --repo=/path/to/project --ref=HEAD --recipe=recipe.json --out=baselines.json
```

The output is a JSON array for `TASK_ORCH_SPRITE_POOL_BASELINES`; merge it with
existing generic/repository entries and keep the sum of targets within
`TASK_ORCH_SPRITE_POOL_SIZE`. `--out` refuses to overwrite an existing file.
Regenerate when dependency inputs or the preparation recipe change. The worker
bundle identity is filled by deployment, so local worker files are not required.

Repository matching checks the run's repository ID, normalized remote and
explicit user allowlist. Generic baselines have no repository data. Private
GitHub checkout can use the control plane's `GH_TOKEN` in the clone exec only;
it is not written to a credential file or passed to dependency installation.
This release has no private package-registry credential provisioning; such
installs must be independently accessible or use the normal run path.

Dependencies are installed at `/home/user/session/repo`, the worker's default
managed checkout path. After the worker selects its requested revision, it
hashes the actual inputs and checks Node/npm-related environment identity.
A matching receipt and tree skip installation. A mismatch runs `npm ci` with
the manifest's options and `/home/user/session/.npm-cache`. The old receipt is
removed before installation, and a new receipt is written only after success
and input revalidation. Resume validates the existing checkout without
restoring the baseline. Avoid a custom runner checkout path for this canary.

### Snapshot scope

Each pool Sprite is prepared, verified and checkpointed before assignment; its
own checkpoint is restored before its first task. A repository baseline includes
installed dependencies and built outputs. A generic worker baseline does not.
Look for `dependencyBaseline: true` on `runner_pool_hit` to confirm the run got
the repository snapshot, and `sprites_dependency_reused` to confirm checkout
validation actually avoided installation.

This implementation does **not** clone one template checkpoint into multiple
Sprites. The public checkpoint restore API is scoped to the same Sprite, and
no documented cross-Sprite fork operation was available when checked on
2026-09-12. Each replenished pool entry still pays preparation once. Used task
environments never return to the ready pool. Fly advertises SBD drive forking,
but wiring that in requires a supported API and enabled organization; do not
assume portable checkpoint IDs or silently recycle a used checkout.

## Production NodeTool profile

The production app uses a persistent Fly secret-store override for
`TASK_ORCH_SPRITE_POOL_BASELINES`: one NodeTool repository snapshot and two
generic snapshots, within the existing total target of three. This override
takes precedence over the generic default in `fly.toml` and survives image
deployments. Change the override when adjusting production targets.

The [NodeTool recipe](profiles/nodetool.recipe.json) is scoped to `R-default`
and user `1`, matching run 276. Its initial pin is
`fc3abb76b01416a140ba1c3039051272aa8b5ffe`. Generate its repository specification
with:

```sh
npm run sprite:baseline -- --repo=/path/to/nodetool --ref=fc3abb76b01416a140ba1c3039051272aa8b5ffe --recipe=docs/runners/profiles/nodetool.recipe.json --out=nodetool-baseline.json
```

Combine that specification with a generic target of two before applying the
override. Preparation installs all locked workspaces, rebuilds native bindings,
builds package outputs with `NODE_ENV` cleared, and probes Jest, TypeScript,
Turbo, Sharp, Keytar and `better-sqlite3`. Preparation installs the Linux
`libsecret-1-dev` prerequisite before npm so Keytar can fall back to compilation.
The first preparation is still a full install;
only a verified checkpoint is eligible for assignment.

The recipe excludes `packages/fal-codegen/package.json` from generic workspace
entrypoint checks because this private generator declares stale `dist/index`
entries without corresponding source files. Its manifest remains fingerprinted,
and an explicit readiness probe requires its actual `dist/generate.js` and
`dist/generate.d.ts` outputs. Other workspace outputs retain their default checks.

## Ownership, recovery and cleanup

A pool entry is claimed and bound to its runner atomically. Before first use,
the provider stops old worker services, restores the recorded checkpoint,
verifies it and persists a restore receipt. Run credentials are then injected
into a fresh generation-scoped service. The existing authenticated channel
handshake alone establishes `running`; VM activity is insufficient.

The restore receipt is written before defining the worker service. A crash
before that receipt retries first-assignment restore; a crash after it follows
normal resume and preserves files. Fingerprint drift replaces only unused
entries. A disappeared assigned Sprite is surfaced as unavailable rather than
silently replacing its resumable filesystem.

Terminal cleanup atomically releases runner authority and queues pool deletion.
Provider failure leaves `deleting` work for later sweeps. Used Sprites never
return to the ready pool. Existing `TASK_ORCH_RUNNER_TERMINAL_MS` retention
continues to apply, including the current 24-hour default.

Setting the pool size to zero disables new claims and refill and drains unused
entries. Assigned runs continue using their Sprite and dependency manifest.
Keep the migration and ownership-aware cleanup code installed until those
runs have reached terminal retention.

## Verification and release gate

Automated coverage uses isolated PostgreSQL schemas, a fake provider transport,
real temporary git checkouts, and shell-executed baseline verification. It
checks concurrent reservations/claims, stale fences, failed restores,
first-assignment adoption, resume, dependency mismatches, and deletion retries.
It does not establish live provider latency or checkpoint/service replay
behavior. Validate those against the
[provider checkpoint API](https://sprites.dev/api/sprites/checkpoints) and
[service API](https://sprites.dev/api/sprites/services) during the canary.

Use `runner_pool_hit`, `runner_pool_miss`, `runner_pool_unavailable`,
`runner_baseline_restored` and the existing runner events alongside the
`sprites_baseline_restore`, `sprites_dependency_install`,
`sprites_dependency_reused` and `sprites_project_ready` telemetry. Compare
dispatch-to-handshake and dispatch-to-project-ready separately. Capture at
least 30 warm hits and a comparable cold cohort before expansion; the PRD's
approximately 15-second p50 is an unverified rollout target.

## Debug logging

Set `TASK_ORCH_LOG_FORMAT=json` and `TASK_ORCH_LOG_LEVEL=debug` on the control
plane, then deploy the updated standalone worker bundle. These settings are
forwarded to newly defined Sprite worker services. Existing workers pick them
up when their service is redefined on resume. Default `info` includes lifecycle
changes and phase timings; `debug` adds capacity decisions and skipped work.

Filter JSON lines by `component == "sprites.lifecycle"`. Follow a preparation
with `poolEntryId` or `spriteName`, then join its claim to `runId`,
`workerGeneration` and `instanceId`. For example, with collected JSON logs:

```sh
jq -R 'fromjson? | select(.component == "sprites.lifecycle" and .runId == 208)' sprite.log
```

A successful preparation emits `sprites_pool_reserved`,
`sprites_pool_preparation_started`, timed baseline phases, and
`sprites_pool_ready` after its database update succeeds. A warm run emits
`sprites_pool_claimed`, the `baseline_assignment` phase, and
`sprites_worker_awaiting_handshake`. Only an authenticated hello accepted by
the current generation's database fence emits `sprites_worker_handshake_accepted`.
Logs from the worker and server can arrive out of order; correlate by generation.
Resume emits `sprites_pool_resume` with `reason=preserve_filesystem`.

`sprites_dependency_decision` records `reused` and a reason, such as
`verified_receipt`, `lockfile_changed`, `revision_changed`, `tree_missing`, or
`receipt_mismatch`. Compare its current and baseline fingerprints. The
`project_dependencies` phase measures validation plus installation; the existing
`sprites_project_ready` event in `runner.telemetry` identifies project readiness
and now carries the same worker correlation fields.

When no capacity appears, inspect `sprites_pool_capacity` and
`sprites_pool_reservation_declined`: reasons distinguish total capacity,
unused budget, per-fingerprint target, and retry backoff. Preparation failures
include retry timestamps (Unix milliseconds), retry delays and attempt counts.
`sprites_pool_delete_pending` means deletion still needs a successful sweep;
`sprites_pool_deleted` follows confirmed provider deletion and its database update.
Timed phases emit started/completed/failed events with `durationMs` on completion
or failure. Failures include available HTTP status, process exit code, and a
bounded set of operating-system error codes.

The new lifecycle logger accepts only selected primitive fields and excludes
commands, manifests, service environments, lease tokens, raw errors and provider
response bodies. Existing logs and database error records retain their existing
behavior; this is not a repository-wide log redaction change.
