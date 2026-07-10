// lib/runner/fly.ts
// Fly Machines-backed RunnerProvider implementation.

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { agentEvents, agentSessions, runnerInstances } from "@/db/schema";
import { agentCredentialEnv } from "../agent-backend/provider-env";
import { config } from "../config";
import { isTerminalStatus, type SessionStatus } from "../types";
import { isWakeIntentFresh, isWorkerClaimLive, nextLifecycleAction } from "./lifecycle";
import { nestedDispatchMode } from "./provider";
import { recordRunnerEvent, timeRunnerPhase } from "./telemetry";
import { workerDispatchEnv } from "../worker/token";
import type { CreateRunnerInput, RunnerProvider, RunnerRef, RunnerState } from "./provider";
import { FlyApiError, type FlyClient, type FlyMachine, type FlyMachineConfig, type FlyVolume, makeFlyClient } from "./fly-client";

const DEFAULT_REGION = "ams";
// Measured default: a repo checkout + npm cache footprint fits comfortably in
// 10 GB for the vast majority of runs. Overridable per-deployment via
// TASK_ORCH_RUNNER_VOLUME_GB (see create()) for heavy repos that need more.

// Prewarm seed volume: a persistent volume (populated by
// scripts/seed-prewarm-volume.ts) holding a baked nodetool `npm ci` under
// PREWARM_MOUNT_DIR. create() forks it into each run's volume so the run boots
// with warm deps — without a 5 GB image (which blew past Fly's 8 GB image cap).
// Named WITHOUT the `vol_run_` prefix so the orphan reaper (isReapableVolume)
// never touches it. Empty name disables forking (runs cold-install).
const PREWARM_SEED_VOLUME_NAME = process.env.TASK_ORCH_PREWARM_SEED_VOLUME ?? "prewarm_seed";
// Where the seed's prewarm tree lands once the forked volume is mounted at
// /mnt/session. Must match scripts/seed-prewarm-volume.ts.
const PREWARM_MOUNT_DIR = "/mnt/session/prewarm";
const SWEEP_MIN_SILENCE_MS = 30_000;
// Grace window so a just-created, not-yet-attached volume isn't reaped mid-
// provision. create() runs createVolume → createMachine → insert runner_instances
// as three separate steps; between the first two a fresh volume legitimately has
// no attachment and no row, so we must let it age past this window before it can
// look like a leak.
const REAP_MIN_AGE_MS = 10 * 60_000; // 10 min
const FLY_MONITOR_KEY = "__taskOrchFlyRunnerMonitor";

const LEASE_STATUSES = new Set<string>(["preparing", "running", "pushing", "opening_pr"]);

function envValue(key: string): string | undefined {
  const value = process.env[key];
  return value == null ? undefined : value;
}

// The runner (pool) app name. NOTE: `FLY_APP_NAME` is reserved by Fly — its
// runtime injects the *current* Machine's own app name, overriding any secret
// we stage, so on Fly it always resolves to the web app, not the runner pool.
// Read `TASK_ORCH_FLY_APP` first; keep `FLY_APP_NAME` only as a local/dev fallback.
export function runnerAppName(): string | undefined {
  return process.env.TASK_ORCH_FLY_APP ?? process.env.FLY_APP_NAME;
}

function compactEnv(entries: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value != null) env[key] = value;
  }
  return env;
}

function machineStateToRunnerState(state: string): RunnerState {
  // Observed/expected Fly Machines states from the live API are generally:
  // created/starting/started/stopping/stopped/suspending/suspended/destroyed.
  // Unknown transient states stay conservative as "starting" so the death policy
  // only fires when the machine is actually missing from listMachines().
  switch (state) {
    case "started":
    case "running":
      return "running";
    case "suspended":
      return "suspended";
    case "stopped":
      return "stopped";
    case "destroyed":
    case "destroying":
    case "gone":
      return "gone";
    case "created":
    case "creating":
    case "starting":
    case "stopping":
    case "suspending":
    default:
      return "starting";
  }
}

function isActiveRunStatus(status: string | null): boolean {
  return !!status && LEASE_STATUSES.has(status);
}

/**
 * Whether a run row — freshly re-read immediately before executing a queued
 * suspend/stop — is STILL eligible for that action. False when the run has
 * become active since the sweep took its decision snapshot: either its status
 * is now an active lease status (a plan-executor's turn started running), its
 * worker claim is live again (a chat worker woke to a new message and renewed
 * its heartbeat), or a wake intent was recorded since the snapshot (resume()
 * just told Fly to start this machine — the booting worker has no heartbeat
 * yet, so only the intent protects it; run-139 incident). Exported as a pure
 * predicate so it's directly unit testable without racing real timing against
 * a live sweep.
 */
