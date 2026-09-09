import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkerLog: vi.fn(),
  fetchContainerLog: vi.fn(),
  getServiceLogs: vi.fn(),
}));
vi.mock("@/lib/runs", () => ({ getWorkerLog: mocks.getWorkerLog }));
vi.mock("@/lib/run-dispatch", () => ({ fetchContainerLog: mocks.fetchContainerLog }));
vi.mock("@/lib/runner/sprites-client", () => ({
  makeSpritesClient: () => ({ getServiceLogs: mocks.getServiceLogs }),
}));
import { GET } from "../app/api/runs/[id]/worker-log/route";

const read = async () => (await GET(null as never, { params: Promise.resolve({ id: "42" }) })).json();

describe("worker log route", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    mocks.getWorkerLog.mockResolvedValue({
      log: null, exitCode: null, scope: null,
      provider: "sprites", spriteName: "to-run-42", serviceName: "worker-g3",
    });
  });

  it("reads the mapped Sprite generation even after the worker claim is released", async () => {
    mocks.getServiceLogs.mockResolvedValue("stdout\nstderr\n");
    expect(await read()).toEqual({ source: "live", log: "stdout\nstderr\n", exitCode: null });
    expect(mocks.getServiceLogs).toHaveBeenCalledWith("to-run-42", "worker-g3");
    expect(mocks.fetchContainerLog).not.toHaveBeenCalled();
  });

  it("bounds live output to the stored log tail limit", async () => {
    mocks.getServiceLogs.mockResolvedValue("x".repeat(70_000));
    expect((await read()).log).toHaveLength(64 * 1024);
  });

  it("keeps captured output when Sprite logs are empty", async () => {
    const stored = await mocks.getWorkerLog();
    mocks.getWorkerLog.mockResolvedValue({ ...stored, log: "captured" });
    mocks.getServiceLogs.mockResolvedValue("");
    expect(await read()).toMatchObject({ source: "stored", log: "captured" });
  });

  it("reports Sprite API failures while preserving captured output", async () => {
    const stored = await mocks.getWorkerLog();
    mocks.getWorkerLog.mockResolvedValue({ ...stored, log: "captured" });
    mocks.getServiceLogs.mockRejectedValue(new Error("unavailable"));
    expect(await read()).toMatchObject({ source: "stored", log: "captured", error: expect.stringContaining("Sprite") });
    expect(mocks.fetchContainerLog).not.toHaveBeenCalled();
  });

  it("reports an API failure instead of silently presenting an empty log", async () => {
    mocks.getServiceLogs.mockRejectedValue(new Error("unavailable"));
    expect(await read()).toMatchObject({ source: null, log: "", error: expect.stringContaining("Sprite") });
  });

  it("continues to read Docker output for local workers", async () => {
    mocks.getWorkerLog.mockResolvedValue({ log: null, exitCode: null, scope: "container-42", provider: "local" });
    mocks.fetchContainerLog.mockResolvedValue("docker output");
    expect(await read()).toEqual({ source: "live", log: "docker output", exitCode: null });
    expect(mocks.getServiceLogs).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown run", async () => {
    mocks.getWorkerLog.mockResolvedValue(null);
    const response = await GET(null as never, { params: Promise.resolve({ id: "42" }) });
    expect(response.status).toBe(404);
  });
});
