// __tests__/box-template-builder.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentEvents, boxTemplates } from "../db/schema";
import type { BoxClient, BoxCommandResult } from "../lib/runner/box-client";
import { runBoxTemplateBuild } from "../lib/runner/box-template-builder";
import { create } from "../lib/runs";

const KNOBS = ["TASK_ORCH_BOX_BASE_ID", "TASK_ORCH_BOX_AGENT_REPO", "TASK_ORCH_WORKER_SHA"];
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
  vi.restoreAllMocks();
});

const ok: BoxCommandResult = { success: true, timedOut: false, exitCode: 0, stdout: "", stderr: "" };

function fakeClient(overrides: Partial<BoxClient> = {}): { client: BoxClient; commands: string[] } {
  const commands: string[] = [];
  const client = {
    fork: vi.fn(async () => ({ id: "bx_new_tpl" })),
    get: vi.fn(async () => ({ id: "bx_new_tpl", state: "ready" })),
    command: vi.fn(async (_boxId: string, input: { command: string }) => {
      commands.push(input.command);
      return ok;
    }),
    stop: vi.fn(async () => ({ id: "bx_new_tpl" })),
    getLatestBoxSnapshot: vi.fn(async () => ({ id: "snap_1", status: "completed", createdAt: new Date() })),
    ...overrides,
  } as unknown as BoxClient;
  return { client, commands };
}

async function seed(sha: string): Promise<{ registryId: number; runId: number }> {
  const run = await create({ goal: "<implement>", defer: true });
  const [row] = await db
    .insert(boxTemplates)
    .values({ workerSha: sha, repository: "nodetool-ai/nodetool", triggeringRunId: run.id })
    .returning();
  return { registryId: row.id, runId: run.id };
}

async function eventTypes(runId: number): Promise<string[]> {
  const rows = await db.select().from(agentEvents).where(eq(agentEvents.sessionId, runId));
  return rows.map((r) => r.type).filter((t) => t.startsWith("runner_box_template_"));
}

const waits = {
  waitReady: vi.fn(async () => ({ id: "bx_new_tpl", state: "ready" })),
  waitCheckpoint: vi.fn(async () => ({
    box: { id: "bx_new_tpl", state: "archived" },
    snapshot: { id: "snap_1", status: "completed" },
  })),
} as never;

describe("runBoxTemplateBuild", () => {
  it("builds, archives, marks ready, and emits the full lifecycle", async () => {
    process.env.TASK_ORCH_BOX_BASE_ID = "bx_base";
    const sha = "b".repeat(40);
    const { registryId, runId } = await seed(sha);
    const { client, commands } = fakeClient();

    await runBoxTemplateBuild(client, { registryId, runId, workerSha: sha }, waits);

    const [row] = await db.select().from(boxTemplates).where(eq(boxTemplates.id, registryId));
    expect(row).toMatchObject({ state: "ready", boxId: "bx_new_tpl" });
    expect(row.readyAt).not.toBeNull();

    const types = await eventTypes(runId);
    expect(types[0]).toBe("runner_box_template_building");
    expect(types.filter((t) => t === "runner_box_template_step")).toHaveLength(7);
    expect(types[types.length - 1]).toBe("runner_box_template_ready");

    // The worker clone checks out the exact SHA and the manifest embeds it.
    expect(commands.some((c) => c.includes(`git checkout ${sha}`))).toBe(true);
    expect(commands.some((c) => c.includes(`"workerBuildSha":"${sha}"`) || c.includes(`\\"workerBuildSha\\":\\"${sha}\\"`))).toBe(true);
    expect(client.stop).toHaveBeenCalledWith("bx_new_tpl");
  });

  it("marks the row failed, emits failed, and stops the box when a step fails", async () => {
    process.env.TASK_ORCH_BOX_BASE_ID = "bx_base";
    const sha = "c".repeat(40);
    const { registryId, runId } = await seed(sha);
    let calls = 0;
    const { client } = fakeClient({
      command: vi.fn(async () => {
        calls += 1;
        if (calls === 2) return { ...ok, success: false, exitCode: 1, stderr: "npm ci exited 1" };
        return ok;
      }) as never,
    });

    await runBoxTemplateBuild(client, { registryId, runId, workerSha: sha }, waits);

    const [row] = await db.select().from(boxTemplates).where(eq(boxTemplates.id, registryId));
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/installing-deps|npm ci/);
    const types = await eventTypes(runId);
    expect(types[types.length - 1]).toBe("runner_box_template_failed");
    expect(client.stop).toHaveBeenCalled(); // best-effort cleanup
  });

  it("fails cleanly when no base box is configured", async () => {
    const sha = "d".repeat(40);
    const { registryId, runId } = await seed(sha);
    const { client } = fakeClient();
    await runBoxTemplateBuild(client, { registryId, runId, workerSha: sha }, waits);
    const [row] = await db.select().from(boxTemplates).where(eq(boxTemplates.id, registryId));
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/TASK_ORCH_BOX_BASE_ID/);
    expect(await eventTypes(runId)).toContain("runner_box_template_failed");
  });
});
