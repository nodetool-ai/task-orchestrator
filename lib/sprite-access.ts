import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import type { AppApiContext } from "./app-api/types";

/** Persisted run ownership wins over attribution or caller-provided user IDs. */
export async function spriteCaller(ctx: AppApiContext) {
  const [run] = ctx.runId ? await db.select({ userId: agentSessions.userId, repoId: agentSessions.repoId })
    .from(agentSessions).where(eq(agentSessions.id, ctx.runId)) : [];
  const userId = ctx.runId ? run?.userId : ctx.userId;
  if (!userId) throw new Error("Sprite operations require an authenticated run owner");
  return { userId, repoId: run?.repoId ?? null };
}

export type SpriteRunTarget = { runId: number; generation: number };

/** Hold the runner row while sending a bounded provider request. Lifecycle
 * generation replacement/deletion must wait rather than retarget a command. */
export async function withOwnedSprite<T>(ctx: AppApiContext, target: SpriteRunTarget,
  action: (runner: typeof runnerInstances.$inferSelect) => Promise<T>): Promise<T> {
  const owner = await spriteCaller(ctx);
  return db.transaction(async (tx) => {
    // Match lifecycle's runner -> run ordering (quiesce takes both locks).
    const [runner] = await tx.select().from(runnerInstances).where(eq(runnerInstances.runId, target.runId)).for("share");
    const [run] = await tx.select().from(agentSessions).where(and(
      eq(agentSessions.id, target.runId), eq(agentSessions.userId, owner.userId),
    )).for("share");
    if (!run) throw new Error("Sprite run not found or not owned by the caller");
    if (!runner || runner.provider !== "sprites" || !runner.spriteName
      || !["running", "suspended"].includes(runner.state) || runner.generationState !== "active"
      || runner.workerGeneration !== target.generation) {
      throw new Error("Sprite generation is unavailable or changed; refresh app.sprites.list before retrying");
    }
    return action(runner);
  });
}