export function isEligibleForLifecycleAction(row: {
  status: string | null;
  workerScope: string | null;
  heartbeatAt: Date | null;
  wakeRequestedAt?: Date | null;
}): boolean {
  return !isActiveRunStatus(row.status) && !isWorkerClaimLive(row) && !isWakeIntentFresh(row);
}

/**
 * Whether a Fly volume is a safe-to-destroy LEAK: an orphan with no attached
 * Machine and no live/resumable runner_instances row referencing it. Exported as
 * a pure predicate so the guards are directly unit-testable without a live sweep.
 *
 * Returns true ONLY when ALL of these hold:
 *  - name starts with `vol_run_` — our own create() naming. We NEVER touch a
 *    volume we didn't create; a missing name is treated as NOT reapable (a
 *    volume whose provenance we can't confirm is left alone).
 *  - attachedMachineId is null/undefined/empty — a volume with a machine attached
 *    is in use (or mid-attach) and must not be destroyed.
 *  - vol.id is NOT in protectedVolumeIds — the caller protects every volumeId
 *    still referenced by a non-"gone" runner_instances row (a run that may still
 *    resume / is mid-lifecycle). This is deliberately conservative.
 *  - the volume is older than REAP_MIN_AGE_MS — the grace window that keeps the
 *    reaper from nuking a volume that's seconds away from being attached by an
 *    in-flight create(). When createdAt is absent/null we treat the volume as OLD
 *    ENOUGH (reapable): a leaked volume from a crash often carries no usable
 *    timestamp, and we don't want unknown-age leaks to live forever. The name +
 *    unattached + unprotected guards already make this safe.
 */
export function isReapableVolume(
  vol: { id: string; name?: string; attachedMachineId?: string | null; createdAt?: Date | null },
  protectedVolumeIds: Set<string>,
  nowMs: number
): boolean {
  if (!vol.name || !vol.name.startsWith("vol_run_")) return false;
  if (vol.attachedMachineId) return false;
  if (protectedVolumeIds.has(vol.id)) return false;
  // createdAt absent/null → unknown age → treat as old enough (reapable); see
  // doc-comment above for why leaks must not be immortal.
  if (vol.createdAt && nowMs - vol.createdAt.getTime() < REAP_MIN_AGE_MS) return false;
  return true;
}

/**
 * Destroy LEAKED per-run volumes with the shared `isReapableVolume` guards: an
 * unattached `vol_run_*` volume no non-"gone" runner_instances row references,
 * aged past the grace window. Shared by the sweep and the `runners --reap` CLI
 * so both paths apply the same safety checks. Crash-safe and idempotent — a
 * second pass finds the already-destroyed volume gone from listVolumes().
 * Returns the ids actually destroyed.
 */
export async function reapOrphanVolumes(flyClient: FlyClient, nowMs: number = Date.now()): Promise<string[]> {
  let volumes: FlyVolume[];
  try {
    volumes = await flyClient.listVolumes();
  } catch (err) {
    console.error("[FlyRunnerProvider] reapOrphanVolumes listVolumes failed:", err);
    return [];
  }

  // Protect every volumeId still mapped by a non-"gone" runner_instances row —
  // the run may still resume or is mid-lifecycle. Conservative by design.
  const mappings = await db
    .select({ volumeId: runnerInstances.volumeId, state: runnerInstances.state })
    .from(runnerInstances)
    .leftJoin(agentSessions, eq(agentSessions.id, runnerInstances.runId));
  const protectedVolumeIds = new Set<string>();
  for (const m of mappings) {
    if (m.volumeId && m.state !== "gone") protectedVolumeIds.add(m.volumeId);
  }

  const destroyed: string[] = [];
  for (const vol of volumes) {
    if (!isReapableVolume(vol, protectedVolumeIds, nowMs)) continue;
    // Destroy FIRST and only touch the DB/emit events on a CONFIRMED destroy.
    // If the destroy fails we leave the mapping intact — clearing volumeId on a
    // still-existing volume would strand a resumable run and lose the pointer we
    // need to retry — and let the next sweep retry. A 404 means the volume is
    // already gone: treat it as an idempotent success.
    try {
      await flyClient.destroyVolume(vol.id);
    } catch (err) {
      if (!(err instanceof FlyApiError && err.status === 404)) {
        console.error(`[FlyRunnerProvider] reap destroyVolume ${vol.id} failed:`, err);
        continue;
      }
    }
    destroyed.push(vol.id);
    try {
      // A leaked volume may have no run row. emitRunnerEvent needs a runId FK
      // (agent_events.run_id is NOT-NULL → agent_sessions); only emit when a
      // runner_instances row still references this volume. Never fabricate one.
      const [ref] = await db
        .select({ runId: runnerInstances.runId })
        .from(runnerInstances)
        .where(eq(runnerInstances.volumeId, vol.id));
      if (ref) {
        await emitRunnerEvent(ref.runId, "runner_volume_reaped", { volumeId: vol.id });
        // A "gone" row can still carry a stale volumeId — clear it so we don't
        // re-examine a destroyed volume, and so nothing resumes into it.
        await db
          .update(runnerInstances)
          .set({ volumeId: null })
          .where(eq(runnerInstances.volumeId, vol.id));
        // The transcript died with this volume — clear the run's SDK resume
        // token so a later revival starts a fresh SDK session instead of
        // resuming into a transcript that no longer exists.
        await clearSdkSession(ref.runId);
      } else {
        console.log(`[FlyRunnerProvider] reaped orphan volume ${vol.id} (no run row)`);
      }
    } catch (err) {
      // Bookkeeping failure after a confirmed destroy must not starve the rest
      // of the reap pass; the volume is already gone on Fly's side.
      console.error(`[FlyRunnerProvider] reap bookkeeping failed for volume ${vol.id}:`, err);
    }
  }
  return destroyed;
}

