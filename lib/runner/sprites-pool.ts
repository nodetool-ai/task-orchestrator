/** Durable warm-pool coordinator for Sprite environments.
 *
 * The coordinator deliberately knows nothing about the provider API or the
 * database schema.  The store owns the cross-process reservation/claim fence;
 * `requestRefill` owns Sprite creation and baseline preparation.  This keeps
 * provider failures and process crashes recoverable by reconciliation.
 */
import { config } from "../config";
import { spritesPoolStore as databaseStore } from "./sprites-pool-store";
import { baselineFingerprint, prepareSpriteBaseline, type SpriteBaselineManifest } from "./sprites-baseline";
import { configureSpriteSwap } from "./sprites-bootstrap";
import type { SpritesClient } from "./sprites-client";
import { db } from "../../db";
import { runnerInstances, agentSessions } from "../../db/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { spriteLog, spriteErrorFields, logSpritePhase } from "./sprites-log";

export type SpritePoolState = "preparing" | "ready" | "claimed" | "recycling" | "draining" | "deleting" | "deleted" | "failed";

export interface SpritePoolEntry {
  id: string;
  spriteName: string;
  fingerprint: string;
  state: SpritePoolState;
  leaseExpiresAt?: number | Date | null;
  updatedAt?: number | Date | null;
}

export interface SpritePoolReservation {
  id: string;
  fingerprint: string;
  leaseToken: string;
  spriteName?: string;
  baselineManifest?: Record<string, unknown>;
}

/** Implementations must make reserve/claim transitions atomic in the DB. */
export interface SpritePoolStore {
  countCapacity(): Promise<{ total: number; preparing: number; ready: number; byFingerprint?: Record<string, { preparing: number; ready: number }> }>;
  reservePreparation(input: { fingerprint: string; maxTotal: number; maxReady?: number; fingerprintTarget?: number; leaseMs: number; spriteName?: string; baselineManifest?: Record<string, unknown>; checkpointId?: string }): Promise<SpritePoolReservation | null>;
  /** Extend a live preparation lease only while the same token still owns it. */
  renewPreparation(input: { reservationId: string; leaseToken: string; leaseMs: number }): Promise<boolean>;
  completePreparation(input: { reservationId: string; leaseToken: string; fingerprint?: string; spriteName: string; checkpointId: string; baselineManifest?: Record<string, unknown> }): Promise<void>;
  failPreparation(input: { reservationId: string; leaseToken: string; reason: string; retryAt: number }): Promise<void>;
  listUnused(input: { fingerprint?: string }): Promise<SpritePoolEntry[]>;
  markDraining(id: string): Promise<boolean>;
  /** Reconcile expired leases. Unknown provider state must remain unknown. */
  reconcile(now: number): Promise<{ expired: SpritePoolReservation[]; deletions: SpritePoolEntry[] }>;
}

export interface SpritePoolRefillRequest {
  reservation: SpritePoolReservation;
}
export interface SpritePoolPrepared {
  spriteName: string;
  checkpointId: string;
}

export interface SpritePoolOptions {
  store: SpritePoolStore;
  /** Provider creates/bootstrap/verifies one reserved Sprite and returns its checkpoint. */
  requestRefill?: (request: SpritePoolRefillRequest) => Promise<SpritePoolPrepared>;
  /** Target ready capacity. Defaults to TASK_ORCH_SPRITE_POOL_SIZE (0). */
  target?: number;
  /** Deployment-wide hard limit; zero means unlimited. */
  maxSprites?: number;
  maxConcurrent?: number;
  leaseMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Deprecated compatibility seam; retries are persisted, never slept here. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Fingerprints in priority order. The total target is shared by all. */
  fingerprints?: () => readonly string[];
  logger?: Pick<Console, "warn" | "error">;
  /** Supplies the immutable manifest required when reserving a baseline. */
  baseline?: (fingerprint: string) => { manifest: Record<string, unknown>; checkpointId?: string };
  spriteName?: (fingerprint: string) => string;
  /** Optional static per fingerprint caps. The total target remains shared. */
  fingerprintTargets?: (fingerprint: string) => number;
}

const DEFAULT_LEASE_MS = 10 * 60_000;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

function asNonNegativeInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 ? Math.floor(value as number) : fallback;
}

