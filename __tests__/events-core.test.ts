// __tests__/events-core.test.ts
//
// Agent event system — core producer/consumer plumbing in lib/runs.ts
// (docs/agent-events.md §3.1, §4, §6):
//   1. buildTerminalChildEvent — the pure terminal-event payload builder every
//      terminal-status write site funnels through.
//   2. decideTurnEndStatus — the turn-end parking contract with the tools layer.
//   3. buildEventDigestBlock / renderEventDigest — digest frame shape/rendering.
//   4. One DB integration pass: emit → injectPendingInboxEvents claims in order,
//      persists ONE event_digest frame, and stamps the claimed rows.

import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";

import { db } from "../db";
import { agentMessages, agentSessions, inboxEvents } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import { emitInboxEvent, type EventEnvelope } from "../lib/inbox";
import {
  buildEventDigestBlock,
  buildTerminalChildEvent,
  decideTurnEndStatus,
  injectPendingInboxEvents,
  renderEventDigest,
} from "../lib/runs";

// ─── buildTerminalChildEvent ─────────────────────────────────────────────────

const baseRow = {
  id: 41,
  attempt: 2,
  result: null as unknown,
  error: null as string | null,
  prUrl: "https://github.com/o/r/pull/7",
  totalCostUsd: 1.25,
  cwdStrategy: "worktree",
};

describe("buildTerminalChildEvent", () => {
  it("completed with a structured result → child.result carrying it verbatim", () => {
    const spec = buildTerminalChildEvent(
      { ...baseRow, status: "completed", result: { status: "success", summary: "done" } },
      null
    )!;
    expect(spec.type).toBe("child.result");
    expect(spec.dedupeKey).toBe("terminal:41:2");
    expect(spec.payload).toMatchObject({
      run_id: 41,
      attempt: 2,
      result: { status: "success", summary: "done" },
      pr_url: baseRow.prUrl,
      total_cost_usd: 1.25,
    });
    expect(spec.payload.implicit).toBeUndefined();
  });

  it("completed without a result → implicit child.result with the last agent text", () => {
    const spec = buildTerminalChildEvent({ ...baseRow, status: "completed" }, "final words")!;
    expect(spec.type).toBe("child.result");
    expect(spec.payload).toMatchObject({ implicit: true, summary: "final words" });
  });

  it("failed with a raise payload → child.exception spreading it, honoring its recoverable", () => {
    const spec = buildTerminalChildEvent(
      {
        ...baseRow,
        status: "failed",
        result: { code: "merge_conflict", message: "rebase needed", recoverable: false },
      },
      null
    )!;
    expect(spec.type).toBe("child.exception");
    expect(spec.dedupeKey).toBe("terminal:41:2");
    expect(spec.payload).toMatchObject({
      code: "merge_conflict",
      message: "rebase needed",
      recoverable: false,
    });
  });

  it("failed without raise → code 'unhandled', message from the error column, recoverable from the worktree judgment", () => {
    const worktree = buildTerminalChildEvent(
      { ...baseRow, status: "failed", error: "boom" },
      null
    )!;
    expect(worktree.type).toBe("child.exception");
    expect(worktree.payload).toMatchObject({ code: "unhandled", message: "boom", recoverable: true });

    const chatStyle = buildTerminalChildEvent(
      { ...baseRow, status: "failed", error: "boom", cwdStrategy: "none" },
      null
    )!;
    expect(chatStyle.payload.recoverable).toBe(false);
  });

  it("cancelled → child.cancelled with the per-run (not per-attempt) dedupe key", () => {
    const spec = buildTerminalChildEvent({ ...baseRow, status: "cancelled" }, null)!;
    expect(spec.type).toBe("child.cancelled");
    expect(spec.dedupeKey).toBe("cancelled:41");
  });

  it("budget_exhausted → child.budget_exhausted with spend", () => {
    const spec = buildTerminalChildEvent({ ...baseRow, status: "budget_exhausted" }, null)!;
    expect(spec.type).toBe("child.budget_exhausted");
    expect(spec.payload).toMatchObject({ spent_usd: 1.25 });
    expect(spec.dedupeKey).toBe("terminal:41:2");
  });

  it("returns null for non-terminal and 'closed' statuses", () => {
    expect(buildTerminalChildEvent({ ...baseRow, status: "running" }, null)).toBeNull();
    expect(buildTerminalChildEvent({ ...baseRow, status: "idle" }, null)).toBeNull();
    expect(buildTerminalChildEvent({ ...baseRow, status: "parked" }, null)).toBeNull();
    expect(buildTerminalChildEvent({ ...baseRow, status: "closed" }, null)).toBeNull();
  });
});

