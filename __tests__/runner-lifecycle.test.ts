import { afterEach, describe, expect, it, vi } from "vitest";
import { nextSpritesLifecycleAction } from "../lib/runner/lifecycle";

const H = 3600_000;
const D = 24 * H;

afterEach(() => vi.unstubAllEnvs());

describe("nextSpritesLifecycleAction — sprites destroy-or-keep", () => {
  it("returns none for gone/creating/starting regardless of idle", () => {
    for (const state of ["gone", "creating", "starting"] as const) {
      expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "idle", runnerState: state, idleMs: 10 * D }).kind).toBe("none");
      expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "completed", runnerState: state, idleMs: 10 * D }).kind).toBe("none");
    }
  });

  it("returns none when the provider observes the worker alive", () => {
    expect(
      nextSpritesLifecycleAction({
        runStatus: "idle",
        runnerState: "running",
        idleMs: 10 * D,
        workerLive: true,
      }).kind,
    ).toBe("none");
    // Terminal run with live claim also spared
    expect(
      nextSpritesLifecycleAction({
        runStatus: "completed",
        runnerState: "running",
        idleMs: 10 * D,
        workerLive: true,
      }).kind,
    ).toBe("none");
  });

  it("destroys terminal non-conversational past 24h, keeps within window", () => {
    // Within window: none
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "completed", runnerState: "running", idleMs: D - 1000 }).kind).toBe("none");
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "failed", runnerState: "suspended", idleMs: D - 1000 }).kind).toBe("none");
    // Past window: destroy
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "completed", runnerState: "running", idleMs: D + 60_000 }).kind).toBe("destroy");
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "failed", runnerState: "suspended", idleMs: D }).kind).toBe("destroy");
    // cancelled/closed also terminal
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "cancelled", runnerState: "running", idleMs: D + 60_000 }).kind).toBe("destroy");
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "closed", runnerState: "running", idleMs: D + 60_000 }).kind).toBe("destroy");
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "budget_exhausted", runnerState: "running", idleMs: D + 60_000 }).kind).toBe("destroy");
  });

  it("honors TASK_ORCH_RUNNER_TERMINAL_MS override for sprites", () => {
    vi.stubEnv("TASK_ORCH_RUNNER_TERMINAL_MS", String(2 * H));
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "completed", runnerState: "running", idleMs: H }).kind).toBe("none");
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "completed", runnerState: "running", idleMs: 3 * H }).kind).toBe("destroy");
  });

  it("returns none for active run statuses regardless of idle", () => {
    for (const status of ["pending", "preparing", "running"]) {
      expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: status, runnerState: "running", idleMs: 10 * D }).kind).toBe("none");
      expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: status, runnerState: "suspended", idleMs: 10 * D }).kind).toBe("none");
    }
  });

  it("destroys idle/parked past 7d, keeps within window", () => {
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "idle", runnerState: "running", idleMs: 7 * D - 1000 }).kind).toBe("none");
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "idle", runnerState: "suspended", idleMs: 7 * D }).kind).toBe("destroy");
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "parked", runnerState: "running", idleMs: 7 * D + 60_000 }).kind).toBe("destroy");
    // stopped state also destroys at 7d
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "idle", runnerState: "stopped", idleMs: 8 * D }).kind).toBe("destroy");
  });

  it("conversational terminal uses long 7d window, not terminal 24h", () => {
    // Within 24h but conversational: should NOT destroy (uses long window)
    expect(
      nextSpritesLifecycleAction({ workerLive: false, runStatus: "completed", runnerState: "running", idleMs: D + 60_000, goal: "<execute>" }).kind,
    ).toBe("none");
    // Within 7d still none
    expect(
      nextSpritesLifecycleAction({ workerLive: false, runStatus: "completed", runnerState: "running", idleMs: 6 * D, goal: "<execute>" }).kind,
    ).toBe("none");
    // Past 7d: destroy
    expect(
      nextSpritesLifecycleAction({ workerLive: false, runStatus: "completed", runnerState: "running", idleMs: 7 * D + 60_000, goal: "<execute>" }).kind,
    ).toBe("destroy");
    expect(
      nextSpritesLifecycleAction({ workerLive: false, runStatus: "budget_exhausted", runnerState: "suspended", idleMs: 8 * D, goal: "<execute>" }).kind,
    ).toBe("destroy");
  });

  it("honors TASK_ORCH_RUNNER_STOP_MS override for sprites", () => {
    vi.stubEnv("TASK_ORCH_RUNNER_STOP_MS", String(2 * D));
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "idle", runnerState: "running", idleMs: D }).kind).toBe("none");
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "idle", runnerState: "running", idleMs: 3 * D }).kind).toBe("destroy");
  });

  it("otherwise returns none", () => {
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "idle", runnerState: "running", idleMs: H }).kind).toBe("none");
    expect(nextSpritesLifecycleAction({ workerLive: false, runStatus: "parked", runnerState: "suspended", idleMs: D }).kind).toBe("none");
  });
});
