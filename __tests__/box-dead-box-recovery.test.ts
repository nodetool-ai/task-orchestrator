// __tests__/box-dead-box-recovery.test.ts
//
// A Box recorded in runner_instances can vanish from the Box account (manual
// deletion, account-side GC, retention). Every path that dereferences a stored
// boxId must then treat the mapping as DEAD and let the run re-provision —
// never re-fail against the same ghost forever.
//
// Prod incident (2026-07-21, runs 147/148/149): each sweep tick called
// box.get(boxId) -> 404 -> recordFailure(), which re-set state='starting' and
// LEFT boxId in place. The sweep selects on `boxId IS NOT NULL`, so the same
// row was re-selected ~every 15s and emitted runner_failed forever. create()
// had the same hole: its `existing?.boxId` short-circuit called box.get()
// with no not-found escape, so the run could never re-provision either.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import * as repo from "../lib/repo";
import { create } from "../lib/runs";
import { BoxRunnerProvider } from "../lib/runner/box";
import type { BoxClient } from "../lib/runner/box-client";

const DEAD_BOX = "bx_dead";

/** A thrown SDK-shaped 404 — normalizeBoxApiError classifies it "not-found". */
function notFound(): Error {
  return Object.assign(new Error("not_found"), {
    response: new Response(JSON.stringify({ message: "not_found" }), { status: 404 }),
  });
}

const manifest = JSON.stringify({
  formatVersion: 1,
  workerBuildSha: "c".repeat(40),
  workerProtocolVersion: 1,
  repository: "acme/widget",
  repositoryPath: "/home/user/repository",
  workerEntryPath: "/home/user/worker/run-worker.js",
});

/** A fake whose `get` 404s for DEAD_BOX but serves any freshly created box. */
function fakeBoxWithDeadBox() {
  const calls: string[] = [];
  const live = new Set<string>();
  let next = 0;

  const client: BoxClient = {
    limits: async () => ({ canStart: true, activeBoxes: 0, maxActiveBoxes: 10 }),
    boxes: async () => ({ boxes: [] }),
    get: async (id) => {
      calls.push(`get:${id}`);
      if (!live.has(id)) throw notFound();
      return { id, state: "ready" };
    },
    update: async (id) => ({ id, state: "ready" }),
    fork: async () => {
      throw new Error("fork must not be called in blank-provisioning mode");
    },
    create: async () => {
      const id = `bx_fresh_${++next}`;
      live.add(id);
      calls.push(`create:${id}`);
      return { id, state: "ready" };
    },
    resume: async (id) => {
      calls.push(`resume:${id}`);
      if (!live.has(id)) throw notFound();
      return { id, status: "accepted" };
    },
    stop: async (id) => {
      calls.push(`stop:${id}`);
      return { id, status: "accepted" };
    },
    remove: async () => {},
    command: async (_id, input) => {
      const cmd = input.command;
      if (cmd.includes("setsid")) return ok("launched");
      if (cmd.includes("__running__")) return ok("0");
      if (cmd.startsWith("tail -c")) return ok("");
      if (cmd.includes("tail -n")) return ok("[box-bootstrap] alive pid=42\n");
      if (cmd.startsWith("cat ")) return ok(manifest);
      if (cmd.includes(".ascii/host")) {
        return ok("https://box-1-8787.on.ascii.dev?_token=faketoken\n");
      }
      return ok("42\n");
    },
    getLatestBoxSnapshot: async (id) => ({
      id: `snap_${id}`,
      status: "completed",
      completedAt: new Date(),
    }),
    writeFile: async () => {},
  };
  return { client, calls };
}

function ok(stdout: string) {
  return { success: true, exitCode: 0, stdout, stderr: "", timedOut: false };
}

