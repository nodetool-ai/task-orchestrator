# Liveness without clocks — step 2 report

Implemented the provider-observed liveness primitive in `lib/run-liveness.ts`.
`resolveLiveness(runId)` loads the run and runner instance, observes the
provider handle, and returns `alive`, `dead` (`exited`, `replaced`, or
`runner-gone`), `unowned`, or `unknown`.  A runner with a preserved
incarnation but no `worker_scope` is deliberately `unowned`.

Moved call sites by rule:

- `reconcileOrphanedRuns` and the boot orphan reaper act only on `dead` or
  `unowned`; `unknown` logs and is left untouched.
- Shared-worktree GC treats `alive` and `unknown` as busy.  Thus an unknown
  provider result cannot authorize cleanup.
- The append, follow-up, server-wake, rival-run, pending-parent-priority, and
  worker-capacity questions now resolve the provider verdict.  They refuse
  ownership only for `alive`; stale-heartbeat SQL is no longer an authority.
- `deferRunForServerDispatch` and server-claim takeover observe before writing
  and fence their write on the snapped worker scope plus
  `runner_instances.worker_incarnation`.
- Sprites lifecycle observation protects `alive` and `unknown` runners from
  destruction; a missing Sprite is immediately handled as dead rather than
  after a heartbeat interval.
- `ensureWorkerConnected` is now the delivery path for chat messages.  It dials
  an observed live worker, otherwise clears an observed stale claim with an
  incarnation-aware fence and dispatches before bridging `run.input`.  A
  replacement therefore takes the new-generation `run.start` path rather than
  relying on a stale input channel.

The heartbeat writer/constants and controller lease columns deliberately remain
for Step 3. `isLeaseLive` remains exported solely for the synchronous injected
`RunsApi` used by `run-dispatch`; `isWorkerLive` remains as the synchronous
fallback in `runner/lifecycle.ts` because its pure policy functions receive no
run id, runner handle, database access, or async boundary. Sprites supplies a
provider-derived `workerLive` value, so production sprites lifecycle decisions
do not use the fallback. The unused `isWorkerClaimLive` re-export was removed.
Converting the generic lifecycle API requires widening all of its callers and
is left as explicit Step 3 cleanup.

Open doubt: `ensureWorkerConnected` relies on existing `dispatchRun` provision
and channel-start behavior for local and Sprites runners.  Its replacement CAS
is identity fenced, but the broader synchronous dispatch claim still contains
legacy heartbeat eligibility and should be converted together with Step 3's
claim-state deletion.

Tests now install a fake provider through the provider cache rather than using
fresh heartbeats for the live-case assertions. Added coverage for unknown
observations and incarnation replacement re-dispatch.

Validation: `npm run typecheck` passed. Vitest cannot reach PostgreSQL on
`127.0.0.1:5433` in this sandbox (`EPERM` during global setup), including when
running focused files.
