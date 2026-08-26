import { afterEach, describe, expect, it } from "vitest";
import { dockerContextSha, resetWorkerShaCache, workerBuildSha } from "../lib/runner/worker-sha";

afterEach(() => {
  delete process.env.TASK_ORCH_WORKER_SHA;
  delete process.env.TASK_ORCH_WORKER_REPO_URL;
  delete process.env.TASK_ORCH_WORKER_REPO_REF;
  resetWorkerShaCache();
});

describe("workerBuildSha", () => {
  it("prefers the TASK_ORCH_WORKER_SHA override", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "a".repeat(40);
    await expect(workerBuildSha()).resolves.toBe("a".repeat(40));
  });

  it("rejects a malformed override", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "not-a-sha";
    await expect(workerBuildSha()).rejects.toThrow(/TASK_ORCH_WORKER_SHA/);
  });

  it("resolves the tip of the remote worker ref via ls-remote, and caches it", async () => {
    process.env.TASK_ORCH_WORKER_REPO_URL = "https://example.com/repo.git";
    process.env.TASK_ORCH_WORKER_REPO_REF = "main";
    const sha = "b".repeat(40);
    const calls: string[][] = [];
    const first = await workerBuildSha({
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { stdout: `${sha}\trefs/heads/main\n` };
      },
    });
    expect(first).toBe(sha);
    expect(calls[0]).toEqual(["git", "ls-remote", "https://example.com/repo.git", "main"]);

    // Cached — a second call must not re-exec.
    const second = await workerBuildSha({
      exec: async () => {
        throw new Error("must not re-exec once cached");
      },
    });
    expect(second).toBe(sha);
  });

  it("throws an actionable error when the ref is not on the remote", async () => {
    await expect(
      workerBuildSha({ exec: async () => ({ stdout: "" }) })
    ).rejects.toThrow(/not found on|TASK_ORCH_WORKER_SHA/);
  });

  it("throws a clear error when git/ls-remote fails", async () => {
    await expect(
      workerBuildSha({ exec: async () => { throw new Error("git: not found"); } })
    ).rejects.toThrow(/TASK_ORCH_WORKER_SHA|worker build SHA/);
  });
});

describe("dockerContextSha", () => {
  it("prefers the TASK_ORCH_WORKER_SHA override", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "c".repeat(40);
    await expect(
      dockerContextSha({ exec: async () => { throw new Error("must not exec with override"); } })
    ).resolves.toBe("c".repeat(40));
  });

  it("resolves the local build-context HEAD, not the remote ref", async () => {
    const sha = "d".repeat(40);
    const calls: string[][] = [];
    const got = await dockerContextSha({
      cwd: "/build/ctx",
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { stdout: `${sha}\n` };
      },
    });
    expect(got).toBe(sha);
    expect(calls[0]).toEqual(["git", "-C", "/build/ctx", "rev-parse", "HEAD"]);
  });

  it("throws an actionable error when the context is not a git checkout", async () => {
    await expect(
      dockerContextSha({ exec: async () => { throw new Error("not a git repository"); } })
    ).rejects.toThrow(/Docker build context SHA|TASK_ORCH_WORKER_SHA/);
  });
});
