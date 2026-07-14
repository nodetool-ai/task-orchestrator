import { describe, expect, it } from "vitest";
import { boxStateToRunnerState, waitForBoxCheckpoint, waitForBoxReady } from "../lib/runner/box-waiters";
import type { BoxClient } from "../lib/runner/box-client";

function client(states: string[], snapshotAt?: Date): BoxClient {
  let index = 0;
  return {
    limits: async () => ({ canStart: true, activeBoxes: 0, maxActiveBoxes: 1 }), boxes: async () => ({ boxes: [] }),
    get: async (id) => ({ id, state: states[Math.min(index++, states.length - 1)], lastSnapshotStatus: "completed", snapshotCompletedAt: snapshotAt }),
    update: async (id) => ({ id, state: "ready" }), fork: async () => ({ id: "bx_fork", status: "ok" }),
    resume: async () => ({ id: "bx_1", status: "ok" }), stop: async () => ({ id: "bx_1", status: "ok" }), remove: async () => undefined,
    command: async () => ({ success: true, exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    getLatestBoxSnapshot: async () => ({ id: "snap_1", status: "completed", completedAt: snapshotAt }),
  };
}

const immediate = { pollMs: 0, sleep: async () => undefined };

describe("Box waiters", () => {
  it("maps Box states to normalized runner states", () => {
    expect(boxStateToRunnerState("provisioning")).toBe("starting");
    expect(boxStateToRunnerState("ready")).toBe("running");
    expect(boxStateToRunnerState("archived")).toBe("stopped");
    expect(boxStateToRunnerState("error")).toBe("starting");
  });
  it("waits for ready or idle only", async () => {
    await expect(waitForBoxReady(client(["cloning", "idle"]), "bx_1", immediate)).resolves.toMatchObject({ state: "idle" });
  });
  it("rejects a stale checkpoint snapshot", async () => {
    let now = 10;
    await expect(waitForBoxCheckpoint(client(["archived"], new Date(9)), "bx_1", 10, { ...immediate, timeoutMs: 0, now: () => now++ })).rejects.toThrow(/Timed out/);
  });
  it("requires the latest completed snapshot", async () => {
    await expect(waitForBoxCheckpoint(client(["archived"], new Date(10)), "bx_1", 10, immediate)).resolves.toMatchObject({ snapshot: { id: "snap_1" } });
  });
  it("retries when the snapshot index lags the archived Box record", async () => {
    const base = client(["archived"], new Date(10));
    let reads = 0;
    base.getLatestBoxSnapshot = async () => {
      reads += 1;
      return reads === 1 ? null : { id: "snap_1", status: "completed", completedAt: new Date(10) };
    };
    await expect(waitForBoxCheckpoint(base, "bx_1", 10, immediate)).resolves.toMatchObject({ snapshot: { id: "snap_1" } });
    expect(reads).toBe(2);
  });
});