export class SpritePoolManager {
  private readonly target: number;
  private readonly maxSprites: number;
  private readonly maxConcurrent: number;
  private readonly leaseMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly fingerprints: () => readonly string[];
  private readonly logger: Pick<Console, "warn" | "error">;
  private readonly baseline?: SpritePoolOptions["baseline"];
  private readonly spriteName: (fingerprint: string) => string;
  private readonly fingerprintTargets?: SpritePoolOptions["fingerprintTargets"];
  private inFlight = 0;
  private refillPromise: Promise<void> | null = null;
  private stopped = false;
  private failures = 0;

  constructor(private readonly options: SpritePoolOptions) {
    this.target = asNonNegativeInt(options.target, config.sprites.poolSize);
    this.maxSprites = asNonNegativeInt(options.maxSprites, config.sprites.maxSprites);
    this.maxConcurrent = Math.max(1, asNonNegativeInt(options.maxConcurrent, DEFAULT_MAX_CONCURRENT));
    this.leaseMs = Math.max(1, asNonNegativeInt(options.leaseMs, DEFAULT_LEASE_MS));
    this.initialBackoffMs = Math.max(0, asNonNegativeInt(options.initialBackoffMs, DEFAULT_BACKOFF_MS));
    this.maxBackoffMs = Math.max(this.initialBackoffMs, asNonNegativeInt(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS));
    this.now = options.now ?? Date.now;
    this.fingerprints = options.fingerprints ?? (() => ["generic"]);
    this.logger = options.logger ?? console;
    this.baseline = options.baseline;
    this.spriteName = options.spriteName ?? ((fingerprint) => `${config.sprites.prefix}pool-${fingerprint.slice(0, 12)}-${randomUUID()}`);
    this.fingerprintTargets = options.fingerprintTargets;
  }

  get activeRefills(): number { return this.inFlight; }

  /** Starts one bounded refill pass and returns when reservations are queued. */
  requestRefill(): Promise<void> {
    if (this.refillPromise) return this.refillPromise;
    this.refillPromise = this.refill().finally(() => { this.refillPromise = null; });
    return this.refillPromise;
  }

  stop(): void { this.stopped = true; }
  start(): void { this.stopped = false; }

  async reconcile(): Promise<void> {
    const result = await this.options.store.reconcile(this.now());
    for (const entry of result.expired) spriteLog("sprites_pool_lease_expired", { poolEntryId: entry.id, fingerprint: entry.fingerprint }, "warn");
    spriteLog("sprites_pool_reconciled", { count: result.deletions.length }, "debug");
    // Deletion is intentionally store-owned. A provider sweep can act on the
    // returned deletion candidates while an inspection error leaves them
    // pending; this manager never turns unknown into dead.
    if (result.deletions.length > 0) {
      this.logger.warn(`[sprites-pool] ${result.deletions.length} deletion candidates require provider reconciliation`);
    }
  }

  /** Drain excess unused entries after a target reduction or fingerprint drift. */
  async drain(): Promise<number> {
    const entries = await this.options.store.listUnused({});
    const desired = new Set(this.fingerprints());
    const counts = new Map<string, number>();
    const compatible: SpritePoolEntry[] = [];
    const stale: SpritePoolEntry[] = [];
    for (const entry of entries) {
      const count = counts.get(entry.fingerprint) ?? 0;
      const cap = this.fingerprintTargets?.(entry.fingerprint) ?? this.target;
      if (!desired.has(entry.fingerprint) || count >= cap) stale.push(entry);
      else { compatible.push(entry); counts.set(entry.fingerprint, count + 1); }
    }
    const excess = Math.max(0, compatible.length - this.target);
    let drained = 0;
    const excessEntries = excess > 0 ? compatible.slice(-excess) : [];
    for (const entry of [...stale, ...excessEntries]) {
      if (await this.options.store.markDraining(entry.id)) {
        drained++;
        spriteLog("sprites_pool_draining", { poolEntryId: entry.id, spriteName: entry.spriteName, fingerprint: entry.fingerprint,
          reason: !desired.has(entry.fingerprint) ? "fingerprint_retired" : "target_reduced" });
      }
    }
    return drained;
  }

