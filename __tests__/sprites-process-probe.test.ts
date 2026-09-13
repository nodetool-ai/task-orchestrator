import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SPRITE_PROCESS_PROBE } from "../lib/runner/sprites-process-probe";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function procFixture(state?: string, env = "TASK_ORCH_WORKER_INSTANCE_ID=wi_current\0TASK_ORCH_WORKER_GENERATION=2\0") {
  const root = await mkdtemp(join(tmpdir(), "sprite-proc-"));
  roots.push(root);
  await mkdir(join(root, "self"));
  await writeFile(join(root, "self", "stat"), "probe");
  if (state) {
    await mkdir(join(root, "1452"));
    await writeFile(join(root, "1452", "stat"), `1452 (worker (supervisor)) ${state} ${Array(18).fill("0").join(" ")} 12345\n`);
    await writeFile(join(root, "1452", "environ"), env);
  }
  return {
    root,
    probe() {
      const script = SPRITE_PROCESS_PROBE.replace('"/proc/self/stat"', JSON.stringify(join(root, "self", "stat")))
        .replace('"/proc/" + pid', `${JSON.stringify(root + "/")} + pid`)
        .replace('"/sys/fs/cgroup/task-orchestrator"', JSON.stringify(join(root, "cgroups")));
      const result = spawnSync("python3", ["-c", script, "1452", "wi_current", "2"], { encoding: "utf8", timeout: 5_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      return result.stdout.trim();
    },
  };
}

describe("Sprite procfs evidence", () => {
  it("confirms a running supervisor without depending on its executable name", async () => {
    expect((await procFixture("S")).probe()).toBe("task-orch-process-v1:alive");
  });
  it("proves the stale service PID is absent", async () => {
    expect((await procFixture()).probe()).toBe("task-orch-process-v1:missing");
  });
  it("detects PID reuse from identity without printing credentials", async () => {
    const fixture = await procFixture("S", "SECRET=never-print-this\0TASK_ORCH_WORKER_INSTANCE_ID=wi_other\0TASK_ORCH_WORKER_GENERATION=3\0");
    expect(fixture.probe()).toBe("task-orch-process-v1:replaced");
  });
  it.each(["0", "1", "malformed"])("gates a missing service PID on descendant cgroup population %s", async (populated) => {
    const fixture = await procFixture();
    const scope = join(fixture.root, "cgroups", "u1000", "wi_current");
    await mkdir(scope, { recursive: true });
    await writeFile(join(scope, "cgroup.events"), `populated ${populated}\nfrozen 0\n`);
    expect(fixture.probe()).toBe(`task-orch-process-v1:${populated === "0" ? "missing" : "unknown"}`);
  });
  it("does not let a new PID hide a retained old worker's descendants", async () => {
    const fixture = await procFixture("S", "TASK_ORCH_WORKER_INSTANCE_ID=wi_replacement\0TASK_ORCH_WORKER_GENERATION=3\0");
    const scope = join(fixture.root, "cgroups", "u1000", "wi_current");
    await mkdir(scope, { recursive: true });
    await writeFile(join(scope, "cgroup.events"), "populated 1\n");
    expect(fixture.probe()).toBe("task-orch-process-v1:unknown");
  });
  it.each(["D", "Z", "X"])("keeps %s process state safe", async (state) => {
    expect((await procFixture(state)).probe()).toBe(`task-orch-process-v1:${state === "D" ? "alive" : "unknown"}`);
  });
  it("does not report death when procfs or process identity is unreadable", async () => {
    const fixture = await procFixture("S");
    await rm(join(fixture.root, "1452", "environ"));
    expect(fixture.probe()).toBe("task-orch-process-v1:unknown");
    await rm(join(fixture.root, "self", "stat"));
    expect(fixture.probe()).toBe("task-orch-process-v1:unknown");
  });
});
