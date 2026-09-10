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
import { agentSessions, inboxEvents, runEventSubscriptions, runSourceEvents, runnerInstances, tasks } from "../db/schema";
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
import type { WorkerDriverSession } from "../lib/worker-runtime/context";

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
  await db.delete(inboxEvents);
  await db.delete(runEventSubscriptions);
  await db.delete(runSourceEvents);
  await db.delete(agentSessions);
});

describe("detached worker terminal PR lifecycle", () => {
  it.each([true, false])("retains the agent-recorded PR without pushing again when origin advances (report URL: %s)", async (reportUrl) => {
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
          // Delivery happens inside the agent turn, including the durable PR
          // and result tools. The worker only reports completion afterwards.
          await command(["git", "push", "-u", "origin", branch], args.cwd);
          const linked = await (server!.session as WorkerDriverSession).invokeTool!("set_task_pr", {
            task_id: taskId, pr_url: "https://github.com/acme/scheduled/pull/17",
          }, randomUUID());
          expect(linked.isError).not.toBe(true);
          const reported = await (server!.session as WorkerDriverSession).invokeTool!("report_result", {
            status: "success", summary: "scheduled change complete",
            ...(reportUrl ? { pr_url: "https://github.com/acme/scheduled/pull/17" } : {}),
          }, randomUUID());
          expect(reported.isError).not.toBe(true);

          // Regression for run 224: another checkout advances the task branch
          // while this run finishes. A lifecycle-owned push would be rejected.
          const other = join(root, "other");
          await command(["git", "clone", "-b", branch, bare, other]);
          await command(["git", "config", "user.name", "other"], other);
          await command(["git", "config", "user.email", "other@example.com"], other);
          await writeFile(join(other, "remote.txt"), "concurrent work\n");
          await command(["git", "add", "remote.txt"], other);
          await command(["git", "commit", "-m", "remote advance"], other);
          await command(["git", "push", "origin", branch], other);
          args.onEvent({ type: "result", is_error: false, result: "scheduled change complete", usage: {} });
          return { envelopes: [], summary: "scheduled change complete", resumeToken: "terminal-session", turns: 1, inputTokens: 0, outputTokens: 0, totalCostUsd: null };
        },
      } as any);

      server = await boot(run.id);
      const start = await server.session.waitForStart!() as RunStart;
      await driveWorkerRun({ start, session: server.session });

      expect((await command(["git", "rev-list", "--count", `release..${branch}`], checkout)).trim()).toBe("1");
      expect((await command(["git", "rev-parse", `refs/remotes/origin/${branch}`], checkout)).trim()).not.toBe("");
      expect((await command(["git", "show", `${branch}:remote.txt`], bare)).trim()).toBe("concurrent work");
      expect(github.create).not.toHaveBeenCalled();
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

  it("leaves committed and dirty work untouched when the agent reports delivery blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "taskorch-agent-delivery-"));
    const bare = join(root, "origin.git");
    const checkout = join(root, "checkout");
    let runId: number | null = null;
    let server: WorkerServer | null = null;
    let agentHead = "";
    try {
      await command(["git", "init", "--bare", bare]);
      await command(["git", "init", "-b", "main", checkout]);
      await command(["git", "config", "user.name", "test"], checkout);
      await command(["git", "config", "user.email", "test@example.com"], checkout);
      await writeFile(join(checkout, "README.md"), "base\n");
      await command(["git", "add", "."], checkout);
      await command(["git", "commit", "-m", "base"], checkout);
      await command(["git", "remote", "add", "origin", bare], checkout);
      await command(["git", "push", "origin", "main"], checkout);
      const repository = await repo.createRepository({
        name: `agent-delivery-${randomUUID()}`, localPath: checkout,
        remote: "https://github.com/acme/scheduled.git",
      });
      const task = await repo.createTask({ planId: null, repoId: repository.id, title: "Agent delivery" });
      await repo.transitionTask(task.id, { state: "in_progress", assignee: "test" });
      const run = await create({ goal: "<implement>", taskId: task.id, repoId: repository.id, defer: true });
      runId = run.id;
      const branch = (await repo.getTask(task.id))!.branch!;
      await command(["git", "checkout", "-b", branch], checkout);
      await db.update(agentSessions).set({ worktreePath: checkout, branch }).where(eq(agentSessions.id, run.id));
      vi.spyOn(backend, "getBackend").mockResolvedValue({
        id: "fake", listProviders: () => [],
        async runTurn() {
          await writeFile(join(checkout, "committed.txt"), "agent commit\n");
          await command(["git", "add", "committed.txt"], checkout);
          await command(["git", "commit", "-m", "agent work"], checkout);
          agentHead = (await command(["git", "rev-parse", "HEAD"], checkout)).trim();
          await writeFile(join(checkout, "unfinished.txt"), "keep uncommitted\n");
          const reported = await (server!.session as WorkerDriverSession).invokeTool!("report_result", {
            status: "blocked", summary: "Cannot reconcile remote changes safely",
          }, randomUUID());
          expect(reported.isError).not.toBe(true);
          return { envelopes: [], summary: "delivery blocked", resumeToken: "blocked-session", turns: 1, inputTokens: 0, outputTokens: 0, totalCostUsd: null };
        },
      } as any);
      server = await boot(run.id);
      const start = await server.session.waitForStart!() as RunStart;
      await driveWorkerRun({ start, session: server.session });

      expect((await get(run.id))!).toMatchObject({ status: "failed", prUrl: null });
      expect((await command(["git", "rev-parse", "HEAD"], checkout)).trim()).toBe(agentHead);
      expect((await command(["git", "status", "--porcelain"], checkout)).trim()).toBe("?? unfinished.txt");
      await expect(command(["git", "show-ref", "--verify", `refs/heads/${branch}`], bare)).rejects.toThrow();
      expect(github.create).not.toHaveBeenCalled();
    } finally {
      if (runId != null) await disconnectRun(runId).catch(() => undefined);
      if (server) await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
