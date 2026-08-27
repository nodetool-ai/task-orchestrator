# Liveness without clocks — step 3 report

Implemented by hand after two Codex passes could not converge without a test
runner (its sandbox cannot reach Postgres).

Deleted: `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_STALE_MS`, `isLeaseLive`,
`isWorkerLive`, `isWorkerClaimLive`, `isWakeIntentFresh`, the Fly-era
`nextLifecycleAction` (suspend/stop ladder), `renewControllerLease`,
`listStaleChannelRuns` / `reapStaleChannels`, `stampRunHeartbeatTx`, and every
write to `heartbeat_at`. The worker's `heartbeat()` RPC is now `pollCancel()`:
a read of `cancel_requested`, no write.

Replaced, because `heartbeat_at` was overloaded with bookkeeping:
- `agent_runs.pending_since` — start of the current pending episode (dispatch
  pump `MAX_DEFER`, boot reaper pending grace).
- `agent_runs.claimed_at` — when the current claim was taken (local container
  sweep's creation-window guard, sprites idle clock).

Controller lease: `controller_epoch` + `controller_id` only. The same
controller re-dialing keeps its epoch; any other bumps it. `touchChannel` is
the per-ping epoch fence.

Migration `0030_drop_clocks.sql` drops `heartbeat_at`, `worker_pid`,
`wake_requested_at`, `controller_lease_expires_at`, `channel_connected_at`,
`channel_last_seen_at`, `last_suspended_at`, `fly_app`, `machine_id`,
`volume_id` and two indexes; adds `pending_since`, `claimed_at`.

Kept on purpose: the per-turn budget deadline and the destroy retention windows
(`TASK_ORCH_RUNNER_TERMINAL_MS`, `TASK_ORCH_RUNNER_STOP_MS`).

Gates: `npm run typecheck` clean; `npx vitest run` 1744/1744.