// ─── decideTurnEndStatus ─────────────────────────────────────────────────────

describe("decideTurnEndStatus", () => {
  const base = {
    goal: "<execute>",
    freshStatus: "running" as const,
    parkReason: null as string | null,
    result: null as unknown,
    budgetHit: false,
    defaultStatus: "completed" as const,
  };

  it("respects a terminal status a result tool already wrote", () => {
    expect(
      decideTurnEndStatus({ ...base, result: { code: "x" }, freshStatus: "failed" })
    ).toBe("failed");
    expect(
      decideTurnEndStatus({ ...base, result: { status: "success" }, freshStatus: "completed" })
    ).toBe("completed");
  });

  it("infers failed for raise-shaped results, completed otherwise", () => {
    expect(decideTurnEndStatus({ ...base, result: { code: "no_creds" } })).toBe("failed");
    expect(decideTurnEndStatus({ ...base, result: { status: "failed" } })).toBe("failed");
    expect(decideTurnEndStatus({ ...base, result: { status: "success" } })).toBe("completed");
  });

  it("a result beats a park_reason written the same turn", () => {
    expect(
      decideTurnEndStatus({ ...base, result: { status: "success" }, parkReason: "sleeping" })
    ).toBe("completed");
  });

  it("parks a goal-driven run that asked to, when it would land completed/idle", () => {
    expect(decideTurnEndStatus({ ...base, parkReason: "sleeping" })).toBe("parked");
    expect(
      decideTurnEndStatus({ ...base, parkReason: "question", defaultStatus: "idle" })
    ).toBe("parked");
  });

  it("chat runs keep their idle behavior even with a park_reason", () => {
    expect(
      decideTurnEndStatus({ ...base, goal: "<chat>", parkReason: "sleeping", defaultStatus: "idle" })
    ).toBe("idle");
  });

  it("budget exhaustion beats parking", () => {
    expect(decideTurnEndStatus({ ...base, parkReason: "sleeping", budgetHit: true })).toBe(
      "budget_exhausted"
    );
  });

  it("a cancel/close that raced the turn end wins", () => {
    expect(decideTurnEndStatus({ ...base, freshStatus: "cancelled" })).toBe("cancelled");
    expect(decideTurnEndStatus({ ...base, freshStatus: "closed", parkReason: "sleeping" })).toBe(
      "closed"
    );
  });

  it("falls through to the legacy default", () => {
    expect(decideTurnEndStatus({ ...base })).toBe("completed");
    expect(decideTurnEndStatus({ ...base, defaultStatus: "idle" })).toBe("idle");
  });
});

// ─── digest frame shape + rendering ──────────────────────────────────────────

function env(overrides: Partial<EventEnvelope>): EventEnvelope {
  return {
    event_id: 1,
    type: "child.result",
    occurred_at: "2026-07-05T12:00:00.000Z",
    audience: "owner",
    source: { kind: "run", id: "9" },
    attempt: 1,
    correlation_id: null,
    causation_event_id: null,
    bubbled_from: null,
    payload: {},
    ...overrides,
  };
}

