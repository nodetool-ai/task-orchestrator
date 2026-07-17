import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BOX_BASE_URL, makeBoxClient, type BoxClient } from "../lib/runner/box-client";

afterEach(() => vi.unstubAllEnvs());

describe("BoxClient boundary", () => {
  it("has a stable default base URL through the lazy config registry", () => {
    vi.stubEnv("TASK_ORCH_BOX_BASE_URL", "");
    expect(DEFAULT_BOX_BASE_URL).toBe("https://ascii.dev/api/box/v1");
  });

  it("maps only runner-relevant response fields and ignores SDK additions", async () => {
    const api = {
      limits: vi.fn().mockResolvedValue({
        canStart: true,
        activeBoxes: 2,
        maxActiveBoxes: 4,
        desktopUrl: "https://secret.example/?_token=not-for-logs",
      }),
      boxes: vi.fn().mockResolvedValue({
        boxes: [
          {
            id: "bx_1",
            state: "ready",
            snapshotCompletedAt: "2026-07-14T10:00:00.000Z",
            desktopUrl: "https://secret.example/?_token=not-for-logs",
            futureField: { ignored: true },
          },
        ],
        pageInfo: { nextCursor: "next", futureField: "ignored" },
      }),
      get: vi.fn(),
      update: vi.fn(),
      fork: vi.fn(),
      create: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(),
      command: vi.fn(),
      getLatestBoxSnapshot: vi.fn(),
    };
    const box = makeBoxClient({ api });

    await expect(box.limits()).resolves.toEqual({ canStart: true, activeBoxes: 2, maxActiveBoxes: 4 });
    const list = await box.boxes();
    expect(list).toEqual({
      boxes: [
        {
          id: "bx_1",
          state: "ready",
          snapshotCompletedAt: new Date("2026-07-14T10:00:00.000Z"),
        },
      ],
      nextCursor: "next",
    });
    expect(JSON.stringify(list)).not.toContain("_token");
  });

  it("can be replaced with a plain structural fake without SDK imports", async () => {
    const fake: BoxClient = {
      limits: async () => ({ canStart: true, activeBoxes: 0, maxActiveBoxes: 2 }),
      boxes: async () => ({ boxes: [] }),
      get: async (id) => ({ id, state: "ready" }),
      update: async (id) => ({ id, state: "ready" }),
      fork: async () => ({ id: "bx_2", status: "forking" }),
      create: async () => ({ id: "bx_2", state: "ready" }),
      resume: async () => ({ id: "bx_2", status: "resuming" }),
      stop: async () => ({ id: "bx_2", status: "archiving" }),
      remove: async () => undefined,
      command: async () => ({ success: true, exitCode: 0, stdout: "123", stderr: "", timedOut: false }),
      getLatestBoxSnapshot: async () => null,
    };

    await expect(fake.get("bx_1")).resolves.toEqual({ id: "bx_1", state: "ready" });
  });
});
