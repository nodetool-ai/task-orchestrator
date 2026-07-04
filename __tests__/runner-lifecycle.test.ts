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

  // A terminal run (completed/failed/cancelled/closed/budget_exhausted) never
  // resumes, so its volume gets only the short TASK_ORCH_RUNNER_TERMINAL_MS
  // window (default 1h) before archive+destroy — no 7d wait.
  describe("terminal runs", () => {
    it("archives+destroys a completed run past the 1h window", () => {
      expect(
        nextLifecycleAction({ runStatus: "completed", runnerState: "running", idleMs: H + 60_000 }).kind,
      ).toBe("archive-and-destroy");
    });

    it("archives+destroys every terminal status past the window", () => {
      for (const status of ["completed", "failed", "cancelled", "closed", "budget_exhausted"]) {
        expect(
          nextLifecycleAction({ runStatus: status, runnerState: "running", idleMs: H + 60_000 }).kind,
        ).toBe("archive-and-destroy");
      }
    });

    it("archives+destroys a stopped terminal run past the window without waiting 7d", () => {
      // Previously a stopped machine waited TASK_ORCH_RUNNER_STOP_MS (7d); a
      // terminal run only waits the short window.
      expect(
        nextLifecycleAction({ runStatus: "completed", runnerState: "stopped", idleMs: H + 60_000 }).kind,
      ).toBe("archive-and-destroy");
    });

    it("suspends a running terminal run within the window", () => {
      expect(
        nextLifecycleAction({ runStatus: "completed", runnerState: "running", idleMs: 10 * 60_000 }).kind,
      ).toBe("suspend");
    });

    it("leaves a stopped/suspended terminal run within the window alone", () => {
      expect(
        nextLifecycleAction({ runStatus: "completed", runnerState: "stopped", idleMs: 10 * 60_000 }).kind,
      ).toBe("none");
      expect(
        nextLifecycleAction({ runStatus: "completed", runnerState: "suspended", idleMs: 10 * 60_000 }).kind,
      ).toBe("none");
    });

    it("keeps the long window for an idle/resumable run at the same idleMs", () => {
      // idle is NOT terminal: at 2h it is still suspend/stop per the old
      // windows, NOT destroyed.
      expect(nextLifecycleAction({ runStatus: "idle", runnerState: "running", idleMs: 2 * H }).kind).toBe("suspend");
      expect(nextLifecycleAction({ runStatus: "idle", runnerState: "stopped", idleMs: 2 * H }).kind).toBe("none");
    });

    it("honors the TASK_ORCH_RUNNER_TERMINAL_MS override", () => {
      vi.stubEnv("TASK_ORCH_RUNNER_TERMINAL_MS", String(3 * H));
      // 2h is now within the (3h) window: running → suspend, stopped → none.
      expect(nextLifecycleAction({ runStatus: "completed", runnerState: "running", idleMs: 2 * H }).kind).toBe("suspend");
      expect(nextLifecycleAction({ runStatus: "completed", runnerState: "stopped", idleMs: 2 * H }).kind).toBe("none");
      // Past 3h → archive-and-destroy.
      expect(
        nextLifecycleAction({ runStatus: "completed", runnerState: "running", idleMs: 3 * H + 60_000 }).kind,
      ).toBe("archive-and-destroy");
    });

    it("never touches a terminal run whose worker claim is still live", () => {
      const action = nextLifecycleAction({
        runStatus: "completed",
        runnerState: "running",
        idleMs: 2 * H,
        workerScope: "m1",
        heartbeatAt: new Date(),
      });
      expect(action.kind).toBe("none");
    });
  });
});
