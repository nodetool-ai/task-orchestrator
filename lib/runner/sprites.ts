// lib/runner/sprites.ts
// Sprites-backed RunnerProvider — see docs/sprites-migration-design.md

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { agentEvents, agentSessions, runnerInstances } from "@/db/schema";
import { agentCredentialEnv } from "../agent-backend/provider-env";
import { config } from "../config";
import type { SessionStatus } from "../types";
import { nextSpritesLifecycleAction } from "./lifecycle";
import { nestedDispatchMode } from "./provider";
import { recordRunnerEvent, timeRunnerPhase } from "./telemetry";
import type { CreateRunnerInput, RunnerProvider, RunnerRef, RunnerState } from "./provider";
import { SpritesApiError, makeSpritesClient, type NetworkPolicy, type SpritesClient, type Sprite } from "./sprites-client";
import { bootstrapSprite } from "./sprites-bootstrap";
import { workerBuildSha } from "./worker-sha";
import { newChannelInstanceId } from "../worker-channel/credential";
import { spritesDialEndpoint, spritesListenEndpoint, workerChannelDispatchEnv } from "../worker-channel/dispatch-env";

const SPRITES_MONITOR_KEY = "__taskOrchSpritesRunnerMonitor";

function envValue(key: string): string | undefined {
  const v = process.env[key];
  return v == null ? undefined : v;
}

function compactEnv(entries: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v != null) env[k] = v;
  }
  return env;
}

