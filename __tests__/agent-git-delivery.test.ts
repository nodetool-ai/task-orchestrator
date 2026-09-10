import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import * as backend from "../lib/agent-backend";
import * as dispatch from "../lib/run-dispatch";
import * as repo from "../lib/repo";
import { sh } from "../lib/repo-checkout";
import { append, create, followUp, get } from "../lib/runs";

afterEach(() => vi.restoreAllMocks());

describe("local agent-owned git delivery", () => {
  it.each(["append", "followUp"])("%s never publishes or salvages the agent's checkout", async (driver) => {
    const root = await mkdtemp(join(tmpdir(), "agent-git-delivery-"));
    const checkout = join(root, "checkout");
    const bare = join(root, "origin.git");
    const git = (args: string[], cwd = checkout) => sh(["git", ...args], cwd);
    let agentCwd = "";
    let agentHead = "";
    try {
      await git(["init", "--bare", bare], root);
      await git(["init", "-b", "main", checkout], root);
      await git(["config", "user.name", "test"]);
      await git(["config", "user.email", "test@example.com"]);
      await writeFile(join(checkout, "base.txt"), "base\n");
      await writeFile(join(checkout, ".gitignore"), ".next\nnode_modules\n");
      await git(["add", "."]);
      await git(["commit", "-m", "base"]);
      await git(["remote", "add", "origin", bare]);
      await git(["push", "origin", "main"]);
      const repository = await repo.createRepository({
        name: `agent-git-${randomUUID()}`, localPath: checkout, remote: bare,
      });
      const task = await repo.createTask({ planId: null, repoId: repository.id, title: "Agent owns publication" });
      const run = await create({ goal: "<implement>", taskId: task.id, repoId: repository.id, defer: true });
      const branch = (await repo.getTask(task.id))!.branch!;
      vi.spyOn(dispatch, "remoteRunnerEnabled").mockReturnValue(false);
      if (driver === "followUp") {
        await git(["checkout", "-b", branch]);
        await db.update(agentSessions).set({ status: "completed", branch, worktreePath: checkout }).where(eq(agentSessions.id, run.id));
      }

      const runTurn = vi.fn(async (args: any) => {
        agentCwd = args.cwd;
        // Setup must not publish the task branch before the agent runs.
        expect((await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], args.cwd)).trim()).toBe("");
        await writeFile(join(args.cwd, "committed.txt"), "agent work\n");
        await git(["add", "committed.txt"], args.cwd);
        await git(["commit", "-m", "agent commit"], args.cwd);
        agentHead = (await git(["rev-parse", "HEAD"], args.cwd)).trim();
        await writeFile(join(args.cwd, "scratch.txt"), "unfinished\n");
        // An existing PR link must not cause lifecycle code to push newer work.
        await repo.setTaskPr(task.id, "https://github.com/acme/repo/pull/1");
        args.onEvent({ type: "result", is_error: false, result: "agent ended", usage: {} });
        return { summary: "agent ended", resumeToken: "test-session", turns: 1, inputTokens: 0, outputTokens: 0, totalCostUsd: null };
      });
      vi.spyOn(backend, "getBackend").mockResolvedValue({ id: "fake", runTurn } as any);

      if (driver === "followUp") await followUp(run.id, "inspect the PR");
      else for await (const _event of append({ runId: run.id, role: "user", text: "implement" })) { /* drain */ }

      expect(runTurn).toHaveBeenCalledTimes(1);
      expect((await get(run.id))!.status).toBe("completed");
      expect((await git(["rev-parse", "HEAD"], agentCwd)).trim()).toBe(agentHead);
      expect((await git(["status", "--porcelain"], agentCwd)).trim()).toBe("?? scratch.txt");
      expect((await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], agentCwd)).trim()).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
