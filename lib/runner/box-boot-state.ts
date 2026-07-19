// Server-side seed for the run view's box boot / worker-startup stepper.
//
// Like the template-build seed (box-template-state.ts), the boot lifecycle
// events fire in a burst at dispatch time. A run opened mid-boot would miss the
// earlier `forking`/`provisioning` frames over the live tail (seeded to forward
// only post-render rows), and the reducer ignores mid-sequence events with no
// prior state. Folding the persisted events here gives the stepper its initial
// state; subsequent events arrive over SSE and advance it.
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { agentEvents } from "../../db/schema";
import { BOX_BOOT_EVENT, reduceBoxBootEvent, type BoxBootState } from "./box-boot-events";

const BOOT_EVENT_TYPES = [
  BOX_BOOT_EVENT.forking,
  BOX_BOOT_EVENT.provisioning,
  BOX_BOOT_EVENT.ready,
  BOX_BOOT_EVENT.bootstrapLog,
  BOX_BOOT_EVENT.channelHosted,
  BOX_BOOT_EVENT.failed,
];

/**
 * The box boot state to seed the run view's stepper: fold this run's own
 * persisted boot lifecycle events. Returns null for non-box runs and runs with
 * no boot events yet. A run whose boot already completed folds to the terminal
 * `ready` phase, which the stepper treats as "nothing to show".
 */
export async function loadBoxBootState(runId: number): Promise<BoxBootState | null> {
  const rows = await db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.sessionId, runId), inArray(agentEvents.type, BOOT_EVENT_TYPES)))
    .orderBy(asc(agentEvents.id));

  let state: BoxBootState | null = null;
  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload ?? "{}");
      if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
    } catch {
      // A malformed payload row can't advance the boot state; skip it.
    }
    // Fold with the event's OWN persisted timestamp so elapsed timers are
    // anchored to when the step happened, in the same epoch-ms basis as the
    // client's Date.now().
    state = reduceBoxBootEvent(state, { type: row.type, ...payload }, row.createdAt.getTime());
  }
  return state;
}
