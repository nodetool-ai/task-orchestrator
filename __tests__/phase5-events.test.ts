// __tests__/phase5-events.test.ts
//
// Phase 5 (R5) event-system reconciliation (docs/agent-events.md):
//   5.1 claim + digest frame commit in ONE transaction (§6.4) — a failure after
//       the tx-claim rolls the claim back, so no event is 'injected' without a frame.
//   5.2 single transcript representation (§5.2) — the eager per-event mirror is
//       excluded from model context; the digest frame is the model-facing record.
//   5.5 the pending-run pump runs wherever a DB is configured (dev-safe).
//   5.6 timer hygiene — cancel() cancels pending timers, and a child's terminal
//       event defuses the parent's await_session backstop timer.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";

import { db } from "../db";
import { agentMessages, agentSessions, inboxEvents, runTimers } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import {
  cancelTimersByCorrelation,
  claimInboxEventsTx,
  createTimer,
  emitInboxEvent,
} from "../lib/inbox";
import {
  cancel,
  emitTerminalChildEvent,
  injectPendingInboxEvents,
  loadPostgresContextMessages,
} from "../lib/runs";
import { startPendingRunPump, stopPendingRunPump } from "../lib/run-dispatch";

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

beforeEach(async () => {
  await seedPersonas();
  await db.delete(runTimers);
  await db.delete(inboxEvents);
  await db.delete(agentMessages);
  await db.delete(agentSessions);
});

// ─── 5.1 transactional claim + frame ─────────────────────────────────────────

describe("5.1 claim + digest frame commit atomically", () => {
  it("a failure after the tx-claim rolls the claim back — events stay pending", async () => {
    const parent = await insertRun({});
    await emitInboxEvent({
      targetRunId: parent,
      type: "timer.fired",
      sourceKind: "timer",
      sourceId: "1",
      noWake: true,
    });

    // Simulate injectPendingInboxEvents's frame-insert failing INSIDE the same
    // transaction as the claim: claim under the caller tx, then throw. Because
    // claimInboxEventsTx runs on the caller's tx, the rollback returns the
    // claimed rows to 'pending' — "claimed but never written anywhere" cannot exist.
    await expect(
      db.transaction(async (tx) => {
        const claimed = await claimInboxEventsTx(tx, parent, { audiences: ["owner"] });
        expect(claimed).toHaveLength(1);
        expect(claimed[0].status).toBe("injected");
        throw new Error("frame insert failed");
      })
    ).rejects.toThrow("frame insert failed");

    const rows = await db.select().from(inboxEvents).where(eq(inboxEvents.targetRunId, parent));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].runTurnId).toBeNull();
  });

  it("the happy path commits the claim and the frame together", async () => {
    const parent = await insertRun({});
    await emitInboxEvent({
      targetRunId: parent,
      type: "timer.fired",
      sourceKind: "timer",
      sourceId: "1",
      noWake: true,
    });

    const digest = await injectPendingInboxEvents(parent);
    expect(digest).toBeTruthy();

    // Exactly one event_digest frame exists AND the event is injected+stamped to it.
    const frames = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.runId, parent))
      .orderBy(asc(agentMessages.id));
    const digestFrame = frames.find(
      (f) => (JSON.parse(f.content)[0] as { type?: string })?.type === "event_digest"
    )!;
    expect(digestFrame).toBeTruthy();
    const rows = await db.select().from(inboxEvents).where(eq(inboxEvents.targetRunId, parent));
    expect(rows[0].status).toBe("injected");
    expect(rows[0].runTurnId).toBe(digestFrame.id);
  });
});

// ─── 5.2 single transcript representation ────────────────────────────────────

describe("5.2 mirror excluded from model context, preserved for the UI", () => {
  it("loadPostgresContextMessages skips inbox_event mirror and event_digest frames", async () => {
    const parent = await insertRun({});
    const child = await insertRun({ parentRunId: parent, status: "completed" });

    // A real agent message the model must keep seeing.
    await db.insert(agentMessages).values({
      runId: parent,
      role: "agent",
      content: JSON.stringify([{ type: "text", text: "hello from the model" }]),
      createdAt: new Date(),
    });

    // Emit → writes the eager inbox_event mirror row; inject → writes the digest frame.
    await emitInboxEvent({
      targetRunId: parent,
      type: "child.result",
      sourceKind: "run",
      sourceId: String(child),
      attempt: 1,
      dedupeKey: `terminal:${child}:1`,
      payload: { run_id: child, attempt: 1, summary: "done" },
      noWake: true,
    });
    await injectPendingInboxEvents(parent);

    // Raw storage still has BOTH the mirror and the digest frame (the UI renders them).
    const raw = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.runId, parent))
      .orderBy(asc(agentMessages.id));
    const rawTypes = raw.map((r) => (JSON.parse(r.content)[0] as { type?: string })?.type);
    expect(rawTypes).toContain("inbox_event");
    expect(rawTypes).toContain("event_digest");

    // Model context excludes both event frames, keeps the agent message.
    const ctx = await loadPostgresContextMessages(parent);
    const ctxTypes = ctx.map((m) => (m.content[0] as { type?: string })?.type);
    expect(ctxTypes).not.toContain("inbox_event");
    expect(ctxTypes).not.toContain("event_digest");
    expect(ctx.some((m) => m.role === "agent")).toBe(true);
  });
});

