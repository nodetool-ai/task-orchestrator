import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { prepareWorkerCwd, workerBranchFor } from "../lib/worker-runtime/cwd";
import { dependencyFingerprint, type SpriteDependencyManifest } from "../lib/runner/sprites-baseline";
import { prepareSpriteDependencies } from "../lib/worker-runtime/dependencies";
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
    writeFileSync(join(src, ".gitignore"), "node_modules/\ndist/\n.sprite-*-fingerprint\n.sprite-dependency-manifest.json\n");
    writeFileSync(join(src, "package.json"), '{"name":"fixture"}');
    writeFileSync(join(src, "package-lock.json"), '{"lockfileVersion":3,"packages":{"":{"name":"fixture"}}}');
    git(["add", "."], src);
    git(["commit", "-q", "-m", "init"], src);
    git(["checkout", "-q", "-b", "release"], src);
    writeFileSync(join(src, "RELEASE.md"), "release\n");
    git(["add", "."], src);
    git(["commit", "-q", "-m", "release base"], src);
    git(["checkout", "-q", "main"], src);
    remote = join(dir, "remote.git");
    git(["clone", "-q", "--bare", src, remote], dir);
    for (const k of ["SESSION_ROOT", "REPO_CACHE_DIR", "TASK_ORCH_RUNNER_REPO_PATH", "TASK_ORCH_GIT_CLONE_DEPTH",
      "TASK_ORCH_SPRITE_RUN_WORKTREE", "TASK_ORCH_SPRITE_BASELINE_CHECKOUT", "TASK_ORCH_SPRITE_DEPENDENCY_REUSE",
      "TASK_ORCH_SPRITE_DEPENDENCY_FINGERPRINT"]) savedEnv[k] = process.env[k];
    process.env.SESSION_ROOT = join(dir, "session");
    delete process.env.REPO_CACHE_DIR;
    delete process.env.TASK_ORCH_RUNNER_REPO_PATH;
    delete process.env.TASK_ORCH_SPRITE_RUN_WORKTREE;
    delete process.env.TASK_ORCH_SPRITE_BASELINE_CHECKOUT;
    delete process.env.TASK_ORCH_SPRITE_DEPENDENCY_REUSE;
    delete process.env.TASK_ORCH_SPRITE_DEPENDENCY_FINGERPRINT;
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

  it("uses the persisted base branch when creating a detached task checkout", async () => {
    const start = makeStart({ run: { cwdStrategy: "worktree", taskId: "T-10", baseBranch: "release" }, task: { id: "T-10" } as never, repository: { remote } });
    const prepared = await prepareWorkerCwd(start);
    expect(git(["rev-parse", "HEAD"], prepared.cwd).trim()).toBe(git(["rev-parse", "release"], join(dir, "src")).trim());
  });

  it("fails with a clear error when the repository has no clonable remote", async () => {
    await expect(prepareWorkerCwd(makeStart({ repository: { remote: null } }))).rejects.toThrow(/no clonable remote/);
  });

  function enableReusableBaseline(runId = 42): string {
    const baseline = join(dir, "session", "repo");
    execFileSync("git", ["clone", "-q", remote, baseline]);
    git(["checkout", "-q", "--detach", "HEAD"], baseline);
    mkdirSync(join(baseline, "node_modules"), { recursive: true });
    mkdirSync(join(baseline, "dist"));
    writeFileSync(join(baseline, "node_modules", "prepared.txt"), "baseline dependency\n");
    writeFileSync(join(baseline, "dist", "prepared.js"), "built output\n");
    writeFileSync(join(baseline, ".sprite-dependency-fingerprint"), "dependency-fingerprint");
    writeFileSync(join(baseline, ".sprite-dependency-manifest.json"), '{"fingerprint":"dependency-fingerprint"}');
    writeFileSync(join(baseline, ".sprite-build-fingerprint"), "build-fingerprint");
    writeFileSync(join(baseline, "README.md"), "dirty baseline source\n");
    process.env.TASK_ORCH_SPRITE_RUN_WORKTREE = "1";
    process.env.TASK_ORCH_SPRITE_BASELINE_CHECKOUT = baseline;
    process.env.SESSION_ROOT = join(dir, "session", "runs", String(runId));
    return baseline;
  }

  it("moves the restored baseline into a private run worktree and resets tracked preparation changes", async () => {
    const baseline = enableReusableBaseline();
    const prepared = await prepareWorkerCwd(makeStart({
      run: { cwdStrategy: "worktree", taskId: "T-21" },
      task: { id: "T-21", branch: "claude/t-21" } as never,
      repository: { remote },
    }));

    expect(prepared.cwd).toBe(join(dir, "session", "runs", "42", "repo"));
    expect(existsSync(baseline)).toBe(false);
    expect(readFileSync(join(prepared.cwd, "README.md"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(prepared.cwd, "dist", "prepared.js"), "utf8")).toBe("built output\n");
    expect(readFileSync(join(prepared.cwd, ".sprite-build-fingerprint"), "utf8")).toBe("build-fingerprint");
    const runDependency = join(prepared.cwd, "node_modules", "prepared.txt");
    expect(statSync(runDependency).nlink).toBe(1);
    writeFileSync(runDependency, "run mutation\n");
    expect(readFileSync(runDependency, "utf8")).toBe("run mutation\n");

    writeFileSync(join(prepared.cwd, "same-run.txt"), "preserved\n");
    const restarted = await prepareWorkerCwd(makeStart({
      run: { cwdStrategy: "worktree", taskId: "T-21", branch: "claude/t-21", worktreePath: prepared.cwd },
      task: { id: "T-21", branch: "claude/t-21" } as never,
      repository: { remote },
    }));
    expect(restarted.cwd).toBe(prepared.cwd);
    expect(readFileSync(join(restarted.cwd, "same-run.txt"), "utf8")).toBe("preserved\n");
  });

  it("uses and reports a private branch for a reusable checkout even with repo strategy", async () => {
    enableReusableBaseline();
    const prepared = await prepareWorkerCwd(makeStart({
      run: { cwdStrategy: "repo" },
      repository: { remote },
    }));

    expect(prepared.branch).toBe("claude/chat-42");
    expect(prepared.worktreePath).toBe(prepared.cwd);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], prepared.cwd).trim()).toBe("claude/chat-42");
  });

  it("reuses moved dependency receipts for the unchanged baseline revision", async () => {
    const baseline = enableReusableBaseline();
    const sha256 = (path: string) => createHash("sha256").update(readFileSync(join(baseline, path))).digest("hex");
    const manifest: SpriteDependencyManifest = {
      repository: remote,
      revision: git(["rev-parse", "HEAD"], baseline).trim(),
      lockfile: { path: "package-lock.json", sha256: sha256("package-lock.json") },
      packageManifests: [{ path: "package.json", sha256: sha256("package.json") }],
      packageManager: "npm",
      packageManagerVersion: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
      installOptions: ["--no-audit"],
      reusePolicy: "inputs",
      npmConfig: null,
      installScriptInputs: [],
    };
    const fingerprint = dependencyFingerprint(manifest);
    writeFileSync(join(baseline, ".sprite-dependency-fingerprint"), fingerprint);
    writeFileSync(join(baseline, ".sprite-dependency-manifest.json"), JSON.stringify({ fingerprint }));
    const prepared = await prepareWorkerCwd(makeStart({ repository: { remote } }));
    process.env.TASK_ORCH_SPRITE_DEPENDENCY_REUSE = "1";
    process.env.TASK_ORCH_SPRITE_DEPENDENCY_FINGERPRINT = fingerprint;
    let installs = 0;

    expect(await prepareSpriteDependencies(prepared.cwd, {
      manifest,
      install: async () => { installs += 1; },
    })).toBe("reused");
    expect(installs).toBe(0);
  });

  it("uses distinct worktrees and branches for independent runs", async () => {
    enableReusableBaseline(42);
    const first = await prepareWorkerCwd(makeStart({
      run: { id: 42, cwdStrategy: "worktree", taskId: "T-22" },
      task: { id: "T-22", branch: "claude/t-22" } as never,
      repository: { remote },
    }));
    const firstPath = first.cwd;
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], firstPath).trim()).toBe("claude/t-22");
    rmSync(join(dir, "session", "runs", "42"), { recursive: true, force: true });
    const baseline = enableReusableBaseline(43);
    const second = await prepareWorkerCwd(makeStart({
      run: { id: 43, cwdStrategy: "worktree", taskId: "T-23" },
      task: { id: "T-23", branch: "claude/t-23" } as never,
      repository: { remote },
    }));

    expect(firstPath).not.toBe(second.cwd);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], second.cwd).trim()).toBe("claude/t-23");
    expect(existsSync(baseline)).toBe(false);
  });

  it("does not seed from a baseline unless the run-worktree flag is enabled", async () => {
    enableReusableBaseline();
    delete process.env.TASK_ORCH_SPRITE_RUN_WORKTREE;
    const prepared = await prepareWorkerCwd(makeStart({ repository: { remote } }));
    expect(existsSync(join(prepared.cwd, "node_modules", "prepared.txt"))).toBe(false);
  });

  it("rejects a run path equal to its baseline or scoped to another repository", async () => {
    const baseline = enableReusableBaseline();
    process.env.SESSION_ROOT = join(dir, "session");
    await expect(prepareWorkerCwd(makeStart({ repository: { remote } }))).rejects.toThrow("must differ");

    process.env.SESSION_ROOT = join(dir, "session", "runs", "42");
    await expect(prepareWorkerCwd(makeStart({ repository: { remote: join(dir, "other.git") } }))).rejects.toThrow("repository differs");
    expect(readFileSync(join(baseline, "README.md"), "utf8")).toBe("dirty baseline source\n");
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

  it("preserves recorded and task branches for reusable repo-strategy runs", () => {
    const before = process.env.TASK_ORCH_SPRITE_RUN_WORKTREE;
    process.env.TASK_ORCH_SPRITE_RUN_WORKTREE = "1";
    try {
      expect(workerBranchFor(makeStart({ run: { cwdStrategy: "repo", branch: "feat/recorded" } }), "main")).toBe("feat/recorded");
      expect(workerBranchFor(makeStart({ run: { cwdStrategy: "repo" }, task: { id: "T-2", branch: "claude/task-branch" } as never }), "main")).toBe("claude/task-branch");
      expect(workerBranchFor(makeStart({ run: { id: 9, cwdStrategy: "repo" } }), "main")).toBe("claude/chat-9");
    } finally {
      if (before === undefined) delete process.env.TASK_ORCH_SPRITE_RUN_WORKTREE;
      else process.env.TASK_ORCH_SPRITE_RUN_WORKTREE = before;
    }
  });
});
