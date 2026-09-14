import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { agentSessions, runnerInstances, spritePoolAssignments, spritePoolEntries } from "../../db/schema";
import { config } from "../config";
import type { WorkerGenerationRef } from "./provider";
import type { SpritesClient } from "./sprites-client";
import { getEffectiveSpriteBaselines } from "./sprites-managed-config";
import { workerBundleId } from "../worker-bundle";
import { verifyBaseline, type SpriteBaselineManifest } from "./sprites-baseline";
import { SPRITE_CODEX_BINARY } from "./sprites-bootstrap";
import { isConversationalTerminal } from "./lifecycle";
import { spriteLog } from "./sprites-log";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Called under the old run's durable Sprite lifecycle lock. A ready entry is
 * published in the same transaction that revokes the old runner mapping. */
export async function recycleCompletedSprite(client: SpritesClient, ref: WorkerGenerationRef,
  stopService: (sprite: string, service: string) => Promise<unknown>): Promise<boolean> {
  const [entry] = await db.select().from(spritePoolEntries).where(eq(spritePoolEntries.spriteName, ref.providerHandle));
  if (!entry || entry.runId !== ref.runId || !["claimed", "recycling"].includes(entry.state)) return false;
  // Finish durable recycling even if an operator disabled future reuse.
  if (entry.state !== "recycling" && !config.sprites.poolReuse) return false;
  const [run] = await db.select().from(agentSessions).where(eq(agentSessions.id, ref.runId));
  if (!run?.userId || !run.repoId || entry.baselineClass !== "repository") return false;
  const manifest = entry.baselineManifest as unknown as SpriteBaselineManifest;
  const specs = await getEffectiveSpriteBaselines(await workerBundleId());
  const spec = specs.find((s) => s.fingerprint === entry.fingerprint && s.repositoryId === run.repoId
    && s.allowedUserIds?.length === 1 && s.allowedUserIds[0] === run.userId && s.target > 0);
  if ((entry.reuseUserId != null && entry.reuseUserId !== run.userId)
    || (entry.reuseRepositoryId != null && entry.reuseRepositoryId !== run.repoId)) throw new Error("Sprite reuse affinity mismatch");
  // Reusable resources with resumable work must not fall through to deletion.
  if (entry.state !== "recycling" && (run.status !== "completed" || isConversationalTerminal({ runStatus: run.status, goal: run.goal }))) return !["cancelled", "closed"].includes(run.status);

  if (entry.state === "claimed") {
    // Keep the runner and run locks through quiescence + delivery validation.
    // appendMessage/dispatch cannot slip new work between the check and fence.
    const reserved = await db.transaction(async (tx) => {
      const [runner] = await tx.select().from(runnerInstances).where(eq(runnerInstances.runId, ref.runId)).for("update");
      const [current] = await tx.select().from(agentSessions).where(eq(agentSessions.id, ref.runId)).for("update");
      const [assignment] = await tx.select().from(spritePoolAssignments)
        .where(eq(spritePoolAssignments.leaseToken, entry.leaseToken!)).for("update");
      if (!runner || runner.spriteName !== ref.providerHandle || runner.workerGeneration !== ref.generation
        || runner.channelInstanceId !== ref.instanceId || current?.status !== "completed" || !assignment) return false;
      const pending = await tx.execute(sql`SELECT 1 FROM run_inputs WHERE run_id=${ref.runId} AND status IN ('pending','assigned') LIMIT 1`);
      if (pending.length) return false;
      // GitHub commonly deletes a task branch after squash-merge. The branch
      // lookup below then cannot prove delivery even though webhook handling
      // recorded the exact merged head on every matching active pool
      // assignment. Inbox delivery is deliberately routed only to the newest
      // run, so it is not proof for older completed assignments. Accept only a
      // server-owned assignment receipt whose branch and full SHA both match;
      // arbitrary agent output and task state are not delivery evidence.
      const mergedHead = assignment.branch === current.branch
        && typeof assignment.commitSha === "string" && /^[a-f0-9]{40}$/.test(assignment.commitSha)
        ? assignment.commitSha
        : null;
      if (!client.listServices) throw new Error("Sprite recycling requires service inspection");
      for (const service of await client.listServices(ref.providerHandle)) await stopService(ref.providerHandle, service.name);
      const repoPath = runner.repoPath;
      // Reuse must not discard unpublished work. An unchanged baseline commit
      // is already durable; otherwise HEAD must equal the published task branch.
      // A deployment may retire the pool fingerprint before this worker
      // finishes. Its sealed manifest remains authoritative for validating
      // delivery even when there is no longer a matching target spec.
      const baselineRevision = manifest.dependency?.revision ?? "";
      const remote = spec?.remote ?? manifest.dependency?.repository ?? "";
      const delivery = await client.exec(ref.providerHandle, { timeoutMs: 30_000, maxOutputBytes: 4096,
        env: { GIT_TERMINAL_PROMPT: "0", ...(process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {}) },
        cmd: `set -eu\ncd ${quote(repoPath)}\n[ -z "$(git status --porcelain --untracked-files=normal)" ] || exit 3\nhead=$(git rev-parse HEAD)\nif [ "$head" != ${quote(baselineRevision)} ] && [ "$head" != ${quote(mergedHead ?? "")} ]; then\n[ -n ${quote(remote)} ] || exit 4\nremote=$(git ls-remote --exit-code ${quote(remote)} ${quote("refs/heads/" + (current.branch ?? ""))} | awk 'NR==1 { print $1 }')\n[ "$remote" = "$head" ] || exit 4\nfi\nprintf '%s' "$head"` });
      if (delivery.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(delivery.stdout.trim())) {
        await tx.update(runnerInstances).set({ state: "stopped", generationState: "stopped", providerOperationId: null }).where(eq(runnerInstances.runId, ref.runId));
        spriteLog("sprites_pool_reuse_retained", { runId: ref.runId, poolEntryId: entry.id, reason: "unpublished_or_unverified_work" });
        return false;
      }
      const [changed] = await tx.update(spritePoolEntries).set({ state: "recycling", reuseUserId: current.userId,
        reuseRepositoryId: current.repoId, leaseExpiresAt: new Date(Date.now() + 30 * 60_000), updatedAt: new Date() })
        .where(and(eq(spritePoolEntries.id, entry.id), eq(spritePoolEntries.runId, ref.runId), eq(spritePoolEntries.state, "claimed"),
          eq(spritePoolEntries.leaseToken, entry.leaseToken!))).returning();
      if (!changed) return false;
      await tx.update(spritePoolAssignments).set({ branch: current.branch, commitSha: delivery.stdout.trim() })
        .where(eq(spritePoolAssignments.leaseToken, entry.leaseToken!));
      await tx.update(runnerInstances).set({ state: "stopped", generationState: "stopping", providerOperationId: null })
        .where(eq(runnerInstances.runId, ref.runId));
      return true;
    });
    if (!reserved) return true;
  }

  // The durable recycling fence remains unclaimable after any interruption.
  // Reconciliation repeats restore and verification; it never reruns npm ci.
  if (!client.listServices) throw new Error("Sprite recycling requires service inspection");
  for (const service of await client.listServices(ref.providerHandle)) await stopService(ref.providerHandle, service.name);
  await client.restoreCheckpoint(ref.providerHandle, entry.checkpointId);
  if ((await client.listServices(ref.providerHandle)).length) throw new Error("Recycled baseline contains unexpected service definitions");
  await verifyBaseline(client, ref.providerHandle, manifest,
    config.sprites.codexBinary ?? SPRITE_CODEX_BINARY);

  await db.transaction(async (tx) => {
    const [runner] = await tx.select().from(runnerInstances).where(eq(runnerInstances.runId, ref.runId)).for("update");
    await tx.select().from(agentSessions).where(eq(agentSessions.id, ref.runId)).for("update");
    if (!runner || runner.spriteName !== ref.providerHandle || runner.workerGeneration !== ref.generation
      || runner.channelInstanceId !== ref.instanceId) throw new Error("Sprite recycling generation changed");
    const now = new Date();
    const [released] = await tx.update(spritePoolEntries).set({ state: spec ? "ready" : "draining", runId: null,
      restoreState: "restored", baselineRestoredAt: now, reuseCount: sql`${spritePoolEntries.reuseCount} + 1`,
      leaseToken: null, leaseExpiresAt: null, providerOperationId: null, lastError: null, updatedAt: now })
      .where(and(eq(spritePoolEntries.id, entry.id), eq(spritePoolEntries.runId, ref.runId), eq(spritePoolEntries.state, "recycling"),
        eq(spritePoolEntries.leaseToken, entry.leaseToken!))).returning();
    if (!released) throw new Error("Sprite recycling assignment changed");
    await tx.update(spritePoolAssignments).set({ releasedAt: now }).where(eq(spritePoolAssignments.leaseToken, entry.leaseToken!));
    await tx.update(runnerInstances).set({ spriteName: null, state: "gone", generationState: "stopped", providerOperationId: null,
      controllerId: null, channelEndpoint: null }).where(eq(runnerInstances.runId, ref.runId));
    await tx.update(agentSessions).set({ workerScope: null, sdkSessionId: null }).where(eq(agentSessions.id, ref.runId));
  });
  spriteLog("sprites_pool_reused", { runId: ref.runId, poolEntryId: entry.id, spriteName: entry.spriteName, fingerprint: entry.fingerprint });
  return true;
}
