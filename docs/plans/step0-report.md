# STEP 0 report — Fly runner removal

Implemented the Fly runner retirement.

- Deleted the Fly provider/client/inventory, Fly runner scripts and image/config,
  Fly runner tests, inventory CLI, runner-image CI paths, and obsolete Fly-runner
  documentation.
- Providers are now `local` and `sprites`; `TASK_ORCH_RUNNER=fly` throws a clear
  configuration error rather than falling back to local execution.
- Removed Fly dispatch/admission/channel branches and `startMonitor()` from the
  provider interface. Local starts its idempotent Docker monitor from `sweep()`.
- Removed Fly runner config; retained Fly control-plane deployment support and
  left `fly.toml` unchanged as requested.
- Added migration `0028_provider_default_sprites.sql` and journal entry to set
  the `runner_instances.provider` default to `sprites`, retaining the legacy
  Fly identifier columns.
- Kept `FLY_API_TOKEN` and `SPRITES_TOKEN` out of worker environments.

Validation:

- `npm run typecheck` passed.
- `npx vitest run` could not execute tests in this sandbox: every suite failed
  during setup because connections to the configured local Postgres
  (`127.0.0.1`/`::1:5433`) are denied with `EPERM`. No test bodies ran.

Uncertainty: historical architecture notes still mention retired Fly work as
historical context; current runner and deployment documentation now describes
only local/Sprites runners and Fly as a control-plane host.
