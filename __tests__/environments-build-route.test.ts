import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { environments } from "../db/schema";

vi.mock("../auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.com" } })) })); // resolves to the same module as the route's "@/auth" (vitest alias)
vi.mock("../lib/runner/box-template-builder", () => ({ runBoxTemplateBuild: vi.fn(async () => {}) }));
vi.mock("../lib/runner/docker-image-build", () => ({ runDockerImageBuild: vi.fn(async () => {}) }));
vi.mock("../lib/runner/box-client", () => ({ makeBoxClient: vi.fn(() => ({})) }));

import { POST } from "../app/api/environments/build/route";
import { runDockerImageBuild } from "../lib/runner/docker-image-build";

afterEach(() => {
  delete process.env.TASK_ORCH_WORKER_SHA;
  vi.clearAllMocks();
});

function post(body: unknown): Request {
  return new Request("http://test/api/environments/build", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/environments/build", () => {
  it("rejects unknown providers", async () => {
    const res = await POST(post({ provider: "fly" }));
    expect(res.status).toBe(400);
  });

  it("inserts a building row and kicks the docker build", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "9".repeat(40);
    const res = await POST(post({ provider: "docker" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.state).toBe("building");
    expect(runDockerImageBuild).toHaveBeenCalledWith(expect.objectContaining({ environmentId: body.id }));
  });

  it("409s when a live row exists for the provider+sha", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "8".repeat(40);
    await db.insert(environments).values({ provider: "box", workerSha: "8".repeat(40), state: "ready", boxId: "bx_x", readyAt: new Date() });
    const res = await POST(post({ provider: "box" }));
    expect(res.status).toBe(409);
  });
});