export function spriteNameForRun(runId: number): string {
  const prefix = config.sprites.prefix || "to-run-";
  return `${prefix}${runId}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isRunSpriteName(name: string): boolean {
  const prefix = config.sprites.prefix || "to-run-";
  const escaped = escapeRegExp(prefix);
  const re = new RegExp(`^${escaped}\\d+$`);
  return re.test(name);
}

export function spritesRunnerStateFromStatus(status: string | undefined): RunnerState {
  switch (status) {
    case "running":
      return "running";
    case "warm":
    case "starting":
    case "creating":
      return "starting";
    case "cold":
    case "hibernated":
      return "suspended";
    case "destroyed":
    case "destroying":
    case "gone":
      return "gone";
    default:
      return "starting";
  }
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
    row.createdAt.getTime(),
  );
}

async function emitRunnerEvent(runId: number, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  recordRunnerEvent(type, { provider: "sprites", runId, fields: payload });
  try {
    await db.insert(agentEvents).values({
      sessionId: runId,
      type,
      payload: JSON.stringify(payload),
      createdAt: new Date(),
    });
  } catch {
    // observability only
  }
}

async function clearSdkSession(runId: number): Promise<void> {
  try {
    await db.update(agentSessions).set({ sdkSessionId: null }).where(eq(agentSessions.id, runId));
  } catch (err) {
    console.error(`[SpritesRunnerProvider] clearSdkSession failed for run ${runId}:`, err);
  }
}

export async function buildSpritesWorkerEnv(
  runId: number,
  opts: { channelInstanceId?: string; channelListenEndpoint?: string } = {},
): Promise<Record<string, string>> {
  const channelEnv =
    opts.channelInstanceId && opts.channelListenEndpoint
      ? workerChannelDispatchEnv(runId, opts.channelInstanceId, opts.channelListenEndpoint)
      : {};
  return compactEnv({
    GH_TOKEN: envValue("GH_TOKEN"),
    ...(await agentCredentialEnv()),
    TASK_ORCH_AGENT_BACKEND: envValue("TASK_ORCH_AGENT_BACKEND"),
    TASK_ORCH_CHAT_MODEL: envValue("TASK_ORCH_CHAT_MODEL"),
    TASK_ORCH_AGENT_MODEL: envValue("TASK_ORCH_AGENT_MODEL"),
    TASK_ORCH_CHAT_IDLE_MS: envValue("TASK_ORCH_CHAT_IDLE_MS"),
    TASK_ORCH_DETACHED_RUNS: "1",
    TASK_ORCH_INSIDE_WORKER: "1",
    TASK_ORCH_NESTED_DISPATCH: nestedDispatchMode(),
    RUN_ID: String(runId),
    SESSION_ROOT: "/home/user/session",
    REPO_CACHE_DIR: envValue("TASK_ORCH_REPO_CACHE_DIR") ?? "/opt/repo-cache",
    ...channelEnv,
  });
}

export class SpritesRunnerProvider implements RunnerProvider {
  readonly kind = "sprites" as const;

  constructor(private readonly spritesClient: SpritesClient = makeSpritesClient()) {}

  private async getInstance(runId: number): Promise<typeof runnerInstances.$inferSelect | null> {
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, runId));
    return row ?? null;
  }

  private async updateInstance(runId: number, patch: Partial<typeof runnerInstances.$inferInsert>): Promise<void> {
    await db.update(runnerInstances).set(patch).where(eq(runnerInstances.runId, runId));
  }

  private async releaseRunClaimIfCurrent(runId: number, spriteName: string): Promise<void> {
    await db
      .update(agentSessions)
      .set({ workerScope: null, workerPid: null, heartbeatAt: null })
      .where(and(eq(agentSessions.id, runId), eq(agentSessions.workerScope, spriteName)));
  }

  async create(input: CreateRunnerInput): Promise<RunnerRef | null> {
    const existing = await this.getInstance(input.runId);
    if (existing?.spriteName) {
      const resumed = await this.resume(input.runId);
      if (resumed) return resumed;
    }

    const spriteName = spriteNameForRun(input.runId);
    const channelInstanceId = input.channelInstanceId ?? existing?.channelInstanceId ?? newChannelInstanceId();
    const channelListenEndpoint = spritesListenEndpoint();
    const workerEnv = await buildSpritesWorkerEnv(input.runId, {
      channelInstanceId,
      channelListenEndpoint,
    });

    let created = false;
    try {
      await timeRunnerPhase(
        "sprites_sprite_create",
        async () => {
          try {
            await this.spritesClient.createSprite({ name: spriteName, urlSettings: { auth: "sprite" } });
            created = true;
          } catch (err) {
            if (err instanceof SpritesApiError && err.status === 409) {
              // already exists — treat as created
              created = true;
              return;
            }
            throw err;
          }
        },
        { provider: "sprites", fields: { runId: input.runId, spriteName } },
      );

      // Phase A bootstrap: fetch the prebuilt worker bundle into the sprite.
      // The bundle is keyed by the worker SHA; the checkpoint makes this idempotent.
      // We skip `git clone` and `npm ci` here — the worker does its own checkout
      // per turn via containerCheckoutAt. See sprites-bootstrap.ts.
      if (!config.sprites.token) {
        throw new Error("SPRITES_TOKEN is required when TASK_ORCH_RUNNER=sprites");
      }
      const bundleUrl = config.sprites.workerBundleUrl;
      if (!bundleUrl) {
        throw new Error("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL is required when TASK_ORCH_RUNNER=sprites");
      }
      const workerSha = await workerBuildSha();
      await timeRunnerPhase(
        "sprites_bootstrap",
        () =>
          bootstrapSprite(this.spritesClient, spriteName, {
            workerSha,
            bundleUrl,
            onStep: (step, status, durationMs) => {
              void emitRunnerEvent(input.runId, "runner_bootstrap_step", { spriteName, step, status, durationMs });
            },
          }),
        { provider: "sprites", fields: { runId: input.runId, spriteName, workerSha } },
      );

      // Define and start the worker service. The base image is standard; the
      // service definition is the sprite's "entrypoint".
      await timeRunnerPhase(
        "sprites_service_define",
        () =>
          this.spritesClient.putService(spriteName, "worker", {
            cmd: "node",
            args: ["dist/run-worker.js", String(input.runId)],
            env: workerEnv,
            dir: "/home/user/worker",
          }),
        { provider: "sprites", fields: { runId: input.runId, spriteName } },
      );

      await timeRunnerPhase(
        "sprites_service_start",
        () => this.spritesClient.startService(spriteName, "worker"),
        { provider: "sprites", fields: { runId: input.runId, spriteName } },
      );

      // Apply optional network policy (defense in depth, phase 6 — observe by default)
      const netAllow = config.sprites.netAllow;
      if (netAllow) {
        // best-effort; policy failures must not block the run
        try {
          const domains = netAllow
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (domains.length) {
            await this.spritesClient.setNetworkPolicy(spriteName, {
              rules: domains.map((domain) => ({ domain, action: "allow" as const })),
            });
          }
        } catch (err) {
          console.warn(`[SpritesRunnerProvider] setNetworkPolicy failed for ${spriteName}:`, err);
        }
      }

      const channelEndpoint = spritesDialEndpoint(spriteName);
      // Persist mapping
      await db
        .insert(runnerInstances)
        .values({
          runId: input.runId,
          provider: "sprites",
          spriteName,
          region: null,
          state: "starting",
          lastStartedAt: new Date(),
          channelInstanceId,
          channelEndpoint,
        })
        .onConflictDoUpdate({
          target: runnerInstances.runId,
          set: {
            provider: "sprites",
            spriteName,
            state: "starting",
            lastStartedAt: new Date(),
            channelInstanceId,
            channelEndpoint,
            lastProviderError: null,
          },
        });

      await emitRunnerEvent(input.runId, "runner_created", { spriteName });
      return { runId: input.runId, handle: spriteName, provider: "sprites", channelInstanceId, channelEndpoint };
    } catch (err) {
      console.error("[SpritesRunnerProvider] create failed:", err);
      if (created) {
        await this.spritesClient.deleteSprite(spriteName).catch(() => {});
      }
      throw err;
    }
  }

  /** Resume a hibernated or existing sprite for a follow-up turn. */
  async resume(runId: number): Promise<RunnerRef | null> {
    const instance = await this.getInstance(runId);
    if (!instance?.spriteName) return null;
    const spriteName = instance.spriteName;
    const channelInstanceId = instance.channelInstanceId ?? newChannelInstanceId();
    const channelEndpoint = instance.channelEndpoint ?? spritesDialEndpoint(spriteName);

    // Fetch sprite — a 404 means we must recreate? But design says one sprite per run
    // bound for life; if it's gone, the transcript is lost and caller should create fresh.
    // For now, if get returns null, treat as gone and return null so dispatch can create.
    const sprite = await this.spritesClient.getSprite(spriteName).catch(() => null);
    if (!sprite) {
      await this.updateInstance(runId, { state: "gone" });
      return null;
    }

    const runnerState = spritesRunnerStateFromStatus(sprite.status);
    if (runnerState === "gone") {
      await this.updateInstance(runId, { state: "gone" });
      return null;
    }

    // Ensure worker service is running — after hibernate the process may be
    // stopped and needs an explicit start. Both S1 outcomes are covered:
    // - if processes survive hibernate, start is idempotent (already running)
    // - if not, this restarts it before we dial
    const now = new Date();
    try {
      await this.spritesClient.startService(spriteName, "worker");
    } catch (err) {
      console.warn(`[SpritesRunnerProvider] startService failed for ${spriteName}:`, err);
    }

    await this.updateInstance(runId, {
      state: "starting",
      lastStartedAt: now,
      channelInstanceId,
      channelEndpoint,
    });
    await emitRunnerEvent(runId, "runner_resumed", { spriteName, status: sprite.status });
    return { runId, handle: spriteName, provider: "sprites", channelInstanceId, channelEndpoint };
  }

  async stop(handle: string): Promise<void> {
    await this.spritesClient.deleteSprite(handle).catch(() => {});
    const [row] = await db.select({ runId: runnerInstances.runId, spriteName: runnerInstances.spriteName }).from(runnerInstances).where(eq(runnerInstances.spriteName, handle));
    if (!row) {
      console.warn(`[SpritesRunnerProvider] stop: no runner row for sprite ${handle}`);
      return;
    }
    // Hard cancel is permanent — destroy and clear
    await this.releaseRunClaimIfCurrent(row.runId, handle);
    await this.updateInstance(row.runId, { state: "gone", spriteName: null });
    await clearSdkSession(row.runId);
    await emitRunnerEvent(row.runId, "runner_failed", { spriteName: handle, reason: "stopped" });
  }

  async sweep(): Promise<void> {
    let sprites: Sprite[];
    try {
      const prefix = config.sprites.prefix || "to-run-";
      sprites = await this.spritesClient.listAllSprites(prefix);
    } catch (err) {
      console.error("[SpritesRunnerProvider] sweep listSprites failed:", err);
      return;
    }
    const spriteByName = new Map(sprites.map((s) => [s.name, s]));
    const rows = await db
      .select({
        runId: runnerInstances.runId,
        spriteName: runnerInstances.spriteName,
        state: runnerInstances.state,
        createdAt: runnerInstances.createdAt,
        lastStartedAt: runnerInstances.lastStartedAt,
        lastSuspendedAt: runnerInstances.lastSuspendedAt,
        archivedUri: runnerInstances.archivedUri,
        runStatus: agentSessions.status,
        runGoal: agentSessions.goal,
        workerScope: agentSessions.workerScope,
        heartbeatAt: agentSessions.heartbeatAt,
        completedAt: agentSessions.completedAt,
      })
      .from(runnerInstances)
      .leftJoin(agentSessions, eq(agentSessions.id, runnerInstances.runId))
      .where(eq(runnerInstances.provider, "sprites"));

    const now = Date.now();
    const protectedNames = new Set<string>();
    for (const r of rows) if (r.spriteName) protectedNames.add(r.spriteName);

    for (const row of rows) {
      if (!row.spriteName) continue;
      try {
        let sprite = spriteByName.get(row.spriteName);
        if (!sprite) {
          await this.updateInstance(row.runId, { state: "gone" });
          const lastSeen = row.heartbeatAt?.getTime() ?? 0;
          const isActive = !!row.runStatus && ["preparing", "running", "pushing", "opening_pr"].includes(row.runStatus);
          if (row.workerScope === row.spriteName && isActive && now - lastSeen >= 30_000) {
            const runs = await import("../runs");
            await runs.handleWorkerDeath(row.runId, {
              exitCode: null,
              oomKilled: false,
              containerName: row.spriteName,
            });
          }
          continue;
        }

        if (sprite.status == null) {
          const full = await this.spritesClient.getSprite(row.spriteName).catch(() => null);
          if (full?.status) {
            sprite = full;
          } else {
            if (config.worker.debugLog) console.debug(`[SpritesRunnerProvider] skipping sweep for ${row.spriteName}: missing status in list`);
            continue;
          }
        }

        const runnerState = spritesRunnerStateFromStatus(sprite.status);
        if (runnerState !== row.state) {
          await this.updateInstance(row.runId, {
            state: runnerState,
            ...(runnerState === "running" ? { lastStartedAt: new Date() } : {}),
            ...(runnerState === "suspended" ? { lastSuspendedAt: new Date() } : {}),
          });
        }

        const runStatus = (row.runStatus ?? "closed") as SessionStatus;
        await this.applyLifecycle(row, runnerState, runStatus, now);
      } catch (err) {
        console.error(`[SpritesRunnerProvider] sweep failed for run ${row.runId}:`, err);
      }
    }

    // Reap orphan sprites: prefix-owned sprites with no runner row and older than grace
    try {
      await this.reapOrphanSprites(sprites, protectedNames, now);
    } catch (err) {
      console.error("[SpritesRunnerProvider] reapOrphanSprites failed:", err);
    }
  }

  private async reapOrphanSprites(allSprites: Sprite[], protectedNames: Set<string>, nowMs: number): Promise<void> {
    const graceMs = config.sprites.orphanGraceMs;
    for (const s of allSprites) {
      if (protectedNames.has(s.name)) continue;
      if (!isRunSpriteName(s.name)) {
        if (config.worker.debugLog) console.debug(`[SpritesRunnerProvider] skipping non-run sprite ${s.name}`);
        continue;
      }
      if (!s.createdAt) {
        if (config.worker.debugLog) console.debug(`[SpritesRunnerProvider] skipping orphan check for ${s.name}: missing createdAt`);
        continue;
      }
      if (nowMs - s.createdAt.getTime() < graceMs) continue;
      try {
        await this.spritesClient.deleteSprite(s.name);
        console.log(`[SpritesRunnerProvider] reaped orphan sprite ${s.name}`);
      } catch (err) {
        if (!(err instanceof SpritesApiError && err.status === 404)) {
          console.error(`[SpritesRunnerProvider] reap deleteSprite ${s.name} failed:`, err);
        }
      }
    }
  }

  startMonitor(): void {
    const g = globalThis as Record<string, unknown>;
    if (g[SPRITES_MONITOR_KEY]) return;
    const intervalMs = config.sprites.pollMs;
    if (intervalMs <= 0) return;
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
    g[SPRITES_MONITOR_KEY] = timer;
    tick();
  }

  private async applyLifecycle(
    row: {
      runId: number;
      spriteName: string | null;
      state: string;
      createdAt: Date;
      lastStartedAt: Date | null;
      lastSuspendedAt: Date | null;
      archivedUri: string | null;
      workerScope: string | null;
      heartbeatAt: Date | null;
      completedAt: Date | null;
      runGoal?: string | null;
    },
    runnerState: RunnerState,
    runStatus: SessionStatus,
    nowMs: number,
  ): Promise<void> {
    if (!row.spriteName) return;
    const idleMs = Math.max(0, nowMs - lastActivityMs(row));
    const action = nextSpritesLifecycleAction({
      runStatus,
      runnerState,
      idleMs,
      workerScope: row.workerScope,
      heartbeatAt: row.heartbeatAt,
      goal: row.runGoal,
    });
    if (action.kind !== "destroy") return;

    const spriteName = row.spriteName;
    if (config.features.archiveR2 && !row.archivedUri) {
      await emitRunnerEvent(row.runId, "runner_archive_requested", { spriteName, idleMs });
      return;
    }
    await timeRunnerPhase(
      "sprites_sprite_destroy",
      () => this.spritesClient.deleteSprite(spriteName).catch(() => {}),
      { provider: "sprites", fields: { runId: row.runId, spriteName, idleMs } },
    );
    await this.releaseRunClaimIfCurrent(row.runId, spriteName);
    await this.updateInstance(row.runId, { state: "gone", spriteName: null });
    if (row.spriteName) await clearSdkSession(row.runId);
    await emitRunnerEvent(row.runId, "runner_destroyed", { spriteName, idleMs });
  }
}

// Aliases for tests / external use
export type { Sprite, SpritesClient };
