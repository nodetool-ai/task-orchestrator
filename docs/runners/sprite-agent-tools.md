# Sprite operations in CodeAct

The orchestrator tools profile exposes `app.snapshots.*` and `app.sprites.*`
through the shared CodeAct registry, including worker-channel calls. The
control plane authenticates operations using the calling run's persisted user.
Workers receive neither Sprite API credentials nor database access. These tools
also work in server runs that have an authenticated owner.

## Repository dependency snapshots

`app.snapshots.list({})` returns your repository profiles, targets, preparation
states, checkpoint IDs and failures. It omits another user's profiles and all
assigned pool entries. Repository-bound agents can manage that repository only.

To prepare dependencies, submit a recipe against a registered GitHub repository:

```js
const result = await app.snapshots.prepare({
  repoId: "R-default",
  ref: "main",
  target: 1,
  recipe: {
    packageManagerVersion: "10.9.8",
    reusePolicy: "revision",
    buildCommands: ["npm run build --workspaces --if-present"],
    readinessCommands: ["node -e \"require('better-sqlite3')\""],
  },
});
return JSON.parse(result.content[0].text);
```

The example commands must be adapted to the repository. The server resolves
the ref once and hashes regular GitHub blobs at that commit: the lockfile,
workspace manifests, optional `.npmrc`, and declared lifecycle-script inputs.
Input-scoped reuse requires an explicit audited `installScriptInputs` list.
Recipes also accept setup commands, readiness commands, workspace output
exclusions and history requirements documented in [warm pools](sprite-warm-pool.md).
No repository commands run on the control plane.

Saving the profile queues preparation. Inspect `list` in a later call: only a
`ready` entry represents successful installation, build, verification and
checkpointing. A fresh Sprite is prepared by the existing pool controller; an
agent's used environment never becomes a reusable pool baseline. Preparation
may take several minutes. A CodeAct timeout during recipe resolution does not
prove the profile was not saved; inspect `list` before resubmitting.

`app.snapshots.setTarget({repoId: "R-default", target: 0})` pauses claims and
replenishment, and unused ready entries drain on reconciliation. An in-flight
preparation may finish before the next reconciliation. Set a positive target
to resume. These persistent overrides survive server restarts and worker-bundle
changes; the new worker bundle SHA is hydrated by the server. A target cannot
take capacity from another profile or exceed `TASK_ORCH_SPRITE_POOL_SIZE`.
Profiles shared among several users must be changed by an administrator.
Identical fingerprints in different owner scopes are rejected rather than
implicitly sharing repository contents.

`app.snapshots.retire({id: 123})` retires an unused ready entry that you manage.
The controller replaces it while its target stays positive. Preparing and
assigned entries cannot be retired through this API.

## Remote commands

Use `app.sprites.list({})` to discover your available run IDs, current worker
generations and repository directories. Commands target those bindings, not
arbitrary provider names. The server checks ownership and generation on every
call and coordinates with runner lifecycle locks. Commands execute with the
run environment's existing permissions and may modify its checkout or processes.
This is command execution through the Sprite API, not an interactive SSH login.

```js
return await app.sprites.exec({
  runId: 276,
  generation: 1, // use the value returned by list
  commandId: "8d3f7618-46b4-4e1a-86ae-c143920a031a",
  command: "node --version && npm --version",
  timeoutSeconds: 10,
});
```

For an install or build, use `startCommand` (default timeout 600 seconds,
maximum 3600) and call `commandStatus` in a later CodeAct execution:

```js
return await app.sprites.startCommand({
  runId: 276,
  generation: 1,
  commandId: "af35c6c8-4f41-4c94-bf84-552104beddf8",
  command: "npm ci --no-audit --no-fund",
  timeoutSeconds: 1800,
});
// Later:
// await app.sprites.commandStatus({runId: 276, generation: 1,
//   commandId: "af35c6c8-4f41-4c94-bf84-552104beddf8"});
```

Choose a new UUID for each logical command, and preserve it as a literal across
retries of the entire CodeAct execution. Do not generate the UUID dynamically
inside retryable code. Reusing a UUID with different command, directory or
timeout is rejected. An atomic reservation in the Sprite prevents a repeated
launch from rerunning the command. Interrupted initialization remains reserved
with an unknown outcome rather than being automatically relaunched.

Background jobs survive a tool disconnect and are bounded by `timeout` in the
VM. They stop when the Sprite is deleted. Logs live under
`/var/tmp/task-orch-codeact/g<generation>/<commandId>` and each file is capped at
10 MiB. Status returns up to the last 16,000 bytes of each output stream, a
status, and an exit code when available (124 normally indicates timeout).
Short `exec` calls wait at most 15 seconds, then return the current job status.
An unknown, missing, or running result is not success; inspect before retrying.
Calls using an old worker generation are rejected even if a prior job survives.

## Personal run checkpoints

`app.snapshots.checkpoint({runId, generation, comment})` saves a personal
checkpoint of an owned Sprite; `listCheckpoints({runId, generation})` lists it.
Checkpoint creation is not idempotent: after an ambiguous result, list existing
checkpoints before retrying. Pause concurrent writers before requesting a
consistent filesystem checkpoint. Personal checkpoints can contain run
credentials, remain inside the owned Sprite, and are never promoted to a pool
baseline. Restoring an active agent runner is deliberately not exposed because
it would rewind worker-channel state. Pool restore remains controlled by the
first-assignment lifecycle.
