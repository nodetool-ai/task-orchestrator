// __tests__/box-blank-provision.test.ts
//
// Blank provisioning: no template snapshot. create() must CREATE a blank box
// (never fork), UPLOAD the worker bundle through the box files API (base64
// chunks — the only transport that works for every control plane, localhost
// included), then run one detached provision command that reassembles +
// sha256-verifies the bundle, clones the RUN'S OWN repo, and writes the
// standard manifest — after which the normal manifest/bootstrap flow
// proceeds unchanged.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import * as repo from "../lib/repo";
import { create } from "../lib/runs";
import { BoxRunnerProvider } from "../lib/runner/box";
import type { BoxClient } from "../lib/runner/box-client";

const WORKER_SHA = "b".repeat(40);

// Shared bundle fixture every test pushes: 13MB forces multiple upload chunks.
const BUNDLE_BYTES = Buffer.alloc(13 * 1024 * 1024, 7);
const BUNDLE_SHA = createHash("sha256").update(BUNDLE_BYTES).digest("hex");
let bundleDir: string;
let bundlePath: string;
beforeAll(() => {
  bundleDir = mkdtempSync(join(tmpdir(), "blank-push-"));
  bundlePath = join(bundleDir, "run-worker.standalone.js");
  writeFileSync(bundlePath, BUNDLE_BYTES);
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

// The manifest the fake box's `cat` of the template path answers with — the
// same shape the real blank-provision command writes.
const manifest = JSON.stringify({
  formatVersion: 1,
  workerBuildSha: WORKER_SHA,
  workerProtocolVersion: 1,
  repository: "acme/widget",
  repositoryPath: "/home/user/repository",
  workerEntryPath: "/home/user/worker/run-worker.js",
});

let fakeBoxSequence = 0;

function fakeBlankBox(opts: { rc?: string; tail?: string } = {}) {
  const sequence = ++fakeBoxSequence;
  const calls: string[] = [];
  const commands: string[] = [];
  const states = new Map<string, string>();
  const createdIds: string[] = [];
  let next = 0;
  let createdInput: { env: Record<string, string>; noEnv: true } | undefined;
  let forkCalled = false;
  let rc = opts.rc ?? "0";
  let tail = opts.tail ?? "";
  const writes: Array<{ path: string; content: string; encoding?: string }> = [];

  const client: BoxClient = {
    limits: async () => ({ canStart: true, activeBoxes: 0, maxActiveBoxes: 2 }),
    boxes: async () => ({ boxes: [] }),
    get: async (id) => ({ id, state: states.get(id) ?? "ready" }),
    update: async (id) => ({ id, state: states.get(id) ?? "ready" }),
    fork: async () => {
      forkCalled = true;
      throw new Error("fork must not be called in blank-provisioning mode");
    },
    create: async (input) => {
      createdInput = input;
      const id = `bx_blank_${sequence}_${++next}`;
      createdIds.push(id);
      states.set(id, "ready");
      calls.push(`create:${id}`);
      return { id, state: "ready" };
    },
    resume: async (id) => {
      states.set(id, "ready");
      return { id, status: "accepted" };
    },
    stop: async (id) => {
      calls.push(`stop:${id}`);
      states.set(id, "archived");
      return { id, status: "accepted" };
    },
    remove: async () => {},
    command: async (_id, input) => {
      const cmd = input.command;
      commands.push(cmd);
      // Detached-step launch (runDetachedBoxStep): `setsid sh -c '<script>' ...`.
      if (cmd.includes("setsid")) {
        calls.push("command:launch");
        return { success: true, exitCode: 0, stdout: "launched", stderr: "", timedOut: false };
      }
      // Detached-step rc probe.
      if (cmd.includes("__running__")) {
        calls.push("command:probe");
        return { success: true, exitCode: 0, stdout: rc, stderr: "", timedOut: false };
      }
      // Detached-step tail-on-failure read.
      if (cmd.startsWith("tail -c")) {
        calls.push("command:tail");
        return { success: true, exitCode: 0, stdout: tail, stderr: "", timedOut: false };
      }
      // Bootstrap-log tail (readyAndLaunch's captureBootstrapLog) — must be
      // checked BEFORE the manifest `cat`, since it also starts with `if [ -f`.
      if (cmd.includes("tail -n")) {
        calls.push("command:bootstrap-log");
        return {
          success: true,
          exitCode: 0,
          stdout: "2026-01-01T00:00:00Z [box-bootstrap] alive pid=42\n",
          stderr: "",
          timedOut: false,
        };
      }
      // Template manifest read.
      if (cmd.startsWith("cat ")) {
        calls.push("command:manifest");
        return { success: true, exitCode: 0, stdout: manifest, stderr: "", timedOut: false };
      }
      // Worker-channel host proxy.
      if (cmd.includes(".ascii/host")) {
        calls.push("command:host");
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
      // Everything else is the worker-bootstrap command.
      calls.push("command:worker");
      return { success: true, exitCode: 0, stdout: "42\n", stderr: "", timedOut: false };
    },
    getLatestBoxSnapshot: async (id) => ({ id: `snap_${id}`, status: "completed", completedAt: new Date() }),
    writeFile: async (_id, input) => {
      writes.push(input);
      calls.push(`writeFile:${input.path}`);
    },
  };
  return {
    client,
    calls,
    commands,
    states,
    createdIds,
    writes,
    createdInput: () => createdInput,
    forkCalled: () => forkCalled,
    setRc: (value: string) => {
      rc = value;
    },
    setTail: (value: string) => {
      tail = value;
    },
  };
}

function blankEnv() {
  vi.stubEnv("TASK_ORCH_RUNNER", "box");
  vi.stubEnv("BOX_API_KEY", "control-plane-only-key");
  vi.stubEnv("TASK_ORCH_BOX_REPO_PATH", "/home/user/repository");
  vi.stubEnv("TASK_ORCH_BOX_POLL_MS", "0");
  vi.stubEnv("DATABASE_URL", "postgres://must-not-leak");
  vi.stubEnv("AUTH_SECRET", "test-channel-secret");
  // TASK_ORCH_BOX_TEMPLATE_ID intentionally unset: blank mode never resolves a
  // template. TASK_ORCH_BOX_PROVISION intentionally unset: blank is the default.
  vi.stubEnv("TASK_ORCH_BUNDLE_PATH", bundlePath);
  vi.stubEnv("TASK_ORCH_WORKER_SHA", WORKER_SHA);
  vi.stubEnv("GH_TOKEN", "ghp_should_never_appear_in_a_command_literal");
}

async function runWithRemote(remote: string) {
  const repository = await repo.createRepository({
    name: `box-blank-${Date.now()}-${Math.random()}`,
    remote,
  });
  const run = await create({ goal: "<implement>", defer: true, repoId: repository.id });
  const scope = `run-${run.id}-fake`;
  await db.update(agentSessions).set({ workerScope: scope }).where(eq(agentSessions.id, run.id));
  return { run, scope };
}

afterEach(() => vi.unstubAllEnvs());

describe("box blank provisioning", () => {
  it("creates a blank box (no fork) and provisions bundle + repo clone + manifest", async () => {
    blankEnv();
    const fake = fakeBlankBox();
    const { run, scope } = await runWithRemote("git@github.com:acme/widget.git");

    const ref = await new BoxRunnerProvider(fake.client).create({ runId: run.id, scope });

    expect(ref).toMatchObject({ provider: "box" });
    expect(fake.forkCalled()).toBe(false);
    expect(fake.createdInput()).toMatchObject({ noEnv: true });
    const createdEnv = fake.createdInput()!.env;
    expect(createdEnv).toHaveProperty("TASK_ORCH_WORKER_CHANNEL_CREDENTIAL");
    expect(typeof createdEnv.TASK_ORCH_WORKER_CHANNEL_CREDENTIAL).toBe("string");
    expect(createdEnv.TASK_ORCH_WORKER_CHANNEL_CREDENTIAL.length).toBeGreaterThan(0);

    // The bundle travels as a chunked, ordered, base64 files-API upload that
    // reassembles to the exact bytes — never as an HTTP download by the box.
    expect(fake.writes.length).toBeGreaterThan(1);
    expect(fake.writes.every((w) => w.encoding === "base64")).toBe(true);
    // The box files API rejects writes over 5MiB decoded ("File is too large
    // for write_file (6291456 bytes > 5242880)", run 29). Every chunk must
    // stay under that platform cap.
    for (const w of fake.writes) {
      expect(Buffer.from(w.content, "base64").length).toBeLessThanOrEqual(5_242_880);
    }
    expect(fake.writes.map((w) => w.path)).toEqual(
      fake.writes.map((_, i) => `worker-upload/part-${String(i).padStart(3, "0")}`)
    );
    const reassembled = Buffer.concat(fake.writes.map((w) => Buffer.from(w.content, "base64")));
    expect(reassembled.equals(BUNDLE_BYTES)).toBe(true);

    const provisionCommand = fake.commands.find((cmd) => cmd.includes("worker-upload/part-000"));
    expect(provisionCommand).toBeTruthy();
    // The command verifies the interpolated sha of the exact uploaded bytes
    // and never references curl or a download URL.
    expect(provisionCommand).toContain(BUNDLE_SHA);
    expect(provisionCommand).not.toContain("curl");
    expect(provisionCommand).not.toContain("TASK_ORCH_BUNDLE_URL");
    expect(provisionCommand).toContain("git clone --depth 1");
    expect(provisionCommand).toContain("github.com/acme/widget");
    expect(provisionCommand).toContain('"workerEntryPath":"/home/user/worker/run-worker.js"');
    expect(provisionCommand).toContain('"repository":"acme/widget"');
    // sha256sum joins the git/node/curl preflight.
    expect(provisionCommand).toContain("sha256sum");
    // The claude binary the run needs must also be preflighted (final review #2).
    expect(provisionCommand).toMatch(/test -x .*\/usr\/local\/bin\/claude/);

    // The literal GH_TOKEN value must never appear in any command text — only
    // the box-shell env reference ($GH_TOKEN) does.
    for (const cmd of fake.commands) {
      expect(cmd).not.toContain("ghp_should_never_appear_in_a_command_literal");
    }
    expect(provisionCommand).toContain("GH_TOKEN");
    // The credential must never ride in the clone URL itself (it would leak
    // verbatim into a "remote: not found" clone error and round-trip through
    // runDetachedBoxStep's log tail into lastProviderError/agentEvents) — it
    // is injected via a git credential helper instead.
    expect(provisionCommand).not.toContain("x-access-token:");
    expect(provisionCommand).toContain("credential.helper");

    const [mapping] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(mapping).toMatchObject({
      provider: "box",
      boxId: ref?.handle,
      boxTemplateId: null,
      state: "running",
    });
  });

  it("uploads via the files API even when a legacy bundle URL is configured", async () => {
    // The pull path is gone: TASK_ORCH_BUNDLE_URL is a no-op, the box never
    // downloads anything, and the URL is not handed into the box env.
    blankEnv();
    vi.stubEnv("TASK_ORCH_BUNDLE_URL", "https://cp.example.com/api/worker-bundle");
    const fake = fakeBlankBox();
    const { run, scope } = await runWithRemote("git@github.com:acme/legacy-url.git");

    const ref = await new BoxRunnerProvider(fake.client).create({ runId: run.id, scope });

    expect(ref).toMatchObject({ provider: "box" });
    expect(fake.writes.length).toBeGreaterThan(0);
    expect(fake.createdInput()!.env.TASK_ORCH_BUNDLE_URL).toBeUndefined();
    for (const cmd of fake.commands) {
      expect(cmd).not.toContain("curl");
      expect(cmd).not.toContain("TASK_ORCH_BUNDLE_URL");
    }
  });

  it("fails actionably when no local bundle exists to upload", async () => {
    blankEnv();
    vi.stubEnv("TASK_ORCH_BUNDLE_PATH", "/nonexistent/run-worker.standalone.js");
    const fake = fakeBlankBox();
    const { run, scope } = await runWithRemote("git@github.com:acme/nobundle.git");

    await expect(new BoxRunnerProvider(fake.client).create({ runId: run.id, scope })).rejects.toThrow(
      /build:worker:standalone/
    );
    expect(fake.calls).toHaveLength(0);
    expect(fake.createdInput()).toBeUndefined();
  });

  it("surfaces the provision log tail when the provision step fails", async () => {
    blankEnv();
    const fake = fakeBlankBox({ rc: "1", tail: "clone failed: repo not found" });
    const { run, scope } = await runWithRemote("git@github.com:acme/missing.git");

    let caught: unknown;
    try {
      await new BoxRunnerProvider(fake.client).create({ runId: run.id, scope });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/provision/i);
    expect((caught as Error).message).toMatch(/clone failed/);
  });

  it("re-provisions on a fresh box after a provision failure (no retry wedge)", async () => {
    blankEnv();
    const fake = fakeBlankBox({ rc: "1", tail: "clone failed: repo not found" });
    const { run, scope } = await runWithRemote("git@github.com:acme/retry.git");

    await expect(new BoxRunnerProvider(fake.client).create({ runId: run.id, scope })).rejects.toThrow();

    // The failed mapping must not pin a dead boxId: the next attempt has to
    // provision a fresh blank box rather than resuming/reading a manifest
    // that was never written on the box the failed provision step stopped.
    const [afterFailure] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(afterFailure?.boxId).toBeNull();
    expect(afterFailure?.lastProviderError).toBeTruthy();
    expect(fake.createdIds).toHaveLength(1);

    fake.setRc("0");
    fake.setTail("");
    const ref = await new BoxRunnerProvider(fake.client).create({ runId: run.id, scope });

    expect(ref).toMatchObject({ provider: "box" });
    expect(fake.forkCalled()).toBe(false);
    expect(fake.createdIds).toHaveLength(2);
    expect(fake.createdIds[1]).not.toBe(fake.createdIds[0]);

    const [afterRetry] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(afterRetry).toMatchObject({ boxId: ref?.handle, boxTemplateId: null, state: "running" });
  });

  it("warns once per process when a pinned template id is ignored in blank mode", async () => {
    blankEnv();
    vi.stubEnv("TASK_ORCH_BOX_TEMPLATE_ID", "bx_pinned_but_ignored");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fake = fakeBlankBox();
      const { run: runA, scope: scopeA } = await runWithRemote("git@github.com:acme/pin-a.git");
      await new BoxRunnerProvider(fake.client).create({ runId: runA.id, scope: scopeA });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/TASK_ORCH_BOX_TEMPLATE_ID/);
      expect(warn.mock.calls[0]?.[0]).toMatch(/TASK_ORCH_BOX_PROVISION=template/);

      // A second run in the same process must not warn again.
      const { run: runB, scope: scopeB } = await runWithRemote("git@github.com:acme/pin-b.git");
      await new BoxRunnerProvider(fake.client).create({ runId: runB.id, scope: scopeB });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
