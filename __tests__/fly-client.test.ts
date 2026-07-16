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

  it("attaches a bounded AbortSignal so a hung request can't stall forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const fly = makeFlyClient({ fetchImpl: fetchMock as unknown as typeof fetch, appName: "app", apiToken: "tok" });
    await fly.suspendMachine("m1");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces a fetch timeout as a clear FlyApiError instead of hanging", async () => {
    const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const fetchMock = vi.fn().mockRejectedValue(timeoutError);
    const fly = makeFlyClient({ fetchImpl: fetchMock as unknown as typeof fetch, appName: "app", apiToken: "tok" });
    await expect(fly.listMachines()).rejects.toThrow(/timed out/);
  });

  // Plan section 20 (Fly provisioning): the worker channel dial endpoint is
  // derived from the Machine's private 6PN IPv6, so the client must surface it.
  it("parses private_ip off a machine response into privateIp", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: "m1", state: "created", region: "ams", private_ip: "fdaa:0:1:a:1::1" }),
        { status: 200 }
      )
    );
    const fly = makeFlyClient({ fetchImpl: fetchMock as unknown as typeof fetch, appName: "app", apiToken: "tok" });
    const machine = await fly.getMachine("m1");
    expect(machine?.privateIp).toBe("fdaa:0:1:a:1::1");
  });

  it("leaves privateIp undefined when the response omits it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "m1", state: "created", region: "ams" }), { status: 200 })
    );
    const fly = makeFlyClient({ fetchImpl: fetchMock as unknown as typeof fetch, appName: "app", apiToken: "tok" });
    const machine = await fly.getMachine("m1");
    expect(machine?.privateIp).toBeUndefined();
  });
});
