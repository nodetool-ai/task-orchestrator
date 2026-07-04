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

  // M15: a chat worker idle-waiting within TASK_ORCH_CHAT_IDLE_MS holds
  // worker_scope + a fresh heartbeat at runStatus='idle' — status alone looks
  // suspendable, but suspending it strands an in-flight message (the machine
  // freezes before it processes the NOTIFY and the claim is cleared) or, for a
  // plan-executor mid-turn, freezes a live turn and strips its claim.
  describe("live worker claim (M15)", () => {
    it("spares an idle run whose claim is live, regardless of status/idleMs", () => {
      const action = nextLifecycleAction({
        runStatus: "idle",
        runnerState: "running",
        idleMs: 2 * H,
        workerScope: "m1",
        heartbeatAt: new Date(),
      });
      expect(action.kind).toBe("none");
    });

    it("still suspends once the claim's heartbeat has gone stale", () => {
      // Past the 5-minute staleness window: the worker died/released the claim
      // without clearing worker_scope in time (or genuinely released it), so
      // this must NOT be treated as live.
      const action = nextLifecycleAction({
        runStatus: "idle",
        runnerState: "running",
        idleMs: 2 * H,
        workerScope: "m1",
        heartbeatAt: new Date(Date.now() - 6 * 60_000),
      });
      expect(action.kind).toBe("suspend");
    });

    it("treats an omitted workerScope/heartbeatAt as no claim (back-compat)", () => {
      // Callers that don't pass the new fields keep today's status-only policy.
      const action = nextLifecycleAction({ runStatus: "idle", runnerState: "running", idleMs: 2 * H });
      expect(action.kind).toBe("suspend");
    });
  });
});
