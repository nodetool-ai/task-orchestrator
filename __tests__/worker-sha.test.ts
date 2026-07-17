import { afterEach, describe, expect, it } from "vitest";
import { resetWorkerShaCache, workerBuildSha } from "../lib/runner/worker-sha";

afterEach(() => {
  delete process.env.TASK_ORCH_WORKER_SHA;
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

  it("falls back to git rev-parse HEAD and caches it", async () => {
    // The test process runs inside this repository, so git is available.
    const first = await workerBuildSha();
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    const second = await workerBuildSha({
      exec: async () => {
        throw new Error("must not re-exec once cached");
      },
    });
    expect(second).toBe(first);
  });

  it("throws a clear error when git is unavailable and no override is set", async () => {
    resetWorkerShaCache();
    await expect(
      workerBuildSha({ exec: async () => { throw new Error("git: not found"); } })
    ).rejects.toThrow(/TASK_ORCH_WORKER_SHA/);
  });
});
