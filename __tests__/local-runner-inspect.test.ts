import { describe, expect, it, vi } from "vitest";

import { LocalRunnerProvider, __setLocalProcessForTests } from "../lib/runner/local";

describe("LocalRunnerProvider.inspect", () => {
  it("observes a Docker worker and classifies absence or an exited container", async () => {
    const docker = { getContainer: vi.fn(() => ({ inspect: vi.fn(async () => ({ Id: "sha", State: { Running: true, Pid: 77, StartedAt: "2026-08-27T10:00:00Z" } })) })) };
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    const provider = new LocalRunnerProvider({ docker: async () => docker as any });
    // No pid: the container worker is PID 1 in its own namespace, so the host pid is not comparable.
    await expect(provider.inspect("run-1")).resolves.toEqual({ status: "alive", incarnation: "sha#2026-08-27T10:00:00Z" });
    const exited = new LocalRunnerProvider({ docker: async () => ({ getContainer: () => ({ inspect: async () => ({ State: { Running: false, ExitCode: 143 } }) }) }) as any });
    await expect(exited.inspect("run-1")).resolves.toEqual({ status: "dead", detail: "exit 143" });
    const absent = new LocalRunnerProvider({ docker: async () => ({ getContainer: () => ({ inspect: async () => { throw { statusCode: 404 }; } }) }) as any });
    await expect(absent.inspect("run-1")).resolves.toEqual({ status: "dead" });
    vi.unstubAllEnvs();
  });

  it("uses the recorded detached-process pid and spawn time", async () => {
    __setLocalProcessForTests("run-2", { pid: 99, spawnedAt: "2026-08-27T10:00:00.000Z" });
    const provider = new LocalRunnerProvider({ kill: vi.fn() });
    await expect(provider.inspect("run-2")).resolves.toEqual({ status: "alive", incarnation: "99#2026-08-27T10:00:00.000Z", pid: 99 });
    const dead = new LocalRunnerProvider({ kill: () => { const error = Object.assign(new Error(), { code: "ESRCH" }); throw error; } });
    await expect(dead.inspect("run-2")).resolves.toEqual({ status: "dead" });
    __setLocalProcessForTests("run-2", undefined);
  });
});
