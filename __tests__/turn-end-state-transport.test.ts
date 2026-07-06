// __tests__/turn-end-state-transport.test.ts
//
// Regression for the run-76 incident: readTurnEndState() ran at the end of
// EVERY worker turn (runExecute, and the shared implement/review/chat path) and
// read agent_runs directly via `db`. HTTP-mode workers hold no DB access, so
// that direct read tripped db/index.ts's guard and failed the turn at the
// finish line with "Direct database access attempted inside a run worker".
//
// The read must go through the RunTransport (getRun) like every other worker
// interaction with orchestrator state. This test pins that routing: it spies
// the transport's getRun and asserts readTurnEndState both returns the fresh
// tool-mutated columns AND obtained them through the transport (not `db`).

import { describe, expect, it, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, readTurnEndState } from "../lib/runs";
import { dbTransport } from "../lib/worker/db-transport";

afterEach(() => vi.restoreAllMocks());

describe("readTurnEndState", () => {
  it("reads the fresh tool-mutated columns THROUGH the transport, not db", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    // Simulate what a mid-turn tool (report_result + timer__sleep) wrote
    // server-side while the worker's turn was in flight.
    await db
      .update(agentSessions)
      .set({ status: "parked", parkReason: "sleeping", result: { ok: true, n: 7 } })
      .where(eq(agentSessions.id, run.id));

    const getRun = vi.spyOn(dbTransport, "getRun");

    const state = await readTurnEndState(run.id);

    // Routed through the transport — the whole point (before the fix this used
    // db.select() directly and getRun was never called).
    expect(getRun).toHaveBeenCalledWith(run.id);
    // ...and it saw the fresh mid-turn writes.
    expect(state.status).toBe("parked");
    expect(state.parkReason).toBe("sleeping");
    expect(state.result).toEqual({ ok: true, n: 7 });
  });

  it("defaults to running with null park/result for a missing run", async () => {
    const state = await readTurnEndState(999_999_999);
    expect(state).toEqual({ status: "running", parkReason: null, result: null });
  });
});
