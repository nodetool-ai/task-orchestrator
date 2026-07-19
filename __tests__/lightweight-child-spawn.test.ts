// __tests__/lightweight-child-spawn.test.ts
//
// The memory cap (TASK_ORCH_LIGHTWEIGHT_MEMORY_MB) must reach the spawned child as
// a V8 --max-old-space-size flag, and the child must inherit the full env
// (DATABASE_URL retained → db transport) WITHOUT the worker marker — it is the
// server tier relocated into a memory-capped child, not a credential-less worker.
//
// We mock only node:child_process.spawn (preserving every other export) so the
// launch is captured, never actually forked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

import { spawnLightweightChild } from "../lib/run-dispatch";

function fakeChild() {
  return { pid: 4242, on: vi.fn(), unref: vi.fn() };
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockReturnValue(fakeChild());
  delete process.env.TASK_ORCH_LIGHTWEIGHT_MEMORY_MB;
});

afterEach(() => {
  delete process.env.TASK_ORCH_LIGHTWEIGHT_MEMORY_MB;
});

describe("spawnLightweightChild", () => {
  it("passes the memory cap as --max-old-space-size and runs the DB-path entrypoint", () => {
    const pid = spawnLightweightChild(77, "run-77-abc");
    expect(pid).toBe(4242);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnMock.mock.calls[0] as [string, string[], Record<string, any>];
    expect(cmd).toBe(process.execPath); // node
    expect(args[0]).toBe("--max-old-space-size=512"); // default cap, before the tsx cli
    // The lightweight child stays on the control-plane DB path (driveDispatchedRun),
    // NOT the WebSocket worker entry — run-worker.ts would exit(2) with no channel
    // identity and the /runs chat would never reply.
    expect(args).toContain("scripts/run-lightweight-child.ts");
    expect(args).not.toContain("scripts/run-worker.ts");
    expect(args).toContain("77");
    expect(options.detached).toBe(true);
  });

  it("honors a custom TASK_ORCH_LIGHTWEIGHT_MEMORY_MB", () => {
    process.env.TASK_ORCH_LIGHTWEIGHT_MEMORY_MB = "256";
    spawnLightweightChild(1, "run-1-x");
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[0]).toBe("--max-old-space-size=256");
  });

  it("omits the heap flag when the cap is disabled (0)", () => {
    process.env.TASK_ORCH_LIGHTWEIGHT_MEMORY_MB = "0";
    spawnLightweightChild(1, "run-1-x");
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args.some((a) => a.startsWith("--max-old-space-size"))).toBe(false);
  });

  it("inherits DATABASE_URL and is NOT marked a worker", () => {
    process.env.DATABASE_URL = "postgres://x/y";
    spawnLightweightChild(1, "run-1-x");
    const [, , options] = spawnMock.mock.calls[0] as [string, string[], Record<string, any>];
    expect(options.env.DATABASE_URL).toBe("postgres://x/y"); // db transport path
    expect(options.env.TASK_ORCH_INSIDE_WORKER).toBeUndefined(); // not a worker
  });
});
