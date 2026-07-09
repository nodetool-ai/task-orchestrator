// __tests__/run-state.test.ts
//
// R4 — lib/run-state.ts, the single owner of run status semantics. Covers the
// three new surfaces this module introduces:
//   1. the legal-transition table + assertTransition (legal edges pass silently,
//      an illegal edge WARNS + telemetry-hooks but still returns/allows);
//   2. recordTurnEffect / turnEffectColumns — the one park/result/question
//      column writer, whose output must match the old inline db.update writes;
//   3. the round-trip: a turn effect's columns, read back through
//      decideTurnEndStatus, land the same status the old flow did;
//   4. coerceRunStatus's defensive mapping of legacy/unknown statuses;
//   5. the applyStatusTx wiring — an illegal transition warns but the write
//      still lands (this phase makes the machine visible, not stricter).

import { describe, expect, it, vi } from "vitest";
import { and, eq, notInArray } from "drizzle-orm";

import { db } from "../db";
import { agentSessions, agentEvents } from "../db/schema";
import { create, get, applyStatusTx } from "../lib/runs";
import {
  isLegalTransition,
  assertTransition,
  STATUS_TRANSITIONS,
  turnEffectColumns,
  recordTurnEffect,
  decideTurnEndStatus,
  coerceRunStatus,
  isTerminalStatus,
  LEASE_STATUSES,
  SESSION_STATUSES,
  type TurnEffect,
  type PendingQuestion,
  type ResultReport,
} from "../lib/run-state";

const TERMINAL = ["completed", "failed", "cancelled", "closed", "budget_exhausted"];
const NOT_TERMINAL = notInArray(agentSessions.status, TERMINAL);

// ─── vocabulary ──────────────────────────────────────────────────────────────

