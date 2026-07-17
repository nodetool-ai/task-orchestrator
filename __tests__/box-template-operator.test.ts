import { describe, expect, it } from "vitest";

import type { BoxClient } from "../lib/runner/box-client";
import {
  publishBoxTemplate,
  requireTemplatePublishConfirmation,
  validateBoxTemplate,
} from "../lib/runner/box-template-operator";

const manifest = JSON.stringify({
  formatVersion: 1,
  workerBuildSha: "worker-sha",
  workerProtocolVersion: 1,
  repository: "acme/service",
  repositoryPath: "/home/user/service",
});

function templateClient(): { client: BoxClient; calls: string[] } {
  const calls: string[] = [];
  let state = "archived";
  let stopped = false;
  const client: BoxClient = {
    limits: async () => ({ canStart: true, activeBoxes: 0, maxActiveBoxes: 1 }),
    boxes: async () => ({ boxes: [] }),
    create: async () => ({ id: "bx_new", state: "ready" }),
    get: async (id) => {
      calls.push(`get:${id}`);
      if (stopped) {
        return {
          id,
          state: "archived",
          lastSnapshotStatus: "completed",
          snapshotCompletedAt: new Date(20),
        };
      }
      return {
        id,
        state,
        lastSnapshotStatus: state === "archived" ? "completed" : undefined,
        snapshotCompletedAt: state === "archived" ? new Date(10) : undefined,
      };
    },
    update: async () => {
      throw new Error("validate/publish must not update templates");
    },
    fork: async () => {
      throw new Error("validate/publish must not fork templates");
    },
    resume: async (id, input) => {
      calls.push(`resume:${id}:${String(input?.noEnv)}`);
      state = "ready";
      return { id: "resume_action", status: "accepted" };
    },
    stop: async (id) => {
      calls.push(`stop:${id}`);
      stopped = true;
      return { id: "stop_action", status: "accepted" };
    },
    remove: async () => {
      throw new Error("validate/publish must not delete templates");
    },
    command: async (_id, input) => {
      calls.push(`command:${input.command}`);
      if (input.command.startsWith("cat ")) return { success: true, exitCode: 0, stdout: manifest, stderr: "", timedOut: false };
      if (input.command.includes("node --version")) return { success: true, exitCode: 0, stdout: "v22.14.0\n", stderr: "", timedOut: false };
      if (input.command.includes("remote get-url")) return { success: true, exitCode: 0, stdout: "git@github.com:acme/service.git\n", stderr: "", timedOut: false };
      return { success: true, exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
    getLatestBoxSnapshot: async () => ({ id: "snap_latest", status: "completed", completedAt: stopped ? new Date(20) : new Date(10) }),
  };
  return { client, calls };
}

describe("Box template operator", () => {
  it("validates an archived template through snapshot metadata only", async () => {
    const { client, calls } = templateClient();
    const validated = await validateBoxTemplate(client, "bx_template", {
      expectedRepositoryPath: "/home/user/service",
    });

    expect(validated).toMatchObject({
      boxId: "bx_template",
      state: "archived",
      snapshot: { id: "snap_latest", status: "completed" },
    });
    expect(calls.some((call) => call.startsWith("command:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("resume:") || call.startsWith("stop:"))).toBe(false);
  });

  it("rejects a dirty/non-matching repository during the resumed publish checks without exposing command output", async () => {
    const { client, calls } = templateClient();
    client.command = async (_id, input) => {
      if (input.command.startsWith("cat ")) return { success: true, exitCode: 0, stdout: manifest, stderr: "", timedOut: false };
      if (input.command.includes("node --version")) return { success: true, exitCode: 0, stdout: "v22.14.0\n", stderr: "", timedOut: false };
      if (input.command.includes("remote get-url")) return { success: true, exitCode: 0, stdout: "https://github.com/other/repo.git\n", stderr: "", timedOut: false };
      return { success: false, exitCode: 1, stdout: "token=should-not-leak", stderr: "secret", timedOut: false };
    };
    await expect(publishBoxTemplate(client, "bx_template", { pollMs: 0, timeoutMs: 1_000 })).rejects.toThrow(
      /origin does not match/
    );
    // A failed post-resume runtime check leaves the ready template intact for
    // operator repair; it is neither deleted nor forced through a checkpoint.
    expect(calls.some((call) => call.startsWith("resume:"))).toBe(true);
    expect(calls.some((call) => call.startsWith("stop:"))).toBe(false);
  });

  it("publishes only after explicit confirmation and verifies a newer stop snapshot", async () => {
    const { client, calls } = templateClient();
    expect(() => requireTemplatePublishConfirmation(undefined)).toThrow(/--yes/);
    requireTemplatePublishConfirmation(true);

    const result = await publishBoxTemplate(client, "bx_template", {
      pollMs: 0,
      timeoutMs: 1_000,
      now: (() => {
        let now = 15;
        return () => now++;
      })(),
    });
    expect(result).toMatchObject({ snapshot: { id: "snap_latest", status: "completed" }, resumeActionId: "resume_action", stopActionId: "stop_action" });
    expect(calls).toContain("resume:bx_template:true");
    expect(calls).toContain("stop:bx_template");
    expect(calls.some((call) => call.includes("status --porcelain=v1"))).toBe(true);
    expect(calls.some((call) => call.includes(".aws/credentials"))).toBe(true);
    expect(calls.some((call) => call.includes("pgrep -f '[n]ode /home/user/task-orchestrator/dist/run-worker.js'"))).toBe(true);
  });
});
