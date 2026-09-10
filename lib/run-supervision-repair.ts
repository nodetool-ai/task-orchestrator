import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentEvents, agentSessions, runEventSubscriptions } from "@/db/schema";
import { lockSourceTx, registerDefaultChildSubscriptionTx } from "./run-source-events";

/** Operator repair for a misplaced leaf replacement. Publication and
 * registration share a lock; current-state replay delivers an already-settled
 * result to the correct parent without rewriting any historical delivery. */
export async function repairReplacementSupervision(input: {
  priorId: number;
  replacementId: number;
  expectedParentId: number;
  apply?: boolean;
}) {
  return db.transaction(async (tx) => {
    await lockSourceTx(tx, input.replacementId);
    const rows = await tx.select().from(agentSessions)
      .where(inArray(agentSessions.id, [input.priorId, input.replacementId])).for("update");
    const prior = rows.find(r => r.id === input.priorId);
    const replacement = rows.find(r => r.id === input.replacementId);
    if (!prior || !replacement || prior.id === replacement.id) throw new Error("Two distinct existing runs are required");
    if (prior.status !== "failed" || !prior.taskId || prior.taskId !== replacement.taskId ||
        prior.goal !== "<implement>" || replacement.goal !== "<implement>") {
      throw new Error("Replacement must implement the same task as a failed prior run");
    }
    if (replacement.parentRunId !== input.expectedParentId) throw new Error("Replacement parent changed; inspect it again");
    if (prior.parentRunId == null || prior.parentRunId === replacement.id) throw new Error("Prior run has no valid supervisor");
    const [parent] = await tx.select().from(agentSessions).where(eq(agentSessions.id, prior.parentRunId));
    if (parent?.deliveryVersion !== 2 || replacement.deliveryVersion !== 2) throw new Error("Repair requires durable event delivery");
    const children = await tx.select({ id: agentSessions.id }).from(agentSessions)
      .where(eq(agentSessions.parentRunId, replacement.id)).limit(1);
    const outgoing = await tx.select({ id: runEventSubscriptions.id }).from(runEventSubscriptions)
      .where(and(eq(runEventSubscriptions.subscriberRunId, replacement.id), eq(runEventSubscriptions.status, "active"))).limit(1);
    if (children.length || outgoing.length) {
      throw new Error("Replacement already has children or observations; requires a subtree repair");
    }
    const subscriptions = await tx.select().from(runEventSubscriptions)
      .where(and(eq(runEventSubscriptions.sourceRunId, replacement.id), eq(runEventSubscriptions.status, "active")));
    if (subscriptions.some(s => s.subscriberRunId !== input.expectedParentId)) throw new Error("Unexpected observers; inspect them before repair");
    const result = {
      priorId: prior.id, replacementId: replacement.id,
      previousParentId: replacement.parentRunId, parentRunId: parent.id,
      cancelledSubscriptionIds: subscriptions.map(s => s.id), applied: !!input.apply,
    };
    if (!input.apply) return result;
    await tx.update(agentSessions).set({ parentRunId: parent.id, resumeOf: prior.id })
      .where(eq(agentSessions.id, replacement.id));
    if (subscriptions.length) await tx.update(runEventSubscriptions)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(inArray(runEventSubscriptions.id, subscriptions.map(s => s.id)));
    const subscription = await registerDefaultChildSubscriptionTx(tx, { ...replacement, parentRunId: parent.id });
    await tx.insert(agentEvents).values({
      sessionId: replacement.id, type: "supervision_repaired", payload: JSON.stringify(result),
    });
    return { ...result, subscriptionId: subscription?.id };
  });
}