describe("status vocabulary", () => {
  it("dropped the vestigial pushing / opening_pr statuses", () => {
    expect(SESSION_STATUSES).not.toContain("pushing");
    expect(SESSION_STATUSES).not.toContain("opening_pr");
  });

  it("LEASE_STATUSES is exactly the two in-flight states", () => {
    expect([...LEASE_STATUSES].sort()).toEqual(["preparing", "running"]);
  });

  it("isTerminalStatus matches the terminal set; idle/parked are not terminal", () => {
    for (const s of TERMINAL) expect(isTerminalStatus(s as never)).toBe(true);
    expect(isTerminalStatus("idle")).toBe(false);
    expect(isTerminalStatus("parked")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
  });
});

// ─── legal-transition table ──────────────────────────────────────────────────

describe("isLegalTransition", () => {
  it("accepts the core dispatch → run → land path", () => {
    expect(isLegalTransition("pending", "preparing")).toBe(true);
    expect(isLegalTransition("preparing", "running")).toBe(true);
    expect(isLegalTransition("running", "completed")).toBe(true);
    expect(isLegalTransition("running", "failed")).toBe(true);
    expect(isLegalTransition("running", "parked")).toBe(true);
    expect(isLegalTransition("running", "idle")).toBe(true);
    expect(isLegalTransition("parked", "running")).toBe(true);
    expect(isLegalTransition("idle", "running")).toBe(true);
  });

  it("encodes the surprising-but-real resumable-terminal edges", () => {
    // A worktree run re-driven on a follow-up turn: completed/failed/
    // budget_exhausted → preparing (dispatch claim) or running (append).
    for (const from of ["completed", "failed", "budget_exhausted"] as const) {
      expect(isLegalTransition(from, "preparing")).toBe(true);
      expect(isLegalTransition(from, "running")).toBe(true);
    }
    // The requiresPrUrl self-loop and the pump's pending re-defer.
    expect(isLegalTransition("running", "running")).toBe(true);
    expect(isLegalTransition("pending", "pending")).toBe(true);
  });

  it("treats any self-transition as legal", () => {
    for (const s of SESSION_STATUSES) expect(isLegalTransition(s, s)).toBe(true);
  });

  it("rejects hard-stop terminals and nonsensical edges", () => {
    expect(STATUS_TRANSITIONS.cancelled).toEqual([]);
    expect(STATUS_TRANSITIONS.closed).toEqual([]);
    expect(isLegalTransition("cancelled", "running")).toBe(false);
    expect(isLegalTransition("closed", "running")).toBe(false);
    expect(isLegalTransition("parked", "completed")).toBe(false);
    expect(isLegalTransition("completed", "cancelled")).toBe(false);
  });
});

describe("assertTransition", () => {
  it("is silent and returns true for a legal edge", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onIllegal = vi.fn();
    try {
      expect(assertTransition("running", "completed", onIllegal)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      expect(onIllegal).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns + calls the telemetry hook but still returns false (allow) for an illegal edge", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onIllegal = vi.fn();
    try {
      expect(assertTransition("parked", "completed", onIllegal)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("parked -> completed");
      expect(onIllegal).toHaveBeenCalledWith("parked", "completed");
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── coerceRunStatus ─────────────────────────────────────────────────────────

describe("coerceRunStatus", () => {
  it("passes a current status through", () => {
    expect(coerceRunStatus("running")).toBe("running");
    expect(coerceRunStatus("parked")).toBe("parked");
  });

  it("maps the retired pushing / opening_pr statuses forward to running", () => {
    expect(coerceRunStatus("pushing")).toBe("running");
    expect(coerceRunStatus("opening_pr")).toBe("running");
  });

  it("leaves an unknown status untouched (trusted, not dropped)", () => {
    expect(coerceRunStatus("some_future_status")).toBe("some_future_status");
  });
});

// ─── turnEffectColumns / recordTurnEffect ────────────────────────────────────

const REPORT: ResultReport = {
  kind: "result",
  status: "success",
  summary: "done",
  data: null,
  pr_url: null,
  needs: null,
  reported_at: "2026-01-01T00:00:00.000Z",
};

const QUESTION: PendingQuestion = {
  question_id: "q-1",
  question: "which way?",
  context: null,
  asked_at: "2026-01-01T00:00:00.000Z",
  deadline: "2026-01-01T01:00:00.000Z",
  state: "open",
};

describe("turnEffectColumns", () => {
  it("park → { parkReason } (matches timer__sleep / await_session's old write)", () => {
    expect(turnEffectColumns({ kind: "park", reason: "sleeping" })).toEqual({
      parkReason: "sleeping",
    });
    expect(turnEffectColumns({ kind: "park", reason: "waiting" })).toEqual({
      parkReason: "waiting",
    });
  });

  it("result → { result } (matches report_result / raise's old write)", () => {
    expect(turnEffectColumns({ kind: "result", payload: REPORT, resultKind: "result" })).toEqual({
      result: REPORT,
    });
  });

  it("question → { pendingQuestion, parkReason: 'question' } (ask_parent set BOTH)", () => {
    expect(turnEffectColumns({ kind: "question", question: QUESTION })).toEqual({
      pendingQuestion: QUESTION,
      parkReason: "question",
    });
  });
});

describe("recordTurnEffect", () => {
  it("hands the mapped columns to the injected writer exactly once", async () => {
    const writes: unknown[] = [];
    const write = vi.fn(async (cols: unknown) => {
      writes.push(cols);
    });
    const effect: TurnEffect = { kind: "park", reason: "sleeping" };
    await recordTurnEffect(write, effect);
    expect(write).toHaveBeenCalledTimes(1);
    expect(writes[0]).toEqual({ parkReason: "sleeping" });
  });
});

// ─── round-trip: effect columns → decideTurnEndStatus ────────────────────────

describe("turn effect columns land the right status via decideTurnEndStatus", () => {
  const base = { goal: "<implement>", freshStatus: "running" as const, budgetHit: false };

  it("a park effect lands 'parked'", () => {
    const cols = turnEffectColumns({ kind: "park", reason: "sleeping" });
    const status = decideTurnEndStatus({
      ...base,
      parkReason: cols.parkReason ?? null,
      result: null,
      defaultStatus: "idle",
    });
    expect(status).toBe("parked");
  });

  it("a success result effect lands 'completed' (no PR required)", () => {
    const cols = turnEffectColumns({ kind: "result", payload: REPORT, resultKind: "result" });
    const status = decideTurnEndStatus({
      ...base,
      parkReason: null,
      result: cols.result ?? null,
      defaultStatus: "completed",
    });
    expect(status).toBe("completed");
  });

  it("a raise (exception) result effect lands 'failed'", () => {
    const cols = turnEffectColumns({
      kind: "result",
      payload: {
        kind: "exception",
        code: "boom",
        message: "nope",
        recoverable: false,
        details: null,
        raised_at: "2026-01-01T00:00:00.000Z",
      },
      resultKind: "exception",
    });
    const status = decideTurnEndStatus({
      ...base,
      parkReason: null,
      result: cols.result ?? null,
      defaultStatus: "completed",
    });
    expect(status).toBe("failed");
  });

  it("a question effect lands 'parked'", () => {
    const cols = turnEffectColumns({ kind: "question", question: QUESTION });
    const status = decideTurnEndStatus({
      ...base,
      parkReason: cols.parkReason ?? null,
      result: null,
      defaultStatus: "idle",
    });
    expect(status).toBe("parked");
  });
});

// ─── applyStatusTx wiring (DB) ───────────────────────────────────────────────

async function statusEvents(id: number, status: string): Promise<unknown[]> {
  const rows = await db
    .select({ payload: agentEvents.payload })
    .from(agentEvents)
    .where(and(eq(agentEvents.sessionId, id), eq(agentEvents.type, "status")));
  return rows.filter((r) => {
    try {
      return (JSON.parse(r.payload) as { status?: string }).status === status;
    } catch {
      return false;
    }
  });
}

describe("applyStatusTx consults the transition table", () => {
  it("a legal transition (running → completed) lands with no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = await create({ goal: "<implement>", defer: true });
      await db.update(agentSessions).set({ status: "running" }).where(eq(agentSessions.id, run.id));

      const ok = await applyStatusTx(run.id, "completed", {
        set: { completedAt: new Date() },
        guard: NOT_TERMINAL,
      });

      expect(ok).toBe(true);
      expect((await get(run.id))?.status).toBe("completed");
      // No illegal-transition warning for this legal edge.
      const illegal = warn.mock.calls.filter((c) => String(c[0]).includes("illegal status transition"));
      expect(illegal).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("an illegal transition (parked → completed) WARNS but the write still lands", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = await create({ goal: "<implement>", defer: true });
      // parked is non-terminal, so NOT_TERMINAL lets the write through — the
      // point is the machine visibly warns rather than rejecting.
      await db.update(agentSessions).set({ status: "parked" }).where(eq(agentSessions.id, run.id));

      const ok = await applyStatusTx(run.id, "completed", {
        set: { completedAt: new Date() },
        guard: NOT_TERMINAL,
      });

      expect(ok).toBe(true); // allowed, not rejected
      expect((await get(run.id))?.status).toBe("completed");
      expect(await statusEvents(run.id, "completed")).toHaveLength(1);
      const illegal = warn.mock.calls.filter((c) =>
        String(c[0]).includes("illegal status transition parked -> completed")
      );
      expect(illegal).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
