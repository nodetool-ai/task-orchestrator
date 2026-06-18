import { afterEach, describe, expect, it } from "vitest";
import { getBackend, resolveBackendId, resetBackendCache } from "../../lib/agent-backend";

const ORIG = process.env.TASK_ORCH_AGENT_BACKEND;

afterEach(() => {
  if (ORIG === undefined) delete process.env.TASK_ORCH_AGENT_BACKEND;
  else process.env.TASK_ORCH_AGENT_BACKEND = ORIG;
  resetBackendCache();
});

describe("resolveBackendId", () => {
  it("defaults to pi when unset", () => {
    expect(resolveBackendId(undefined)).toBe("pi");
  });

  it("accepts pi and claude case-insensitively", () => {
    expect(resolveBackendId("pi")).toBe("pi");
    expect(resolveBackendId("CLAUDE")).toBe("claude");
    expect(resolveBackendId(" claude ")).toBe("claude");
  });

  it("throws on an unknown backend id", () => {
    expect(() => resolveBackendId("gpt")).toThrow(/Unknown TASK_ORCH_AGENT_BACKEND/);
  });
});

describe("getBackend", () => {
  it("returns the pi backend by default", async () => {
    resetBackendCache();
    delete process.env.TASK_ORCH_AGENT_BACKEND;
    const backend = await getBackend();
    expect(backend.id).toBe("pi");
  });

  it("returns the claude backend when selected", async () => {
    resetBackendCache();
    process.env.TASK_ORCH_AGENT_BACKEND = "claude";
    const backend = await getBackend();
    expect(backend.id).toBe("claude");
  });
});
