import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { environments } from "../db/schema";
import { runDockerImageBuild, type DockerBuildApi } from "../lib/runner/docker-image-build";

afterEach(() => {
  delete process.env.TASK_ORCH_WORKER_IMAGE;
  vi.restoreAllMocks();
});

function fakeDocker(outcome: { error?: string; progress?: string[] } = {}): DockerBuildApi {
  return {
    buildImage: vi.fn(async () => ({}) as NodeJS.ReadableStream),
    modem: {
      followProgress: (_s, onFinished, onProgress) => {
        for (const line of outcome.progress ?? []) onProgress({ stream: line });
        if (outcome.error) onFinished(new Error(outcome.error), []);
        else onFinished(null, [{ stream: "Successfully built" }]);
      },
    },
  };
}

let seedCounter = 0;
async function seed(): Promise<number> {
  // Unique SHA per call: rows persist across tests in the fork's schema and the
  // live index forbids two building/ready rows for the same (provider, sha).
  const sha = (++seedCounter).toString(16).padStart(40, "f");
  const [row] = await db.insert(environments).values({ provider: "docker", workerSha: sha }).returning();
  return row.id;
}

describe("runDockerImageBuild", () => {
  it("builds Dockerfile.worker, tracks step detail, marks ready with the image", async () => {
    const id = await seed();
    const docker = fakeDocker({ progress: ["Step 3/12 : RUN npm ci\n"] });
    await runDockerImageBuild({ environmentId: id, image: "worker:test" }, { docker });
    expect(docker.buildImage).toHaveBeenCalledWith(expect.anything(), { t: "worker:test", dockerfile: "Dockerfile.worker" });
    const [row] = await db.select().from(environments).where(eq(environments.id, id));
    expect(row).toMatchObject({ state: "ready", image: "worker:test" });
  });

  it("marks failed with the build error", async () => {
    const id = await seed();
    await runDockerImageBuild({ environmentId: id, image: "worker:test" }, { docker: fakeDocker({ error: "COPY failed" }) });
    const [row] = await db.select().from(environments).where(eq(environments.id, id));
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/COPY failed/);
  });

  it("fails the row when no image tag is configured", async () => {
    const id = await seed();
    await runDockerImageBuild({ environmentId: id }, { docker: fakeDocker() });
    const [row] = await db.select().from(environments).where(eq(environments.id, id));
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/TASK_ORCH_WORKER_IMAGE/);
  });
});