  private async refill(): Promise<void> {
    if (this.stopped || this.target <= 0 || !this.options.requestRefill) {
      spriteLog("sprites_pool_refill_skipped", { target: this.target, reason: this.stopped ? "stopped" : this.target <= 0 ? "disabled" : "no_preparer" }, "debug");
      return;
    }
    await this.reconcile().catch((error) => spriteLog("sprites_pool_reconcile_failed", spriteErrorFields(error), "warn"));
    const fingerprints = this.fingerprints();
    if (fingerprints.length === 0) {
      spriteLog("sprites_pool_refill_skipped", { reason: "no_baselines", target: this.target }, "debug"); return;
    }
    const preparations: Promise<void>[] = [];
    const queuedByFingerprint = new Map<string, number>();
    const unavailable = new Set<string>();
    while (!this.stopped && this.inFlight < this.maxConcurrent) {
      const capacity = await this.options.store.countCapacity();
      spriteLog("sprites_pool_capacity", { target: this.target, total: capacity.total, ready: capacity.ready,
        preparing: capacity.preparing, maxSprites: this.maxSprites, inFlight: this.inFlight }, "debug");
      const reserved = capacity.total;
      if (capacity.ready + capacity.preparing >= this.target) break;
      if (this.maxSprites > 0 && reserved >= this.maxSprites) break;
      const fingerprint = fingerprints.find((fp) => {
        if (unavailable.has(fp)) return false;
        const target = this.fingerprintTargets?.(fp);
        if (target == null || target < 0) return true;
        const counts = capacity.byFingerprint?.[fp];
        return counts ? counts.ready + counts.preparing < target : (queuedByFingerprint.get(fp) ?? 0) < target;
      });
      if (!fingerprint) break;
      const baseline = this.baseline?.(fingerprint);
      const reservation = await this.options.store.reservePreparation({
        fingerprint,
        maxTotal: this.maxSprites,
        maxReady: this.target,
        fingerprintTarget: this.fingerprintTargets?.(fingerprint),
        leaseMs: this.leaseMs,
        spriteName: this.spriteName(fingerprint),
        ...(baseline ? { baselineManifest: baseline.manifest, checkpointId: baseline.checkpointId } : {}),
      });
      if (!reservation) {
        spriteLog("sprites_pool_reservation_unavailable", { fingerprint, reason: "reservation_declined" }, "debug");
        unavailable.add(fingerprint); continue;
      }
      spriteLog("sprites_pool_reserved", { poolEntryId: reservation.id, spriteName: reservation.spriteName,
        fingerprint: reservation.fingerprint });
      this.inFlight++;
      queuedByFingerprint.set(fingerprint, (queuedByFingerprint.get(fingerprint) ?? 0) + 1);
      preparations.push(this.prepare(reservation));
    }
    await Promise.all(preparations);
  }

  private async prepare(reservation: SpritePoolReservation): Promise<void> {
    const context = { poolEntryId: reservation.id, spriteName: reservation.spriteName, fingerprint: reservation.fingerprint };
    const started = performance.now();
    const renewalIntervalMs = Math.max(1, Math.floor(this.leaseMs / 3));
    let renewalTimer: ReturnType<typeof setTimeout> | null = null;
    let renewalInFlight: Promise<void> | null = null;
    let renewalStopped = false;
    let renewalError: Error | null = null;
    const lostLease = () => new Error("Sprite pool preparation lease is no longer owned");
    const scheduleRenewal = () => {
      if (renewalStopped || renewalError) return;
      renewalTimer = setTimeout(() => {
        renewalTimer = null;
        renewalInFlight = (async () => {
          try {
            const renewed = await this.options.store.renewPreparation({
              reservationId: reservation.id,
              leaseToken: reservation.leaseToken,
              leaseMs: this.leaseMs,
            });
            if (!renewed) renewalError = lostLease();
          } catch (error) {
            renewalError = error instanceof Error ? error : new Error(String(error));
          } finally {
            renewalInFlight = null;
            scheduleRenewal();
          }
        })();
      }, renewalIntervalMs);
      renewalTimer.unref?.();
    };
    const stopRenewal = async () => {
      renewalStopped = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      renewalTimer = null;
      await renewalInFlight;
    };
    spriteLog("sprites_pool_preparation_started", context);
    scheduleRenewal();
    try {
      const prepared = await this.options.requestRefill!({ reservation });
      await stopRenewal();
      if (renewalError) throw renewalError;
      // Fence the handoff to ready with a final renewal. The store rejects an
      // expired token, so a preparation that lost ownership can never publish
      // its checkpoint after a reconciliation pass.
      if (!await this.options.store.renewPreparation({
        reservationId: reservation.id,
        leaseToken: reservation.leaseToken,
        leaseMs: this.leaseMs,
      })) throw lostLease();
      await this.options.store.completePreparation({ ...prepared, reservationId: reservation.id, leaseToken: reservation.leaseToken, fingerprint: reservation.fingerprint, baselineManifest: reservation.baselineManifest });
      this.failures = 0;
      spriteLog("sprites_pool_ready", { ...context, checkpointId: prepared.checkpointId, durationMs: Math.round(performance.now() - started) });
    } catch (error) {
      await stopRenewal();
      this.failures++;
      const delay = Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** Math.min(this.failures - 1, 8));
      const retryAt = this.now() + delay;
      spriteLog("sprites_pool_preparation_failed", { ...context, ...spriteErrorFields(error), durationMs: Math.round(performance.now() - started),
        retryAt, retryDelayMs: delay, attempt: this.failures }, "warn");
      await this.options.store.failPreparation({
        reservationId: reservation.id,
        leaseToken: reservation.leaseToken,
        reason: error instanceof Error ? error.message : String(error),
        retryAt,
      }).catch((storeError) => spriteLog("sprites_pool_failure_persist_failed", { ...context, ...spriteErrorFields(storeError) }, "error"));
      // Retry timing is durable in the store (retryAt). Do not hold a worker
      // slot or sleep inside the request; the next maintenance pass retries it.
    } finally {
      this.inFlight--;
    }
  }
}

