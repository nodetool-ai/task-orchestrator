// __tests__/runs-planning-api.test.ts
//
// Route-level tests for POST /api/runs/[id]/planning.
// Verifies: both approve transitions (stage advance + append), 409 wrong-stage,
// 400 bad/missing action, 404 unknown run.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/runs/[id]/planning/route";
import { db } from "../db";
import { agentSessions } from "../db/schema";

// Stub auth() — we test without OAuth in route tests.
vi.mock("../auth", () => ({
  auth: () => Promise.resolve({ user: { email: "tester@example.com" } }),
}));

// Stub runs.append so the route's background turn never hits the SDK.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { mockAppend } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockAppend: vi.fn(async function* (..._args: any[]) {
    yield { type: "done" };
  }),
}));
vi.mock("../lib/runs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runs")>();
  return { ...actual, append: mockAppend };
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/runs/1/planning", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function params(id: string | number) {
  return Promise.resolve({ id: String(id) });
}

async function insertRun(planningStage: string | null = null): Promise<number> {
  const row = (
    await db
      .insert(agentSessions)
      .values({
        goal: "<plan>",
        status: "idle",
        toolsProfile: "orchestrator,repo_read,planning",
        cwdStrategy: "none",
        planningStage,
        startedAt: new Date(),
      })
      .returning({ id: agentSessions.id })
  )[0];
  return row!.id;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("POST /api/runs/[id]/planning", () => {
  beforeEach(async () => {
    await db.delete(agentSessions);
    mockAppend.mockClear();
  });

  // ── approve_spec ─────────────────────────────────────────────────────────────

  it("approve_spec: spec_review → building_plan, appends proceed message", async () => {
    const runId = await insertRun("spec_review");
    const res = await POST(makeReq({ action: "approve_spec" }) as never, {
      params: params(runId),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.planningStage).toBe("building_plan");

    const row = (
      await db
        .select({ planningStage: agentSessions.planningStage })
        .from(agentSessions)
    )[0];
    expect(row?.planningStage).toBe("building_plan");

    // append must be called (background fire)
    await new Promise((r) => setTimeout(r, 10));
    expect(mockAppend).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockAppend.mock.calls as any)[0][0] as { text: string; role: string };
    expect(call.text).toBe(
      "Approved the spec — create the plan and draft the implementation plan."
    );
    expect(call.role).toBe("user");
  });

  // ── approve_plan ─────────────────────────────────────────────────────────────

  it("approve_plan: plan_review → committing, appends proceed message", async () => {
    const runId = await insertRun("plan_review");
    const res = await POST(makeReq({ action: "approve_plan" }) as never, {
      params: params(runId),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.planningStage).toBe("committing");

    const row = (
      await db
        .select({ planningStage: agentSessions.planningStage })
        .from(agentSessions)
    )[0];
    expect(row?.planningStage).toBe("committing");

    await new Promise((r) => setTimeout(r, 10));
    expect(mockAppend).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockAppend.mock.calls as any)[0][0] as { text: string };
    expect(call.text).toBe("Approved the implementation plan — create the tasks.");
  });

  // ── 409: wrong prior stage ────────────────────────────────────────────────────

  it("approve_spec from wrong stage returns 409 and does not append", async () => {
    const runId = await insertRun("gathering");
    const res = await POST(makeReq({ action: "approve_spec" }) as never, {
      params: params(runId),
    });
    expect(res.status).toBe(409);

    const row = (
      await db
        .select({ planningStage: agentSessions.planningStage })
        .from(agentSessions)
    )[0];
    expect(row?.planningStage).toBe("gathering");

    await new Promise((r) => setTimeout(r, 10));
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("approve_plan from wrong stage returns 409 and does not append", async () => {
    const runId = await insertRun("building_plan");
    const res = await POST(makeReq({ action: "approve_plan" }) as never, {
      params: params(runId),
    });
    expect(res.status).toBe(409);

    await new Promise((r) => setTimeout(r, 10));
    expect(mockAppend).not.toHaveBeenCalled();
  });

  // ── 400: bad/missing action ───────────────────────────────────────────────────

  it("returns 400 for missing action", async () => {
    const runId = await insertRun("spec_review");
    const res = await POST(makeReq({}) as never, { params: params(runId) });
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("returns 400 for unknown action", async () => {
    const runId = await insertRun("spec_review");
    const res = await POST(makeReq({ action: "approve_everything" }) as never, {
      params: params(runId),
    });
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockAppend).not.toHaveBeenCalled();
  });

  // ── 404: unknown run ─────────────────────────────────────────────────────────

  it("returns 404 for unknown run", async () => {
    const res = await POST(makeReq({ action: "approve_spec" }) as never, {
      params: params(99999),
    });
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockAppend).not.toHaveBeenCalled();
  });
});
