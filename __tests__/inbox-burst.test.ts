// __tests__/inbox-burst.test.ts
//
// Burst-class GitHub events (docs/agent-events.md §6.2a): a single push fans
// out into many check_run/check_suite/workflow_run deliveries, so
// gh.ci.completed / gh.pr.pushed get two defenses that keep a webhook storm
// from costing one LLM turn per delivery and from piling up 25-event digests:
//   1. emit-time coalescing — a newer pending event supersedes older pending
//      ones with the same identity (same target/audience/type + check name);
//   2. debounced wake — burst types never dispatch at emit time; the pump
//      sweep (parkedRunsWithPendingEvents) wakes once the burst goes quiet
//      (TASK_ORCH_EVENT_WAKE_QUIET_MS) or after the hard ceiling
//      (TASK_ORCH_EVENT_WAKE_MAX_DELAY_MS).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";

import { db } from "../db";
import { agentSessions, inboxEvents, runTimers } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import { emitInboxEvent, parkedRunsWithPendingEvents } from "../lib/inbox";
import * as runDispatch from "../lib/run-dispatch";

async function insertRun(
  values: Partial<typeof agentSessions.$inferInsert> = {}
): Promise<number> {
  const rows = await db
    .insert(agentSessions)
    .values({
      goal: "<execute>",
      toolsProfile: "orchestrator",
      cwdStrategy: "none",
      personaId: "implementor",
      status: "idle",
      startedAt: new Date(),
      ...values,
    })
    .returning({ id: agentSessions.id });
  return rows[0].id;
}

async function eventsFor(runId: number) {
  return db
    .select()
    .from(inboxEvents)
    .where(eq(inboxEvents.targetRunId, runId))
    .orderBy(asc(inboxEvents.id));
}

function emitCi(runId: number, sourceId: string, check: string | null, conclusion = "failure") {
  return emitInboxEvent({
    targetRunId: runId,
    type: "gh.ci.completed",
    sourceKind: "github",
    sourceId,
    dedupeKey: `gh:${sourceId}:${runId}`,
    payload: { pr_url: "https://github.com/o/r/pull/7", conclusion, check },
  });
}

beforeEach(async () => {
  await seedPersonas();
  await db.delete(runTimers);
  await db.delete(inboxEvents);
  await db.delete(agentSessions);
  delete process.env.TASK_ORCH_EVENT_WAKE_QUIET_MS;
  delete process.env.TASK_ORCH_EVENT_WAKE_MAX_DELAY_MS;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TASK_ORCH_EVENT_WAKE_QUIET_MS;
  delete process.env.TASK_ORCH_EVENT_WAKE_MAX_DELAY_MS;
});

describe("burst coalescing at emit time", () => {
  it("a newer gh.ci.completed supersedes an older pending one for the same check", async () => {
    const run = await insertRun({ status: "parked" });
    await emitCi(run, "d1", "lint", "pending");
    await emitCi(run, "d2", "lint", "failure");

    const rows = await eventsFor(run);
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("superseded");
    expect(rows[1].status).toBe("pending");
    expect((rows[1].payload as { conclusion?: string }).conclusion).toBe("failure");
  });

  it("distinct checks coalesce independently (which check failed IS the information)", async () => {
    const run = await insertRun({ status: "parked" });
    await emitCi(run, "d1", "lint");
    await emitCi(run, "d2", "tests");

    const rows = await eventsFor(run);
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
  });

  it("a newer gh.pr.pushed supersedes any older pending push", async () => {
    const run = await insertRun({ status: "parked" });
    for (const [d, sha] of [
      ["d1", "aaa"],
      ["d2", "bbb"],
      ["d3", "ccc"],
    ]) {
      await emitInboxEvent({
        targetRunId: run,
        type: "gh.pr.pushed",
        sourceKind: "github",
        sourceId: d,
        dedupeKey: `gh:${d}:${run}`,
        payload: { pr_url: "https://github.com/o/r/pull/7", sha },
      });
    }
    const rows = await eventsFor(run);
    expect(rows.map((r) => r.status)).toEqual(["superseded", "superseded", "pending"]);
    expect((rows[2].payload as { sha?: string }).sha).toBe("ccc");
  });

  it("a deduped redelivery (same dedupe key) does not supersede the surviving row", async () => {
    const run = await insertRun({ status: "parked" });
    await emitCi(run, "d1", "lint");
    // GitHub redelivers the SAME delivery id → the insert dedupes to nothing;
    // the original row must stay pending (coalescing runs only after a real
    // insert, scoped to older rows).
    const res = await emitCi(run, "d1", "lint");
    expect(res.eventId).toBeNull();

    const rows = await eventsFor(run);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });

  it("non-burst types never coalesce", async () => {
    const run = await insertRun({ status: "parked" });
    vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);
    for (const d of ["d1", "d2"]) {
      await emitInboxEvent({
        targetRunId: run,
        type: "gh.pr.review_submitted",
        sourceKind: "github",
        sourceId: d,
        dedupeKey: `gh:${d}:${run}`,
        payload: { state: "commented" },
      });
    }
    const rows = await eventsFor(run);
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
  });

  it("the supervisor copy on the parent coalesces too", async () => {
    const parent = await insertRun({ status: "parked" });
    const child = await insertRun({ parentRunId: parent, status: "idle" });
    await emitCi(child, "d1", "lint", "pending");
    await emitCi(child, "d2", "lint", "failure");

    const copies = await eventsFor(parent);
    expect(copies).toHaveLength(2);
    expect(copies.map((r) => r.status)).toEqual(["superseded", "pending"]);
    expect(copies.every((r) => r.audience === "supervisor")).toBe(true);
  });
});

