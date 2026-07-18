import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { spawnSync } from "node:child_process";

import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import * as repo from "../lib/repo";
import { create } from "../lib/runs";
import { BoxRunnerProvider, WORKER_BOOTSTRAP_COMMAND } from "../lib/runner/box";
import type { BoxClient } from "../lib/runner/box-client";

const manifest = JSON.stringify({
  formatVersion: 1,
  workerBuildSha: "test-worker",
  workerProtocolVersion: 1,
  repository: "acme/test",
  repositoryPath: "/home/user/repository",
});

// The test database is shared across examples. Real Box IDs are globally
// unique, so model that here instead of reusing `bx_run_1` in every fake.
let fakeBoxSequence = 0;

function fakeBox() {
  const sequence = ++fakeBoxSequence;
  const calls: string[] = [];
  const states = new Map<string, string>();
  const forks: Array<{ source: string; input: { env: Record<string, string>; noEnv: true } }> = [];
  let next = 0;
  let limit = { canStart: true, activeBoxes: 0, maxActiveBoxes: 2 };
  let missing = false;
  const client: BoxClient = {
    limits: async () => limit,
    boxes: async () => ({ boxes: [] }),
    get: async (id) => {
      calls.push(`get:${id}`);
      if (missing) throw Object.assign(new Error("missing"), { response: new Response("", { status: 404 }) });
      const state = states.get(id) ?? "ready";
      return {
        id,
        state,
        ...(state === "archived" ? { lastSnapshotStatus: "completed", snapshotCompletedAt: new Date() } : {}),
      };
    },
    update: async (id) => ({ id, state: states.get(id) ?? "ready" }),
    fork: async (source, input) => {
      forks.push({ source, input });
      const id = `bx_run_${sequence}_${++next}`;
      states.set(id, "ready");
      calls.push(`fork:${source}`);
      return { id, status: "accepted" };
    },
    create: async () => {
      const id = `bx_new_${sequence}_${++next}`;
      states.set(id, "ready");
      calls.push(`create:${id}`);
      return { id, state: "ready" };
    },
    resume: async (id, input) => {
      calls.push(`resume:${id}:${String(input?.noEnv)}`);
      states.set(id, "ready");
      return { id, status: "accepted" };
    },
    stop: async (id) => {
      calls.push(`stop:${id}`);
      states.set(id, "archived");
      return { id, status: "accepted" };
    },
    remove: async (id) => {
      calls.push(`remove:${id}`);
    },
    command: async (_id, input) => {
      const kind = input.command.startsWith("cat ")
        ? "manifest"
        : input.command.includes("tail -n")
          ? "bootstrap-log"
          : input.command.includes(".ascii/host")
            ? "host"
            : "worker";
      calls.push(`command:${kind}`);
      if (kind === "manifest") return { success: true, exitCode: 0, stdout: manifest, stderr: "", timedOut: false };
      if (kind === "bootstrap-log") {
        return {
          success: true,
          exitCode: 0,
          stdout: "2026-01-01T00:00:00Z [box-bootstrap] alive pid=42\n",
          stderr: "",
          timedOut: false,
        };
      }
      if (kind === "host") {
        // Mirror `host <port>`'s output: log lines then the gated public URL.
        return {
          success: true,
          exitCode: 0,
          stdout:
            `Opening firewall for port 8787...\n` +
            `https://box-${sequence}-8787.on.ascii.dev?_token=faketoken${sequence}\n`,
          stderr: "",
          timedOut: false,
        };
      }
      return { success: true, exitCode: 0, stdout: "42\n", stderr: "", timedOut: false };
    },
    getLatestBoxSnapshot: async (id) => ({ id: `snap_${id}`, status: "completed", completedAt: new Date() }),
  };
  return {
    client,
    calls,
    forks,
    states,
    setLimit: (value: typeof limit) => (limit = value),
    setMissing: (value: boolean) => (missing = value),
  };
}

function boxEnv() {
  vi.stubEnv("TASK_ORCH_RUNNER", "box");
  // Blank provisioning is the new default; this suite exercises the legacy
  // fork-a-template flow.
  vi.stubEnv("TASK_ORCH_BOX_PROVISION", "template");
  vi.stubEnv("BOX_API_KEY", "control-plane-only-key");
  vi.stubEnv("TASK_ORCH_BOX_TEMPLATE_ID", "bx_template");
  vi.stubEnv("TASK_ORCH_BOX_REPO_PATH", "/home/user/repository");
  vi.stubEnv("TASK_ORCH_BOX_POLL_MS", "0");
  vi.stubEnv("DATABASE_URL", "postgres://must-not-leak");
  // The worker channel credential is an HMAC over (runId, instanceId); the Box
  // env builder mints it during provisioning and needs the signing secret.
  vi.stubEnv("AUTH_SECRET", "test-channel-secret");
}

async function runWithClaim() {
  // Box admission rejects a repo without a clonable remote (runs 26/27), so
  // the fixture repo must carry one for provisioning to be reachable at all.
  const repository = await repo.createRepository({
    name: `box-e2e-${Date.now()}-${Math.random()}`,
    remote: "git@github.com:acme/box-e2e.git",
  });
  const run = await create({ goal: "<implement>", defer: true, repoId: repository.id });
  const scope = `run-${run.id}-fake`;
  await db.update(agentSessions).set({ workerScope: scope }).where(eq(agentSessions.id, run.id));
  return { run, scope };
}

afterEach(() => vi.unstubAllEnvs());

