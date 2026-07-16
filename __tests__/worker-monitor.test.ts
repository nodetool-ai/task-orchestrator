// __tests__/worker-monitor.test.ts
//
// The worker monitor keeps a run's DB state tracking the REAL container state:
// a die event (or the reconcile sweep) captures the container's logs + exit
// code onto the run, removes the container, and applies the death policy —
// within seconds, instead of the 5-minute heartbeat timeout.

import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get, getWorkerLog, handleWorkerDeath } from "../lib/runs";
import * as dispatch from "../lib/run-dispatch";
import {
  INSTANCE_LABEL,
  RUN_LABEL,
  buildWorkerContainerConfig,
  defaultSpawn,
  demuxDockerLog,
  dispatchRun,
  dockerSpawn,
  handleContainerExit,
  handleWorkerEvent,
  instanceId,
  provisionLocalChannel,
  resolveDockerDialHost,
  sweepWorkerContainers,
  sweepWorkerSockets,
  waitForDockerPortReady,
  type DockerLike,
} from "../lib/run-dispatch";

const FRESH = () => new Date(Date.now() - 5_000); // 5s ago — inside the lease window

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function patchRun(
  id: number,
  patch: Partial<typeof agentSessions.$inferInsert>
): Promise<void> {
  await db.update(agentSessions).set(patch).where(eq(agentSessions.id, id));
}

