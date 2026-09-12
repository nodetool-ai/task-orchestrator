import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logSpritePhase, spriteLog, spriteWorkerLogContext } from "../lib/runner/sprites-log";
import { SpritePoolManager, type SpritePoolStore } from "../lib/runner/sprites-pool";

let lines: Record<string, unknown>[];
beforeEach(() => {
  lines = [];
  vi.stubEnv("TASK_ORCH_LOG_FORMAT", "json");
  vi.stubEnv("TASK_ORCH_LOG_LEVEL", "debug");
  const capture = (line: unknown) => { lines.push(JSON.parse(String(line))); };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Sprite lifecycle diagnostics", () => {
  it("filters runtime fields and respects severity settings", () => {
    spriteLog("test", { runId: 208, leaseToken: "secret", env: { TOKEN: "secret" }, command: "secret", durationMs: NaN } as never);
    expect(lines[0]).toMatchObject({ component: "sprites.lifecycle", event: "test", runId: 208 });
    expect(JSON.stringify(lines)).not.toContain("secret");
    expect(lines[0]).not.toHaveProperty("durationMs");
    vi.stubEnv("TASK_ORCH_LOG_LEVEL", "info");
    spriteLog("capacity", {}, "debug");
    expect(lines).toHaveLength(1);
  });

  it("times phases and preserves errors without exposing their bodies", async () => {
    expect(await logSpritePhase("restore", { runId: 208 }, async () => 42)).toBe(42);
    expect(lines.map(l => l.event)).toEqual(["sprites_phase_started", "sprites_phase_completed"]);
    expect(lines[1]).toMatchObject({ runId: 208, phase: "restore", durationMs: expect.any(Number), outcome: "success" });
    const error = Object.assign(new Error("Bearer super-secret"), { status: 503, body: "super-secret", code: "super-secret" });
    await expect(logSpritePhase("restore", { runId: 208 }, async () => { throw error; })).rejects.toBe(error);
    expect(lines.at(-1)).toMatchObject({ event: "sprites_phase_failed", level: "warn", errorKind: "provider", httpStatus: 503 });
    expect(JSON.stringify(lines)).not.toContain("super-secret");
  });

  it("reads run and generation correlation from the worker environment", () => {
    vi.stubEnv("RUN_ID", "208"); vi.stubEnv("TASK_ORCH_WORKER_GENERATION", "3");
    vi.stubEnv("TASK_ORCH_WORKER_INSTANCE_ID", "channel-3"); vi.stubEnv("TASK_ORCH_SPRITE_NAME", "pool-a");
    expect(spriteWorkerLogContext()).toEqual({ runId: 208, workerGeneration: 3, instanceId: "channel-3", spriteName: "pool-a" });
  });

  it.each([false, true])("reports readiness only after persistence succeeds (failure=%s)", async (fails) => {
    const s: SpritePoolStore = {
      countCapacity: async () => ({ total: 0, preparing: 0, ready: 0 }),
      reservePreparation: async () => ({ id: "entry-a", spriteName: "pool-a", fingerprint: "fp", leaseToken: "private-lease" }),
      renewPreparation: async () => true,
      completePreparation: async () => {
        expect(lines.some(l => l.event === "sprites_pool_ready")).toBe(false);
        if (fails) throw new Error("private-provider-body");
      },
      failPreparation: vi.fn(async () => undefined), listUnused: async () => [],
      markDraining: async () => true, reconcile: async () => ({ expired: [], deletions: [] }),
    };
    await new SpritePoolManager({ store: s, target: 1, requestRefill: async () => ({ spriteName: "pool-a", checkpointId: "cp-a" }) }).requestRefill();
    expect(lines.some(l => l.event === "sprites_pool_ready")).toBe(!fails);
    const event = lines.find(l => l.event === (fails ? "sprites_pool_preparation_failed" : "sprites_pool_ready"));
    expect(event).toMatchObject({ poolEntryId: "entry-a", spriteName: "pool-a", fingerprint: "fp", durationMs: expect.any(Number) });
    if (fails) expect(event).toMatchObject({ retryAt: expect.any(Number), retryDelayMs: expect.any(Number), attempt: 1 });
    expect(JSON.stringify(lines)).not.toMatch(/private-lease|private-provider-body/);
  });
});
