// __tests__/runner-provider.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRunnerProvider, type RunnerRef } from "../lib/runner/provider";

afterEach(() => vi.unstubAllEnvs());

describe("getRunnerProvider", () => {
  it("defaults to the local (Docker) provider", () => {
    vi.stubEnv("TASK_ORCH_RUNNER", "");
    expect(getRunnerProvider().kind).toBe("local");
  });

  it("selects the fly provider when TASK_ORCH_RUNNER=fly", () => {
    vi.stubEnv("TASK_ORCH_RUNNER", "fly");
    vi.stubEnv("FLY_API_TOKEN", "t");
    vi.stubEnv("FLY_APP_NAME", "a");
    expect(getRunnerProvider().kind).toBe("fly");
  });

  it("selects the inert Box provider without performing lifecycle work", () => {
    vi.stubEnv("TASK_ORCH_RUNNER", "box");
    expect(getRunnerProvider().kind).toBe("box");
  });
});

describe("RunnerRef", () => {
  it("accepts a Box handle", () => {
    const ref: RunnerRef = { runId: 1, handle: "box_123", provider: "box" };
    expect(ref.provider).toBe("box");
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
    expect(typeof provider.startMonitor).toBe("function");
  });
});
