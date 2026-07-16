import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { envScrubFactory } from "../../lib/extensions/env-scrub";
import { SECRET_ENV_DENYLIST } from "../../lib/agent-backend/env-scrub";
import { makeRegistrar } from "../helpers/fake-registrar";

describe("envScrubFactory", () => {
  it("prepends the unset prefix to bash commands", async () => {
    const r = makeRegistrar();
    envScrubFactory(r.reg);
    const result = (await r.fireToolCall({ toolName: "bash", input: { command: "ls" } })) as {
      input: { command: string };
    };
    expect(result.input.command.startsWith("unset ")).toBe(true);
    expect(result.input.command).toContain("DATABASE_URL");
    expect(result.input.command.endsWith("\nls")).toBe(true);
  });

  it("leaves non-bash tool calls untouched", async () => {
    const r = makeRegistrar();
    envScrubFactory(r.reg);
    const result = await r.fireToolCall({ toolName: "write", input: { path: "/work/foo.ts" } });
    expect(result).toBeUndefined();
  });

  it("leaves bash calls with a non-string command untouched", async () => {
    const r = makeRegistrar();
    envScrubFactory(r.reg);
    const result = await r.fireToolCall({ toolName: "bash", input: { command: undefined } });
    expect(result).toBeUndefined();
  });

  it("real end-to-end semantics: unset strips denylisted vars from bash children, keeps GH_TOKEN", () => {
    const r = makeRegistrar();
    envScrubFactory(r.reg);
    const mutated = r.fireToolCall({
      toolName: "bash",
      input: {
        command:
          "printenv DATABASE_URL; printenv TASK_ORCH_WORKER_CHANNEL_CREDENTIAL; printenv TASK_ORCH_WORKER_CHANNEL_ENDPOINT; printenv TASK_ORCH_WORKER_INSTANCE_ID; printenv GH_TOKEN",
      },
    }) as { input: { command: string } };

    const stdout = execFileSync("bash", ["-c", mutated.input.command], {
      env: {
        ...process.env,
        PATH: process.env.PATH,
        DATABASE_URL: "leak-me",
        TASK_ORCH_WORKER_CHANNEL_CREDENTIAL: "channel-credential-leak",
        TASK_ORCH_WORKER_CHANNEL_ENDPOINT: "channel-endpoint-leak",
        TASK_ORCH_WORKER_INSTANCE_ID: "instance-id-leak",
        GH_TOKEN: "keep-me",
      },
      encoding: "utf8",
    });

    expect(stdout).toContain("keep-me");
    expect(stdout).not.toContain("leak-me");
    expect(stdout).not.toContain("channel-credential-leak");
    expect(stdout).not.toContain("channel-endpoint-leak");
    expect(stdout).not.toContain("instance-id-leak");
  });

  it("real end-to-end: a child process spawned from the mutated command also lacks the secret", () => {
    const r = makeRegistrar();
    envScrubFactory(r.reg);
    const mutated = r.fireToolCall({
      toolName: "bash",
      input: {
        command:
          "bash -c 'printenv DATABASE_URL; printenv TASK_ORCH_WORKER_CHANNEL_CREDENTIAL; printenv TASK_ORCH_WORKER_CHANNEL_ENDPOINT; printenv TASK_ORCH_WORKER_INSTANCE_ID; printenv GH_TOKEN'",
      },
    }) as { input: { command: string } };

    const stdout = execFileSync("bash", ["-c", mutated.input.command], {
      env: {
        ...process.env,
        PATH: process.env.PATH,
        DATABASE_URL: "leak-me",
        TASK_ORCH_WORKER_CHANNEL_CREDENTIAL: "channel-credential-leak",
        TASK_ORCH_WORKER_CHANNEL_ENDPOINT: "channel-endpoint-leak",
        TASK_ORCH_WORKER_INSTANCE_ID: "instance-id-leak",
        GH_TOKEN: "keep-me",
      },
      encoding: "utf8",
    });

    expect(stdout).toContain("keep-me");
    expect(stdout).not.toContain("leak-me");
    expect(stdout).not.toContain("channel-credential-leak");
    expect(stdout).not.toContain("channel-endpoint-leak");
    expect(stdout).not.toContain("instance-id-leak");
  });

  it("covers every denylisted name in the emitted prefix", async () => {
    const r = makeRegistrar();
    envScrubFactory(r.reg);
    const result = (await r.fireToolCall({ toolName: "bash", input: { command: "ls" } })) as {
      input: { command: string };
    };
    for (const key of SECRET_ENV_DENYLIST) {
      expect(result.input.command).toContain(key);
    }
  });
});