export function createSpritePoolManager(options: SpritePoolOptions): SpritePoolManager {
  return new SpritePoolManager(options);
}

/** Adapts the durable DB store to the manager contract. Kept here so callers
 * cannot accidentally implement capacity accounting from provider listings. */
export function createDatabaseSpritePoolStore(): SpritePoolStore {
  return {
    async countCapacity() {
      return databaseStore.countCapacity();
    },
    async reservePreparation(input) {
      if (!input.spriteName || !input.baselineManifest) return null;
      const row = await databaseStore.reservePreparation({
        spriteName: input.spriteName,
        fingerprint: input.fingerprint,
        checkpointId: input.checkpointId ?? "pending",
        baselineManifest: input.baselineManifest,
        leaseMs: input.leaseMs,
        maxReady: input.maxReady,
        fingerprintTarget: input.fingerprintTarget,
        baselineClass: input.baselineManifest.dependency ? "repository" : "generic",
      }, input.maxTotal || Number.MAX_SAFE_INTEGER);
      const candidate = row as (typeof row & { spriteName?: string; baselineManifest?: unknown }) | null;
      return candidate ? { id: String(candidate.id), fingerprint: candidate.fingerprint, leaseToken: candidate.leaseToken ?? "", spriteName: candidate.spriteName ?? undefined, baselineManifest: candidate.baselineManifest as Record<string, unknown> } : null;
    },
    async renewPreparation(input) {
      return databaseStore.renewPreparation(input);
    },
    async completePreparation(input) {
      await databaseStore.completePreparation({ reservationId: input.reservationId, leaseToken: input.leaseToken, spriteName: input.spriteName, checkpointId: input.checkpointId, baselineManifest: input.baselineManifest });
    },
    async failPreparation(input) {
      await databaseStore.failPreparation(input);
    },
    async listUnused() {
      const rows = await databaseStore.listActive();
      return rows.filter((r) => r.runId == null && (r.state === "ready" || r.state === "preparing"))
        .map((r) => ({ id: String(r.id), spriteName: r.spriteName, fingerprint: r.fingerprint, state: r.state as SpritePoolState, updatedAt: r.updatedAt }));
    },
    async markDraining(id) { return Boolean(await databaseStore.requestDrain(Number(id))); },
    async reconcile(now) {
      await databaseStore.recoverExpiredLeases(new Date(now));
      const result = await databaseStore.reconcile(now);
      return result as { expired: SpritePoolReservation[]; deletions: SpritePoolEntry[] };
    },
  };
}

export interface SpritePoolProviderRefillOptions {
  baseline: SpriteBaselineManifest;
  workerSha: string;
  bundleUrl: string;
  codexBinary?: string;
  /** Swap is kernel state, so every newly created baseline Sprite must enable
   * it before dependency installation even when the eventual run also does. */
  swapMb: number;
}

/** Provider-side creation hook. A failure always attempts to retire the newly
 * created resource; the durable reservation is failed by the manager. */