/** 8-byte-header stdout/stderr frame as Docker multiplexes them without a TTY. */
function muxFrame(stream: number, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

interface FakeContainer {
  Id: string;
  Names: string[];
  State: string;
  Labels: Record<string, string>;
}

function fakeDocker(opts: {
  containers?: FakeContainer[];
  logs?: Buffer;
  inspect?: {
    State?: { ExitCode?: number; OOMKilled?: boolean };
    NetworkSettings?: { IPAddress?: string; Networks?: Record<string, { IPAddress?: string }> };
  };
}) {
  const calls = { removed: [] as string[], stopped: [] as string[] };
  const docker: DockerLike = {
    createContainer: async () => ({ start: async () => undefined }),
    listContainers: async () => opts.containers ?? [],
    getContainer: (ref: string) => ({
      logs: async () => opts.logs ?? Buffer.alloc(0),
      inspect: async () => opts.inspect ?? {},
      remove: async () => {
        calls.removed.push(ref);
      },
      stop: async () => {
        calls.stopped.push(ref);
      },
    }),
    getEvents: async () => {
      throw new Error("not used in tests");
    },
  };
  return { docker, calls };
}

describe("demuxDockerLog", () => {
  it("strips the 8-byte frame headers and concatenates payloads", () => {
    const buf = Buffer.concat([muxFrame(1, "hello "), muxFrame(2, "stderr\n"), muxFrame(1, "world")]);
    expect(demuxDockerLog(buf)).toBe("hello stderr\nworld");
  });

  it("passes a non-multiplexed (TTY / plain-text) buffer through verbatim", () => {
    expect(demuxDockerLog(Buffer.from("plain text log"))).toBe("plain text log");
  });

  it("handles an empty buffer", () => {
    expect(demuxDockerLog(Buffer.alloc(0))).toBe("");
  });

  it("tolerates a truncated final frame", () => {
    const full = muxFrame(1, "complete");
    const cut = Buffer.concat([full, muxFrame(1, "chopped").subarray(0, 10)]);
    expect(demuxDockerLog(cut)).toContain("complete");
  });
});

describe("buildWorkerContainerConfig", () => {
  it("labels the container with its run id and keeps it after exit (no AutoRemove)", () => {
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    const cfg = buildWorkerContainerConfig(42, "run-42-x") as {
      Labels: Record<string, string>;
      HostConfig: { AutoRemove?: boolean; LogConfig?: { Type: string } };
    };
    expect(cfg.Labels[RUN_LABEL]).toBe("42");
    expect(cfg.HostConfig.AutoRemove).toBeUndefined();
    expect(cfg.HostConfig.LogConfig?.Type).toBe("json-file");
  });

  it("scopes the container to this instance (finding 3)", () => {
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    vi.stubEnv("TASK_ORCH_INSTANCE_ID", "prod-1");
    const cfg = buildWorkerContainerConfig(7, "run-7-x") as { Labels: Record<string, string> };
    expect(cfg.Labels[INSTANCE_LABEL]).toBe("prod-1");
    expect(instanceId()).toBe("prod-1");
  });

  // plan section 19: Docker provisioning
  it("exposes the fixed channel port with no PortBindings (never public ingress)", () => {
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    const cfg = buildWorkerContainerConfig(1, "run-1-x") as {
      ExposedPorts: Record<string, unknown>;
      HostConfig: Record<string, unknown>;
    };
    expect(cfg.ExposedPorts).toEqual({ "8787/tcp": {} });
    expect(cfg.HostConfig.PortBindings).toBeUndefined();
  });

  it("injects the channel identity, credential, and tcp listen endpoint when given a channel", () => {
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    const cfg = buildWorkerContainerConfig(1, "run-1-x", {
      instanceId: "wi_" + "a".repeat(32),
      listenEndpoint: "tcp:0.0.0.0:8787",
    }) as { Env: string[] };
    expect(cfg.Env).toContain(`TASK_ORCH_WORKER_INSTANCE_ID=wi_${"a".repeat(32)}`);
    expect(cfg.Env).toContain("TASK_ORCH_WORKER_CHANNEL_ENDPOINT=tcp:0.0.0.0:8787");
    expect(cfg.Env.some((e) => e.startsWith("TASK_ORCH_WORKER_CHANNEL_CREDENTIAL="))).toBe(true);
  });

  it("omits channel env when no channel is given (legacy 2-arg call)", () => {
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    const cfg = buildWorkerContainerConfig(1, "run-1-x") as { Env: string[] };
    expect(cfg.Env.some((e) => e.startsWith("TASK_ORCH_WORKER_INSTANCE_ID="))).toBe(false);
  });

  it("uses NetworkMode from TASK_ORCH_DOCKER_NETWORK when configured", () => {
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    vi.stubEnv("TASK_ORCH_DOCKER_NETWORK", "compose_net");
    const cfg = buildWorkerContainerConfig(1, "run-1-x") as { HostConfig: { NetworkMode?: string } };
    expect(cfg.HostConfig.NetworkMode).toBe("compose_net");
  });
});

describe("resolveDockerDialHost", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("dials by container name when a shared Docker network is configured", async () => {
    vi.stubEnv("TASK_ORCH_DOCKER_NETWORK", "compose_net");
    const { docker } = fakeDocker({ inspect: {} });
    await expect(resolveDockerDialHost(docker, "run-1-x")).resolves.toBe("run-1-x");
  });

  it("falls back to the container's bridge IP without a shared network", async () => {
    vi.stubEnv("TASK_ORCH_DOCKER_NETWORK", "");
    const { docker } = fakeDocker({
      inspect: { NetworkSettings: { IPAddress: "172.17.0.5" } },
    });
    await expect(resolveDockerDialHost(docker, "run-1-x")).resolves.toBe("172.17.0.5");
  });

  it("falls back to a named-network entry when the top-level IPAddress is empty", async () => {
    vi.stubEnv("TASK_ORCH_DOCKER_NETWORK", "");
    const { docker } = fakeDocker({
      inspect: {
        NetworkSettings: { IPAddress: "", Networks: { bridge: { IPAddress: "172.18.0.9" } } },
      },
    });
    await expect(resolveDockerDialHost(docker, "run-1-x")).resolves.toBe("172.18.0.9");
  });

  it("returns null when no address can be resolved", async () => {
    vi.stubEnv("TASK_ORCH_DOCKER_NETWORK", "");
    const { docker } = fakeDocker({ inspect: {} });
    await expect(resolveDockerDialHost(docker, "run-1-x")).resolves.toBeNull();
  });
});

