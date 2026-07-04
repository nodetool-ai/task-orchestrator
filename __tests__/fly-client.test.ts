import { afterEach, describe, expect, it, vi } from "vitest";
import { FlyApiError, makeFlyClient } from "../lib/runner/fly-client";

afterEach(() => vi.unstubAllEnvs());

describe("makeFlyClient", () => {
  it("POSTs a machine create to the app-scoped path with bearer auth", async () => {
    vi.stubEnv("FLY_API_TOKEN", "tok");
    vi.stubEnv("FLY_APP_NAME", "myapp");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "m1", state: "created", region: "ams" }), { status: 200 })
    );
    const fly = makeFlyClient(fetchMock as unknown as typeof fetch);
    const machine = await fly.createMachine({
      name: "run-1",
      region: "ams",
      config: {
        image: "img",
        env: {},
        mounts: [{ volume: "v1", path: "/mnt/session" }],
        guest: { cpu_kind: "shared", cpus: 2, memory_mb: 4096 },
      },
    });

    expect(machine).toMatchObject({ id: "m1", state: "created", region: "ams" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.machines.dev/v1/apps/myapp/machines");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "run-1", region: "ams" });
  });

  it("prefers TASK_ORCH_FLY_APP over the Fly-reserved FLY_APP_NAME", async () => {
    // On Fly, FLY_APP_NAME is force-injected with the web Machine's own app name,
    // so the runner app name must come from TASK_ORCH_FLY_APP and win.
    vi.stubEnv("FLY_API_TOKEN", "tok");
    vi.stubEnv("FLY_APP_NAME", "task-orchestrator");
    vi.stubEnv("TASK_ORCH_FLY_APP", "task-orchestrator-runners");
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    const fly = makeFlyClient(fetchMock as unknown as typeof fetch);
    await fly.listMachines();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.machines.dev/v1/apps/task-orchestrator-runners/machines");
  });

  it("POSTs suspend and accepts empty success bodies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const fly = makeFlyClient({ fetchImpl: fetchMock as unknown as typeof fetch, appName: "app", apiToken: "tok" });
    await fly.suspendMachine("m1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.machines.dev/v1/apps/app/machines/m1/suspend");
    expect(init.method).toBe("POST");
  });

  it("turns getMachine 404 into null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    const fly = makeFlyClient({ fetchImpl: fetchMock as unknown as typeof fetch, appName: "app", apiToken: "tok" });
    await expect(fly.getMachine("missing")).resolves.toBeNull();
  });

  it("throws FlyApiError with response body on non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad", { status: 500 }));
    const fly = makeFlyClient({ fetchImpl: fetchMock as unknown as typeof fetch, appName: "app", apiToken: "tok" });
    await expect(fly.listMachines()).rejects.toBeInstanceOf(FlyApiError);
  });
});
