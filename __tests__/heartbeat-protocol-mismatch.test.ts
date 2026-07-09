import { afterEach, describe, expect, it, vi } from "vitest";
import { __heartbeatTest } from "../lib/runs";
import * as worker from "../lib/worker";

function protocolMismatch(): Error {
  const err = new Error("worker protocol is stale");
  err.name = "ProtocolMismatchError";
  return err;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("heartbeat protocol mismatch handling", () => {
  it("surfaces a protocol mismatch from the plain heartbeat wrapper", async () => {
    vi.useFakeTimers();
    const mismatch = protocolMismatch();
    const heartbeat = vi.fn().mockRejectedValue(mismatch);
    vi.spyOn(worker, "runTransport").mockResolvedValue({ heartbeat } as never);
    const fatal = vi.fn();

    const timer = __heartbeatTest.startHeartbeat(17, fatal);
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledWith(mismatch));
    clearInterval(timer);
  });

  it("aborts and surfaces a protocol mismatch from the cancel-aware wrapper", async () => {
    vi.useFakeTimers();
    const mismatch = protocolMismatch();
    const heartbeat = vi.fn().mockRejectedValue(mismatch);
    vi.spyOn(worker, "runTransport").mockResolvedValue({ heartbeat } as never);
    const abort = new AbortController();
    const fatal = vi.fn();

    const timer = __heartbeatTest.startHeartbeatWithCancel(18, abort, fatal);
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledWith(mismatch));
    expect(abort.signal.aborted).toBe(true);
    expect(abort.signal.reason).toBe(mismatch);
    clearInterval(timer);
  });

  it("continues to tolerate generic heartbeat failures", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn().mockRejectedValue(new Error("temporary outage"));
    vi.spyOn(worker, "runTransport").mockResolvedValue({ heartbeat } as never);
    const abort = new AbortController();
    const fatal = vi.fn();

    const plain = __heartbeatTest.startHeartbeat(19, fatal);
    const cancelAware = __heartbeatTest.startHeartbeatWithCancel(20, abort, fatal);
    await vi.advanceTimersByTimeAsync(1);

    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(abort.signal.aborted).toBe(false);
    expect(fatal).not.toHaveBeenCalled();
    clearInterval(plain);
    clearInterval(cancelAware);
  });
});