describe("waitForDockerPortReady", () => {
  it("succeeds once a listener is bound on the port", async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(waitForDockerPortReady("127.0.0.1", port, 5_000)).resolves.toBe(true);
    } finally {
      server.close();
    }
  });

  it("times out when nothing ever listens (container.start() resolving is not readiness)", async () => {
    // Port 1 is a reserved low port with nothing listening; connect fails fast.
    await expect(waitForDockerPortReady("127.0.0.1", 1, 800)).resolves.toBe(false);
  });
});

describe("dockerSpawn", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns null (without waiting for readiness) when no dial host can be resolved", async () => {
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    vi.stubEnv("TASK_ORCH_DOCKER_NETWORK", "");
    const { docker } = fakeDocker({ inspect: {} }); // no NetworkSettings ⇒ no resolvable host
    await expect(dockerSpawn(1, "run-1-x", "wi_" + "b".repeat(32), docker)).resolves.toBeNull();
  });
});

describe("defaultSpawn", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("routes to the Docker path when TASK_ORCH_WORKER_IMAGE is set", async () => {
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    await expect(defaultSpawn(1, "run-1-x")).rejects.toThrow(/channel instance id/);
  });
});

describe("handleWorkerDeath policy", () => {
  it("fails a running run whose container died, citing the exit code", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await patchRun(run.id, { status: "running", workerScope: "run-x-1" });

    await handleWorkerDeath(run.id, { exitCode: 1, oomKilled: false, containerName: "run-x-1" });

    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/exited with code 1/);
  });

  it("mentions OOM when the container was killed at its memory cap", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await patchRun(run.id, { status: "running", workerScope: "run-x-2" });

    await handleWorkerDeath(run.id, { exitCode: 137, oomKilled: true, containerName: "run-x-2" });

    expect((await get(run.id))?.error).toMatch(/OOM/);
  });

  it("ignores a stale container from a superseded claim", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await patchRun(run.id, { status: "running", workerScope: "run-x-NEW" });

    await handleWorkerDeath(run.id, { exitCode: 137, oomKilled: true, containerName: "run-x-OLD" });

    expect((await get(run.id))?.status).toBe("running");
  });

  it("leaves a run alone that finished before its container exited", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await patchRun(run.id, { status: "completed", workerScope: "run-x-3" });

    await handleWorkerDeath(run.id, { exitCode: 0, oomKilled: false, containerName: "run-x-3" });

    const after = await get(run.id);
    expect(after?.status).toBe("completed");
    expect(after?.error).toBeNull();
  });

  it("returns a dying chat run to idle (resumable on the next message)", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await patchRun(run.id, { status: "running", workerScope: "run-c-1" });

    await handleWorkerDeath(run.id, { exitCode: 139, oomKilled: false, containerName: "run-c-1" });

    const after = await get(run.id);
    expect(after?.status).toBe("idle");
    expect(after?.workerScope).toBeNull();
  });

  it("releases the claim of an idle chat run whose parked worker wound down", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await patchRun(run.id, { status: "idle", workerScope: "run-c-2" });

    await handleWorkerDeath(run.id, { exitCode: 0, oomKilled: false, containerName: "run-c-2" });

    const after = await get(run.id);
    expect(after?.status).toBe("idle");
    expect(after?.workerScope).toBeNull();
  });

  it("re-dispatches a resumable implement run after a non-OOM death, clearing the stale heartbeat", async () => {
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    vi.stubEnv("TASK_ORCH_DETACHED_RUNS", "1");
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<implement>", defer: true });
    await patchRun(run.id, {
      status: "running",
      workerScope: "run-r-1",
      heartbeatAt: FRESH(), // the dead worker's last beat, still "fresh"
      sdkSessionId: "sess-1",
      branch: "claude/task-1",
    });

    await handleWorkerDeath(run.id, { exitCode: 1, oomKilled: false, containerName: "run-r-1" });

    expect(spy).toHaveBeenCalledWith(run.id);
    const after = await get(run.id);
    expect(after?.workerScope).toBeNull();
    // Regression (finding 1): heartbeatAt MUST be cleared, or the real
    // dispatchRun's isLeaseLive guard would see the dead worker's fresh beat and
    // no-op the re-dispatch, stranding the run until the 5-minute reaper.
    expect(after?.heartbeatAt).toBeNull();
    expect(after?.status).toBe("running"); // untouched; the fresh dispatch owns it now
  });

  it("the cleared heartbeat actually lets the real dispatchRun re-claim (finding 1)", async () => {
    // A run left 'running' with a fresh heartbeat but no scope (the bug's state)
    // is rejected by dispatchRun's guard...
    const blocked = await create({ goal: "<implement>", defer: true });
    await patchRun(blocked.id, { status: "running", workerScope: null, heartbeatAt: FRESH() });
    expect(await dispatchRun(blocked.id, { spawn: () => 1 })).toBe("already-claimed");

    // ...and with the heartbeat cleared (what handleWorkerDeath now does) it claims.
    const ok = await create({ goal: "<implement>", defer: true });
    await patchRun(ok.id, { status: "running", workerScope: null, heartbeatAt: null });
    expect(await dispatchRun(ok.id, { spawn: () => 1 })).toBe("spawned");
  });

  it("is idempotent: a second death for the same container is a no-op", async () => {
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    vi.stubEnv("TASK_ORCH_DETACHED_RUNS", "1");
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<implement>", defer: true });
    await patchRun(run.id, {
      status: "running",
      workerScope: "run-dup",
      heartbeatAt: FRESH(),
      sdkSessionId: "sess-d",
      branch: "claude/task-d",
    });

    await handleWorkerDeath(run.id, { exitCode: 1, oomKilled: false, containerName: "run-dup" });
    await handleWorkerDeath(run.id, { exitCode: 1, oomKilled: false, containerName: "run-dup" });

    // The atomic claim-release ran once; the second call found scope already null.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does NOT resume after an OOM kill — the retry would die at the same cap", async () => {
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    vi.stubEnv("TASK_ORCH_DETACHED_RUNS", "1");
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<implement>", defer: true });
    await patchRun(run.id, {
      status: "running",
      workerScope: "run-r-2",
      sdkSessionId: "sess-2",
      branch: "claude/task-2",
    });

    await handleWorkerDeath(run.id, { exitCode: 137, oomKilled: true, containerName: "run-r-2" });

    expect(spy).not.toHaveBeenCalled();
    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/OOM/);
  });
});