// The re-provision path is blank provisioning, which uploads a worker bundle.
// Ship a fixture one rather than depending on `npm run build:worker:standalone`
// having been run — CI runs `npm test` against a clean tree with no dist/.
let bundleDir: string;
let bundlePath: string;
beforeAll(() => {
  bundleDir = mkdtempSync(join(tmpdir(), "box-dead-bundle-"));
  bundlePath = join(bundleDir, "run-worker.standalone.js");
  writeFileSync(bundlePath, Buffer.alloc(1024, 3));
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

function boxEnv() {
  vi.stubEnv("TASK_ORCH_RUNNER", "box");
  vi.stubEnv("BOX_API_KEY", "control-plane-only-key");
  vi.stubEnv("TASK_ORCH_BOX_REPO_PATH", "/home/user/repository");
  vi.stubEnv("TASK_ORCH_BOX_POLL_MS", "0");
  vi.stubEnv("AUTH_SECRET", "test-channel-secret");
  vi.stubEnv("TASK_ORCH_WORKER_SHA", "c".repeat(40));
  vi.stubEnv("TASK_ORCH_BUNDLE_PATH", bundlePath);
  vi.stubEnv("GH_TOKEN", "ghp_test");
}

/** A run with a runner_instances row already pointing at the now-dead box.
 *  `ageMs` back-dates the mapping past BOX_DEAD_GRACE_MS so the 404 counts as
 *  death rather than possible Box-side eventual consistency. */
async function runMappedToDeadBox(state: string, ageMs = 60 * 60_000) {
  const repository = await repo.createRepository({
    name: `box-dead-${Date.now()}-${Math.random()}`,
    remote: "git@github.com:acme/widget.git",
  });
  const run = await create({ goal: "<implement>", defer: true, repoId: repository.id });
  const scope = `run-${run.id}-fake`;
  await db.update(agentSessions).set({ workerScope: scope }).where(eq(agentSessions.id, run.id));
  const aged = new Date(Date.now() - ageMs);
  await db.insert(runnerInstances).values({
    runId: run.id,
    provider: "box",
    boxId: DEAD_BOX,
    state,
    repoPath: "/home/user/repository",
    createdAt: aged,
    lastStartedAt: aged,
    credentialsVersion: 1,
    // Must satisfy INSTANCE_ID_PATTERN (wi_ + 32 hex) — the worker-channel
    // credential is derived from it.
    channelInstanceId: `wi_${String(run.id).padStart(32, "0")}`,
  });
  return { run, scope };
}

async function instanceRow(runId: number) {
  const [row] = await db
    .select({ boxId: runnerInstances.boxId, state: runnerInstances.state })
    .from(runnerInstances)
    .where(eq(runnerInstances.runId, runId));
  return row;
}

afterEach(() => vi.unstubAllEnvs());

describe("box provider: a recorded box that no longer exists", () => {
  it("sweep() retires the mapping instead of re-failing it forever", async () => {
    boxEnv();
    const fake = fakeBoxWithDeadBox();
    const { run } = await runMappedToDeadBox("starting");

    await new BoxRunnerProvider(fake.client).sweep();

    const row = await instanceRow(run.id);
    // The row must fall OUT of the sweep's `boxId IS NOT NULL` selection, or the
    // next tick re-runs this exact failure — the prod symptom.
    expect(row?.boxId).toBeNull();
    expect(row?.state).toBe("gone");
  });

  // The mirror image: a 404 against a mapping provisioned moments ago is far
  // more likely Box-side eventual consistency than death. Retiring it would
  // strand a live, billing box and provision a duplicate, so the mapping is
  // kept and the failure recorded as before until it ages out.
  it("sweep() keeps a freshly provisioned mapping that 404s", async () => {
    boxEnv();
    const fake = fakeBoxWithDeadBox();
    const { run } = await runMappedToDeadBox("starting", 5_000);

    await new BoxRunnerProvider(fake.client).sweep();

    const row = await instanceRow(run.id);
    expect(row?.boxId).toBe(DEAD_BOX);
  });

  it("create() clears the dead mapping and provisions a fresh box", async () => {
    boxEnv();
    const fake = fakeBoxWithDeadBox();
    const { run, scope } = await runMappedToDeadBox("starting");

    const ref = await new BoxRunnerProvider(fake.client).create({ runId: run.id, scope });

    expect(ref).toMatchObject({ provider: "box" });
    // It must have re-provisioned rather than thrown against the ghost.
    expect(fake.calls.some((c) => c.startsWith("create:"))).toBe(true);
    const row = await instanceRow(run.id);
    expect(row?.boxId).not.toBe(DEAD_BOX);
    expect(row?.boxId).toBeTruthy();
  });
});