function lastActivityMs(row: {
  heartbeatAt: Date | null;
  completedAt: Date | null;
  lastSuspendedAt: Date | null;
  lastStartedAt: Date | null;
  createdAt: Date;
}): number {
  return Math.max(
    row.heartbeatAt?.getTime() ?? 0,
    row.completedAt?.getTime() ?? 0,
    row.lastSuspendedAt?.getTime() ?? 0,
    row.lastStartedAt?.getTime() ?? 0,
    row.createdAt.getTime()
  );
}

/**
 * Clear a run's stored SDK resume token. Call this whenever the run's volume is
 * destroyed: the Claude Agent SDK's conversation transcript lives on that volume
 * (HOME=$SESSION_ROOT/claude-home, see scripts/fly-runner-entry.sh), so once the
 * volume is gone the resume id (agent_sessions.sdk_session_id, replayed as
 * `resume: <id>` by the Claude backend) dangles — resuming it either errors
 * ("no conversation found") or silently starts fresh against a transcript that
 * no longer exists. Clearing it lets the next turn knowingly start a fresh SDK
 * session. Best-effort: a bookkeeping failure must never break the sweep/reap/
 * stop path that already destroyed the volume on Fly's side.
 */
async function clearSdkSession(runId: number): Promise<void> {
  try {
    await db.update(agentSessions).set({ sdkSessionId: null }).where(eq(agentSessions.id, runId));
  } catch (err) {
    console.error(`[FlyRunnerProvider] clearSdkSession failed for run ${runId}:`, err);
  }
}

async function emitRunnerEvent(runId: number, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  recordRunnerEvent(type, { provider: "fly", runId, fields: payload });
  try {
    await db.insert(agentEvents).values({
      sessionId: runId,
      type,
      payload: JSON.stringify(payload),
      createdAt: new Date(),
    });
  } catch {
    // Lifecycle events are observability only; never break reconciliation.
  }
}

export function buildFlyWorkerEnv(
  runId: number,
  opts: { prewarmDir?: string } = {}
): Record<string, string> {
  // Worker HTTP protocol (docs/worker-http-api.md): every Machine gets a
  // run-scoped API token and talks to /api/worker over HTTP + SSE. Workers
  // hold NO database credentials — DATABASE_URL is deliberately absent.
  return compactEnv({
    ...workerDispatchEnv(runId),
    // Set only when this run's volume was forked from the prewarm seed, so the
    // baked deps live at PREWARM_MOUNT_DIR. lib/prewarm.ts existsSync-guards it,
    // and compactEnv drops it when undefined (no seed → cold install).
    PREWARM_DIR: opts.prewarmDir,
    GH_TOKEN: envValue("GH_TOKEN"),
    // Agent credentials for BOTH backends: the Claude auth pair plus every
    // pi provider key the server holds, so a Machine dispatched with
    // TASK_ORCH_AGENT_BACKEND=pi can reach non-Anthropic providers too.
    ...agentCredentialEnv(),
    TASK_ORCH_AGENT_BACKEND: envValue("TASK_ORCH_AGENT_BACKEND"),
    TASK_ORCH_CHAT_MODEL: envValue("TASK_ORCH_CHAT_MODEL"),
    TASK_ORCH_AGENT_MODEL: envValue("TASK_ORCH_AGENT_MODEL"),
    TASK_ORCH_CHAT_IDLE_MS: envValue("TASK_ORCH_CHAT_IDLE_MS"),
    TASK_ORCH_DETACHED_RUNS: "1",
    TASK_ORCH_INSIDE_WORKER: "1",
    // Pass the server's RESOLVED nested-dispatch policy (docs/nested-machine-
    // dispatch.md, Decision 5), not the raw env: workers never get
    // TASK_ORCH_RUNNER, so the Fly default can't resolve inside them — the
    // effective value must be handed down so a worker's children (and their
    // children) inherit the server's policy.
    TASK_ORCH_NESTED_DISPATCH: nestedDispatchMode(),
    RUN_ID: String(runId),
    SESSION_ROOT: "/mnt/session",
    // Point the worker's --reference mirror lookup at the image-baked repo cache.
    // Operators can override the in-image path via TASK_ORCH_REPO_CACHE_DIR; the
    // ?? default keeps this entry present through compactEnv (which drops
    // undefined). Safe when the dir is missing: containerCheckoutAt guards with
    // existsSync before using the mirror.
    REPO_CACHE_DIR: envValue("TASK_ORCH_REPO_CACHE_DIR") ?? "/opt/repo-cache",
  });
}

