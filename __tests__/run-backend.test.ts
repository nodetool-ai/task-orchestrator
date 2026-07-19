// Per-run agent-backend selection: agent_runs.backend picks the SDK adapter
// for that run ('pi' | 'claude'). The deployment default is resolved and
// persisted at creation so placement and backend cannot diverge after an env
// change; legacy NULL rows still resolve the deployment default when read.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import * as repo from "../lib/repo";
import * as runs from "../lib/runs";
import { startSession } from "../lib/agent";

// Force defer through the real create so no worker/worktree lifecycle starts
// (same seam as agent-reaper.test.ts).
const realCreate = runs.create;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(runs, "create").mockImplementation((input) => realCreate({ ...input, defer: true }));
});

async function makeTask(title: string): Promise<string> {
  const plan = await repo.createPlan({ title: `${title} plan`, body: "backend tests" });
  const task = await repo.createTask({ planId: plan.id, title });
  return task.id;
}

describe("runs.create backend column", () => {
  it("persists both an explicit backend and the resolved deployment default", async () => {
    const picked = await runs.create({ goal: "<chat>", backend: "pi", defer: true });
    expect(picked.backend).toBe("pi");
    expect((await runs.get(picked.id))?.backend).toBe("pi");

    const unpicked = await runs.create({ goal: "<chat>", defer: true });
    expect(unpicked.backend).toBe("pi");
  });

  it("rejects an unknown backend with a 400", async () => {
    await expect(
      runs.create({ goal: "<chat>", backend: "gpt", defer: true })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("accepts the claude backend for chat runs with an Anthropic model", async () => {
    const run = await runs.create({
      goal: "<chat>",
      backend: "claude",
      model: "anthropic/claude-sonnet-4-6",
      defer: true,
    });
    expect(run.backend).toBe("claude");
    expect((await runs.get(run.id))?.backend).toBe("claude");
  });

  it("rejects the claude backend for a chat run with a non-Anthropic model", async () => {
    await expect(
      runs.create({ goal: "<chat>", backend: "claude", model: "openai/gpt-5", defer: true })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects the claude backend with a non-Anthropic model (can never run)", async () => {
    await expect(
      runs.create({ goal: "<implement>", backend: "claude", model: "openai/gpt-5", defer: true })
    ).rejects.toMatchObject({ status: 400 });
    // The same model on pi is fine.
    const ok = await runs.create({ goal: "<chat>", backend: "pi", model: "openai/gpt-5", defer: true });
    expect(ok.backend).toBe("pi");
  });
});

describe("startSession backend inheritance", () => {
  it("a resume inherits the prior session's backend; an explicit pick overrides", async () => {
    const taskId = await makeTask("Backend inherit");
    const prior = await startSession({ taskId, backend: "pi" });
    expect(prior.backend).toBe("pi");

    // Make the prior session terminal + resumable (a stored resume token).
    await db
      .update(agentSessions)
      .set({ status: "completed", completedAt: new Date(), sdkSessionId: "pi:/tmp/sess.jsonl" })
      .where(eq(agentSessions.id, prior.id));

    const resumed = await startSession({ taskId, resumeOf: prior.id });
    expect(resumed.backend).toBe("pi");

    await db
      .update(agentSessions)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(agentSessions.id, resumed.id));

    const overridden = await startSession({ taskId, resumeOf: prior.id, backend: "claude" });
    expect(overridden.backend).toBe("claude");
  });
});
