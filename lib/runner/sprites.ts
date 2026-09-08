// lib/runner/sprites.ts
// Sprites-backed RunnerProvider — see docs/sprites-migration-design.md

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { agentEvents, agentSessions, runnerInstances } from "@/db/schema";
import { agentCredentialEnv } from "../agent-backend/provider-env";
import { config } from "../config";
import type { SessionStatus } from "../types";
import { nextSpritesLifecycleAction } from "./lifecycle";
import { nestedDispatchMode } from "./provider";
import { recordRunnerEvent, timeRunnerPhase } from "./telemetry";
import type { CreateRunnerInput, WorkerGenerationRef, RunnerObservation, RunnerProvider, RunnerRef, RunnerState } from "./provider";
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

function sameEnv(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  if (!a) return false;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length && aKeys.every((key, i) => key === bKeys[i] && a[key] === b[key]);
}

export function spriteNameForRun(runId: number): string {
  const prefix = config.sprites.prefix || "to-run-";
  return `${prefix}${runId}`;
}

/** Service names are generation-scoped. Keeping the Sprite itself stable lets
 * us retain its checkout/session volume while a delayed stop for generation N
 * can never terminate generation N+1. */
export function workerServiceName(workerGeneration: number | null | undefined): string {
  return Number.isSafeInteger(workerGeneration) && Number(workerGeneration) > 0
    ? `worker-g${Number(workerGeneration)}`
    : "worker";
}

type GenerationRow = {
  workerGeneration?: number | null;
  providerServiceName?: string | null;
};

function generationOf(row: GenerationRow | null | undefined): number | null {
  const n = row?.workerGeneration;
  return Number.isSafeInteger(n) && Number(n) > 0 ? Number(n) : null;
}

function serviceNameOf(row: GenerationRow | null | undefined): string {
  if (row?.providerServiceName) return row.providerServiceName;
  // Rows created before generation-aware services used the literal `worker`;
  // generation 1 remains compatible until that row is explicitly restarted.
  if (generationOf(row) === 1) return "worker";
  return workerServiceName(generationOf(row));
}

/** Keep generation columns optional while the generation migration is rolled
 * out. New callers always provide both values; legacy rows continue using the
 * historical `worker` service until their next restart. */
function generationInsert(generation: number | undefined, serviceName: string): Record<string, string | number> {
  if (!Number.isSafeInteger(generation) || Number(generation) <= 0) return {};
  return { workerGeneration: Number(generation), providerServiceName: serviceName, generationState: "connecting" };
}

function generationColumns(): { workerGeneration?: any; providerOperationId?: any } {
  const columns = runnerInstances as unknown as Record<string, unknown>;
  return {
    workerGeneration: columns.workerGeneration,
    providerOperationId: columns.providerOperationId,
  };
}

