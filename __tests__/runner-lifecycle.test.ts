import { afterEach, describe, expect, it, vi } from "vitest";
import { nextLifecycleAction } from "../lib/runner/lifecycle";

const H = 3600_000;
const D = 24 * H;

afterEach(() => vi.unstubAllEnvs());

describe("nextLifecycleAction", () => {
  it("leaves a running agent alone", () => {
    expect(nextLifecycleAction({ runStatus: "running", runnerState: "running", idleMs: 5 * H }).kind).toBe("none");
  });

  it("suspends an idle-<24h resumable session", () => {
    expect(nextLifecycleAction({ runStatus: "idle", runnerState: "running", idleMs: 2 * H }).kind).toBe("suspend");
  });

  it("stops a 1–7 day idle session", () => {
    expect(nextLifecycleAction({ runStatus: "idle", runnerState: "suspended", idleMs: 3 * D }).kind).toBe("stop");
  });

  it("archives+destroys a >7 day idle session", () => {
    expect(nextLifecycleAction({ runStatus: "idle", runnerState: "stopped", idleMs: 8 * D }).kind).toBe("archive-and-destroy");
  });

  it("honors lifecycle threshold env overrides", () => {
    vi.stubEnv("TASK_ORCH_RUNNER_SUSPEND_MS", String(10 * H));
    vi.stubEnv("TASK_ORCH_RUNNER_STOP_MS", String(20 * H));
    expect(nextLifecycleAction({ runStatus: "idle", runnerState: "suspended", idleMs: 11 * H }).kind).toBe("stop");
    expect(nextLifecycleAction({ runStatus: "idle", runnerState: "stopped", idleMs: 21 * H }).kind).toBe("archive-and-destroy");
  });
});
