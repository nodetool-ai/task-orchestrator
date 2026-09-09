import { describe, expect, it, vi } from "vitest";
import { SpritePoolManager, type SpritePoolStore } from "@/lib/runner/sprites-pool";

function store(overrides: Partial<SpritePoolStore> = {}): SpritePoolStore {
  return {
    countCapacity: vi.fn(async () => ({ total: 0, preparing: 0, ready: 0 })),
    reservePreparation: vi.fn(async (input) => ({ id: "r1", fingerprint: input.fingerprint, leaseToken: "lease" })),
    completePreparation: vi.fn(async () => undefined),
    failPreparation: vi.fn(async () => undefined),
    listUnused: vi.fn(async () => []),
    markDraining: vi.fn(async () => true),
    reconcile: vi.fn(async () => ({ expired: [], deletions: [] })),
    ...overrides,
  };
}

describe("SpritePoolManager", () => {
  it("is disabled by default when the target is zero", async () => {
    const s = store();
    const refill = vi.fn();
    await new SpritePoolManager({ store: s, target: 0, requestRefill: refill }).requestRefill();
    expect(refill).not.toHaveBeenCalled();
    expect(s.reservePreparation).not.toHaveBeenCalled();
  });

  it("reserves only bounded capacity and completes provider preparations", async () => {
    const s = store({
      countCapacity: vi.fn(async () => ({ total: 0, preparing: 0, ready: 0 })),
      reservePreparation: vi.fn()
        .mockResolvedValueOnce({ id: "r1", fingerprint: "generic", leaseToken: "a" })
        .mockResolvedValueOnce({ id: "r2", fingerprint: "generic", leaseToken: "b" })
        .mockResolvedValue(null),
    });
    const release: (() => void)[] = [];
    const refill = vi.fn(async () => {
      await new Promise<void>((resolve) => release.push(resolve));
      return { spriteName: "pool-1", checkpointId: "cp-1" };
    });
    const manager = new SpritePoolManager({ store: s, target: 4, maxConcurrent: 2, requestRefill: refill });
    const running = manager.requestRefill();
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    expect(manager.activeRefills).toBe(2);
    release.forEach((resolve) => resolve());
    await running;
    expect(s.completePreparation).toHaveBeenCalledTimes(2);
    expect(s.completePreparation).toHaveBeenCalledWith(expect.objectContaining({ reservationId: "r1", leaseToken: "a" }));
  });

  it("fences failed preparations and schedules retry with exponential backoff", async () => {
    const s = store();
    const refill = vi.fn(async () => { throw new Error("provider unavailable"); });
    const manager = new SpritePoolManager({ store: s, target: 1, requestRefill: refill, initialBackoffMs: 10 });
    await manager.requestRefill();
    expect(s.failPreparation).toHaveBeenCalledWith(expect.objectContaining({
      reservationId: "r1", leaseToken: "lease", reason: "provider unavailable", retryAt: expect.any(Number),
    }));
  });

  it("drains stale fingerprints before excess compatible entries", async () => {
    const s = store({
      listUnused: vi.fn(async () => [
        { id: "stale", spriteName: "s1", fingerprint: "old", state: "ready" as const },
        { id: "keep", spriteName: "s2", fingerprint: "current", state: "ready" as const },
        { id: "excess", spriteName: "s3", fingerprint: "current", state: "ready" as const },
      ]),
    });
    const manager = new SpritePoolManager({ store: s, target: 1, fingerprints: () => ["current"] });
    expect(await manager.drain()).toBe(2);
    expect(s.markDraining).toHaveBeenNthCalledWith(1, "stale");
    expect(s.markDraining).toHaveBeenNthCalledWith(2, "excess");
  });
});