// Fly's shared-cpu machines enforce a hard memory-per-vCPU ratio — 256MB to
// 2048MB per vCPU (see https://fly.io/docs/machines/guides-examples/machine-sizing/).
// A TASK_ORCH_FLY_CPUS/TASK_ORCH_FLY_MEMORY_MB pair outside that range is
// rejected by createMachine at the API layer, which upstream (run-dispatch.ts)
// can only report as an opaque "spawn returned no pid" failure — no indication
// the actual problem is the resource *ratio*. Incident: run 59 (2026-07-06),
// TASK_ORCH_FLY_MEMORY_MB was bumped to 8192 to fix OOM-killed workers, but
// TASK_ORCH_FLY_CPUS stayed at its old default of 2 (max for 2 vCPU is 4096MB).
// Validating here fails fast with the real numbers instead of a guessing game.
function assertValidSharedMachineResources(cpus: number, memoryMb: number): void {
  const minMb = 256 * cpus;
  const maxMb = 2048 * cpus;
  if (memoryMb < minMb || memoryMb > maxMb) {
    throw new Error(
      `invalid Fly runner config: ${memoryMb}MB memory for ${cpus} vCPU (shared-cpu allows ` +
        `${minMb}-${maxMb}MB for ${cpus} vCPU) — check TASK_ORCH_FLY_CPUS/TASK_ORCH_FLY_MEMORY_MB`
    );
  }
}

export function buildFlyMachineConfig(
  runId: number,
  volumeId: string,
  opts: { prewarmDir?: string } = {}
): FlyMachineConfig {
  // Default bumped from 2→4 vCPU alongside the existing 4096MB memory default:
  // 4 vCPU supports up to 8192MB, matching the memory ceiling operators reach
  // for first under OOM pressure (see incident note above).
  const cpus = config.fly.cpus;
  const memoryMb = config.fly.memoryMb;
  assertValidSharedMachineResources(cpus, memoryMb);
  return {
    image: process.env.FLY_RUNNER_IMAGE || "fly-runner:latest",
    env: buildFlyWorkerEnv(runId, opts),
    mounts: [{ volume: volumeId, path: "/mnt/session" }],
    guest: {
      cpu_kind: "shared",
      cpus,
      memory_mb: memoryMb,
    },
    restart: { policy: "on-failure", max_retries: 3 },
    metadata: { run_id: String(runId), managed_by: "task-orchestrator" },
  };
}

export class FlyRunnerProvider implements RunnerProvider {
  readonly kind = "fly" as const;

  constructor(private readonly flyClient: FlyClient = makeFlyClient()) {}

  /**
   * The prewarm seed volume to fork for a new run, or null when none is usable
   * (feature disabled, no seed in this region, or a listing error). Best-effort:
   * never throws — a missing seed just means the run cold-installs.
   */
  private async resolvePrewarmSeed(region: string): Promise<FlyVolume | null> {
    if (!PREWARM_SEED_VOLUME_NAME) return null;
    try {
      const requiredGb = config.fly.volumeGb;
      const volumes = await this.flyClient.listVolumes();
      const seed =
        volumes.find(
          (v) =>
            v.name === PREWARM_SEED_VOLUME_NAME &&
            v.region === region &&
            // Skip a seed mid-provision/teardown; "created"/"ready" are forkable.
            (v.state == null || v.state === "created" || v.state === "ready")
        ) ?? null;
      if (seed?.sizeGb != null && seed.sizeGb < requiredGb) {
        console.error(
          `[FlyRunnerProvider] prewarm seed ${seed.id} is ${seed.sizeGb} GB, smaller than ` +
            `TASK_ORCH_RUNNER_VOLUME_GB=${requiredGb}; skipping fork because Fly volume forks ` +
            `inherit source size`
        );
        return null;
      }
      return seed;
    } catch (err) {
      console.error("[FlyRunnerProvider] resolvePrewarmSeed failed:", err);
      return null;
    }
  }

