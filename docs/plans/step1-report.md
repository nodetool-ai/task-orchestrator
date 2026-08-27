# Liveness without clocks — step 1 report

Implemented the observation-only liveness primitive. `RunnerProvider.inspect()`
returns `alive`, `dead`, or `unknown` and never throws. The Sprites identity is
`<service.state.started_at>#<service.state.pid>`; Docker uses
`<container.Id>#<container.State.StartedAt>`; a detached local process uses
`<pid>#<spawnedAtIso>`, with its spawn time recorded when it is launched.

Workers now include their PID in `channel.hello` (optional in the protocol for
older bundles). Before accepting a channel, the controller observes the runner,
checks that the provider-observed PID matches hello, and persists the observed
identity in `runner_instances.worker_incarnation`. A mismatch or unavailable
observation is warned/skipped and never blocks the handshake.

The public observation shape remains status-plus-incarnation. Providers retain
the observed PID as internal handshake metadata because Docker's required
incarnation (`Id#StartedAt`) deliberately does not embed a PID.

Boot recovery and each pump tick log persisted versus observed identities for
all rows that have one. They do not change any state. Heartbeat writes,
`isLeaseLive`, and `isWorkerLive` remain unchanged.

The required migration is `0029_worker_incarnation.sql`; this repository already
uses `0028_provider_default_sprites.sql`, despite the older plan text referring
to the step-1 migration as 0028.

Validation: `npm run typecheck` passed. Vitest could not run in this sandbox:
its global setup tried Postgres at `127.0.0.1:5433` and was blocked with
`EPERM`, including for focused unit files. Added tests cover Sprites service
parsing and inspect behavior, local Docker/detached-process inspect behavior,
the hello PID schema, and channel accept-path persistence.

Open doubt: detached-process spawn metadata is in the local provider's
in-process registry. After a control-plane restart it is deliberately
unobservable (`unknown`) rather than guessed from a PID; this is safe for the
observation-only rollout, but a later liveness-decision step may need durable
local spawn metadata if local workers must survive controller restarts.
