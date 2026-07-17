// Server-side seed for the run view's template-build stepper.
//
// The build's lifecycle events fire in a burst at dispatch time and then go
// quiet during the long npm ci steps. The run view's live SSE tail is seeded to
// forward only rows written AFTER the page render, so a run opened mid-build
// would otherwise never receive the `building` event — and the reducer ignores
// `step` events with no prior `building` state, leaving the stepper hidden.
// Folding the persisted events here gives the run view its initial state so the
// stepper renders immediately; subsequent events arrive over SSE and advance it.
import { and, asc, eq, like } from "drizzle-orm";
import { db } from "../../db";
import { agentEvents } from "../../db/schema";
import { reduceTemplateBuildEvent, type TemplateBuildState } from "./box-template-events";

export async function loadTemplateBuildState(runId: number): Promise<TemplateBuildState | null> {
  const rows = await db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.sessionId, runId), like(agentEvents.type, "runner_box_template_%")))
    .orderBy(asc(agentEvents.id));

  let state: TemplateBuildState | null = null;
  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload ?? "{}");
      if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
    } catch {
      // A malformed payload row can't advance the build state; skip it.
    }
    // Fold with the event's OWN persisted timestamp so elapsed timers (startedAt
    // / stepStartedAt) are anchored to when the step actually happened, in the
    // same epoch-ms basis the client's Date.now() uses.
    state = reduceTemplateBuildEvent(state, { type: row.type, ...payload }, row.createdAt.getTime());
  }
  return state;
}