  async create(input: CreateRunnerInput): Promise<RunnerRef | null> {
    const existing = await this.getInstance(input.runId);
    if (existing?.volumeId) return this.resume(input.runId, input.scope);

    const region = process.env.TASK_ORCH_FLY_REGION || DEFAULT_REGION;
    const configuredGb = config.fly.volumeGb;
    // Fork the prewarm seed when one exists: the run boots with warm deps at
    // PREWARM_MOUNT_DIR and skips the cold install. Fly rejects size_gb on fork
    // requests, so forked volumes inherit the seed size. No seed → blank volume
    // with the configured size + cold install (unchanged path).
    const seed = await this.resolvePrewarmSeed(region);
    const prewarmDir = seed ? PREWARM_MOUNT_DIR : undefined;
    let volume: FlyVolume | null = null;
    let machine: FlyMachine | null = null;
    try {
      volume = await timeRunnerPhase(
        seed ? "fly_volume_fork" : "fly_volume_create",
        () =>
          this.flyClient.createVolume({
            // Fly volume names allow only [a-z0-9_] (<=30 chars) — no hyphens,
            // unlike Machine names. runId is numeric, so vol_run_<id> is always valid.
            name: `vol_run_${input.runId}`,
            region,
            ...(seed ? { source_volume_id: seed.id } : { size_gb: configuredGb }),
          }),
        { provider: "fly", fields: { runId: input.runId, region, prewarm: !!seed } }
      );
      machine = await timeRunnerPhase(
        "fly_machine_create",
        () =>
          this.flyClient.createMachine({
            name: input.scope,
            region,
            config: buildFlyMachineConfig(input.runId, volume!.id, { prewarmDir }),
          }),
        { provider: "fly", fields: { runId: input.runId, region, scope: input.scope } }
      );

      await db
        .insert(runnerInstances)
        .values({
          runId: input.runId,
          provider: "fly",
          flyApp: runnerAppName() ?? null,
          machineId: machine.id,
          volumeId: volume.id,
          region: machine.region || volume.region || region,
          state: "starting",
          lastStartedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: runnerInstances.runId,
          set: {
            provider: "fly",
            flyApp: runnerAppName() ?? null,
            machineId: machine.id,
            volumeId: volume.id,
            region: machine.region || volume.region || region,
            state: "starting",
            lastStartedAt: new Date(),
          },
        });
      await emitRunnerEvent(input.runId, "runner_created", {
        machineId: machine.id,
        volumeId: volume.id,
        region: machine.region || volume.region || region,
      });
      return { runId: input.runId, handle: machine.id, provider: "fly" };
    } catch (err) {
      console.error("[FlyRunnerProvider] create failed:", err);
      if (machine?.id) await this.flyClient.destroyMachine(machine.id, { force: true }).catch(() => {});
      if (volume?.id) await this.flyClient.destroyVolume(volume.id).catch(() => {});
      throw err;
    }
  }

  async resume(runId: number, scope = `run-${runId}-${Date.now()}`): Promise<RunnerRef | null> {
    const instance = await this.getInstance(runId);
    if (!instance?.volumeId) return null;
    const region = instance.region || process.env.TASK_ORCH_FLY_REGION || DEFAULT_REGION;
    const now = new Date();

    if (instance.machineId) {
      const machine = await this.flyClient.getMachine(instance.machineId);
      if (machine) {
        const state = machineStateToRunnerState(machine.state);
        // A "gone" machine (destroyed/destroying) is not a live runner even
        // though Fly still answers GET for it — fall through to cold-recovering
        // a fresh machine from the volume below instead of returning it as a
        // live handle. Returning it here would hand the sweep a corpse it
        // re-death-detects and re-dispatches into forever.
        if (state === "suspended" || state === "stopped") {
          // Record the wake intent BEFORE the Fly call: from the instant the
          // machine reports "started" until the booting worker writes its first
          // heartbeat there is NO live claim on the run, and a lifecycle sweep
          // tick landing in that window sees a running machine with a parked/
          // idle run and suspends it mid-boot (incident: run 139, suspended
          // 64ms after its wake, then failed by the reaper for the heartbeat it
          // never wrote). The intent is cleared by the worker's first heartbeat
          // (see the db transport) or ages out past the wake grace window.
          await this.updateInstance(runId, { wakeRequestedAt: now });
          let started = true;
          try {
            await timeRunnerPhase(
              "fly_machine_start",
              () => this.startMachineWithRetry(machine.id, runId),
              { provider: "fly", fields: { runId, machineId: machine.id, state } }
            );
          } catch (err) {
            // Unrecoverable wake (e.g. repeated 409 "machine exited abruptly"):
            // the machine is a corpse, but the VOLUME — the run's warm checkout,
            // unpushed work, and SDK transcript — is intact. Destroy the corpse
            // and fall through to the cold-recover path below, which creates a
            // fresh machine on the same volume, instead of surfacing the error
            // as a spawn failure that fails the run outright (incident: run 135
            // died on a single un-retried 409).
            started = false;
            console.error(
              `[FlyRunnerProvider] startMachine ${machine.id} failed after retries; cold-recovering:`,
              err
            );
            await emitRunnerEvent(runId, "runner_wake_failed", {
              machineId: machine.id,
              error: err instanceof Error ? err.message : String(err),
            });
            await this.flyClient.destroyMachine(machine.id, { force: true }).catch(() => {});
          }
          if (started) {
            await this.updateInstance(runId, {
              machineId: machine.id,
              state: "starting",
              lastStartedAt: now,
              region: machine.region || region,
            });
            await emitRunnerEvent(runId, "runner_resumed", { machineId: machine.id, state });
            return { runId, handle: machine.id, provider: "fly" };
          }
        } else if (state !== "gone") {
          await this.updateInstance(runId, {
            machineId: machine.id,
            state,
            lastStartedAt: state === "running" ? now : instance.lastStartedAt,
            region: machine.region || region,
          });
          return { runId, handle: machine.id, provider: "fly" };
        }
      }
    }

    try {
      const volumeId = instance.volumeId;
      if (!volumeId) return null;
      // Same boot window as the warm start above: the fresh machine runs before
      // its worker heartbeats, so the wake intent must already be on the row.
      await this.updateInstance(runId, { wakeRequestedAt: now });
      const machine = await timeRunnerPhase(
        "fly_machine_cold_recover_create",
        () =>
          this.flyClient.createMachine({
            name: scope,
            region,
            config: buildFlyMachineConfig(runId, volumeId),
          }),
        { provider: "fly", fields: { runId, region, scope } }
      );
      await this.updateInstance(runId, {
        machineId: machine.id,
        state: "starting",
        lastStartedAt: now,
        region: machine.region || region,
      });
      await emitRunnerEvent(runId, "runner_cold_recovered", {
        machineId: machine.id,
        volumeId: instance.volumeId,
        region: machine.region || region,
      });
      return { runId, handle: machine.id, provider: "fly" };
    } catch (err) {
      // The volume itself may be gone too (e.g. destroyed alongside a stale
      // machine) — clear the mapping so the next create() provisions an
      // entirely fresh volume+machine instead of retrying against a dead
      // volume forever.
      console.error("[FlyRunnerProvider] resume cold-recover failed:", err);
      await this.updateInstance(runId, { machineId: null, volumeId: null, state: "gone" });
      // The volume is concluded gone → its transcript is unrecoverable; drop the
      // stale SDK resume token so the next create() + turn starts a fresh SDK
      // session instead of dangling.
      await clearSdkSession(runId);
      return null;
    }
  }

