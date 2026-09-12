import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithTurnWatchdog } from "../lib/worker-runtime/turn-watchdog";

const MINUTE = 60_000;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function pendingTurn(options: { idleTimeoutMs?: number; hardTimeoutMs?: number; deadline?: string; diagnostics?: any } = {}) {
  const abort = new AbortController();
  const warning = vi.fn();
  let progress!: (activity: string) => void;
  let finish!: (value: string) => void;
  const result = runWithTurnWatchdog({
    abort, idleTimeoutMs: 30 * MINUTE, hardTimeoutMs: 0, onWarning: warning, ...options,
  }, (report) => {
    progress = report;
    return new Promise<string>(resolve => { finish = resolve; });
  }).catch(error => error as Error);
  return { abort, warning, result, progress: (label: string) => progress(label), finish: () => finish("done") };
}

describe("backend turn watchdog", () => {
  it("allows two hours of progressing work without a total-turn limit", async () => {
    const turn = pendingTurn();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      turn.progress("tool output");
    }
    expect(turn.abort.signal.aborted).toBe(false);
    expect(turn.warning).not.toHaveBeenCalled();
    turn.finish();
    expect(await turn.result).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("warns before interrupting silence and names the last observed activity", async () => {
    const turn = pendingTurn();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    turn.progress("Codex command_execution (item_5): started");
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(turn.warning).toHaveBeenCalledOnce();
    expect(turn.abort.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    const failure = await turn.result;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("no backend progress for 1800000ms");
    expect((failure as Error).message).toContain("item_5");
    expect(turn.abort.signal.reason).toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cap", "budget"])("enforces an explicit %s even while progress continues", async (kind) => {
    const turn = pendingTurn(kind === "cap"
      ? { hardTimeoutMs: 20 * MINUTE }
      : { hardTimeoutMs: 60 * MINUTE, deadline: new Date(Date.now() + 20 * MINUTE).toISOString() });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    turn.progress("model output");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect((await turn.result as Error).message).toContain("explicit wall-clock deadline");
    expect(turn.abort.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start the backend after an expired run budget", async () => {
    const operation = vi.fn();
    await expect(runWithTurnWatchdog({ abort: new AbortController(), idleTimeoutMs: 0, hardTimeoutMs: 0,
      deadline: new Date(Date.now() - 1).toISOString() }, operation)).rejects.toThrow("explicit wall-clock deadline");
    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancellation releases a stuck backend even with both watchdogs disabled", async () => {
    const turn = pendingTurn({ idleTimeoutMs: 0 });
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(turn.abort.signal.aborted).toBe(false);
    const cancel = new Error("operator cancelled");
    turn.abort.abort(cancel);
    expect(await turn.result).toBe(cancel);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("summarizes a never-settling invocation without treating diagnostics as progress", async () => {
    const emit = vi.fn();
    const diagnostics = {
      emit,
      snapshot: () => ({
        last_raw_event_type: "tool.started",
        last_meaningful_progress_reason: "tool started",
        open_tool_count: 1,
        open_tools: ["inv-1:Bash:item-1:0"],
        rss_bytes: 1024,
        cpu_time_delta_ms: 1,
        "channel.state": "connected",
      }),
    };
    const turn = pendingTurn({ idleTimeoutMs: MINUTE, diagnostics });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(emit).toHaveBeenCalledWith("backend.progress", expect.objectContaining({
      last_raw_event_type: "tool.started",
      open_tool_count: 1,
      "watchdog.armed": true,
      "watchdog.fired": false,
      "watchdog.latest_reset": "initial arm",
      "watchdog.reset_count": 0,
    }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await turn.result).toBeInstanceOf(Error);
    expect(emit).toHaveBeenCalledWith("watchdog.expired", expect.objectContaining({
      "watchdog.fired": true,
      open_tool_count: 1,
    }));
  });

  it("clears warning and timeout state after recovery or normal errors", async () => {
    const turn = pendingTurn();
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    turn.progress("tool completed");
    turn.finish();
    expect(await turn.result).toBe("done");
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(turn.warning).toHaveBeenCalledOnce();
    expect(turn.abort.signal.aborted).toBe(false);
    await expect(runWithTurnWatchdog({ abort: new AbortController(), idleTimeoutMs: MINUTE, hardTimeoutMs: MINUTE },
      () => { throw new Error("backend failure"); })).rejects.toThrow("backend failure");
    expect(vi.getTimerCount()).toBe(0);
  });
});