describe("dispatchRun log reset", () => {
  it("clears a prior container's captured log + exit code on re-claim", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await patchRun(run.id, {
      status: "failed",
      workerScope: null,
      workerLog: "old crash output",
      workerExitCode: 137,
    });

    expect(await dispatchRun(run.id, { spawn: () => 1 })).toBe("spawned");

    const log = await getWorkerLog(run.id);
    expect(log?.log).toBeNull();
    expect(log?.exitCode).toBeNull();
  });
});

describe("handleContainerExit", () => {
  it("captures the log + exit code onto the run, removes the container, applies policy", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const scope = `run-${run.id}-t1`;
    await patchRun(run.id, { status: "running", workerScope: scope });
    const { docker, calls } = fakeDocker({ logs: muxFrame(2, "FATAL: boom\n") });

    await handleContainerExit(
      { runId: run.id, containerName: scope, exitCode: 137, oomKilled: true },
      docker
    );

    const log = await getWorkerLog(run.id);
    expect(log?.log).toContain("FATAL: boom");
    expect(log?.exitCode).toBe(137);
    expect(calls.removed).toContain(scope);
    expect((await get(run.id))?.status).toBe("failed");
  });

  it("removes a superseded container without touching the run or its log", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await patchRun(run.id, { status: "running", workerScope: `run-${run.id}-CURRENT` });
    const { docker, calls } = fakeDocker({ logs: muxFrame(1, "old noise") });

    await handleContainerExit(
      { runId: run.id, containerName: `run-${run.id}-OLD`, exitCode: 0, oomKilled: false },
      docker
    );

    expect(calls.removed).toContain(`run-${run.id}-OLD`);
    expect((await get(run.id))?.status).toBe("running");
    expect((await getWorkerLog(run.id))?.log).toBeNull();
  });

  it("does not overwrite the log when a re-dispatch repoints the scope mid-fetch (finding 4)", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const oldScope = `run-${run.id}-OLD`;
    const newScope = `run-${run.id}-NEW`;
    await patchRun(run.id, { status: "running", workerScope: oldScope });
    // A docker whose logs() simulates a re-dispatch landing WHILE we read the old
    // container's log: the run's scope moves to a fresh container before the patch.
    const docker: DockerLike = {
      createContainer: async () => ({ start: async () => undefined }),
      listContainers: async () => [],
      getContainer: () => ({
        logs: async () => {
          await patchRun(run.id, {
            workerScope: newScope,
            workerLog: "NEW container log",
            workerExitCode: 0,
          });
          return muxFrame(1, "OLD container crash");
        },
        inspect: async () => ({}),
        remove: async () => undefined,
        stop: async () => undefined,
      }),
      getEvents: async () => {
        throw new Error("unused");
      },
    };

    await handleContainerExit(
      { runId: run.id, containerName: oldScope, exitCode: 137, oomKilled: true },
      docker
    );

    const log = await getWorkerLog(run.id);
    expect(log?.log).toBe("NEW container log"); // NOT clobbered by the old crash
    expect(log?.exitCode).toBe(0);
  });
});