  /**
   * startMachine with a bounded retry on Fly 409s. Fly answers 409 (e.g.
   * "machine exited abruptly", or a state-transition conflict) for a machine
   * that transiently can't accept a start; run 135 saw ONE such 409 propagate
   * straight to failSpawn and fail the run. Two retries with short backoff
   * cover the transient case; a machine still 409ing after that is handed back
   * to the caller, which cold-recovers a fresh machine on the same volume.
   * Non-409 errors are never retried — they indicate a different failure the
   * caller's fallback should see immediately.
   */
  private async startMachineWithRetry(machineId: string, runId: number): Promise<void> {
    const backoffMs = [500, 1500];
    for (let attempt = 0; ; attempt++) {
      try {
        await this.flyClient.startMachine(machineId);
        return;
      } catch (err) {
        if (!(err instanceof FlyApiError && err.status === 409) || attempt >= backoffMs.length) {
          throw err;
        }
        await emitRunnerEvent(runId, "runner_wake_retry", {
          machineId,
          attempt: attempt + 1,
          error: err.message,
        });
        await new Promise((r) => setTimeout(r, backoffMs[attempt]));
      }
    }
  }

  async stop(handle: string): Promise<void> {
    await this.flyClient.destroyMachine(handle, { force: true }).catch(() => {});
    const [row] = await db
      .select({ runId: runnerInstances.runId, volumeId: runnerInstances.volumeId })
      .from(runnerInstances)
      .where(eq(runnerInstances.machineId, handle));
    if (row) {
      // A hard stop is a permanent cancel, not an idle suspend — unlike lifecycle
      // suspend/stop, there is no future resume to preserve the volume for, so
      // reclaim it now (mirrors archive-and-destroy's ordering/error handling).
      if (row.volumeId) await this.flyClient.destroyVolume(row.volumeId).catch(() => {});
      await this.releaseRunClaimIfCurrent(row.runId, handle);
      await this.updateInstance(row.runId, { state: "gone", machineId: null, volumeId: null });
      // The volume (and its SDK transcript) is gone — clear the stale resume
      // token so a later revival starts a fresh SDK session.
      if (row.volumeId) await clearSdkSession(row.runId);
      await emitRunnerEvent(row.runId, "runner_failed", { machineId: handle, reason: "stopped" });
    }
  }

