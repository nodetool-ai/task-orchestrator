// __tests__/box-detached.test.ts
import { describe, expect, it, vi } from "vitest";
import type { BoxClient, BoxCommandResult } from "../lib/runner/box-client";
import { runDetachedBoxStep } from "../lib/runner/box-detached";

const ok: BoxCommandResult = { success: true, timedOut: false, exitCode: 0, stdout: "", stderr: "" };

function fakeClient(opts: { rc?: string; failLaunch?: boolean } = {}) {
  const commands: string[] = [];
  const client = {
    command: vi.fn(async (_id: string, input: { command: string }) => {
      commands.push(input.command);
      if (input.command.includes("setsid")) {
        if (opts.failLaunch) return { ...ok, exitCode: 1, stderr: "boom" };
        return { ...ok, stdout: "launched" };
      }
      if (input.command.includes(".rc")) return { ...ok, stdout: opts.rc ?? "0" };
      if (input.command.includes("tail -c")) return { ...ok, stdout: "some log tail" };
      return ok;
    }),
  } as unknown as BoxClient;
  return { client, commands };
}

const fast = { timeoutSeconds: 5, pollMs: 1, sleep: async () => {} };

describe("runDetachedBoxStep", () => {
  it("launches detached and resolves when the rc marker reads 0", async () => {
    const { client, commands } = fakeClient();
    await runDetachedBoxStep(client, "bx_1", "provisioning", "echo hi", fast);
    expect(commands[0]).toContain("setsid");
    expect(commands[0]).toContain("echo hi");
  });

  it("throws with the log tail when the step exits non-zero", async () => {
    const { client } = fakeClient({ rc: "1" });
    await expect(
      runDetachedBoxStep(client, "bx_1", "provisioning", "false", fast)
    ).rejects.toThrow(/provisioning failed \(exit 1\): some log tail/);
  });

  it("throws when the launch itself fails", async () => {
    const { client } = fakeClient({ failLaunch: true });
    await expect(
      runDetachedBoxStep(client, "bx_1", "provisioning", "true", fast)
    ).rejects.toThrow(/provisioning failed to launch/);
  });

  it("times out against the injected clock", async () => {
    let t = 0;
    const { client } = fakeClient({ rc: "__running__" });
    await expect(
      runDetachedBoxStep(client, "bx_1", "provisioning", "sleep 999", {
        ...fast,
        now: () => (t += 4_000),
      })
    ).rejects.toThrow(/provisioning timed out/);
  });
});
