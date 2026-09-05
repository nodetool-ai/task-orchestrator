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
import type { CreateRunnerInput, RunnerObservation, RunnerProvider, RunnerRef, RunnerState } from "./provider";
import { SpritesApiError, makeSpritesClient, type NetworkPolicy, type SpritesClient, type Sprite } from "./sprites-client";
import { bootstrapSprite, SPRITE_CODEX_BINARY } from "./sprites-bootstrap";
import { workerBundleId } from "../worker-bundle";
import { newChannelInstanceId } from "../worker-channel/credential";
import { spritesDialEndpoint, spritesListenEndpoint, workerChannelDispatchEnv } from "../worker-channel/dispatch-env";

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

// Idle clock for the destroy policy. claimed_at is stamped once per claim, so
// this does NOT advance during a long turn — nextSpritesLifecycleAction is
// safe only because it returns `none` for a live worker and an active status
// BEFORE it looks at idleMs. Keep that rule order.
function lastActivityMs(row: {
  claimedAt: Date | null;
  completedAt: Date | null;
  lastStartedAt: Date | null;
  createdAt: Date;
}): number {
  return Math.max(
    row.claimedAt?.getTime() ?? 0,
    row.completedAt?.getTime() ?? 0,
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

/** Where the sprite base image installs Claude Code (symlink to the versioned ELF). */
const SPRITE_CLAUDE_BINARY = "/home/sprite/.local/bin/claude";

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
    // The standalone bundle carries no native claude binary; the sprite base
    // image installs Claude Code, so the SDK spawns that one.
    TASK_ORCH_CLAUDE_BINARY: envValue("TASK_ORCH_SPRITES_CLAUDE_BINARY") ?? SPRITE_CLAUDE_BINARY,
    // bootstrapSprite installs the pinned Codex native package and links its
    // architecture-specific binary to this stable path. An override is useful
    // for a custom Sprite image that already provisions Codex elsewhere.
    TASK_ORCH_CODEX_BINARY: envValue("TASK_ORCH_SPRITES_CODEX_BINARY") ?? SPRITE_CODEX_BINARY,
    RUN_ID: String(runId),
    SESSION_ROOT: "/home/user/session",
    REPO_CACHE_DIR: envValue("TASK_ORCH_REPO_CACHE_DIR") ?? "/opt/repo-cache",
    ...channelEnv,
  });
}

export class SpritesRunnerProvider implements RunnerProvider {
  readonly kind = "sprites" as const;

  constructor(private readonly spritesClient: SpritesClient = makeSpritesClient()) {}