  async sweep(): Promise<void> {
    let machines: FlyMachine[];
    try {
      machines = await this.flyClient.listMachines();
    } catch (err) {
      console.error("[FlyRunnerProvider] sweep listMachines failed:", err);
      return;
    }
    const machineById = new Map(machines.map((m) => [m.id, m]));
    const rows = await db
      .select({
        runId: runnerInstances.runId,
        machineId: runnerInstances.machineId,
        volumeId: runnerInstances.volumeId,
        state: runnerInstances.state,
        region: runnerInstances.region,
        createdAt: runnerInstances.createdAt,
        lastStartedAt: runnerInstances.lastStartedAt,
        lastSuspendedAt: runnerInstances.lastSuspendedAt,
        wakeRequestedAt: runnerInstances.wakeRequestedAt,
        archivedUri: runnerInstances.archivedUri,
        runStatus: agentSessions.status,
        runGoal: agentSessions.goal,
        workerScope: agentSessions.workerScope,
        heartbeatAt: agentSessions.heartbeatAt,
        completedAt: agentSessions.completedAt,
      })
      .from(runnerInstances)
      .leftJoin(agentSessions, eq(agentSessions.id, runnerInstances.runId))
      .where(eq(runnerInstances.provider, "fly"));

    const now = Date.now();
    for (const row of rows) {
      if (!row.machineId) continue;
      // One row's FlyApiError (e.g. a 412 on an invalid state transition) must
      // not starve death-detection/lifecycle for every row after it on this
      // tick, or every tick thereafter.
      try {
        const machine = machineById.get(row.machineId);
        if (!machine) {
          await this.updateInstance(row.runId, { state: "gone" });
          const lastSeen = row.heartbeatAt?.getTime() ?? 0;
          if (
            row.workerScope === row.machineId &&
            isActiveRunStatus(row.runStatus) &&
            now - lastSeen >= SWEEP_MIN_SILENCE_MS
          ) {
            const runs = await import("../runs");
            await runs.handleWorkerDeath(row.runId, {
              exitCode: null,
              oomKilled: false,
              containerName: row.machineId,
            });
          }
          continue;
        }

        const runnerState = machineStateToRunnerState(machine.state);
        if (runnerState !== row.state || machine.region !== row.region) {
          await this.updateInstance(row.runId, {
            state: runnerState,
            region: machine.region || row.region,
            ...(runnerState === "running" ? { lastStartedAt: new Date() } : {}),
            ...(runnerState === "suspended" ? { lastSuspendedAt: new Date() } : {}),
          });
        }

        const runStatus = row.runStatus ?? "closed";
        await this.applyLifecycle(row, runnerState, runStatus as SessionStatus, now);
      } catch (err) {
        console.error(`[FlyRunnerProvider] sweep failed for run ${row.runId}:`, err);
      }
    }

    // Reap leaked volumes AFTER the per-row machine loop. Wrapped whole so a
    // listVolumes failure or one destroy failure never breaks the sweep tick.
    try {
      await this.reapOrphanVolumes(now);
    } catch (err) {
      console.error("[FlyRunnerProvider] reapOrphanVolumes failed:", err);
    }
  }

  private async reapOrphanVolumes(nowMs: number): Promise<void> {
    await reapOrphanVolumes(this.flyClient, nowMs);
  }

  startMonitor(): void {
    const g = globalThis as Record<string, unknown>;
    if (g[FLY_MONITOR_KEY]) return;
    const intervalMs = config.fly.pollMs;
    if (intervalMs <= 0) return;
    // A slow/hung Fly API call can make one sweep tick outlive the poll interval;
    // without this guard setInterval piles up overlapping sweeps indefinitely.
    let sweeping = false;
    const tick = () => {
      if (sweeping) return;
      sweeping = true;
      void this.sweep()
        .catch(() => {})
        .finally(() => {
          sweeping = false;
        });
    };
    const timer = setInterval(tick, intervalMs);
    (timer as { unref?: () => void }).unref?.();
    g[FLY_MONITOR_KEY] = timer;
    tick();
  }