describe("handleWorkerEvent", () => {
  it("routes a die event to the exit handler", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const scope = `run-${run.id}-e1`;
    await patchRun(run.id, { status: "running", workerScope: scope });
    const { docker } = fakeDocker({ logs: Buffer.alloc(0) });

    await handleWorkerEvent(
      {
        Action: "die",
        id: "cid-1",
        Actor: { Attributes: { [RUN_LABEL]: String(run.id), name: scope, exitCode: "2" } },
      },
      docker
    );

    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/exited with code 2/);
  });

  it("marks the death as OOM when an oom event preceded the die", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const scope = `run-${run.id}-e2`;
    await patchRun(run.id, { status: "running", workerScope: scope });
    const { docker } = fakeDocker({});
    const attrs = { [RUN_LABEL]: String(run.id), name: scope, exitCode: "1" };

    await handleWorkerEvent({ Action: "oom", id: "cid-2", Actor: { Attributes: attrs } }, docker);
    await handleWorkerEvent({ Action: "die", id: "cid-2", Actor: { Attributes: attrs } }, docker);

    expect((await get(run.id))?.error).toMatch(/OOM/);
  });

  it("ignores events without a run label", async () => {
    const { docker } = fakeDocker({});
    await expect(
      handleWorkerEvent({ Action: "die", id: "x", Actor: { Attributes: { name: "other" } } }, docker)
    ).resolves.toBeUndefined();
  });
});

