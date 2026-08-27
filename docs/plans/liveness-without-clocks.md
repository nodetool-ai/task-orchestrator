# Liveness without clocks

Status: complete (2026-08-27). Steps 0-3 landed as one commit each; migrations 0028-0030 must be applied before deploy.

## Problem

Every liveness decision reads `agent_runs.heartbeat_at` against `HEARTBEAT_STALE_MS` (5 min)
through two predicates, `isLeaseLive` and `isWorkerLive` (`lib/run-liveness.ts`). A sprite that
hibernates mid-turn is healthy but writes no heartbeat, so the clocks call it orphaned. Run 181
died because an idle run kept a live-looking claim for 5 minutes and delivery was skipped.

## Principle

Ask the provider, do not infer from time. Compare process identity, not freshness.

## Interface (provider-neutral)

```ts
// lib/runner/provider.ts
export type RunnerObservation =
  | { status: "alive"; incarnation: string }   // same string ⇒ same process
  | { status: "dead"; detail?: string }         // box gone, or worker exited/absent
  | { status: "unknown" };                      // could not observe — NEVER act on it
inspect(handle: string): Promise<RunnerObservation>;   // never throws
```

Providers: `sprites` (GET sprite + GET /services/worker; incarnation `${started_at}#${pid}`),
`local` (docker inspect: `${Id}#${StartedAt}`; plain process: `${pid}#${spawnedAt}`).
The worker sends its own incarnation in `channel.hello`; provider and worker must agree.

```ts
// lib/run-liveness.ts
export type Liveness =
  | { verdict: "alive"; incarnation: string }
  | { verdict: "dead"; reason: "exited" | "replaced" | "runner-gone"; detail?: string }
  | { verdict: "unowned" }
  | { verdict: "unknown" };
export async function resolveLiveness(runId: number): Promise<Liveness>;
```

## Rules

1. Never act destructively on `unknown`. Reap, re-dispatch, takeover need `dead` or `unowned`.
2. Observe outside the transaction; mutate inside with `WHERE worker_incarnation = $stored`.
3. Liveness never skips delivery. Delivery calls `ensureWorkerConnected(runId)`:
   inspect → start service if not alive → if `replaced` re-issue `run.start` → dial → deliver.

## Steps

0. Delete the Fly provider. `RunnerProviderKind = "local" | "sprites"`. Remove `startMonitor()`
   from the interface (local monitor starts inside `sweep()`); remove `flyAdmit` and the
   `"fly"` admission branch; drop `FLY_*` from env-scrub/config-guard; schema `provider`
   default → `"sprites"`. Keep `fly.toml` (control plane still runs on Fly). Keep the
   `fly_app/machine_id/volume_id` columns until step 3.
1. Observe only: `inspect()` on both providers, `SpritesClient.getService`, migration
   `0029` adds `runner_instances.worker_incarnation text`, `channel.hello` carries
   `incarnation`, accept path stores it, boot reconcile logs disagreement. No consumer.
2. `resolveLiveness` replaces both predicates (keep names as thin adapters first, then move
   call sites by question group). Add `ensureWorkerConnected` on every delivery path.
3. Delete the clocks: `HEARTBEAT_INTERVAL_MS`, heartbeat writer, `stampRunHeartbeatTx`,
   `HEARTBEAT_STALE_MS`, `isLeaseLive/isWorkerLive/isWorkerClaimLive`, `isWakeIntentFresh`,
   `wake_requested_at`, `controller_lease_expires_at`, `channel_connected_at`,
   `channel_last_seen_at`, repository `HEARTBEAT_MS/LEASE_MS`, lifecycle `suspend` action and
   `TASK_ORCH_RUNNER_SUSPEND_MS`. Worker enforces single controller (closes the older one on a
   new accept). Migration `0030` drops those columns plus `fly_app/machine_id/volume_id`,
   `agent_runs.worker_pid`, `agent_runs.heartbeat_at`. Keep: per-turn deadline
   (`budget_max_seconds`) and destroy retention.

## Gates per step

`npm run typecheck` and `npx vitest run` green. Steps 1–2: one prod run with a wake after
idle, one with `DELETE /services/worker` mid-turn → `dead("replaced")` + immediate re-dispatch.