describe("debounced wake for burst types", () => {
  it("gh.ci.completed to a parked run does NOT dispatch at emit time", async () => {
    const run = await insertRun({ status: "parked" });
    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);

    await emitCi(run, "d1", "lint");

    expect(spy).not.toHaveBeenCalled();
    // The event is still durably pending — the pump sweep is its wake path.
    const rows = await eventsFor(run);
    expect(rows[0].status).toBe("pending");
  });

  it("gh.pr.pushed does not wake the parked parent through the supervisor copy either", async () => {
    const parent = await insertRun({ status: "parked" });
    const child = await insertRun({ parentRunId: parent, status: "parked" });
    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);

    await emitInboxEvent({
      targetRunId: child,
      type: "gh.pr.pushed",
      sourceKind: "github",
      sourceId: "d1",
      payload: { sha: "aaa" },
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it("non-burst gh events still wake immediately", async () => {
    const run = await insertRun({ status: "parked" });
    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);

    await emitInboxEvent({
      targetRunId: run,
      type: "gh.pr.merged",
      sourceKind: "github",
      sourceId: "d1",
      payload: {},
    });

    expect(spy).toHaveBeenCalledWith(run);
  });
});

describe("parkedRunsWithPendingEvents debounce windows", () => {
  it("holds a run whose only pending events are fresh burst events", async () => {
    const run = await insertRun({ status: "parked" });
    await emitCi(run, "d1", "lint");

    const ids = await parkedRunsWithPendingEvents();
    expect(ids).not.toContain(run);
  });

  it("wakes once the burst has gone quiet", async () => {
    const run = await insertRun({ status: "parked" });
    await emitCi(run, "d1", "lint");

    // Evaluate the sweep as if 2 minutes passed with no new deliveries
    // (default quiet window is 90s).
    const later = new Date(Date.now() + 2 * 60_000);
    expect(await parkedRunsWithPendingEvents(50, later)).toContain(run);
  });

  it("a continuous stream still wakes after the hard ceiling", async () => {
    const run = await insertRun({ status: "parked" });
    await emitCi(run, "d1", "lint");
    // Backdate the first delivery past the 5min ceiling, then land a fresh one
    // (different check so it doesn't coalesce it away) to keep the burst "hot".
    await db
      .update(inboxEvents)
      .set({ createdAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(inboxEvents.targetRunId, run));
    await emitCi(run, "d2", "tests");

    expect(await parkedRunsWithPendingEvents()).toContain(run);
  });

  it("any pending non-burst notify event wakes immediately, even mid-burst", async () => {
    const run = await insertRun({ status: "parked" });
    await emitCi(run, "d1", "lint");
    await emitInboxEvent({
      targetRunId: run,
      type: "timer.fired",
      sourceKind: "timer",
      sourceId: "1",
      noWake: true,
    });

    expect(await parkedRunsWithPendingEvents()).toContain(run);
  });

  it("TASK_ORCH_EVENT_WAKE_QUIET_MS=0 disables the debounce (legacy behavior)", async () => {
    process.env.TASK_ORCH_EVENT_WAKE_QUIET_MS = "0";
    const run = await insertRun({ status: "parked" });
    await emitCi(run, "d1", "lint");

    expect(await parkedRunsWithPendingEvents()).toContain(run);
  });

  it("still excludes parked runs with no pending events at all", async () => {
    const run = await insertRun({ status: "parked" });
    expect(await parkedRunsWithPendingEvents()).not.toContain(run);
  });
});
