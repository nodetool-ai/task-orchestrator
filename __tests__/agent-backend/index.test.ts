import { afterEach, describe, expect, it } from "vitest";
import {
  BACKEND_IDS,
  getBackend,
  resolveBackendId,
  resetBackendCache,
} from "../../lib/agent-backend";

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

  it("accepts pi, claude and codex case-insensitively", () => {
    expect(resolveBackendId("pi")).toBe("pi");
    expect(resolveBackendId("CLAUDE")).toBe("claude");
    expect(resolveBackendId(" claude ")).toBe("claude");
    expect(resolveBackendId("Codex")).toBe("codex");
  });

  it("throws on an unknown backend id", () => {
    expect(() => resolveBackendId("gpt")).toThrow(/Unknown agent backend/);
  });

  it("falls back to the deployment default on null (a run with no per-run pick)", () => {
    process.env.TASK_ORCH_AGENT_BACKEND = "claude";
    expect(resolveBackendId(null)).toBe("claude");
    delete process.env.TASK_ORCH_AGENT_BACKEND;
    expect(resolveBackendId(null)).toBe("pi");
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

  it("returns the codex backend when selected", async () => {
    resetBackendCache();
    process.env.TASK_ORCH_AGENT_BACKEND = "codex";
    const backend = await getBackend();
    expect(backend.id).toBe("codex");
  });

  it("serves every backend side by side for per-run selection", async () => {
    resetBackendCache();
    delete process.env.TASK_ORCH_AGENT_BACKEND;
    const pi = await getBackend("pi");
    const claude = await getBackend("claude");
    const codex = await getBackend("codex");
    expect(pi.id).toBe("pi");
    expect(claude.id).toBe("claude");
    expect(codex.id).toBe("codex");
    // Per-id caching: same instance on repeat, and the env default is not
    // clobbered by an earlier per-run override.
    expect(await getBackend("claude")).toBe(claude);
    expect(await getBackend("codex")).toBe(codex);
    expect((await getBackend(null)).id).toBe("pi");
  });

  it("lists every backend id it can construct", async () => {
    for (const id of BACKEND_IDS) {
      expect((await getBackend(id)).id).toBe(id);
    }
  });
});