describe("buildEventDigestBlock / renderEventDigest", () => {
  it("orders owner events first (id order), then the supervisor section", () => {
    const block = buildEventDigestBlock([
      env({ event_id: 3, audience: "supervisor", type: "gh.pr.merged" }),
      env({ event_id: 5, audience: "owner" }),
      env({ event_id: 2, audience: "owner", type: "timer.fired" }),
    ]);
    expect(block.type).toBe("event_digest");
    expect(block.events.map((e) => e.event_id)).toEqual([2, 5, 3]);
  });

  it("renders both sections with the supervisor one explicitly marked", () => {
    const block = buildEventDigestBlock([
      env({ event_id: 1, audience: "owner", payload: { run_id: 9 } }),
      env({ event_id: 2, audience: "supervisor", type: "gh.ci.completed" }),
    ]);
    const text = renderEventDigest(block);
    expect(text).toContain("Inbox event digest");
    expect(text).toContain("act on these");
    expect(text).toContain("[#1] child.result");
    expect(text).toContain("For your awareness");
    expect(text).toContain("[#2] gh.ci.completed");
    expect(text).toContain('"run_id":9');
    // owner section renders before the supervisor section
    expect(text.indexOf("[#1]")).toBeLessThan(text.indexOf("For your awareness"));
  });

  it("omits an empty supervisor section", () => {
    const text = renderEventDigest(buildEventDigestBlock([env({ event_id: 1 })]));
    expect(text).not.toContain("For your awareness");
  });
});

// ─── integration: emit → claim → single digest frame ─────────────────────────

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

describe("injectPendingInboxEvents (integration)", () => {
  beforeEach(async () => {
    await seedPersonas();
    await db.delete(inboxEvents);
    await db.delete(agentMessages);
    await db.delete(agentSessions);
  });

  it("claims pending events, persists ONE event_digest frame, stamps rows, and is idempotent", async () => {
    // Parent 'idle' (not 'parked') so emit-time wake never tries to spawn a worker.
    const parent = await insertRun({});
    const child = await insertRun({ parentRunId: parent, status: "completed" });

    // A gh event addressed to the CHILD fans a supervisor copy out to the parent…
    await emitInboxEvent({
      targetRunId: child,
      type: "gh.pr.merged",
      sourceKind: "github",
      sourceId: "d1",
      payload: { pr_url: "https://github.com/o/r/pull/7" },
      noWake: true,
    });
    // …and a terminal child.result is addressed to the parent as owner.
    await emitInboxEvent({
      targetRunId: parent,
      type: "child.result",
      sourceKind: "run",
      sourceId: String(child),
      attempt: 1,
      dedupeKey: `terminal:${child}:1`,
      payload: { run_id: child, attempt: 1, implicit: true, summary: "done" },
      noWake: true,
    });

    const digest = await injectPendingInboxEvents(parent);
    expect(digest).toBeTruthy();
    // Owner event first even though the supervisor copy has the lower id.
    expect(digest!.indexOf("child.result")).toBeLessThan(digest!.indexOf("gh.pr.merged"));

    // Exactly one system frame carrying a single event_digest block.
    const frames = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.runId, parent))
      .orderBy(asc(agentMessages.id));
    expect(frames).toHaveLength(1);
    expect(frames[0].role).toBe("system");
    const blocks = JSON.parse(frames[0].content) as Array<{ type: string; events: unknown[] }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("event_digest");
    expect(blocks[0].events).toHaveLength(2);

    // Claimed rows are 'injected' and stamped with the frame id.
    const rows = await db
      .select()
      .from(inboxEvents)
      .where(eq(inboxEvents.targetRunId, parent))
      .orderBy(asc(inboxEvents.id));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("injected");
      expect(row.runTurnId).toBe(frames[0].id);
    }

    // Nothing left pending: a second injection is a no-op.
    expect(await injectPendingInboxEvents(parent)).toBeNull();
  });

  it("child events (owner to the child) are untouched by the parent's claim", async () => {
    const parent = await insertRun({});
    const child = await insertRun({ parentRunId: parent, status: "completed" });
    await emitInboxEvent({
      targetRunId: child,
      type: "gh.ci.completed",
      sourceKind: "github",
      sourceId: "d2",
      payload: { conclusion: "failure" },
      noWake: true,
    });

    await injectPendingInboxEvents(parent);

    const childRows = await db
      .select()
      .from(inboxEvents)
      .where(eq(inboxEvents.targetRunId, child));
    expect(childRows).toHaveLength(1);
    expect(childRows[0].status).toBe("pending");
  });
});
