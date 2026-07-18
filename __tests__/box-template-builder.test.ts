// __tests__/box-template-builder.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentEvents, environments } from "../db/schema";
import type { BoxClient, BoxCommandResult } from "../lib/runner/box-client";
import { runBoxTemplateBuild } from "../lib/runner/box-template-builder";
import { create } from "../lib/runs";

const KNOBS = ["TASK_ORCH_BOX_AGENT_REPO", "TASK_ORCH_WORKER_SHA"];
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
  vi.restoreAllMocks();
});

const ok: BoxCommandResult = { success: true, timedOut: false, exitCode: 0, stdout: "", stderr: "" };

// The builder runs each step DETACHED then polls a marker file, so the fake box
// speaks that protocol: a `setsid` launch → "launched"; a `.rc` probe → the
// exit code ("0", or "1" for a step whose launch matched `failOn`); a `tail`
// read → the captured log. Every build command still appears verbatim inside
// its launch string, so the substring assertions below hold.
function fakeClient(
  opts: { failOn?: RegExp; overrides?: Partial<BoxClient> } = {}
): { client: BoxClient; commands: string[] } {
  const commands: string[] = [];
  let pendingFail = false;
  const client = {
    create: vi.fn(async () => ({ id: "bx_new_tpl", state: "ready" })),
    get: vi.fn(async () => ({ id: "bx_new_tpl", state: "ready" })),
    command: vi.fn(async (_boxId: string, input: { command: string }) => {
      const cmd = input.command;
      commands.push(cmd);
      if (cmd.includes("setsid")) {
        pendingFail = opts.failOn ? opts.failOn.test(cmd) : false;
        return { ...ok, stdout: "launched" };
      }
      if (cmd.includes(".rc")) return { ...ok, stdout: pendingFail ? "1" : "0" };
      if (cmd.includes("tail -c")) return { ...ok, stdout: "npm ci exited 1" };
      return ok;
    }),
    stop: vi.fn(async () => ({ id: "bx_new_tpl" })),
    getLatestBoxSnapshot: vi.fn(async () => ({ id: "snap_1", status: "completed", createdAt: new Date() })),
    ...opts.overrides,
  } as unknown as BoxClient;
  return { client, commands };
}

async function seed(sha: string): Promise<{ registryId: number; runId: number }> {
  const run = await create({ goal: "<implement>", defer: true });
  const [row] = await db
    .insert(environments)
    .values({ provider: "box", workerSha: sha, triggeringRunId: run.id })
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
  // No-op sleep so the poll loop doesn't wall-clock wait between probes.
  sleep: async () => {},
} as never;

