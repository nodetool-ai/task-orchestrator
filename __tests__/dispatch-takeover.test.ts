// __tests__/dispatch-takeover.test.ts
//
// Regression: a detached worker claims its run via dispatchRun (status ->
// 'preparing' + fresh heartbeat), then drives the first turn through append().
// append()'s in-flight guard saw isLeaseLive(run)===true (preparing is a lease
// status with a fresh heartbeat) and rejected the worker's OWN turn as "already
// in flight" — wedging every dispatched run in 'preparing' with no output.
// The `takeover` flag lets the claiming worker adopt its own preparing claim.
import { installFakeRunnerProvider, setFakeRunLiveness } from "./helpers/fake-runner-provider";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get, append } from "../lib/runs";
import * as backend from "../lib/agent-backend";

function fakeBackend() {
  return {
    id: "fake",
    async runTurn(args: any) {
      args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
      args.onEvent({ type: "result", is_error: false, result: "done", usage: {} });
      return { summary: "done", resumeToken: "sess-1", turns: 1, inputTokens: 0, outputTokens: 0, totalCostUsd: null };
    },
  } as any;
}

// Simulate dispatchRun's atomic claim: preparing + fresh heartbeat.
async function claim(id: number) {
  await db.update(agentSessions)
    .set({ status: "preparing"})
    .where(eq(agentSessions.id, id));
  // The claiming worker is observably alive (provider verdict, not a clock).
  installFakeRunnerProvider();
  await setFakeRunLiveness(id, { status: "alive", incarnation: "w1" }, "w1");
}

describe("dispatched-worker takeover of its own preparing claim", () => {
  it("WITHOUT takeover, rejects the preparing claim (the wedge)", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await claim(run.id);
    const events: any[] = [];
    for await (const ev of append({ runId: run.id, role: "user", text: "go" })) events.push(ev);
    expect(events.some((e) => e.type === "error" && /already in flight/.test(e.error))).toBe(true);
    expect((await get(run.id))!.status).toBe("preparing"); // still wedged
  });

  it("WITH takeover, adopts the claim and drives the turn off 'preparing'", async () => {
    vi.spyOn(backend, "getBackend").mockResolvedValue(fakeBackend());
    const run = await create({ goal: "<chat>", defer: true });
    await claim(run.id);
    const events: any[] = [];
    for await (const ev of append({ runId: run.id, role: "user", text: "go", takeover: true })) events.push(ev);
    expect(events.some((e) => e.type === "error" && /already in flight/.test(e.error))).toBe(false);
    expect((await get(run.id))!.status).not.toBe("preparing"); // proceeded past the guard
    vi.restoreAllMocks();
  });
});