  private async getInstance(runId: number): Promise<typeof runnerInstances.$inferSelect | null> {
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, runId));
    return row ?? null;
  }

  private async updateInstance(
    runId: number,
    patch: Partial<typeof runnerInstances.$inferInsert>
  ): Promise<void> {
    await db.update(runnerInstances).set(patch).where(eq(runnerInstances.runId, runId));
  }

  private async releaseRunClaimIfCurrent(runId: number, machineId: string): Promise<void> {
    await db
      .update(agentSessions)
      .set({ workerScope: null, workerPid: null, heartbeatAt: null })
      .where(and(eq(agentSessions.id, runId), eq(agentSessions.workerScope, machineId)));
  }

  private async applyLifecycle(
    row: {
      runId: number;
      machineId: string | null;
      volumeId: string | null;
      state: string;
      createdAt: Date;
      lastStartedAt: Date | null;
      lastSuspendedAt: Date | null;
      wakeRequestedAt: Date | null;
      archivedUri: string | null;
      workerScope: string | null;
      heartbeatAt: Date | null;
      completedAt: Date | null;
      runGoal?: string | null;
    },
    runnerState: RunnerState,
    runStatus: SessionStatus,
    nowMs: number
  ): Promise<void> {
    if (!row.machineId) return;
    const idleMs = Math.max(0, nowMs - lastActivityMs(row));
    const action = nextLifecycleAction({
      runStatus,
      runnerState,
      idleMs,
      workerScope: row.workerScope,
      heartbeatAt: row.heartbeatAt,
      // A fresh wake intent (resume() just told Fly to start this machine, the
      // worker hasn't heartbeated yet) is honored like a live claim.
      wakeRequestedAt: row.wakeRequestedAt,
      // Lets the policy exempt conversational terminal runs (a plan executor
      // between operator messages) from the short terminal retention window.
      goal: row.runGoal,
    });
    if (action.kind === "none") return;

    // The decision above was made from this sweep tick's row snapshot, taken at
    // the top of sweep() — it can be tens of seconds stale by the time we
    // actually execute a suspend/stop. In that window a chat worker may have
    // woken to a new message (renewing its claim) or a plan-executor's status
    // may now be a live lease status. Re-read the row right before acting and
    // skip if it's no longer eligible; the next sweep tick re-decides from a
    // fresh snapshot instead of us suspending/stopping out from under it.
    if (action.kind === "suspend" || action.kind === "stop") {
      const [fresh] = await db
        .select({
          status: agentSessions.status,
          workerScope: agentSessions.workerScope,
          heartbeatAt: agentSessions.heartbeatAt,
          // Re-read the wake intent alongside the claim: resume() stamps it in
          // exactly this snapshot-to-execution window (that IS the run-139
          // race), so the snapshot's value is the one we must not trust here.
          wakeRequestedAt: runnerInstances.wakeRequestedAt,
        })
        .from(agentSessions)
        .leftJoin(runnerInstances, eq(runnerInstances.runId, agentSessions.id))
        .where(eq(agentSessions.id, row.runId));
      if (fresh && !isEligibleForLifecycleAction(fresh)) return;
    }

    const now = new Date();
    const machineId = row.machineId;
    if (!machineId) return;
    if (action.kind === "suspend") {
      await timeRunnerPhase(
        "fly_machine_suspend",
        () => this.flyClient.suspendMachine(machineId),
        { provider: "fly", fields: { runId: row.runId, machineId, idleMs } }
      );
      await this.releaseRunClaimIfCurrent(row.runId, machineId);
      await this.updateInstance(row.runId, { state: "suspended", lastSuspendedAt: now });
      await emitRunnerEvent(row.runId, "runner_suspended", { machineId, idleMs });
      return;
    }

    if (action.kind === "stop") {
      await timeRunnerPhase(
        "fly_machine_stop",
        () => this.flyClient.stopMachine(machineId),
        { provider: "fly", fields: { runId: row.runId, machineId, idleMs } }
      );
      await this.releaseRunClaimIfCurrent(row.runId, machineId);
      await this.updateInstance(row.runId, { state: "stopped" });
      await emitRunnerEvent(row.runId, "runner_stopped", { machineId, idleMs });
      return;
    }

    if (action.kind === "archive-and-destroy") {
      if (process.env.TASK_ORCH_ARCHIVE_R2 && !row.archivedUri) {
        // The control plane cannot read a Fly volume directly. Leave the stopped
        // machine/volume intact and emit a durable request for a future in-runner
        // archiver instead of destroying data without an archive.
        await emitRunnerEvent(row.runId, "runner_archive_requested", {
          machineId: row.machineId,
          volumeId: row.volumeId,
          idleMs,
        });
        return;
      }
      await timeRunnerPhase(
        "fly_machine_destroy",
        () => this.flyClient.destroyMachine(machineId, { force: true }).catch(() => {}),
        { provider: "fly", fields: { runId: row.runId, machineId, idleMs } }
      );
      if (row.volumeId) {
        await timeRunnerPhase(
          "fly_volume_destroy",
          () => this.flyClient.destroyVolume(row.volumeId!).catch(() => {}),
          { provider: "fly", fields: { runId: row.runId, volumeId: row.volumeId, idleMs } }
        );
      }
      await this.releaseRunClaimIfCurrent(row.runId, machineId);
      // Both are now destroyed on Fly's side — clear the mapping too, or a later
      // dispatch would resume() into a dead machine/volume instead of creating
      // fresh ones.
      await this.updateInstance(row.runId, { state: "gone", machineId: null, volumeId: null });
      // The volume (and its SDK transcript) is gone — clear the stale resume
      // token so a later revival starts a fresh SDK session instead of dangling.
      if (row.volumeId) await clearSdkSession(row.runId);
      await emitRunnerEvent(row.runId, "runner_destroyed", {
        machineId,
        volumeId: row.volumeId,
        idleMs,
      });
    }
  }
}

export type { FlyMachineConfig, FlyMachine, FlyVolume };
