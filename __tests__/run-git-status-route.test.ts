import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  runGitStatus: vi.fn(),
}));
vi.mock("@/lib/runs", () => ({ get: mocks.get }));
vi.mock("@/lib/run-git-status", () => ({ runGitStatus: mocks.runGitStatus }));
vi.mock("@/lib/api-auth", () => ({ requireBearer: async () => null }));

import { GET } from "../app/api/runs/[id]/git-status/route";

const call = (id: string) =>
  GET(null as never, { params: Promise.resolve({ id }) });

describe("run git-status route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serves the snapshot for the run's checkout", async () => {
    const run = { id: 42, worktreePath: "/work/42" };
    mocks.get.mockResolvedValue(run);
    mocks.runGitStatus.mockResolvedValue({ available: true, committed: { files: [] } });

    const res = await call("42");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: true });
    expect(mocks.runGitStatus).toHaveBeenCalledWith(run);
  });

  it("404s an unknown run instead of inspecting anything", async () => {
    mocks.get.mockResolvedValue(null);
    expect((await call("42")).status).toBe(404);
    expect(mocks.runGitStatus).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric id", async () => {
    expect((await call("nope")).status).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