describe("sweepWorkerContainers", () => {
  it("cleans up an exited container the events stream missed", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const scope = `run-${run.id}-s1`;
    await patchRun(run.id, { status: "running", workerScope: scope });
    const { docker, calls } = fakeDocker({
      containers: [
        { Id: "c1", Names: [`/${scope}`], State: "exited", Labels: { [RUN_LABEL]: String(run.id) } },
      ],
      logs: muxFrame(1, "sweep sees this\n"),
      inspect: { State: { ExitCode: 137, OOMKilled: true } },
    });

    await sweepWorkerContainers(docker);

    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/OOM/);
    expect((await getWorkerLog(run.id))?.log).toContain("sweep sees this");
    expect(calls.removed).toContain(scope);
  });

  it("stops a container still running long after its run finished", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const scope = `run-${run.id}-s2`;
    await patchRun(run.id, {
      status: "completed",
      workerScope: scope,
      completedAt: new Date(Date.now() - 5 * 60_000),
    });
    const { docker, calls } = fakeDocker({
      containers: [
        { Id: "c2", Names: [`/${scope}`], State: "running", Labels: { [RUN_LABEL]: String(run.id) } },
      ],
    });

    await sweepWorkerContainers(docker);

    expect(calls.stopped).toContain(scope);
  });

  it("gives a just-finished run's container grace to wind down on its own", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const scope = `run-${run.id}-s3`;
    await patchRun(run.id, { status: "completed", workerScope: scope, completedAt: new Date() });
    const { docker, calls } = fakeDocker({
      containers: [
        { Id: "c3", Names: [`/${scope}`], State: "running", Labels: { [RUN_LABEL]: String(run.id) } },
      ],
    });

    await sweepWorkerContainers(docker);

    expect(calls.stopped).toHaveLength(0);
  });

  it("leaves a live run's running container alone", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const scope = `run-${run.id}-s4`;
    await patchRun(run.id, { status: "running", workerScope: scope, heartbeatAt: new Date() });
    const { docker, calls } = fakeDocker({
      containers: [
        { Id: "c4", Names: [`/${scope}`], State: "running", Labels: { [RUN_LABEL]: String(run.id) } },
      ],
    });

    await sweepWorkerContainers(docker);

    expect(calls.stopped).toHaveLength(0);
    expect(calls.removed).toHaveLength(0);
    expect((await get(run.id))?.status).toBe("running");
  });

  it("stops a running container whose claim was superseded", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const oldScope = `run-${run.id}-OLD`;
    await patchRun(run.id, {
      status: "running",
      workerScope: `run-${run.id}-NEW`,
      heartbeatAt: new Date(),
    });
    const { docker, calls } = fakeDocker({
      containers: [
        { Id: "c5", Names: [`/${oldScope}`], State: "running", Labels: { [RUN_LABEL]: String(run.id) } },
      ],
    });

    await sweepWorkerContainers(docker);

    expect(calls.stopped).toContain(oldScope);
  });

  it("declares a leased run dead when its container is gone and it has been silent", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await patchRun(run.id, {
      status: "running",
      workerScope: `run-${run.id}-gone`,
      heartbeatAt: new Date(Date.now() - 60_000),
    });
    const { docker } = fakeDocker({ containers: [] });

    await sweepWorkerContainers(docker);

    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/container is gone/);
  });

  it("spares a leased run inside the container-creation window (fresh heartbeat)", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await patchRun(run.id, {
      status: "preparing",
      workerScope: `run-${run.id}-new`,
      heartbeatAt: new Date(),
    });
    const { docker } = fakeDocker({ containers: [] });

    await sweepWorkerContainers(docker);

    expect((await get(run.id))?.status).toBe("preparing");
  });
});

// Local reaper socket cleanup (plan section 10.2): abandoned worker sockets are
// unlinked, but a live worker's socket is spared.
describe("sweepWorkerSockets", () => {
  async function bindSocket(path: string): Promise<() => Promise<void>> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    return () => new Promise<void>((resolve) => server.close(() => resolve()));
  }

  it("unlinks an abandoned socket but keeps a live worker's socket", async () => {
    const dead = await create({ goal: "<chat>", defer: true });
    const live = await create({ goal: "<chat>", defer: true });
    const deadCh = await provisionLocalChannel(dead.id);
    const liveCh = await provisionLocalChannel(live.id);

    const closers = [await bindSocket(deadCh.socketPath), await bindSocket(liveCh.socketPath)];
    try {
      // The dead run is terminal; the live run holds a fresh worker claim.
      await patchRun(dead.id, { status: "failed", workerScope: null, heartbeatAt: null });
      await patchRun(live.id, {
        status: "running",
        workerScope: `run-${live.id}-live`,
        heartbeatAt: new Date(),
      });

      await sweepWorkerSockets();

      expect(existsSync(deadCh.socketPath)).toBe(false);
      expect(existsSync(liveCh.socketPath)).toBe(true);
    } finally {
      await Promise.all(closers.map((close) => close().catch(() => undefined)));
    }
  });
});
