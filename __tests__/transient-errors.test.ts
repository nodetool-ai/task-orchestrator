import { describe, it, expect, vi } from "vitest";
import {
  isTransientNetworkError,
  installProcessSafetyNet,
} from "../lib/transient-errors";

describe("isTransientNetworkError", () => {
  it("flags a raw ECONNRESET socket error", () => {
    const err = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("flags postgres.js CONNECTION_CLOSED writes", () => {
    const err = new Error(
      "write CONNECTION_CLOSED task-orchestrator-db.flycast:5432"
    );
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("flags an error whose transient cause is nested", () => {
    const inner = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const outer = new Error("query failed");
    (outer as { cause?: unknown }).cause = inner;
    expect(isTransientNetworkError(outer)).toBe(true);
  });

  it("does NOT flag a real application/query error", () => {
    const err = Object.assign(new Error('column "app_doc" does not exist'), {
      code: "42703",
    });
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it("does NOT flag a plain Error or nullish values", () => {
    expect(isTransientNetworkError(new Error("boom"))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });

  it("terminates on a cyclic .errors graph instead of overflowing", () => {
    const err = new Error("aggregate") as Error & { errors: unknown[] };
    err.errors = [err]; // self-referential cycle via .errors
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it("still finds a transient error reachable through a cyclic .errors graph", () => {
    const transient = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const err = new Error("aggregate") as Error & { errors: unknown[] };
    err.errors = [err, transient]; // cycle plus a real transient leaf
    expect(isTransientNetworkError(err)).toBe(true);
  });
});

describe("installProcessSafetyNet", () => {
  it("swallows a transient unhandled rejection without calling onFatal", () => {
    const onFatal = vi.fn();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const dispose = installProcessSafetyNet({ onFatal, logger, label: "test" });
    try {
      const err = Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      });
      process.emit("unhandledRejection", err, Promise.reject(err).catch(() => {}));
      expect(onFatal).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledOnce();
    } finally {
      dispose();
    }
  });

  it("routes a genuinely fatal rejection to onFatal", () => {
    const onFatal = vi.fn();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const dispose = installProcessSafetyNet({ onFatal, logger, label: "test" });
    try {
      const err = new Error("real bug");
      process.emit("unhandledRejection", err, Promise.reject(err).catch(() => {}));
      expect(onFatal).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledOnce();
    } finally {
      dispose();
    }
  });
});
