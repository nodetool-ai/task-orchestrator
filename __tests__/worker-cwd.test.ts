import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { prepareWorkerCwd, workerBranchFor } from "../lib/worker-runtime/cwd";
import type { RunStart } from "../lib/worker-channel/protocol";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

function makeStart(over: Omit<Partial<RunStart>, "run" | "repository"> & { run?: Record<string, unknown>; repository?: Record<string, unknown> }): RunStart {
  return {
    mode: "start",
    run: { id: 42, status: "running", goal: "<chat>", cwdStrategy: "repo", ...(over.run ?? {}) },
    task: (over.task as RunStart["task"]) ?? null,
    plan: null,
    persona: { id: "p" } as RunStart["persona"],
    repository: { id: "R-default", defaultBranch: "main", ...(over.repository ?? {}) } as RunStart["repository"],
    transcript: [],
    pendingInput: [],
    policy: {} as RunStart["policy"],
    allowedTools: [],
    kickoffPrompt: "",
  } as unknown as RunStart;
}

describe("prepareWorkerCwd on a managed runner", () => {
  let dir: string;
  let remote: string;
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "worker-cwd-"));
    const src = join(dir, "src");
    execFileSync("mkdir", ["-p", src]);
    git(["init", "-q", "-b", "main"], src);
    writeFileSync(join(src, "README.md"), "hello\n");
    git(["add", "."], src);
    git(["commit", "-q", "-m", "init"], src);
    remote = join(dir, "remote.git");
    git(["clone", "-q", "--bare", src, remote], dir);
    for (const k of ["SESSION_ROOT", "REPO_CACHE_DIR", "TASK_ORCH_RUNNER_REPO_PATH", "TASK_ORCH_GIT_CLONE_DEPTH"]) savedEnv[k] = process.env[k];
    process.env.SESSION_ROOT = join(dir, "session");
    delete process.env.REPO_CACHE_DIR;
    delete process.env.TASK_ORCH_RUNNER_REPO_PATH;
    process.env.TASK_ORCH_GIT_CLONE_DEPTH = "0";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });

  it("clones the repository into $SESSION_ROOT/repo on the default branch for cwd_strategy=repo", async () => {
    const prepared = await prepareWorkerCwd(makeStart({ repository: { remote } }));
    expect(prepared.cwd).toBe(join(dir, "session", "repo"));
    expect(existsSync(join(prepared.cwd, "README.md"))).toBe(true);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], prepared.cwd).trim()).toBe("main");
    expect(prepared.branch).toBeUndefined();
  });

  it("is idempotent: a second call reuses the checkout", async () => {
    const first = await prepareWorkerCwd(makeStart({ repository: { remote } }));
    writeFileSync(join(first.cwd, "scratch.txt"), "keep me\n");
    const second = await prepareWorkerCwd(makeStart({ repository: { remote } }));
    expect(second.cwd).toBe(first.cwd);
    expect(existsSync(join(second.cwd, "scratch.txt"))).toBe(true);
  });

  it("creates the task branch off the default branch for a worktree run and reports it", async () => {
    const start = makeStart({ run: { cwdStrategy: "worktree", taskId: "T-9" }, task: { id: "T-9" } as never, repository: { remote } });
    const prepared = await prepareWorkerCwd(start);
    expect(prepared.branch).toBe("claude/t-9");
    expect(prepared.worktreePath).toBe(prepared.cwd);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], prepared.cwd).trim()).toBe("claude/t-9");
  });

  it("fails with a clear error when the repository has no clonable remote", async () => {
    await expect(prepareWorkerCwd(makeStart({ repository: { remote: null } }))).rejects.toThrow(/no clonable remote/);
  });
});

describe("workerBranchFor", () => {
  it("prefers the recorded branch, then the task branch, then claude/<task>, then a chat branch", () => {
    expect(workerBranchFor(makeStart({ run: { cwdStrategy: "worktree", branch: "feat/x" } }), "main")).toBe("feat/x");
    expect(workerBranchFor(makeStart({ run: { cwdStrategy: "worktree" }, task: { id: "T-1", branch: "claude/custom" } as never }), "main")).toBe("claude/custom");
    expect(workerBranchFor(makeStart({ run: { cwdStrategy: "worktree" }, task: { id: "T-1" } as never }), "main")).toBe("claude/t-1");
    expect(workerBranchFor(makeStart({ run: { id: 7, cwdStrategy: "worktree" } }), "main")).toBe("claude/chat-7");
    expect(workerBranchFor(makeStart({ run: { cwdStrategy: "repo" } }), "develop")).toBe("develop");
  });
});
