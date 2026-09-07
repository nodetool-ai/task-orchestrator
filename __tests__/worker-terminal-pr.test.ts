import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const github = vi.hoisted(() => ({
  create: vi.fn(async () => ({ data: { html_url: "https://github.com/acme/scheduled/pull/17" } })),
  get: vi.fn(),
  graphql: vi.fn(),
}));

vi.mock("../lib/github-client", () => ({
  getOctokit: () => ({ pulls: { create: github.create, get: github.get }, graphql: github.graphql }),
}));

import { db } from "../db";
import { agentSessions, runnerInstances, tasks } from "../db/schema";
import * as agent from "../lib/agent";
import * as backend from "../lib/agent-backend";
import * as repo from "../lib/repo";
import * as schedules from "../lib/schedules";
import { create, get } from "../lib/runs";
import { startWorkerServer, type WorkerServer } from "../lib/worker-channel/worker-server";
import { localDialEndpoint } from "../lib/worker-channel/dispatch-env";
import { connectRun, disconnectRun } from "../lib/worker-channel/registry";
import { startChannelForRun } from "../lib/run-dispatch";
import type { RunStart } from "../lib/worker-channel/protocol";
import { WORKER_TERMINAL_PR_TOOLS } from "../lib/worker-terminal-pr";

async function command(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${args.join(" ")} failed: ${stderr || stdout}`)));
  });
}

async function driveWorkerRun(context: unknown): Promise<void> {
  const worker = await import("../lib/worker-runtime/context");
  await worker.driveWorkerRun(context as Parameters<typeof worker.driveWorkerRun>[0]);
}

async function boot(runId: number) {
  const instanceId = `wi_${randomUUID().replace(/-/g, "").slice(0, 32)}`;
  const secret = "terminal-pr-test-secret";
  const server: WorkerServer = await startWorkerServer({
    runId,
    instanceId,
    credentialSecret: secret,
    transport: "unix",
    sessionRoot: `/tmp/wtpr-${runId}-${Date.now()}`,
  });
  await db.insert(runnerInstances).values({
    runId,
    channelInstanceId: instanceId,
    channelEndpoint: localDialEndpoint(server.endpoint.replace(/^unix:\/\//, "")),
  });
  process.env.TASK_ORCH_WORKER_CHANNEL_SECRET = secret;
  await connectRun(runId);
  await startChannelForRun(runId, instanceId);
  return server;
}

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.TASK_ORCH_WORKER_CHANNEL_SECRET;
  await db.delete(agentSessions);
});

describe("detached worker terminal PR lifecycle", () => {
  it("pushes a release-based branch from the worker, opens a ready PR through the channel, and links the task", async () => {
    const root = await mkdtemp(join(tmpdir(), "taskorch-terminal-pr-"));
    const bare = join(root, "origin.git");
    const checkout = join(root, "checkout");
    let runId: number | null = null;
    let server: WorkerServer | null = null;
    try {
      await command(["git", "init", "--bare", bare]);
      await command(["git", "init", "-b", "release", checkout]);
      await command(["git", "config", "user.name", "test"], checkout);
      await command(["git", "config", "user.email", "test@example.com"], checkout);
      await writeFile(join(checkout, "README.md"), "base\n");
      await command(["git", "add", "README.md"], checkout);
      await command(["git", "commit", "-m", "base"], checkout);
      await command(["git", "remote", "add", "origin", bare], checkout);
      await command(["git", "push", "-u", "origin", "release"], checkout);

      const repository = await repo.createRepository({
        name: `terminal-pr-${randomUUID()}`,
        // The checkout's origin is deliberately local; this registered remote
        // is the control-plane-only GitHub target consumed by the mocked API.
        remote: "https://github.com/acme/scheduled.git",
        localPath: checkout,
        defaultBranch: "release",
      });
      // Exercise the production scheduler path: it creates this task in todo,
      // then must advance it before the detached worker's PR handoff.
      const realStart = agent.startSession;
      const startSession = vi.spyOn(agent, "startSession").mockImplementation((input) =>
        realStart({ ...input, defer: true })
      );
      const schedule = await schedules.createSchedule({
        name: "Scheduled release work",
        prompt: "implement scheduled release work",
        repoId: repository.id,
        baseBranch: "release",
        kind: "once",
        runAt: new Date(),
        autoMerge: false,
      });
      let taskId!: string;
      let run!: NonNullable<Awaited<ReturnType<typeof get>>>;
      try {
        const occurrenceId = await schedules.runScheduleNow(schedule.id);
        taskId = (await db.select().from(tasks).where(eq(tasks.scheduleOccurrenceId, occurrenceId)))[0]!.id;
        run = (await get((await db.select().from(agentSessions).where(eq(agentSessions.scheduleOccurrenceId, occurrenceId)))[0]!.id))!;
      } finally {
        startSession.mockRestore();
      }
      const task = (await repo.getTask(taskId))!;
      runId = run.id;
      const branch = task.branch!;
      await command(["git", "checkout", "-b", branch], checkout);
      await db.update(agentSessions).set({ worktreePath: checkout }).where(eq(agentSessions.id, run.id));

      vi.spyOn(backend, "getBackend").mockResolvedValue({
        id: "fake",
        listProviders: () => [],
        async runTurn(args: { cwd: string; onEvent: (event: unknown) => void }) {
          await writeFile(join(args.cwd, "scheduled.txt"), "worker change\n");
          await command(["git", "add", "scheduled.txt"], args.cwd);
          await command(["git", "commit", "-m", "scheduled change"], args.cwd);
          args.onEvent({ type: "result", is_error: false, result: "scheduled change complete", usage: {} });
          return { envelopes: [], summary: "scheduled change complete", resumeToken: "terminal-session", turns: 1, inputTokens: 0, outputTokens: 0, totalCostUsd: null };
        },
      } as any);

      server = await boot(run.id);
      const start = await server.session.waitForStart!() as RunStart;
      await driveWorkerRun({ start, session: server.session });

      expect((await command(["git", "rev-list", "--count", `release..${branch}`], checkout)).trim()).toBe("1");
      expect((await command(["git", "rev-parse", `refs/remotes/origin/${branch}`], checkout)).trim()).not.toBe("");
      expect(github.create).toHaveBeenCalledWith(expect.objectContaining({
        owner: "acme", repo: "scheduled", head: branch, base: "release",
      }));
      expect(github.get).not.toHaveBeenCalled();
      expect(github.graphql).not.toHaveBeenCalled();
      expect((await get(run.id))!).toMatchObject({ status: "completed", prUrl: "https://github.com/acme/scheduled/pull/17", baseBranch: "release" });
      expect(await repo.getTask(task.id)).toMatchObject({ prUrl: "https://github.com/acme/scheduled/pull/17", state: "testing" });
    } finally {
      if (runId != null) await disconnectRun(runId).catch(() => undefined);
      if (server) await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps a no-change scheduled task in progress and leaves its criteria open", async () => {
    github.create.mockClear();
    const root = await mkdtemp(join(tmpdir(), "taskorch-terminal-pr-empty-"));
    const bare = join(root, "origin.git");
    const checkout = join(root, "checkout");
    let runId: number | null = null;
    let server: WorkerServer | null = null;
    try {
      await command(["git", "init", "--bare", bare]);
      await command(["git", "init", "-b", "main", checkout]);
      await command(["git", "config", "user.name", "test"], checkout);
      await command(["git", "config", "user.email", "test@example.com"], checkout);
      await writeFile(join(checkout, "README.md"), "base\n");
      await command(["git", "add", "README.md"], checkout);
      await command(["git", "commit", "-m", "base"], checkout);
      await command(["git", "remote", "add", "origin", bare], checkout);
      await command(["git", "push", "-u", "origin", "main"], checkout);

      const repository = await repo.createRepository({
        name: `terminal-pr-empty-${randomUUID()}`,
        remote: "https://github.com/acme/scheduled.git",
        localPath: checkout,
        defaultBranch: "main",
      });
      const realStart = agent.startSession;
      const startSession = vi.spyOn(agent, "startSession").mockImplementation((input) =>
        realStart({ ...input, defer: true })
      );
      let taskId!: string;
      let run!: NonNullable<Awaited<ReturnType<typeof get>>>;
      try {
        const schedule = await schedules.createSchedule({
          name: "Scheduled no-op work",
          prompt: "inspect the repository",
          repoId: repository.id,
          kind: "once",
          runAt: new Date(),
          autoMerge: false,
        });
        const occurrenceId = await schedules.runScheduleNow(schedule.id);
        taskId = (await db.select().from(tasks).where(eq(tasks.scheduleOccurrenceId, occurrenceId)))[0]!.id;
        run = (await get((await db.select().from(agentSessions).where(eq(agentSessions.scheduleOccurrenceId, occurrenceId)))[0]!.id))!;
      } finally {
        startSession.mockRestore();
      }
      await repo.addCriterion(taskId, "A no-change run must not complete this");
      const task = (await repo.getTask(taskId))!;
      await command(["git", "checkout", "-b", task.branch!], checkout);
      await db.update(agentSessions).set({ worktreePath: checkout }).where(eq(agentSessions.id, run.id));

      vi.spyOn(backend, "getBackend").mockResolvedValue({
        id: "fake",
        listProviders: () => [],
        async runTurn(args: { onEvent: (event: unknown) => void }) {
          args.onEvent({ type: "result", is_error: false, result: "nothing to change", usage: {} });
          return { envelopes: [], summary: "nothing to change", resumeToken: "terminal-session", turns: 1, inputTokens: 0, outputTokens: 0, totalCostUsd: null };
        },
      } as any);

      runId = run.id;
      server = await boot(run.id);
      const start = await server.session.waitForStart!() as RunStart;
      await driveWorkerRun({ start, session: server.session });

      expect((await get(run.id))!).toMatchObject({ status: "completed", prUrl: null });
      expect(await repo.getTask(taskId)).toMatchObject({
        state: "in_progress",
        prUrl: null,
        criteria: [expect.objectContaining({ done: false })],
      });
      expect(github.create).not.toHaveBeenCalled();
    } finally {
      if (runId != null) await disconnectRun(runId).catch(() => undefined);
      if (server) await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses squash auto-merge only for the manual-run default", async () => {
    github.create.mockResolvedValueOnce({ data: { html_url: "https://github.com/acme/scheduled/pull/18" } });
    github.get.mockResolvedValueOnce({ data: { node_id: "PR_node" } });
    const repository = await repo.createRepository({ name: `manual-pr-${randomUUID()}`, remote: "https://github.com/acme/scheduled.git" });
    const task = await repo.createTask({ planId: null, repoId: repository.id, title: "Manual implementation" });
    await repo.transitionTask(task.id, { state: "in_progress", assignee: "operator" });
    const run = await create({ goal: "<implement>", taskId: task.id, repoId: repository.id, baseBranch: "main", defer: true });
    const branch = (await repo.getTask(task.id))!.branch!;
    await db.update(agentSessions).set({ branch }).where(eq(agentSessions.id, run.id));

    const response = await WORKER_TERMINAL_PR_TOOLS[0]!.execute(
      { branch, baseBranch: "main", summary: "manual work" },
      { author: "claude-agent", runId: run.id }
    );

    expect(response.isError).not.toBe(true);
    expect(github.graphql).toHaveBeenCalledWith(
      expect.stringContaining("PullRequestMergeMethod"),
      { pullRequestId: "PR_node", mergeMethod: "SQUASH" }
    );
  });
});
