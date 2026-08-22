// __tests__/runs-configure-api.test.ts
//
// Route-level tests for PATCH /api/runs/[id] { action: "configure" } — the
// endpoint behind the cockpit's `/model` and `/budget` (tui T-tui-12).
// Verifies: each field lands on the row, an omitted field is left alone, an
// explicit null clears a cap, junk is a 400 (never a silently dropped field),
// and an unknown run is a 404.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "../app/api/runs/[id]/route";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import * as runs from "../lib/runs";

// Stub auth() — route tests run without OAuth, same as the other route suites.
vi.mock("../auth", () => ({
  auth: () => Promise.resolve({ user: { email: "tester@example.com" } }),
}));

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/runs/1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function params(id: string | number) {
  return Promise.resolve({ id: String(id) });
}

async function insertRun(over: Partial<typeof agentSessions.$inferInsert> = {}): Promise<number> {
  const row = (
    await db
      .insert(agentSessions)
      .values({
        goal: "<chat>",
        status: "idle",
        toolsProfile: "orchestrator",
        cwdStrategy: "none",
        startedAt: new Date(),
        ...over,
      })
      .returning({ id: agentSessions.id })
  )[0];
  return row!.id;
}

const configure = async (id: number, body: Record<string, unknown>) =>
  PATCH(makeReq({ action: "configure", ...body }) as never, { params: params(id) });

describe('PATCH /api/runs/[id] { action: "configure" }', () => {
  beforeEach(async () => {
    await db.delete(agentSessions);
  });

  it("sets the model and both caps, and answers with the updated row", async () => {
    const id = await insertRun();
    const res = await configure(id, {
      model: "claude-sonnet-4-5",
      budgetMaxUsd: 5,
      budgetMaxTurns: 20,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.budgetMaxUsd).toBe(5);
    expect(body.budgetMaxTurns).toBe(20);
    const stored = await runs.get(id);
    expect(stored?.model).toBe("claude-sonnet-4-5");
    expect(stored?.budgetMaxUsd).toBe(5);
    expect(stored?.budgetMaxTurns).toBe(20);
  });

  // Patch semantics: `/budget $5` must not wipe the turn cap the persona set.
  it("leaves an omitted field alone", async () => {
    const id = await insertRun({ model: "opus", budgetMaxTurns: 40 });
    const res = await configure(id, { budgetMaxUsd: 2.5 });
    expect(res.status).toBe(200);
    const stored = await runs.get(id);
    expect(stored?.model).toBe("opus");
    expect(stored?.budgetMaxTurns).toBe(40);
    expect(stored?.budgetMaxUsd).toBe(2.5);
  });

  it("clears a cap on an explicit null", async () => {
    const id = await insertRun({ budgetMaxUsd: 5, budgetMaxTurns: 40 });
    expect((await configure(id, { budgetMaxUsd: null })).status).toBe(200);
    const stored = await runs.get(id);
    expect(stored?.budgetMaxUsd).toBeNull();
    expect(stored?.budgetMaxTurns).toBe(40);
  });

  // A field silently dropped for being junk is the one answer an operator
  // cannot act on, so every bad shape is a 400 with a reason.
  it("400s a junk value rather than ignoring it", async () => {
    const id = await insertRun({ model: "opus" });
    for (const body of [
      { model: "" },
      { model: 7 },
      { budgetMaxUsd: 0 },
      { budgetMaxUsd: -1 },
      { budgetMaxUsd: "5" },
      { budgetMaxTurns: 2.5 },
      { budgetMaxTurns: 0 },
    ]) {
      const res = await configure(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toContain("Bad configure");
    }
    expect((await runs.get(id))?.model).toBe("opus");
  });

  it("400s a configure that sets nothing", async () => {
    const id = await insertRun();
    const res = await configure(id, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("nothing to set");
  });

  it("404s an unknown run and still refuses an unknown action", async () => {
    const gone = await configure(999999, { model: "opus" });
    expect(gone.status).toBe(404);
    const id = await insertRun();
    const res = await PATCH(makeReq({ action: "retune" }) as never, { params: params(id) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Unknown action");
  });
});