export function requestSpritePoolRefill(client: SpritesClient, options: SpritePoolProviderRefillOptions): SpritePoolOptions["requestRefill"] {
  return async ({ reservation }) => {
    const spriteName = reservation.spriteName;
    if (!spriteName) throw new Error("pool reservation has no provider sprite name");
    const expectedFingerprint = baselineFingerprint(options.baseline);
    if (options.workerSha !== options.baseline.workerBundleSha) {
      throw new Error("Sprite baseline worker SHA differs from refill configuration");
    }
    if (reservation.fingerprint !== expectedFingerprint) {
      throw new Error("Sprite pool reservation fingerprint differs from refill baseline");
    }
    if (reservation.baselineManifest
      && baselineFingerprint(reservation.baselineManifest as unknown as SpriteBaselineManifest) !== expectedFingerprint) {
      throw new Error("Sprite pool reservation manifest differs from refill baseline");
    }
    let created = false;
    try {
      await logSpritePhase("pool_sprite_create", { poolEntryId: reservation.id, spriteName, fingerprint: reservation.fingerprint },
        () => client.createSprite({ name: spriteName, urlSettings: { auth: "sprite" } }));
      created = true;
      await logSpritePhase("pool_swap_configure", { poolEntryId: reservation.id, spriteName, fingerprint: reservation.fingerprint },
        () => configureSpriteSwap(client, spriteName, options.swapMb));
      const prepared = await prepareSpriteBaseline(client, spriteName, {
        manifest: options.baseline,
        bundleUrl: options.bundleUrl,
        codexBinary: options.codexBinary,
        dependency: options.baseline.dependency ? {
          remote: options.baseline.dependency.repository,
          branch: options.baseline.dependency.revision,
          packageManager: options.baseline.dependency.packageManager as "npm" | "pnpm" | "yarn",
          installOptions: options.baseline.dependency.installOptions,
        } : undefined,
      });
      if (prepared.fingerprint !== expectedFingerprint) {
        throw new Error("Prepared Sprite fingerprint differs from refill baseline");
      }
      return { spriteName, checkpointId: prepared.checkpointId };
    } catch (error) {
      if (created) await logSpritePhase("failed_preparation_delete", { poolEntryId: reservation.id, spriteName },
        () => client.deleteSprite(spriteName)).catch(() => undefined);
      throw error;
    }
  };
}

/** One provider maintenance pass used by create/sweep paths. Deletion is
 * fenced in the DB before the remote call and finalized only after a confirmed
 * provider delete. Inspection errors leave the row pending. */
export async function requestSpritePoolMaintenance(client: SpritesClient, manager: SpritePoolManager): Promise<void> {
  await manager.reconcile();
  await manager.drain();
  const rows = await databaseStore.listActive();
  for (const row of rows) {
    if (row.state !== "draining" && row.state !== "deleting") continue;
    const [bound] = await db.select({ runId: runnerInstances.runId }).from(runnerInstances)
      .where(eq(runnerInstances.spriteName, row.spriteName));
    if (bound) {
      spriteLog("sprites_pool_delete_skipped", { poolEntryId: row.id, spriteName: row.spriteName, runId: bound.runId, reason: "runner_still_bound" }, "debug");
      continue;
    }
    const deleting = row.state === "deleting" ? row : await databaseStore.markDeleting(row.id);
    if (!deleting) continue;
    try {
      await logSpritePhase("pool_sprite_delete", { poolEntryId: row.id, spriteName: row.spriteName, runId: row.runId }, () => client.deleteSprite(row.spriteName));
      const deleted = await databaseStore.markDeleted(row.id);
      if (deleted) spriteLog("sprites_pool_deleted", { poolEntryId: row.id, spriteName: row.spriteName, runId: row.runId });
    } catch (error) {
      spriteLog("sprites_pool_delete_pending", { poolEntryId: row.id, spriteName: row.spriteName, runId: row.runId, ...spriteErrorFields(error) }, "warn");
      // Keep the deleting row for a later pass; provider failure is unknown.
    }
  }
  const [waiting] = await db.select({ id: agentSessions.id }).from(agentSessions)
    .leftJoin(runnerInstances, eq(runnerInstances.runId, agentSessions.id))
    .where(and(eq(agentSessions.status, "pending"), eq(agentSessions.runtime, "worker"),
      or(isNull(runnerInstances.spriteName), eq(runnerInstances.state, "gone")))).limit(1);
  if (waiting) {
    spriteLog("sprites_pool_refill_skipped", { reason: "queued_run_priority", runId: waiting.id }, "debug");
    return;
  } // Foreground demand gets newly freed capacity first.
  await manager.requestRefill();
}
