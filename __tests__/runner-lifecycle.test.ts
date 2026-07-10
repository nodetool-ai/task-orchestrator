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

  // Wake-intent lease (run-139 incident): resume() stamps wake_requested_at just
  // before telling Fly to start a machine; the booting worker has no heartbeat
  // yet, so without this the sweep sees "running machine, parked run, no live
  // claim" and suspends it mid-boot — the reaper then fails the run for the
  // heartbeat it never got to write. A fresh intent must be honored exactly like
  // a live worker claim; a stale one (worker never came up) must expire so the
  // cost policy resumes.
  describe("wake intent grace", () => {
    it("spares a parked run whose machine has a fresh wake intent (the run-139 race)", () => {
      const action = nextLifecycleAction({
        runStatus: "parked",
        runnerState: "running",
        idleMs: 2 * H,
        wakeRequestedAt: new Date(),
      });
      expect(action.kind).toBe("none");
    });

    it("spares an idle run with a fresh wake intent even with no claim", () => {
      const action = nextLifecycleAction({
        runStatus: "idle",
        runnerState: "running",
        idleMs: 2 * H,
        wakeRequestedAt: new Date(Date.now() - 30_000),
      });
      expect(action.kind).toBe("none");
    });

    it("resumes normal behavior once the intent has aged past the grace window", () => {
      // Default TASK_ORCH_RUNNER_WAKE_GRACE_MS is 120s; a 3-minute-old intent
      // means the worker never came up — do not shield the machine forever.
      const action = nextLifecycleAction({
        runStatus: "idle",
        runnerState: "running",
        idleMs: 2 * H,
        wakeRequestedAt: new Date(Date.now() - 3 * 60_000),
      });
      expect(action.kind).toBe("suspend");
    });

    it("honors the TASK_ORCH_RUNNER_WAKE_GRACE_MS override", () => {
      vi.stubEnv("TASK_ORCH_RUNNER_WAKE_GRACE_MS", String(10 * 60_000));
      const action = nextLifecycleAction({
        runStatus: "idle",
        runnerState: "running",
        idleMs: 2 * H,
        wakeRequestedAt: new Date(Date.now() - 3 * 60_000),
      });
      expect(action.kind).toBe("none");
    });

    it("treats a null/omitted intent as no intent (back-compat)", () => {
      const withNull = nextLifecycleAction({
        runStatus: "idle",
        runnerState: "running",
        idleMs: 2 * H,
        wakeRequestedAt: null,
      });
      expect(withNull.kind).toBe("suspend");
    });
  });

  // A terminal run (completed/failed/cancelled/closed/budget_exhausted) never
  // resumes on its own, but dispatchRun DOES re-claim completed/failed/
  // budget_exhausted for a follow-up turn or an operator restart — and that
  // restart needs the volume's warm checkout + unpushed work + SDK transcript.
  // So the volume gets the TASK_ORCH_RUNNER_TERMINAL_MS window (default 24h,
  // matching the idle suspend window) before archive+destroy, while compute is
  // still suspended immediately within the window. Incident: run 58's volume
  // was destroyed 1h after a failed turn, so its restart lost all its work.
  describe("terminal runs", () => {
    it("archives+destroys a completed run past the 24h window", () => {
      expect(
        nextLifecycleAction({ runStatus: "completed", runnerState: "running", idleMs: D + 60_000 }).kind,
      ).toBe("archive-and-destroy");
    });

    it("archives+destroys every terminal status past the window", () => {
      for (const status of ["completed", "failed", "cancelled", "closed", "budget_exhausted"]) {
        expect(
          nextLifecycleAction({ runStatus: status, runnerState: "running", idleMs: D + 60_000 }).kind,
        ).toBe("archive-and-destroy");
      }
    });

    it("archives+destroys a stopped terminal run past the window without waiting 7d", () => {
      // Previously a stopped machine waited TASK_ORCH_RUNNER_STOP_MS (7d); a
      // terminal run only waits the (shorter) terminal window.
      expect(
        nextLifecycleAction({ runStatus: "completed", runnerState: "stopped", idleMs: D + 60_000 }).kind,
      ).toBe("archive-and-destroy");
    });

    it("preserves a terminal run's volume for a same-day restart (1h after a failure)", () => {
      // Regression for run 58: a failed <implement> run is revivable, so its
      // volume must survive well past the 1h mark — long enough to restart.
      expect(
        nextLifecycleAction({ runStatus: "failed", runnerState: "suspended", idleMs: H + 60_000 }).kind,
      ).toBe("none");
      expect(
        nextLifecycleAction({ runStatus: "failed", runnerState: "stopped", idleMs: H + 60_000 }).kind,
      ).toBe("none");
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

  // A plan executor lands `completed` after EVERY turn but is conversational —
  // the operator steers it with follow-up messages. Its completed/failed/
  // budget_exhausted states must age through the LONG resumable windows (its
  // machine+volume hold the warm checkout and the SDK transcript), while
  // cancelled/closed remain hard-terminal.
  describe("conversational terminal runs (plan executor)", () => {
    it("keeps a completed executor's stopped machine past the 1h terminal window", () => {
      expect(
        nextLifecycleAction({
          runStatus: "completed",
          runnerState: "stopped",
          idleMs: 2 * H,
          goal: "<execute>",
        }).kind,
      ).toBe("none");
    });

    it("gives every revivable executor status the resumable ladder", () => {
      for (const status of ["completed", "failed", "budget_exhausted"]) {
        // 2h: stopped stays; running is suspended (cost control, fast resume).
        expect(
          nextLifecycleAction({ runStatus: status, runnerState: "stopped", idleMs: 2 * H, goal: "<execute>" }).kind,
        ).toBe("none");
        expect(
          nextLifecycleAction({ runStatus: status, runnerState: "running", idleMs: 2 * H, goal: "<execute>" }).kind,
        ).toBe("suspend");
        // 3d: suspended → stop. 8d: stopped → archive-and-destroy.
        expect(
          nextLifecycleAction({ runStatus: status, runnerState: "suspended", idleMs: 3 * D, goal: "<execute>" }).kind,
        ).toBe("stop");
        expect(
          nextLifecycleAction({ runStatus: status, runnerState: "stopped", idleMs: 8 * D, goal: "<execute>" }).kind,
        ).toBe("archive-and-destroy");
      }
    });

    it("still hard-reclaims a cancelled/closed executor after the terminal window", () => {
      // cancelled/closed are NOT revivable, so even an executor gets the terminal
      // window (not the long resumable window) and is destroyed once it elapses.
      for (const status of ["cancelled", "closed"]) {
        expect(
          nextLifecycleAction({ runStatus: status, runnerState: "stopped", idleMs: D + 60_000, goal: "<execute>" }).kind,
        ).toBe("archive-and-destroy");
      }
    });

    it("does not extend the window for completed non-executor runs", () => {
      // Past the 24h terminal window a completed non-executor run is destroyed —
      // it does NOT get the executor's long (7d) resumable window.
      for (const goal of [null, undefined, "<chat>", "implement task"]) {
        expect(
          nextLifecycleAction({ runStatus: "completed", runnerState: "stopped", idleMs: D + 60_000, goal }).kind,
        ).toBe("archive-and-destroy");
      }
    });
  });
});
