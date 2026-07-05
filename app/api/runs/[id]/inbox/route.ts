import { type NextRequest } from "next/server";
import * as runs from "@/lib/runs";
import { listRunInboxEvents, listRunTimers, CONTROL_TYPES } from "@/lib/inbox";

export const dynamic = "force-dynamic";

// The run's agent-event trail (docs/agent-events.md §11): every inbox event
// addressed to this run across all lifecycle states — pending (queued, will
// wake it), injected (delivered to a turn's digest frame), superseded (stale
// attempt, never delivered), error (quarantined poison) — plus its timers.
// This is the traceability view: the digest frames in the transcript show what
// the agent SAW; this endpoint also shows what it hasn't seen yet and why
// something was withheld.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const runId = parseInt(id, 10);
  if (!Number.isFinite(runId)) {
    return Response.json({ error: "Bad id" }, { status: 400 });
  }
  try {
    const run = await runs.getRun(runId);
    if (!run) return Response.json({ error: "Not found" }, { status: 404 });

    const [events, timers] = await Promise.all([
      listRunInboxEvents(runId),
      listRunTimers(runId),
    ]);
    return Response.json({
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        control: CONTROL_TYPES.has(e.type),
        audience: e.audience,
        status: e.status,
        sourceKind: e.sourceKind,
        sourceId: e.sourceId,
        attempt: e.attempt,
        correlationId: e.correlationId,
        causationEventId: e.causationEventId,
        bubbledFrom: e.bubbledFrom,
        payload: e.payload ?? {},
        errorReason: e.errorReason,
        runTurnId: e.runTurnId,
        createdAt: e.createdAt.toISOString(),
        injectedAt: e.injectedAt?.toISOString() ?? null,
      })),
      timers: timers.map((t) => ({
        id: t.id,
        status: t.status,
        note: t.note,
        correlationId: t.correlationId,
        fireAt: t.fireAt.toISOString(),
        createdAt: t.createdAt.toISOString(),
        firedAt: t.firedAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