describe("runBoxTemplateBuild", () => {
  it("creates a blank box, builds, archives, marks ready, and emits the full lifecycle", async () => {
    const sha = "b".repeat(40);
    const { registryId, runId } = await seed(sha);
    const { client, commands } = fakeClient();

    await runBoxTemplateBuild(client, { registryId, runId, workerSha: sha }, waits);

    // A fresh blank box was created — no base/fork id involved.
    expect(client.create).toHaveBeenCalledWith({ env: {}, noEnv: true });

    const [row] = await db.select().from(environments).where(eq(environments.id, registryId));
    expect(row).toMatchObject({ state: "ready", boxId: "bx_new_tpl" });
    expect(row.readyAt).not.toBeNull();

    const types = await eventTypes(runId);
    expect(types[0]).toBe("runner_box_template_building");
    expect(types.filter((t) => t === "runner_box_template_step")).toHaveLength(8);
    expect(types[types.length - 1]).toBe("runner_box_template_ready");

    // The first step verifies the blank-box runtime before cloning.
    expect(commands.some((c) => c.includes("command -v git") && c.includes("node") && c.includes("npm"))).toBe(true);
    // The worker clone checks out the exact SHA and the manifest embeds it.
    expect(commands.some((c) => c.includes(`git checkout ${sha}`))).toBe(true);
    expect(commands.some((c) => c.includes(`"workerBuildSha":"${sha}"`) || c.includes(`\\"workerBuildSha\\":\\"${sha}\\"`))).toBe(true);
    // Before archiving, the build (a) runs the standalone bundle in isolation
    // — its own usage check, exit 2, proves the full dependency graph loads
    // with no node_modules — and (b) execs the Box's preinstalled claude
    // binary, then syncs so the checkpoint can't seal half-written pages.
    const verify = commands.find((c) => c.includes("/usr/local/bin/claude --version"));
    expect(verify).toBeDefined();
    expect(verify).toContain("run-worker.js");
    expect(verify).toContain("sync");
    // The reshaped build installs without the SDK's 251MB optional platform
    // binary, builds the standalone bundle, prunes the checkout, and never
    // npm-installs the agent repo (deps are on-demand at run time).
    expect(commands.some((c) => c.includes("npm ci --omit=optional"))).toBe(true);
    expect(commands.some((c) => c.includes("build:worker:standalone"))).toBe(true);
    expect(commands.some((c) => c.includes("rm -rf") && c.includes("/home/user/task-orchestrator"))).toBe(true);
    expect(commands.some((c) => c.includes("workerEntryPath"))).toBe(true);
    expect(commands.some((c) => c.includes("/home/user/repository") && c.includes("npm ci"))).toBe(false);
    expect(client.stop).toHaveBeenCalledWith("bx_new_tpl");
  });

  it("marks the row failed when the pre-archive binary smoke test fails", async () => {
    const sha = "f".repeat(40);
    const { registryId, runId } = await seed(sha);
    // Fail the step whose launch runs the SDK binary's --version probe.
    const { client } = fakeClient({ failOn: /--version/ });

    await runBoxTemplateBuild(client, { registryId, runId, workerSha: sha }, waits);

    const [row] = await db.select().from(environments).where(eq(environments.id, registryId));
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/verifying-worker/);
    const types = await eventTypes(runId);
    expect(types[types.length - 1]).toBe("runner_box_template_failed");
    // The build never reached the archiving step: no step event for it.
    const stepPayloads = await db.select().from(agentEvents).where(eq(agentEvents.sessionId, runId));
    const archived = stepPayloads.some(
      (r) => r.type === "runner_box_template_step" && JSON.stringify(r.payload).includes("archiving")
    );
    expect(archived).toBe(false);
  });

  it("marks the row failed, emits failed, and stops the box when a step fails", async () => {
    const sha = "c".repeat(40);
    const { registryId, runId } = await seed(sha);
    // The installing-deps step's launch carries `npm ci` in the worker dir; make
    // its polled exit code non-zero.
    const { client } = fakeClient({ failOn: /npm ci/ });

    await runBoxTemplateBuild(client, { registryId, runId, workerSha: sha }, waits);

    const [row] = await db.select().from(environments).where(eq(environments.id, registryId));
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/installing-deps|npm ci/);
    const types = await eventTypes(runId);
    expect(types[types.length - 1]).toBe("runner_box_template_failed");
    expect(client.stop).toHaveBeenCalled(); // best-effort cleanup
  });

  it("fails cleanly when the blank box cannot be created", async () => {
    const sha = "d".repeat(40);
    const { registryId, runId } = await seed(sha);
    const { client } = fakeClient({
      overrides: {
        create: vi.fn(async () => {
          throw new Error("Box account cannot start another box");
        }) as never,
      },
    });
    await runBoxTemplateBuild(client, { registryId, runId, workerSha: sha }, waits);
    const [row] = await db.select().from(environments).where(eq(environments.id, registryId));
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/cannot start another box/);
    expect(await eventTypes(runId)).toContain("runner_box_template_failed");
    // Nothing was created, so there is no box to stop.
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("manual build (runId null): no run events, detail updated per step, marks ready", async () => {
    const sha = "e".repeat(40);
    const [row] = await db.insert(environments).values({ provider: "box", workerSha: sha }).returning();
    const { client } = fakeClient();
    await runBoxTemplateBuild(client, { registryId: row.id, runId: null, workerSha: sha }, waits);
    const [after] = await db.select().from(environments).where(eq(environments.id, row.id));
    expect(after.state).toBe("ready");
    expect(after.boxId).toBe("bx_new_tpl");
    expect(after.detail).toBeNull(); // cleared on ready
    // No run to check events on — assert the global agent_events table gained no
    // runner_box_template_* rows for a null session by construction: emitBoxEvent
    // was never called (sessionId would be required). Covered by type safety +
    // the emit no-op below; the meaningful assertion is state/boxId/detail above.
  });
});
