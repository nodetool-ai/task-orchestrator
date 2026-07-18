import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { environments } from "../db/schema";

vi.mock("../auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.com" } })) })); // resolves to the same module as the route's "@/auth" (vitest alias)
vi.mock("../lib/runner/box-template-builder", () => ({ runBoxTemplateBuild: vi.fn(async () => {}) }));
vi.mock("../lib/runner/docker-image-build", () => ({ runDockerImageBuild: vi.fn(async () => {}) }));
vi.mock("../lib/runner/box-client", () => ({ makeBoxClient: vi.fn(() => ({})) }));
vi.mock("../lib/api-tokens", () => ({
  verifyToken: vi.fn(async (t: string) => (t === "valid-ci-token" ? { id: 1, userId: 1 } : null)),
}));

import { POST } from "../app/api/environments/build/route";
import { auth } from "../auth";
import { runDockerImageBuild } from "../lib/runner/docker-image-build";
import { runBoxTemplateBuild } from "../lib/runner/box-template-builder";

afterEach(() => {
  delete process.env.TASK_ORCH_WORKER_SHA;
  delete process.env.BOX_API_KEY;
  vi.clearAllMocks();
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://test/api/environments/build", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
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
    process.env.BOX_API_KEY = "test-key";
    await db.insert(environments).values({ provider: "box", workerSha: "8".repeat(40), state: "ready", boxId: "bx_x", readyAt: new Date() });
    const res = await POST(post({ provider: "box" }));
    expect(res.status).toBe(409);
  });

  it("503s a box build when BOX_API_KEY is not configured (CI warm on a non-box deployment)", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "7".repeat(40);
    const res = await POST(post({ provider: "box" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/BOX_API_KEY/);
  });

  it("accepts a valid bearer API token without a session (the CI warm path)", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "6".repeat(40);
    process.env.BOX_API_KEY = "test-key";
    vi.mocked(auth).mockResolvedValueOnce(null as never); // no session — token must carry it
    const res = await POST(post({ provider: "box" }, { authorization: "Bearer valid-ci-token" }));
    expect(res.status).toBe(202);
    expect(runBoxTemplateBuild).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: null, workerSha: "6".repeat(40) })
    );
  });

  it("401s an invalid bearer token when there is no session", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    const res = await POST(post({ provider: "docker" }, { authorization: "Bearer nope" }));
    expect(res.status).toBe(401);
  });
});