// Box worker-channel ingress is provided by the ascii.dev `host` proxy: the
// worker binds tcp:0.0.0.0:8787 inside the Box, create() runs `host 8787`, and
// the control plane dials the resulting public WSS URL. These fake-client flows
// exercise the fork(noEnv), bootstrap, host-discovery, checkpoint, and capacity
// plumbing without a real Box.
describe("Box provider fake-client flow", () => {
  it("uses syntactically valid shell for detached worker bootstrap", () => {
    const parsed = spawnSync("sh", ["-n", "-c", WORKER_BOOTSTRAP_COMMAND], { encoding: "utf8" });
    expect(parsed.status).toBe(0);
    expect(WORKER_BOOTSTRAP_COMMAND).not.toContain("& &&");
    expect(WORKER_BOOTSTRAP_COMMAND).toContain("[box-bootstrap] starting");
    expect(WORKER_BOOTSTRAP_COMMAND).toContain("[box-bootstrap] exited-early");
    expect(WORKER_BOOTSTRAP_COMMAND).not.toContain("printenv");
    // New templates bake only the standalone bundle; old templates keep the
    // checkout layout. The bootstrap probes new-then-legacy so both launch.
    expect(WORKER_BOOTSTRAP_COMMAND).toContain('/home/user/worker/run-worker.js');
    expect(WORKER_BOOTSTRAP_COMMAND).toContain('/home/user/task-orchestrator/dist/run-worker.js');
  });

  it("forks a template with noEnv, a hygienic worker environment, and a hosted channel", async () => {
    boxEnv();
    const fake = fakeBox();
    const { run, scope } = await runWithClaim();
    const ref = await new BoxRunnerProvider(fake.client).create({ runId: run.id, scope });

    expect(ref).toMatchObject({ provider: "box" });
    expect(fake.forks).toHaveLength(1);
    expect(fake.forks[0]).toMatchObject({ source: "bx_template", input: { noEnv: true } });
    expect(fake.forks[0]!.input.env).not.toHaveProperty("BOX_API_KEY");
    expect(fake.forks[0]!.input.env).not.toHaveProperty("DATABASE_URL");
    // The worker gets its channel identity (binds tcp:0.0.0.0:8787).
    expect(fake.forks[0]!.input.env).toMatchObject({
      TASK_ORCH_WORKER_INSTANCE_ID: ref!.channelInstanceId,
      TASK_ORCH_WORKER_CHANNEL_ENDPOINT: "tcp:0.0.0.0:8787",
    });
    // create() hosted the port and resolved a WSS dial endpoint carrying the
    // proxy token as _port_auth.
    expect(fake.calls).toContain("command:host");
    expect(ref!.channelEndpoint).toMatch(
      /^wss:\/\/box-\d+-8787\.on\.ascii\.dev\/worker\/channel\?_port_auth=faketoken\d+$/
    );
    const [mapping] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(mapping).toMatchObject({
      boxId: ref?.handle,
      boxTemplateId: "bx_template",
      state: "running",
      channelInstanceId: ref!.channelInstanceId,
      channelEndpoint: ref!.channelEndpoint,
    });
    const [session] = await db
      .select({ workerLog: agentSessions.workerLog })
      .from(agentSessions)
      .where(eq(agentSessions.id, run.id));
    expect(session?.workerLog).toContain("[box-bootstrap] alive pid=42");
    expect(fake.calls).toContain("command:bootstrap-log");
  });

  it("checkpoints, resumes the same Box, and uses noEnv on resume", async () => {
    boxEnv();
    const fake = fakeBox();
    const { run, scope } = await runWithClaim();
    const provider = new BoxRunnerProvider(fake.client);
    const first = await provider.create({ runId: run.id, scope });
    await provider.checkpoint(run.id);
    await provider.create({ runId: run.id, scope });

    expect(fake.calls).toContain(`stop:${first!.handle}`);
    expect(fake.calls).toContain(`resume:${first!.handle}:true`);
    expect(fake.forks).toHaveLength(1);
    const [mapping] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(mapping).toMatchObject({ boxId: first!.handle, snapshotId: `snap_${first!.handle}`, state: "running" });
  });

  it("defers capacity and preserves a mapped Box for recoverable or missing remote state", async () => {
    boxEnv();
    const fake = fakeBox();
    fake.setLimit({ canStart: false, activeBoxes: 2, maxActiveBoxes: 2 });
    const provider = new BoxRunnerProvider(fake.client);
    await expect(provider.admit({ runId: 1, reservedActive: 0 })).resolves.toMatchObject({ decision: "defer" });

    fake.setLimit({ canStart: true, activeBoxes: 0, maxActiveBoxes: 2 });
    const { run, scope } = await runWithClaim();
    const ref = await provider.create({ runId: run.id, scope });
    fake.states.set(ref!.handle, "error");
    await provider.sweep();
    fake.setMissing(true);
    await provider.sweep();

    const [mapping] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(mapping?.boxId).toBe(ref!.handle);
    expect(mapping?.lastProviderError).toBeTruthy();
    expect(fake.calls.some((call) => call.startsWith("remove:"))).toBe(false);
  });

  it("uses checkpointing—not deletion—for a mapped cancellation fallback", async () => {
    boxEnv();
    const fake = fakeBox();
    const { run, scope } = await runWithClaim();
    const provider = new BoxRunnerProvider(fake.client);
    const ref = await provider.create({ runId: run.id, scope });
    await provider.stop(ref!.handle);

    expect(fake.calls).toContain(`stop:${ref!.handle}`);
    expect(fake.calls.some((call) => call.startsWith("remove:"))).toBe(false);
    const [mapping] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(mapping).toMatchObject({ state: "stopped", snapshotId: `snap_${ref!.handle}` });
  });
});
