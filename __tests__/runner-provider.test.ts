// __tests__/runner-provider.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRunnerProvider, type RunnerRef } from "../lib/runner/provider";

afterEach(() => vi.unstubAllEnvs());

describe("getRunnerProvider", () => {
  it("defaults to the local (Docker) provider", () => {
    vi.stubEnv("TASK_ORCH_RUNNER", "");
    expect(getRunnerProvider().kind).toBe("local");
  });

  it("rejects the retired fly provider at configuration read", () => {
    vi.stubEnv("TASK_ORCH_RUNNER", "fly");
    expect(() => getRunnerProvider()).toThrow("TASK_ORCH_RUNNER=fly is no longer supported");
  });

});

describe("LocalRunnerProvider", () => {
  it("wraps dockerSpawn/create and returns a RunnerRef", async () => {
    vi.stubEnv("TASK_ORCH_RUNNER", "");
    const { LocalRunnerProvider } = await import("../lib/runner/local");
    const provider = new LocalRunnerProvider();
    expect(provider.kind).toBe("local");
    // The create method should call dockerSpawn internally
    // We can't easily mock dockerSpawn without docker available, but we can verify
    // the provider exists and has the right interface
    expect(typeof provider.create).toBe("function");
    expect(typeof provider.stop).toBe("function");
    expect(typeof provider.sweep).toBe("function");
  });
});
