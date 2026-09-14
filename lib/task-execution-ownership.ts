import { and, eq, notInArray } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, tasks } from "../db/schema";

type TaskReader = Pick<typeof db, "select">;

/** Ownership survives run failure/parking: its worker may hold unpublished code.
 * Call under the task advisory lock when admitting a competing writer. */
export async function executorOwnerForTask(tx: TaskReader, taskId: string): Promise<number | null> {
  const [task] = await tx.select({ owner: tasks.executorRunId }).from(tasks).where(and(
    eq(tasks.id, taskId), notInArray(tasks.state, ["merged", "cancelled"])
  ));
  return task?.owner ?? null;
}

/** Shared by task runs and executor claims, under the same task lock. */
export async function reserveTaskBranch(
  tx: Pick<typeof db, "select" | "update">,
  taskId: string
): Promise<string | null> {
  const [row] = await tx.select({ branch: tasks.branch, attachedRunId: tasks.attachedRunId })
    .from(tasks).where(eq(tasks.id, taskId));
  if (!row) return null;
  if (row.branch) return row.branch;
  const attached = row.attachedRunId == null ? null : (await tx
    .select({ branch: agentSessions.branch }).from(agentSessions)
    .where(eq(agentSessions.id, row.attachedRunId)))[0];
  const branch = attached?.branch ?? `claude/${taskId.toLowerCase()}`;
  await tx.update(tasks).set({ branch }).where(eq(tasks.id, taskId));
  return branch;
}
