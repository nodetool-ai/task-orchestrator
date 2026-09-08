import { describe, expect, it } from "vitest";
import { executeInThread } from "../lib/codeact/thread";
import { loadPackagedWasm } from "../lib/codeact/quickjs-variant";
import { evaluateGuest } from "../lib/codeact/evaluate";

// The dedicated-thread CodeAct prototype (plan P-2026-09-07-codeact-migration,
// "Runtime decision"). Each `it` pins one required property: fresh
// runtime/context, explicit promise-job pumping, enforced limits, deterministic
// disposal, and external termination.
describe("CodeAct dedicated-thread runtime", () => {
  it("runs an async guest body with top-level await and return (promise pumping)", async () => {
    const result = await executeInThread({
      code: "const a = await Promise.resolve(2); const b = await Promise.resolve(40); return a + b;",
    });
    expect(result).toMatchObject({ status: "ok", value: 42 });
    // Both awaits required draining the guest job queue.
    if (result.status === "ok") expect(result.jobsExecuted).toBeGreaterThan(0);
  });

  it("returns a structured error for a guest throw without crashing the host", async () => {
    const result = await executeInThread({ code: "throw new Error('boom');" });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.message).toBe("boom");
  });

  it("enforces the soft in-guest deadline via the interrupt callback", async () => {
    const result = await executeInThread({
      code: "while (true) {}",
      limits: { guestDeadlineMs: 150, hardDeadlineMs: 5000 },
    });
    expect(result.status).toBe("timeout");
  });

  it("externally terminates a thread the interrupt cannot reach", async () => {
    // guestDeadline far in the future so the in-guest interrupt never fires;
    // only the host's Worker.terminate against the hard deadline can stop it.
    const result = await executeInThread({
      code: "while (true) {}",
      limits: { guestDeadlineMs: 60_000, hardDeadlineMs: 400 },
    });
    expect(result.status).toBe("terminated");
  });

  it("exposes no host globals to the guest (WASM isolation)", async () => {
    const result = await executeInThread({
      code: "return [typeof process, typeof require, typeof fetch, typeof globalThis.Worker].join(',');",
    });
    expect(result).toMatchObject({
      status: "ok",
      value: "undefined,undefined,undefined,undefined",
    });
  });

  it("gives each execution a fresh runtime/context with no shared state", async () => {
    // If runtimes/heaps were reused, a global set by the first would leak into
    // the second. A fresh context per execution means it must be undefined.
    const first = await executeInThread({ code: "globalThis.__leak = 'seen'; return globalThis.__leak;" });
    expect(first).toMatchObject({ status: "ok", value: "seen" });
    const second = await executeInThread({ code: "return typeof globalThis.__leak;" });
    expect(second).toMatchObject({ status: "ok", value: "undefined" });
  });

  it("disposes deterministically across many sequential executions", async () => {
    // Reuse the immutable WASM bytes; a disposal leak would surface as a hang or
    // OOM well before 25 iterations complete.
    const wasmBinary = await loadPackagedWasm();
    for (let i = 0; i < 25; i++) {
      const outcome = await evaluateGuest({ code: `return ${i} * 2;`, wasmBinary });
      expect(outcome).toMatchObject({ status: "ok", value: i * 2 });
    }
  });

  it("enforces the runtime memory limit", async () => {
    // Allocate past a tiny heap ceiling; QuickJS raises rather than growing.
    const result = await executeInThread({
      code: "const a = []; for (let i = 0; i < 1e7; i++) a.push(i); return a.length;",
      limits: { memoryBytes: 1024 * 1024, guestDeadlineMs: 3000, hardDeadlineMs: 6000 },
    });
    expect(result.status).not.toBe("ok");
  });
});