  async inspect(handle: string): Promise<RunnerObservation> {
    try {
      const sprite = await this.spritesClient.getSprite(handle);
      if (!sprite) return { status: "dead", detail: "sprite gone" };
      const runnerState = spritesRunnerStateFromStatus(sprite.status);
      if (runnerState === "gone") return { status: "dead", detail: `sprite ${sprite.status}` };
      const service = await this.spritesClient.getService(handle, "worker");
      const s = service?.state;
      // Only two things prove a worker dead: the sprite is gone (above) or the
      // service itself reports `failed`. Everything else — no service yet,
      // defined-but-not-started, a hibernating (cold) sprite, restart backoff —
      // is a boot or freeze window in which the process identity is not settled.
      // Run 184 was reaped mid-bootstrap by calling one of those "dead".
      if (!service) return { status: "unknown" };
      if (s!.status === "failed") return { status: "dead", detail: s!.error ?? "failed" };
      if (s!.nextRestartAt) return { status: "unknown" };
      if (s!.status !== "running" || s!.pid == null || !s!.startedAt) return { status: "unknown" };
      return { status: "alive", incarnation: `${s!.startedAt}#${s!.pid}`, pid: s!.pid };
    } catch {
      return { status: "unknown" };
    }
  }

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
      .set({ workerScope: null })
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
      // The checkpoint is keyed by the bundle id (sha1 of the shipped bundle),
      // which makes bootstrap idempotent per deploy.
      // We skip `git clone` and `npm ci` here — the worker does its own checkout
      // per turn via containerCheckoutAt. See sprites-bootstrap.ts.
      if (!config.sprites.token) {
        throw new Error("SPRITES_TOKEN is required when TASK_ORCH_RUNNER=sprites");
      }
      const bundleUrl = config.sprites.workerBundleUrl;
      if (!bundleUrl) {
        throw new Error("Set TASK_ORCH_PUBLIC_URL (or TASK_ORCH_SPRITES_WORKER_BUNDLE_URL) when TASK_ORCH_RUNNER=sprites");
      }
      const workerSha = await workerBundleId();
      const codexBinary = envValue("TASK_ORCH_SPRITES_CODEX_BINARY");
      await timeRunnerPhase(
        "sprites_bootstrap",
        () =>
          bootstrapSprite(this.spritesClient, spriteName, {
            workerSha,
            bundleUrl,
            ...(codexBinary ? { codexBinary } : {}),
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
    // The dial endpoint is a pure function of the sprite name. Never trust the
    // stored value here: dispatch seeds the row with a `pending:sprites:` placeholder
    // before it knows the name, and a redispatch can leave that placeholder in
    // place (run 185, 2026-08-27 — every follow-up turn dialed "pending:…").
    const channelEndpoint = spritesDialEndpoint(spriteName);

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
    // The service definition carries the channel credential the worker verifies
    // every dial against. It is an HMAC over AUTH_SECRET, so a control plane
    // whose secret changed since the sprite was created (a deploy that rotated
    // AUTH_SECRET: runs 182-185, 2026-08-27) is refused with 401 forever.
    // Re-define the service with the current env whenever the stored credential
    // no longer matches; that also refreshes provider keys and model settings.
    try {
      const desiredEnv = await buildSpritesWorkerEnv(runId, { channelInstanceId, channelListenEndpoint: spritesListenEndpoint() });
      const current = await this.spritesClient.getService(spriteName, "worker").catch(() => null);
      const staleCredential =
        current?.env?.TASK_ORCH_WORKER_CHANNEL_CREDENTIAL !== desiredEnv.TASK_ORCH_WORKER_CHANNEL_CREDENTIAL;
      // A sprite outlives deploys; its worker bundle does not follow them on
      // its own. bootstrapSprite is idempotent per bundle id (checkpoint
      // comment), so when the shipped bundle changed since this sprite was
      // created it fetches the new one, and the service is redefined so the
      // next start runs the new code.
      let staleBundle = false;
      const bundleUrl = config.sprites.workerBundleUrl;
      if (bundleUrl && config.sprites.token) {
        const workerSha = await workerBundleId();
        const checkpoints = await this.spritesClient.listCheckpoints(spriteName).catch(() => []);
        staleBundle = !checkpoints.some((cp) => cp.comment === `bootstrap ${workerSha}`);
        if (staleBundle) {
          console.warn(`[SpritesRunnerProvider] worker bundle on ${spriteName} predates ${workerSha}; re-bootstrapping`);
          await this.spritesClient.stopService(spriteName, "worker").catch(() => {});
          await bootstrapSprite(this.spritesClient, spriteName, {
            workerSha,
            bundleUrl,
            ...(envValue("TASK_ORCH_SPRITES_CODEX_BINARY")
              ? { codexBinary: envValue("TASK_ORCH_SPRITES_CODEX_BINARY") }
              : {}),
            onStep: (step, status, durationMs) => {
              void emitRunnerEvent(runId, "runner_bootstrap_step", { spriteName, step, status, durationMs });
            },
          });
        }
      }
      if (staleCredential || staleBundle) {
        console.warn(`[SpritesRunnerProvider] redefining the worker service on ${spriteName} (${staleBundle ? "new bundle" : "stale credential"})`);
        await this.spritesClient.stopService(spriteName, "worker").catch(() => {});
        await this.spritesClient.putService(spriteName, "worker", {
          cmd: "node",
          args: ["dist/run-worker.js", String(runId)],
          env: desiredEnv,
          dir: "/home/user/worker",
        });
        await emitRunnerEvent(runId, "runner_service_redefined", { spriteName, reason: staleBundle ? "new-bundle" : "stale-credential" });
      }
    } catch (err) {
      console.warn(`[SpritesRunnerProvider] service refresh failed for ${spriteName}:`, err);
    }
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
        archivedUri: runnerInstances.archivedUri,
        workerIncarnation: runnerInstances.workerIncarnation,
        runStatus: agentSessions.status,
        runGoal: agentSessions.goal,
        workerScope: agentSessions.workerScope,
        claimedAt: agentSessions.claimedAt,
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
          // The list was snapshotted before the rows: a sprite created in
          // between is missing here while booting normally. Confirm with a
          // direct observation and act only on `dead`.
          const observed = await this.inspect(row.spriteName);
          if (observed.status !== "dead") continue;
          await this.updateInstance(row.runId, { state: "gone" });
          const isActive = !!row.runStatus && ["preparing", "running", "pushing", "opening_pr"].includes(row.runStatus);
          if (row.workerScope === row.spriteName && isActive) {
            const runs = await import("../runs");
            await runs.handleWorkerDeath(row.runId, {
              exitCode: null,
              oomKilled: false,
              containerName: row.spriteName,
              incarnation: row.workerIncarnation ?? null,
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
          });
        }

        const runStatus = (row.runStatus ?? "closed") as SessionStatus;
        const observed = await this.inspect(row.spriteName);
        await this.applyLifecycle(row, runnerState, runStatus, now, observed.status === "dead" ? false : true);
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

  private async applyLifecycle(
    row: {
      runId: number;
      spriteName: string | null;
      state: string;
      createdAt: Date;
      lastStartedAt: Date | null;
      archivedUri: string | null;
      workerScope: string | null;
      claimedAt: Date | null;
      completedAt: Date | null;
      runGoal?: string | null;
    },
    runnerState: RunnerState,
    runStatus: SessionStatus,
    nowMs: number,
    workerLive: boolean,
  ): Promise<void> {
    if (!row.spriteName) return;
    const idleMs = Math.max(0, nowMs - lastActivityMs(row));
    const action = nextSpritesLifecycleAction({
      runStatus,
      runnerState,
      idleMs,
      workerLive,
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