function generationGuard(input: CreateRunnerInput, fallback: number | null): { workerGeneration?: number; providerOperationId?: string } {
  const workerGeneration = input.workerGeneration ?? fallback ?? undefined;
  return {
    ...(workerGeneration != null ? { workerGeneration } : {}),
    ...(input.providerOperationId ? { providerOperationId: input.providerOperationId } : {}),
  };
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

function runIdFromSpriteName(name: string): number | null {
  if (!isRunSpriteName(name)) return null;
  const prefix = config.sprites.prefix || "to-run-";
  const runId = Number(name.slice(prefix.length));
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
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

// Provider calls are serialized per run. This is deliberately process-local
// (the DB operation id is the cross-process fence); it closes the common race
// where a resume and cancellation both issue service mutations concurrently.
const spriteOperations = new Map<number, Promise<unknown>>();

async function serializeSpriteOperation<T>(runId: number, operation: () => Promise<T>): Promise<T> {
  const previous = spriteOperations.get(runId) ?? Promise.resolve();
  // The in-process queue closes races within one server, while this
  // transaction-scoped advisory lock serializes provider operations across
  // control-plane replicas. Keep the transaction open for the complete
  // external lifecycle operation so a later generation cannot start between
  // terminal claim and Sprite deletion.
  const runLocked = () => db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"sprites:" + runId}))`);
    return operation();
  });
  const current = previous.then(runLocked, runLocked);
  const queued = current.then(() => undefined, () => undefined);
  spriteOperations.set(runId, queued);
  try {
    return await current;
  } finally {
    if (spriteOperations.get(runId) === queued) spriteOperations.delete(runId);
  }
}

export async function buildSpritesWorkerEnv(
  runId: number,
  opts: { channelInstanceId?: string; channelListenEndpoint?: string; workerGeneration?: number } = {},
): Promise<Record<string, string>> {
  const channelEnv =
    opts.channelInstanceId && opts.channelListenEndpoint
      ? workerChannelDispatchEnv(runId, opts.channelInstanceId, opts.channelListenEndpoint, opts.workerGeneration ?? 1)
      : {};
  return compactEnv({
    GH_TOKEN: envValue("GH_TOKEN"),
    ...(await agentCredentialEnv()),
    TASK_ORCH_AGENT_BACKEND: envValue("TASK_ORCH_AGENT_BACKEND"),
    TASK_ORCH_CHAT_MODEL: envValue("TASK_ORCH_CHAT_MODEL"),
    TASK_ORCH_AGENT_MODEL: envValue("TASK_ORCH_AGENT_MODEL"),
    // Sprite workers are already isolated per run, so the VM supplies the
    // filesystem boundary instead of Codex's nested sandbox. Keep an override for
    // operators who want the local/default workspace-write policy there too.
    TASK_ORCH_CODEX_SANDBOX: envValue("TASK_ORCH_CODEX_SANDBOX") ?? "danger-full-access",
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
    ...(opts.workerGeneration != null ? { TASK_ORCH_WORKER_GENERATION: String(opts.workerGeneration) } : {}),
    SESSION_ROOT: "/home/user/session",
    REPO_CACHE_DIR: envValue("TASK_ORCH_REPO_CACHE_DIR") ?? "/opt/repo-cache",
    ...channelEnv,
  });
}

export class SpritesRunnerProvider implements RunnerProvider {
  readonly kind = "sprites" as const;

  constructor(private readonly spritesClient: SpritesClient = makeSpritesClient()) {}

  async inspect(handle: string): Promise<RunnerObservation> {
    return this.inspectService(handle, "worker");
  }

  /** Observe the process identity for one generation, rather than merely the
   * stable Sprite. A running Sprite with a replaced service is not proof that
   * the current worker is alive. */
  async inspectGeneration(ref: WorkerGenerationRef): Promise<RunnerObservation> {
    return this.inspectService(
      ref.providerHandle,
      ref.providerServiceName ?? (ref.generation === 1 ? "worker" : workerServiceName(ref.generation)),
    );
  }

  private async inspectService(handle: string, serviceName: string): Promise<RunnerObservation> {
    try {
      const sprite = await this.spritesClient.getSprite(handle);
      if (!sprite) return { status: "dead", detail: "sprite gone" };
      const runnerState = spritesRunnerStateFromStatus(sprite.status);
      if (runnerState === "gone") return { status: "dead", detail: `sprite ${sprite.status}` };
      const service = await this.spritesClient.getService(handle, serviceName);
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

  private async updateInstance(
    runId: number,
    patch: Partial<typeof runnerInstances.$inferInsert>,
    guard: { workerGeneration?: number; providerOperationId?: string; spriteName?: string | null } = {},
  ): Promise<boolean> {
    let where = eq(runnerInstances.runId, runId);
    const columns = generationColumns();
    if (guard.workerGeneration != null && columns.workerGeneration) {
      where = and(where, eq(columns.workerGeneration, guard.workerGeneration)) as typeof where;
    }
    if (guard.providerOperationId != null && columns.providerOperationId) {
      where = and(where, eq(columns.providerOperationId, guard.providerOperationId)) as typeof where;
    }
    if (guard.spriteName !== undefined) {
      where = and(where, guard.spriteName == null ? isNull(runnerInstances.spriteName) : eq(runnerInstances.spriteName, guard.spriteName)) as typeof where;
    }
    const result = await db.update(runnerInstances).set(patch).where(where);
    return result.count > 0;
  }

  private async releaseRunClaimIfCurrent(runId: number, spriteName: string, workerGeneration?: number | null): Promise<void> {
    const session = db
      .update(agentSessions)
      .set({ workerScope: null })
      .where(and(eq(agentSessions.id, runId), eq(agentSessions.workerScope, spriteName)));
    // The claim itself is run-scoped, but generation is the authority fence for
    // provider cleanup. The runner-row CAS is performed by callers before this
    // method; keeping this helper narrowly scoped avoids clearing a newer claim.
    await session;
  }

  async create(input: CreateRunnerInput): Promise<RunnerRef | null> {
    return serializeSpriteOperation(input.runId, () => this.createUnserialized(input));
  }

  private async createUnserialized(input: CreateRunnerInput): Promise<RunnerRef | null> {
    const existing = await this.getInstance(input.runId);
    if (existing?.spriteName) {
      const resumed = await this.resumeUnserialized(input.runId, input);
      if (resumed) return resumed;
    }

    const spriteName = spriteNameForRun(input.runId);
    const channelInstanceId = input.channelInstanceId ?? existing?.channelInstanceId ?? newChannelInstanceId();
    const channelListenEndpoint = spritesListenEndpoint();
    const workerEnv = await buildSpritesWorkerEnv(input.runId, {
      channelInstanceId,
      channelListenEndpoint,
      workerGeneration: input.workerGeneration,
    });
    const serviceName = input.providerServiceName ?? workerServiceName(input.workerGeneration);

    // Publish the stable provider handle before any external boot work. A
    // dispatcher crash after create/bootstrap can then be adopted by sweep or
    // the next generation instead of being mistaken for an orphan Sprite.
    if (input.workerGeneration != null) {
      const mapped = await this.updateInstance(input.runId, {
        provider: "sprites",
        spriteName,
        state: "starting",
        generationState: "booting",
        providerServiceName: serviceName,
      }, generationGuard(input, null));
      if (!mapped) return null;
    }

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
          this.spritesClient.putService(spriteName, serviceName, {
            cmd: "node",
            args: ["dist/run-worker.js", String(input.runId)],
            env: workerEnv,
            dir: "/home/user/worker",
          }),
        { provider: "sprites", fields: { runId: input.runId, spriteName } },
      );

      await timeRunnerPhase(
        "sprites_service_start",
        () => this.spritesClient.startService(spriteName, serviceName),
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
      // Persist mapping. A generation-aware dispatch must update only its
      // `(run,generation,operation)` row; an old provider call must never use
      // an unconditional upsert to roll generation N+1 back to N. Legacy
      // direct callers retain the historical upsert path.
      const instancePatch = {
        provider: "sprites" as const,
        spriteName,
        state: "starting" as const,
        lastStartedAt: new Date(),
        channelInstanceId,
        channelEndpoint,
        ...generationInsert(input.workerGeneration, serviceName),
        lastProviderError: null,
      };
      if (input.workerGeneration != null) {
        const accepted = await this.updateInstance(input.runId, instancePatch, generationGuard(input, null));
        if (!accepted) {
          // The operation was superseded after provider startup. Its service
          // name is generation-specific, so stopping it is safe even though
          // the stable Sprite now belongs to another generation.
          await this.stopServiceAndConfirm(spriteName, serviceName).catch(() => undefined);
          return null;
        }
      } else {
        await db
          .insert(runnerInstances)
          .values({
            runId: input.runId,
            ...instancePatch,
            region: null,
          })
          .onConflictDoUpdate({
            target: runnerInstances.runId,
            set: instancePatch,
          });
      }

      await emitRunnerEvent(input.runId, "runner_created", { spriteName });
      return { runId: input.runId, handle: spriteName, provider: "sprites", channelInstanceId, channelEndpoint,
        workerGeneration: input.workerGeneration, providerServiceName: serviceName };
    } catch (err) {
      console.error("[SpritesRunnerProvider] create failed:", err);
      // Provider calls can finish after cancellation or a replacement. Claim
      // failure cleanup against this exact generation/operation before
      // deleting the stable Sprite; otherwise a stale create failure can
      // destroy the Sprite already adopted by generation N+1.
      let ownsCleanup = true;
      if (created && input.workerGeneration != null) {
        ownsCleanup = await this.updateInstance(input.runId, {
          state: "gone",
          spriteName: null,
          generationState: "failed",
          providerOperationId: null,
        }, generationGuard(input, null));
      }
      if (created && ownsCleanup) {
        await this.spritesClient.deleteSprite(spriteName).catch(() => {});
      }
      throw err;
    }
  }

  /** Resume a hibernated or existing sprite for a follow-up turn. */
  async resume(runId: number, input: CreateRunnerInput = { runId, scope: `run-${runId}` }): Promise<RunnerRef | null> {
    return serializeSpriteOperation(runId, () => this.resumeUnserialized(runId, input));
  }

  private async resumeUnserialized(runId: number, input: CreateRunnerInput = { runId, scope: `run-${runId}` }): Promise<RunnerRef | null> {
    const instance = await this.getInstance(runId);
    if (!instance?.spriteName) return null;
    const spriteName = instance.spriteName;
    const requestedGeneration = input.workerGeneration;
    const currentGeneration = generationOf(instance);
    const restarting = input.replacesGeneration != null || (requestedGeneration != null && requestedGeneration > (currentGeneration ?? 0));
    const channelInstanceId = input.channelInstanceId ?? (restarting ? newChannelInstanceId() : instance.channelInstanceId ?? newChannelInstanceId());
    const oldServiceName = input.previousProviderServiceName
      ?? (input.replacesGeneration != null
        ? (input.replacesGeneration === 1 ? "worker" : workerServiceName(input.replacesGeneration))
        : serviceNameOf(instance));
    const serviceName = input.providerServiceName ?? (requestedGeneration == null ? serviceNameOf(instance) : workerServiceName(requestedGeneration));
    // The dial endpoint is a pure function of the sprite name. Never trust the
    // stored value here: dispatch seeds the row with a `pending:sprites:` placeholder
    // before it knows the name, and a redispatch can leave that placeholder in
    // place (run 185, 2026-08-27 — every follow-up turn dialed "pending:…").
    const channelEndpoint = spritesDialEndpoint(spriteName);

    // Fetch sprite — a 404 means we must recreate? But design says one sprite per run
    // bound for life; if it's gone, the transcript is lost and caller should create fresh.
    // For now, if get returns null, treat as gone and return null so dispatch can create.
    let sprite: Sprite | null;
    try {
      sprite = await this.spritesClient.getSprite(spriteName);
    } catch (err) {
      // A provider read failure is not evidence that the Sprite is gone. Do
      // not fall through to create/resume work: that could start a replacement
      // while the old service is still running and bypass its teardown fence.
      console.warn(`[SpritesRunnerProvider] getSprite failed for ${spriteName}; refusing adoption`, err);
      throw err;
    }
    if (!sprite) {
      await this.updateInstance(runId, { state: "gone" }, generationGuard(input, currentGeneration));
      return null;
    }

    const runnerState = spritesRunnerStateFromStatus(sprite.status);
    if (runnerState === "gone") {
      await this.updateInstance(runId, { state: "gone" }, generationGuard(input, currentGeneration));
      return null;
    }

    // Ensure worker service is running — after hibernate the process may be
    // stopped and needs an explicit start. Both S1 outcomes are covered:
    // - if processes survive hibernate, start is idempotent (already running)
    // - if not, this restarts it before we dial
    const now = new Date();
    const generationFence = generationGuard(input, currentGeneration);
    if (generationFence.workerGeneration != null) {
      const claimed = await this.updateInstance(
        runId,
        { generationState: restarting ? "booting" : "connecting" },
        generationFence,
      );
      if (!claimed) return null;
    }
    // The service definition carries the channel credential the worker verifies
    // every dial against. It is an HMAC over AUTH_SECRET, so a control plane
    // whose secret changed since the sprite was created (a deploy that rotated
    // AUTH_SECRET: runs 182-185, 2026-08-27) is refused with 401 forever.
    // Re-define the service with the current env whenever the stored credential
    // no longer matches; that also refreshes provider keys and model settings.
    try {
      const desiredEnv = await buildSpritesWorkerEnv(runId, {
        channelInstanceId,
        channelListenEndpoint: spritesListenEndpoint(),
        workerGeneration: requestedGeneration ?? currentGeneration ?? undefined,
      });
      // A true restart gets a new service and instance. Stop and confirm the
      // prior generation before binding the replacement to port 8787; a delayed
      // stop on the stable `worker` name is otherwise able to kill the new turn.
      if (restarting && oldServiceName !== serviceName) {
        await this.stopServiceAndConfirm(spriteName, oldServiceName);
      }
      // Provider inspection failures are not proof that the service is absent
      // or stale. Surface the error so resume fails closed instead of starting
      // a second process while the old service may still own the port.
      const current = await this.spritesClient.getService(spriteName, serviceName);
      const staleEnv = !sameEnv(current?.env, desiredEnv);
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
          await this.stopServiceAndConfirm(spriteName, serviceName, serviceName !== "worker");
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
      if (staleEnv || staleBundle) {
        console.warn(`[SpritesRunnerProvider] redefining the worker service on ${spriteName} (${staleBundle ? "new bundle" : "worker env changed"})`);
        await this.stopServiceAndConfirm(spriteName, serviceName, serviceName !== "worker");
        await this.spritesClient.putService(spriteName, serviceName, {
          cmd: "node",
          args: ["dist/run-worker.js", String(runId)],
          env: desiredEnv,
          dir: "/home/user/worker",
        });
        await emitRunnerEvent(runId, "runner_service_redefined", { spriteName, reason: staleBundle ? "new-bundle" : "worker-env-changed" });
      }
    } catch (err) {
      console.warn(`[SpritesRunnerProvider] service refresh failed for ${spriteName}:`, err);
      // A generation replacement must fail closed if teardown could not be
      // confirmed. Starting the new service while the old one may still hold
      // port 8787 recreates the delayed-stop race this lifecycle is fencing.
      throw err;
    }
    try {
      await this.spritesClient.startService(spriteName, serviceName);
    } catch (err) {
      console.warn(`[SpritesRunnerProvider] startService failed for ${spriteName}:`, err);
    }

    await this.updateInstance(runId, {
      state: "starting",
      lastStartedAt: now,
      channelInstanceId,
      channelEndpoint,
      ...generationInsert(requestedGeneration, serviceName),
      generationState: "connecting",
    }, generationFence);
    await emitRunnerEvent(runId, "runner_resumed", { spriteName, status: sprite.status });
    return { runId, handle: spriteName, provider: "sprites", channelInstanceId, channelEndpoint,
      workerGeneration: requestedGeneration ?? currentGeneration ?? undefined, providerServiceName: serviceName };
  }

  /** Stop a generation-specific service and wait until the provider no longer
   * reports it running. An API error is treated as an absent service only when
   * the follow-up read confirms that; callers never start a replacement based
   * solely on fire-and-forget stop. */
  private async stopServiceAndConfirm(spriteName: string, serviceName: string, confirm = true): Promise<void> {
    await this.spritesClient.stopService(spriteName, serviceName).catch(() => {});
    if (!confirm) return;
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    for (;;) {
      try {
        const service = await this.spritesClient.getService(spriteName, serviceName);
        const state = service?.state;
        if (!service || state?.status === "stopped" || state?.status === "failed") return;
        lastError = undefined;
      } catch (err) {
        // An observation failure is unknown, never proof that teardown
        // completed. Keep polling and fail closed at the deadline.
        lastError = err;
      }
      if (Date.now() >= deadline) {
        const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
        throw new Error(`Sprites service ${spriteName}/${serviceName} did not stop${detail}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async stopGeneration(ref: WorkerGenerationRef): Promise<void> {
    return serializeSpriteOperation(ref.runId, () => this.stopGenerationUnserialized(ref));
  }

  private async stopGenerationUnserialized(ref: WorkerGenerationRef): Promise<void> {
    const serviceName = ref.providerServiceName ?? workerServiceName(ref.generation);
    const row = await this.getInstance(ref.runId);
    if (row && generationOf(row) === ref.generation) {
      await this.updateInstance(ref.runId, { generationState: "stopping", providerOperationId: null }, { workerGeneration: ref.generation });
    }
    await this.stopServiceAndConfirm(ref.providerHandle, serviceName);
    if (row && generationOf(row) === ref.generation) {
      await this.updateInstance(ref.runId, { generationState: "stopped" }, { workerGeneration: ref.generation });
    }
  }

  async stop(handle: string): Promise<void> {
    const [row] = await db.select({ runId: runnerInstances.runId, spriteName: runnerInstances.spriteName, workerGeneration: runnerInstances.workerGeneration, channelInstanceId: runnerInstances.channelInstanceId, providerServiceName: runnerInstances.providerServiceName }).from(runnerInstances).where(eq(runnerInstances.spriteName, handle));
    if (row) {
      // destroyGeneration owns the per-run serialization. Calling it from a
      // second lock here would wait on itself forever because the lock is a
      // promise chain, not a re-entrant mutex.
      return this.destroyGeneration({
        runId: row.runId,
        generation: row.workerGeneration,
        instanceId: row.channelInstanceId ?? "legacy",
        providerHandle: handle,
        ...(row.providerServiceName ? { providerServiceName: row.providerServiceName } : {}),
      });
    }
    console.warn(`[SpritesRunnerProvider] stop: no runner row for sprite ${handle}`);
    const runId = runIdFromSpriteName(handle);
    if (runId != null) {
      await serializeSpriteOperation(runId, async () => {
        // Re-check under the durable lifecycle lock. A row may have been
        // mapped after the initial lookup; deleting then could remove a new
        // generation's stable Sprite.
        const [mapped] = await db.select({ runId: runnerInstances.runId })
          .from(runnerInstances)
          .where(eq(runnerInstances.spriteName, handle));
        if (mapped) return;
        await this.spritesClient.deleteSprite(handle).catch(() => {});
      });
      return;
    }
    await this.spritesClient.deleteSprite(handle).catch(() => {});
  }

  /** Destroy a run-scoped Sprite only after atomically claiming the current
   * generation. A stale cleanup therefore cannot delete a replacement Sprite
   * generation that reused the stable run handle. */
  async destroyGeneration(ref: WorkerGenerationRef): Promise<void> {
    return serializeSpriteOperation(ref.runId, () => this.destroyGenerationUnserialized(ref));
  }

  private async destroyGenerationUnserialized(ref: WorkerGenerationRef): Promise<void> {
    const claimed = await this.updateInstance(ref.runId, {
      state: "gone",
      spriteName: null,
      generationState: "stopped",
      providerOperationId: null,
    }, { workerGeneration: ref.generation });
    if (!claimed) return;
    await this.spritesClient.deleteSprite(ref.providerHandle).catch(() => {});
    await this.releaseRunClaimIfCurrent(ref.runId, ref.providerHandle);
    await clearSdkSession(ref.runId);
    await emitRunnerEvent(ref.runId, "runner_failed", { spriteName: ref.providerHandle, reason: "stopped", workerGeneration: ref.generation });
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
        workerGeneration: runnerInstances.workerGeneration,
        providerServiceName: runnerInstances.providerServiceName,
        channelInstanceId: runnerInstances.channelInstanceId,
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
      const spriteName = row.spriteName;
      // Serialize the complete observation/reconciliation transaction with
      // create, resume, stop, and destroy for this run. A lock only around the
      // final delete still lets a concurrent resume race the provider reads.
      await serializeSpriteOperation(row.runId, async () => {
        try {
        let sprite = spriteByName.get(spriteName);
        if (!sprite) {
          // The list was snapshotted before the rows: a sprite created in
          // between is missing here while booting normally. Confirm with a
          // direct observation and act only on `dead`.
          const observed = row.workerGeneration != null
            ? await this.inspectGeneration({
                runId: row.runId,
                generation: row.workerGeneration,
                instanceId: row.channelInstanceId ?? "legacy",
                providerHandle: spriteName,
                ...(row.providerServiceName ? { providerServiceName: row.providerServiceName } : {}),
              })
            : await this.inspect(spriteName);
          if (observed.status !== "dead") return;
          await this.updateInstance(row.runId, { state: "gone" }, { workerGeneration: row.workerGeneration ?? undefined });
          const isActive = !!row.runStatus && ["preparing", "running", "pushing", "opening_pr"].includes(row.runStatus);
          if (row.workerScope === spriteName && isActive) {
            const runs = await import("../runs");
            await runs.handleWorkerDeath(row.runId, {
              exitCode: null,
              oomKilled: false,
              containerName: spriteName,
              incarnation: row.workerIncarnation ?? null,
            });
          }
          return;
        }

        if (sprite.status == null) {
          const full = await this.spritesClient.getSprite(spriteName).catch(() => null);
          if (full?.status) {
            sprite = full;
          } else {
            if (config.worker.debugLog) console.debug(`[SpritesRunnerProvider] skipping sweep for ${spriteName}: missing status in list`);
            return;
          }
        }

        const runnerState = spritesRunnerStateFromStatus(sprite.status);
        if (runnerState !== row.state) {
          await this.updateInstance(row.runId, {
            state: runnerState,
            ...(runnerState === "running" ? { lastStartedAt: new Date() } : {}),
          }, { workerGeneration: row.workerGeneration ?? undefined });
        }

        const runStatus = (row.runStatus ?? "closed") as SessionStatus;
        const observed = row.workerGeneration != null
          ? await this.inspectGeneration({
              runId: row.runId,
              generation: row.workerGeneration,
              instanceId: row.channelInstanceId ?? "legacy",
              providerHandle: spriteName,
              ...(row.providerServiceName ? { providerServiceName: row.providerServiceName } : {}),
            })
          : await this.inspect(spriteName);
        await this.applyLifecycle(row, runnerState, runStatus, now, observed.status === "dead" ? false : true);
        } catch (err) {
          console.error(`[SpritesRunnerProvider] sweep failed for run ${row.runId}:`, err);
        }
      });
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
        const runId = runIdFromSpriteName(s.name);
        if (runId != null) {
          await serializeSpriteOperation(runId, async () => {
            // The list and row query are snapshots. Re-check while holding the
            // same lock as dispatch allocation/create before deleting.
            const [mapped] = await db.select({ runId: runnerInstances.runId })
              .from(runnerInstances)
              .where(eq(runnerInstances.spriteName, s.name));
            if (mapped) return;
            await this.spritesClient.deleteSprite(s.name);
          });
        } else {
          await this.spritesClient.deleteSprite(s.name);
        }
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
      workerGeneration?: number | null;
      providerServiceName?: string | null;
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
    // Claim terminal ownership before touching the provider. If a newer
    // generation was allocated while this sweep was observing the old one,
    // this CAS fails and the old sweep must not delete the shared Sprite.
    const cleaned = await this.updateInstance(row.runId, {
      state: "gone",
      spriteName: null,
      generationState: "stopped",
      providerOperationId: null,
    }, row.workerGeneration == null
      ? { spriteName }
      : { workerGeneration: row.workerGeneration, spriteName });
    if (!cleaned) return;
    await timeRunnerPhase(
      "sprites_sprite_destroy",
      () => this.spritesClient.deleteSprite(spriteName).catch(() => {}),
      { provider: "sprites", fields: { runId: row.runId, spriteName, idleMs } },
    );
    await this.releaseRunClaimIfCurrent(row.runId, spriteName);
    if (row.spriteName) await clearSdkSession(row.runId);
    await emitRunnerEvent(row.runId, "runner_destroyed", { spriteName, idleMs });
  }
}

// Aliases for tests / external use
export type { Sprite, SpritesClient };
