// lib/runner/fly.ts
// Fly Machines-backed RunnerProvider implementation.

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { agentEvents, agentSessions, runnerInstances } from "@/db/schema";
import { isTerminalStatus, type SessionStatus } from "../types";
import { isWorkerClaimLive, nextLifecycleAction } from "./lifecycle";
import type { CreateRunnerInput, RunnerProvider, RunnerRef, RunnerState } from "./provider";
import { type FlyClient, type FlyMachine, type FlyMachineConfig, type FlyVolume, makeFlyClient } from "./fly-client";

const DEFAULT_REGION = "ams";
const DEFAULT_VOLUME_GB = 20;
const DEFAULT_POLL_MS = 10_000;
const SWEEP_MIN_SILENCE_MS = 30_000;
const FLY_MONITOR_KEY = "__taskOrchFlyRunnerMonitor";

const LEASE_STATUSES = new Set<string>(["preparing", "running", "pushing", "opening_pr"]);

function intEnv(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
}

function envValue(key: string): string | undefined {
  const value = process.env[key];
  return value == null ? undefined : value;
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
 * is now an active lease status (a plan-executor's turn started running) or
 * its worker claim is live again (a chat worker woke to a new message and
 * renewed its heartbeat). Exported as a pure predicate so it's directly unit
 * testable without racing real timing against a live sweep.
 */
export function isEligibleForLifecycleAction(row: {
  status: string | null;
  workerScope: string | null;
  heartbeatAt: Date | null;
}): boolean {
  return !isActiveRunStatus(row.status) && !isWorkerClaimLive(row);
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

async function emitRunnerEvent(runId: number, type: string, payload: Record<string, unknown> = {}): Promise<void> {
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

export function buildFlyWorkerEnv(runId: number): Record<string, string> {
  return compactEnv({
    DATABASE_URL: envValue("DATABASE_URL"),
    GH_TOKEN: envValue("GH_TOKEN"),
    CLAUDE_CODE_OAUTH_TOKEN: envValue("CLAUDE_CODE_OAUTH_TOKEN"),
    ANTHROPIC_API_KEY: envValue("ANTHROPIC_API_KEY"),
    TASK_ORCH_AGENT_BACKEND: envValue("TASK_ORCH_AGENT_BACKEND"),
    TASK_ORCH_CHAT_MODEL: envValue("TASK_ORCH_CHAT_MODEL"),
    TASK_ORCH_AGENT_MODEL: envValue("TASK_ORCH_AGENT_MODEL"),
    TASK_ORCH_CHAT_IDLE_MS: envValue("TASK_ORCH_CHAT_IDLE_MS"),
    TASK_ORCH_PG_SCHEMA: envValue("TASK_ORCH_PG_SCHEMA"),
    TASK_ORCH_DETACHED_RUNS: "1",
    TASK_ORCH_INSIDE_WORKER: "1",
    RUN_ID: String(runId),
    SESSION_ROOT: "/mnt/session",
  });
}

export function buildFlyMachineConfig(runId: number, volumeId: string): FlyMachineConfig {
  return {
    image: process.env.FLY_RUNNER_IMAGE || "fly-runner:latest",
    env: buildFlyWorkerEnv(runId),
    mounts: [{ volume: volumeId, path: "/mnt/session" }],
    guest: {
      cpu_kind: "shared",
      cpus: intEnv("TASK_ORCH_FLY_CPUS", 2),
      memory_mb: intEnv("TASK_ORCH_FLY_MEMORY_MB", 4096),
    },
    restart: { policy: "on-failure", max_retries: 3 },
    metadata: { run_id: String(runId), managed_by: "task-orchestrator" },
  };
}

export class FlyRunnerProvider implements RunnerProvider {
  readonly kind = "fly" as const;

  constructor(private readonly flyClient: FlyClient = makeFlyClient()) {}

  async create(input: CreateRunnerInput): Promise<RunnerRef | null> {
    const existing = await this.getInstance(input.runId);
    if (existing?.volumeId) return this.resume(input.runId, input.scope);

    const region = process.env.TASK_ORCH_FLY_REGION || DEFAULT_REGION;
    const sizeGb = intEnv("TASK_ORCH_RUNNER_VOLUME_GB", DEFAULT_VOLUME_GB);
    let volume: FlyVolume | null = null;
    let machine: FlyMachine | null = null;
    try {
      volume = await this.flyClient.createVolume({
        name: `vol-run-${input.runId}`,
        region,
        size_gb: sizeGb,
      });
      machine = await this.flyClient.createMachine({
        name: input.scope,
        region,
        config: buildFlyMachineConfig(input.runId, volume.id),
      });

      await db
        .insert(runnerInstances)
        .values({
          runId: input.runId,
          provider: "fly",
          flyApp: process.env.FLY_APP_NAME ?? null,
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
            flyApp: process.env.FLY_APP_NAME ?? null,
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
      return null;
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
          await this.flyClient.startMachine(machine.id);
          await this.updateInstance(runId, {
            machineId: machine.id,
            state: "starting",
            lastStartedAt: now,
            region: machine.region || region,
          });
          await emitRunnerEvent(runId, "runner_resumed", { machineId: machine.id, state });
          return { runId, handle: machine.id, provider: "fly" };
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
      const machine = await this.flyClient.createMachine({
        name: scope,
        region,
        config: buildFlyMachineConfig(runId, instance.volumeId),
      });
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
      return null;
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
        archivedUri: runnerInstances.archivedUri,
        runStatus: agentSessions.status,
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
  }

  startMonitor(): void {
    const g = globalThis as Record<string, unknown>;
    if (g[FLY_MONITOR_KEY]) return;
    const intervalMs = intEnv("TASK_ORCH_FLY_POLL_MS", DEFAULT_POLL_MS);
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
      archivedUri: string | null;
      workerScope: string | null;
      heartbeatAt: Date | null;
      completedAt: Date | null;
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
        })
        .from(agentSessions)
        .where(eq(agentSessions.id, row.runId));
      if (fresh && !isEligibleForLifecycleAction(fresh)) return;
    }

    const now = new Date();
    if (action.kind === "suspend") {
      await this.flyClient.suspendMachine(row.machineId);
      await this.releaseRunClaimIfCurrent(row.runId, row.machineId);
      await this.updateInstance(row.runId, { state: "suspended", lastSuspendedAt: now });
      await emitRunnerEvent(row.runId, "runner_suspended", { machineId: row.machineId, idleMs });
      return;
    }

    if (action.kind === "stop") {
      await this.flyClient.stopMachine(row.machineId);
      await this.releaseRunClaimIfCurrent(row.runId, row.machineId);
      await this.updateInstance(row.runId, { state: "stopped" });
      await emitRunnerEvent(row.runId, "runner_stopped", { machineId: row.machineId, idleMs });
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
      await this.flyClient.destroyMachine(row.machineId, { force: true }).catch(() => {});
      if (row.volumeId) await this.flyClient.destroyVolume(row.volumeId).catch(() => {});
      await this.releaseRunClaimIfCurrent(row.runId, row.machineId);
      // Both are now destroyed on Fly's side — clear the mapping too, or a later
      // dispatch would resume() into a dead machine/volume instead of creating
      // fresh ones.
      await this.updateInstance(row.runId, { state: "gone", machineId: null, volumeId: null });
      await emitRunnerEvent(row.runId, "runner_destroyed", {
        machineId: row.machineId,
        volumeId: row.volumeId,
        idleMs,
      });
    }
  }
}

export type { FlyMachineConfig, FlyMachine, FlyVolume };
