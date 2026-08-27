# Liveness without clocks — post-landing review

Four reviewers (one per step commit) ran after the four steps landed. Findings and
what was done. Severities are the reviewers'.

## Step 2 / liveness semantics (the important ones)

- CRITICAL `unowned` meant both "no claim" and "claim I cannot see". Server-runtime
  turns (no runner row) and workers in their boot window (no stored incarnation)
  were reaped every pump tick. Fixed: `unowned` now means exactly "no claim". A
  server claim carries its process identity (`server-<host>@<pid>@<bootId>@<nonce>`,
  `serverClaimScope()`) and is observed like a runner: this process's boot id →
  alive; same host, pid gone → dead; other host → unknown; legacy format → dead.
  A runner row with no stored incarnation returns the provider observation as-is.
  A claim with no runner row is `unknown`.
- HIGH `worker_scope` is not a fence on sprites (the sprite name is stable across
  incarnations). `handleWorkerDeath` and the boot reaper now fence on the observed
  incarnation.
- HIGH `ensureWorkerConnected` cleared an ALIVE worker's claim when it had no dialable
  channel, and silently dropped the message on `unknown`. Now: alive/unknown with a
  channel id → dial (waking a cold sprite); only `dead` discards the claim; a
  dispatch that returns `already-claimed` with no connected channel throws, so the
  caller reports a delivery failure instead of pretending.
- `unknown` now counts as occupied/live in: `deferRunForServerDispatch`,
  `findRivalTaskRun`, `followUp`, `countInFlightWorkers`, `sweepWorkerSockets`.
- Sprites sweep confirms a list miss with `inspect()` before declaring death.
- worktree-gc: an in-flight status protects the checkout regardless of claim.

## Step 1 / inspect()

- CRITICAL Docker workers never persisted an incarnation: the worker reports pid 1
  (own namespace) while docker inspect reports the host pid. The pid cross-check now
  applies only when both sides supply a comparable pid; the inspected handle is the
  registered instance, which is identity enough.
- HIGH The hello observation ran BEFORE `channel.accept` and could take 60s against
  a 10s worker accept timer. It now runs after accept, fire-and-forget.
- HIGH A cold (hibernating) or starting sprite could read as dead. `inspect()` now
  gates on sprite status: only a settled (`running`) sprite or the service's own
  `failed` verdict may say dead; a service in restart backoff is `unknown`.
- HIGH A malformed/empty service answer became `dead`. `serviceFromJson` throws on a
  missing `state.status`; an empty body throws; only 404 means absent.
- `pid?` is on the `alive` observation type; the string-tail fallback is gone.
- Local detached mode: `stop()` evicts the pid record (no recycled-pid false alive).
  Spawn metadata is still in-memory only: after a control-plane restart a detached
  local worker is `unknown` for life (non-destructive). Not fixed — local dev only.

## Step 3 / clocks

- HIGH Same-epoch redial was rejected by the worker once the epoch stopped expiring
  (half-open socket → 60s of 4409 → run abandoned). The worker fence is now
  `epoch < active.epoch`; an equal epoch replaces the connection.
- MEDIUM A stale-epoch close made the loser redial and steal the run back
  (ping-pong). The supervisor now stands down on `STALE_CONTROLLER_EPOCH`.
- `claimServerTurn` clears `pending_since`. `reconcileOrphanedRuns` skips runs
  driven by this process (`isLive`). Stale comments and a dead `now` removed.
- Migration 0030 ordering: documented in the plan (single-machine replacement;
  workers do not use the DB). Not split.

## Step 0 / Fly removal

- HIGH `fly-deploy.sh` had lost the pi-provider key staging and the admin-account
  step; both restored. `TASK_ORCH_PUBLIC_URL` is now synced to the app.
- MEDIUM `fly.toml` still set `TASK_ORCH_MAX_MACHINES` (dead) — prod had NO sprite
  concurrency cap. Now `TASK_ORCH_MAX_SPRITES = "4"`.
- The Fly environments card in the settings UI, `config.dispatch.maxMachines`,
  `config.sprites.pollMs`, and unused imports removed; `.env.fly.example` documents
  `SPRITES_TOKEN`.
- Not done: the stale Fly-era comments in `lib/runs.ts` (cosmetic), the
  `AUTH_SECRET` re-randomisation on re-run of the deploy script (pre-existing;
  pass `AUTH_SECRET` explicitly to keep sessions).