// ─── 5.5 dev pump ────────────────────────────────────────────────────────────

describe("5.5 pending-run pump starts wherever a DB is configured", () => {
  const KEY = "__taskOrchPendingPump";
  const savedImage = process.env.TASK_ORCH_WORKER_IMAGE;
  const savedPumpMs = process.env.TASK_ORCH_PENDING_PUMP_MS;

  afterEach(() => {
    stopPendingRunPump();
    if (savedImage === undefined) delete process.env.TASK_ORCH_WORKER_IMAGE;
    else process.env.TASK_ORCH_WORKER_IMAGE = savedImage;
    if (savedPumpMs === undefined) delete process.env.TASK_ORCH_PENDING_PUMP_MS;
    else process.env.TASK_ORCH_PENDING_PUMP_MS = savedPumpMs;
  });

  it("starts in dev (no worker image, not fly) when DATABASE_URL is set", () => {
    delete process.env.TASK_ORCH_WORKER_IMAGE; // dev: no container path
    process.env.TASK_ORCH_PENDING_PUMP_MS = "3600000"; // long interval; unref'd, won't fire
    expect(process.env.DATABASE_URL).toBeTruthy();

    stopPendingRunPump();
    startPendingRunPump();
    expect((globalThis as Record<string, unknown>)[KEY]).toBeTruthy();
  });

  it("stays off when TASK_ORCH_PENDING_PUMP_MS=0", () => {
    delete process.env.TASK_ORCH_WORKER_IMAGE;
    process.env.TASK_ORCH_PENDING_PUMP_MS = "0";

    stopPendingRunPump();
    startPendingRunPump();
    expect((globalThis as Record<string, unknown>)[KEY]).toBeFalsy();
  });
});

// ─── 5.6 timer hygiene ───────────────────────────────────────────────────────

describe("5.6 timer hygiene", () => {
  it("cancel() cancels the run's pending timers (via applyStatusTx's in-tx sweep)", async () => {
    const run = await insertRun({ status: "parked", parkReason: "sleeping" });
    const timer = await createTimer({ runId: run, minutes: 30, note: "watchdog" });
    expect(timer.ok).toBe(true);

    await cancel(run);

    const rows = await db.select().from(runTimers).where(eq(runTimers.runId, run));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("cancelled");
    const runRow = (await db.select().from(agentSessions).where(eq(agentSessions.id, run)))[0];
    expect(runRow.status).toBe("cancelled");
  });

  it("a child's terminal event defuses the parent's await_session backstop timer", async () => {
    // Parent 'idle' (not 'parked') so the terminal event's emit-time wake never
    // tries to spawn a worker — the backstop cancellation is independent of the
    // parent's status, which is what this test exercises.
    const parent = await insertRun({ status: "idle" });
    const child = await insertRun({ parentRunId: parent, status: "completed" });

    // The parent armed a backstop when it parked on the child (await_session).
    const armed = await createTimer({
      runId: parent,
      minutes: 30,
      note: `await_session #${child} timeout`,
      correlationId: `await-session:${child}`,
    });
    // An unrelated watchdog timer must survive.
    const watchdog = await createTimer({ runId: parent, minutes: 45, note: "watchdog" });
    expect(armed.ok && watchdog.ok).toBe(true);

    // The child completing emits its terminal event, which cancels the backstop.
    await emitTerminalChildEvent(child);

    const timers = await db
      .select()
      .from(runTimers)
      .where(eq(runTimers.runId, parent))
      .orderBy(asc(runTimers.id));
    const backstop = timers.find((t) => t.correlationId === `await-session:${child}`)!;
    const other = timers.find((t) => t.note === "watchdog")!;
    expect(backstop.status).toBe("cancelled");
    expect(other.status).toBe("pending");
  });

  it("cancelTimersByCorrelation only touches pending timers with the matching correlation", async () => {
    const run = await insertRun({});
    const match = await createTimer({
      runId: run,
      minutes: 10,
      correlationId: "await-session:777",
    });
    const nonMatch = await createTimer({
      runId: run,
      minutes: 10,
      correlationId: "await-session:888",
    });
    expect(match.ok && nonMatch.ok).toBe(true);

    const cancelled = await cancelTimersByCorrelation(run, "await-session:777");
    expect(cancelled).toBe(1);

    const rows = await db.select().from(runTimers).where(eq(runTimers.runId, run));
    expect(rows.find((r) => r.correlationId === "await-session:777")?.status).toBe("cancelled");
    expect(rows.find((r) => r.correlationId === "await-session:888")?.status).toBe("pending");
  });
});
