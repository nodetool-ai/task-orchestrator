import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import {
  acceptanceCriteria,
  agentEvents,
  agentMessages,
  agentSessions,
  plans,
  repositories,
  taskDependencies,
  taskNotes,
  tasks,
} from "../db/schema";
import { seedPersonas } from "../db/seed-personas";

// Shared with the module mocks below (vi.mock factories are hoisted above
// imports, so plain module-level state would not be visible to them).
const h = vi.hoisted(() => ({
  // Message rows read from the DB *mid-turn*, between two streamed assistant
  // envelopes — what a page load during a long executor run would see.
  midTurn: null as null | Array<{ role: string }>,
  snapshot: null as null | (() => Array<{ role: string }>),
}));

vi.mock("../lib/agent-backend", () => ({
  getBackend: async () => ({
    id: "pi",
    listProviders: () => [],
    runTurn: async (args: {
      onEvent: (env: Record<string, unknown>) => void;
    }) => {
      args.onEvent({ type: "system", subtype: "init", session_id: "sess-1" });
      args.onEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "starting task A" }] },
      });
      // Simulate a page load while the turn is still streaming.
      if (h.snapshot) h.midTurn = h.snapshot();
      args.onEvent({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      });
      args.onEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "task A merged" }] },
      });
      args.onEvent({
        type: "result",
        is_error: false,
        result: "plan done",
        usage: { input_tokens: 10, output_tokens: 20 },
      });
      return {
        envelopes: [],
        summary: "plan done",
        resumeToken: "pi:tok",
        totalCostUsd: 0.01,
        inputTokens: 10,
        outputTokens: 20,
        turns: 1,
      };
    },
  }),
}));

vi.mock("../auth", () => ({
  auth: async () => ({ user: { email: "test@example.com" } }),
}));

import * as repo from "../lib/repo";
import * as runs from "../lib/runs";
import { GET as getLiveSessions } from "../app/api/live-sessions/route";

beforeEach(() => {
  seedPersonas();
  db.delete(agentMessages).run();
  db.delete(agentEvents).run();
  db.delete(agentSessions).run();
  db.delete(acceptanceCriteria).run();
  db.delete(taskNotes).run();
  db.delete(taskDependencies).run();
  db.delete(tasks).run();
  db.delete(plans).run();
  db.delete(repositories).where(ne(repositories.id, "R-default")).run();
  h.midTurn = null;
  h.snapshot = null;
});

async function waitForTerminal(runId: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = runs.get(runId);
    if (r && ["completed", "failed", "budget_exhausted", "cancelled", "closed", "idle"].includes(r.status)) {
      if (r.status !== "idle") return;
    }
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`run ${runId} did not reach a terminal status in ${timeoutMs}ms`);
}

describe("plan-executor run history", () => {
  it("persists the kickoff prompt and each streamed message so a page load mid-turn sees history", async () => {
    const plan = repo.createPlan({ title: "Ship Sidebar", date: "2026-07-02" });
    h.snapshot = () => {
      const r = runs.list({ goal: "<execute>" })[0];
      return r ? runs.listMessages(r.id).map((m) => ({ role: m.role })) : [];
    };

    const run = runs.create({ goal: "<execute>", planId: plan.id });
    await waitForTerminal(run.id);

    // Mid-turn (between the two assistant envelopes) the DB already held the
    // kickoff prompt and the first assistant message — previously assistant
    // output was only written once at end-of-turn, so a reload showed nothing.
    expect(h.midTurn).not.toBeNull();
    expect(h.midTurn!.map((m) => m.role)).toEqual(["system", "agent"]);

    const msgs = runs.listMessages(run.id);
    expect(msgs.map((m) => m.role)).toEqual(["system", "agent", "tool", "agent"]);
    // The kickoff prompt anchors the transcript.
    expect(JSON.stringify(msgs[0].content)).toContain(plan.id);
    expect(runs.get(run.id)!.status).toBe("completed");
  });
});

describe("GET /api/live-sessions", () => {
  it("includes a running plan-executor run, titled after its plan", async () => {
    const plan = repo.createPlan({ title: "Big Migration", date: "2026-07-02" });
    const execId = db
      .insert(agentSessions)
      .values({ goal: "<execute>", status: "running", planId: plan.id })
      .returning()
      .all()[0].id;
    // A plain chat run must stay hidden.
    db.insert(agentSessions).values({ goal: "<chat>", status: "running" }).run();

    const res = await getLiveSessions();
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      runDbId: execId,
      bucket: "running",
      title: `Execute: ${plan.title}`,
      taskId: null,
      planId: plan.id,
    });
  });

  it("drops completed executor runs (not live) but keeps failed ones as blocked", async () => {
    const plan = repo.createPlan({ title: "Two Runs", date: "2026-07-02" });
    db.insert(agentSessions)
      .values({ goal: "<execute>", status: "completed", planId: plan.id })
      .run();
    const failedId = db
      .insert(agentSessions)
      .values({ goal: "<execute>", status: "failed", planId: plan.id, error: "boom" })
      .returning()
      .all()[0].id;

    const res = await getLiveSessions();
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      runDbId: failedId,
      bucket: "blocked",
      planId: plan.id,
    });
  });
});
