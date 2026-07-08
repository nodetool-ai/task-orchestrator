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
  snapshot: null as null | (() => Promise<Array<{ role: string }>>),
}));

// Mock BOTH executor turn paths so a single file can cover them. The
// runOneTurn path (getBackend.runTurn) is used when
// TASK_ORCH_LIGHTWEIGHT_EXECUTOR=0; the lightweight loop (runChatAiTurn) is
// the default. Each implementation mirrors the other's streaming shape so the
// mid-turn snapshot captures the same "kickoff + first assistant" state.
vi.mock("../lib/agent-backend", () => ({
  getBackend: async () => ({
    id: "pi",
    listProviders: () => [],
    runTurn: async (args: {
      onEvent: (env: Record<string, unknown>) => void | Promise<void>;
    }) => {
      await args.onEvent({ type: "system", subtype: "init", session_id: "sess-1" });
      await args.onEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "starting task A" }] },
      });
      // Simulate a page load while the turn is still streaming.
      if (h.snapshot) h.midTurn = await h.snapshot();
      await args.onEvent({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      });
      await args.onEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "task A merged" }] },
      });
      await args.onEvent({
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

vi.mock("../lib/chat-ai-loop", () => ({
  // Mirror getBackend.runTurn's streaming shape: persist a 'system'/tool pair
  // via the transport so the snapshot sees the same "kickoff + first assistant"
  // state, then return the same final result. The lightweight path emits one
  // AppendStreamEvent per assistant / tool-result envelope.
  runChatAiTurn: async ({ run }: { run: { id: number } }) => {
    const { runTransport } = await import("../lib/worker");
    const transport = await runTransport();
    const firstBlocks = [{ type: "text", text: "starting task A" }];
    const firstMessage = await transport.appendMessage(run.id, "agent", firstBlocks as any);
    // Page load snapshot after the first assistant envelope is persisted.
    if (h.snapshot) h.midTurn = await h.snapshot();
    const toolBlocks = [
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
    ];
    await transport.appendMessage(run.id, "tool", toolBlocks as any);
    const finalBlocks = [{ type: "text", text: "task A merged" }];
    const finalMessage = await transport.appendMessage(run.id, "agent", finalBlocks as any);
    return {
      events: [
        { type: "sdk", sdk: { type: "assistant", message: { content: firstBlocks } }, message: firstMessage },
        { type: "sdk", sdk: { type: "user", message: { content: toolBlocks } } },
        { type: "sdk", sdk: { type: "assistant", message: { content: finalBlocks } }, message: finalMessage },
      ],
      summary: "plan done",
      totalCostUsd: 0.01,
      inputTokens: 10,
      outputTokens: 20,
      turns: 1,
    };
  },
}));

vi.mock("../auth", () => ({
  auth: async () => ({ user: { email: "test@example.com" } }),
}));

import * as repo from "../lib/repo";
import * as runs from "../lib/runs";
import { GET as getLiveSessions } from "../app/api/live-sessions/route";

beforeEach(async () => {
  // This file mocks lib/agent-backend's runTurn — the runOneTurn / full
  // SDK harness path. Disable the lightweight executor loop so executors
  // route through that harness here; the lightweight path has its own
  // persistence test below.
  process.env.TASK_ORCH_LIGHTWEIGHT_EXECUTOR = "0";
  await seedPersonas();
  await db.delete(agentMessages);
  await db.delete(agentEvents);
  await db.delete(agentSessions);
  await db.delete(acceptanceCriteria);
  await db.delete(taskNotes);
  await db.delete(taskDependencies);
  await db.delete(tasks);
  await db.delete(plans);
  await db.delete(repositories).where(ne(repositories.id, "R-default"));
  h.midTurn = null;
  h.snapshot = null;
});

async function waitForTerminal(runId: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await runs.get(runId);
    if (r && ["completed", "failed", "budget_exhausted", "cancelled", "closed", "idle"].includes(r.status)) {
      if (r.status !== "idle") return;
    }
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`run ${runId} did not reach a terminal status in ${timeoutMs}ms`);
}

describe("plan-executor run history", () => {
  it("persists the kickoff prompt and each streamed message so a page load mid-turn sees history", async () => {
    const plan = await repo.createPlan({ title: "Ship Sidebar", date: "2026-07-02" });
    h.snapshot = async () => {
      const r = (await runs.list({ goal: "<execute>" }))[0];
      return r ? (await runs.listMessages(r.id)).map((m) => ({ role: m.role })) : [];
    };

    const run = await runs.create({ goal: "<execute>", planId: plan.id });
    await waitForTerminal(run.id);

    // Mid-turn (between the two assistant envelopes) the DB already held the
    // kickoff prompt and the first assistant message — previously assistant
    // output was only written once at end-of-turn, so a reload showed nothing.
    expect(h.midTurn).not.toBeNull();
    expect(h.midTurn!.map((m) => m.role)).toEqual(["system", "agent"]);

    const msgs = await runs.listMessages(run.id);
    expect(msgs.map((m) => m.role)).toEqual(["system", "agent", "tool", "agent"]);
    // The kickoff prompt anchors the transcript.
    expect(JSON.stringify(msgs[0].content)).toContain(plan.id);
    expect((await runs.get(run.id))!.status).toBe("completed");
  });
});

// Lightweight executor loop (the default): same mid-turn persistence guarantee
// as the runOneTurn path above, but driving @earendil-works/pi-ai directly via
// runChatAiTurn. The kickoff prompt lands as a 'user' row (the loop's context
// loader keys on the latest user row) instead of 'system'.
describe("plan-executor run history (lightweight loop)", () => {
  beforeEach(() => {
    process.env.TASK_ORCH_LIGHTWEIGHT_EXECUTOR = "1";
  });

  it("persists the kickoff prompt and each streamed envelope mid-turn", async () => {
    const plan = await repo.createPlan({ title: "Ship Light", date: "2026-07-02" });
    h.snapshot = async () => {
      const r = (await runs.list({ goal: "<execute>" }))[0];
      return r ? (await runs.listMessages(r.id)).map((m) => ({ role: m.role })) : [];
    };

    const run = await runs.create({ goal: "<execute>", planId: plan.id });
    await waitForTerminal(run.id);

    // Mid-turn the DB already holds the kickoff prompt (user) and the first
    // assistant envelope — same guarantee as the runOneTurn path.
    expect(h.midTurn).not.toBeNull();
    expect(h.midTurn!.map((m) => m.role)).toEqual(["user", "agent"]);

    const msgs = await runs.listMessages(run.id);
    // user kickoff, assistant, tool result, assistant final.
    expect(msgs.map((m) => m.role)).toEqual(["user", "agent", "tool", "agent"]);
    expect(JSON.stringify(msgs[0].content)).toContain(plan.id);
    expect((await runs.get(run.id))!.status).toBe("completed");
  });
});

describe("GET /api/live-sessions", () => {
  it("includes a running plan-executor run, titled after its plan", async () => {
    const plan = await repo.createPlan({ title: "Big Migration", date: "2026-07-02" });
    const execId = (
      await db
        .insert(agentSessions)
        .values({ goal: "<execute>", status: "running", planId: plan.id })
        .returning()
    )[0].id;
    // A plain chat run must stay hidden.
    await db.insert(agentSessions).values({ goal: "<chat>", status: "running" });

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
    const plan = await repo.createPlan({ title: "Two Runs", date: "2026-07-02" });
    await db
      .insert(agentSessions)
      .values({ goal: "<execute>", status: "completed", planId: plan.id });
    const failedId = (
      await db
        .insert(agentSessions)
        .values({ goal: "<execute>", status: "failed", planId: plan.id, error: "boom" })
        .returning()
    )[0].id;

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
