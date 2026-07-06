import { describe, expect, it } from "vitest";
import { toolPolicyFactory } from "../../lib/extensions/tool-policy";
import { makeRegistrar } from "../helpers/fake-registrar";

describe("toolPolicyFactory", () => {
  it("blocks disallowed built-ins regardless of raw-name casing", async () => {
    const r = makeRegistrar();
    toolPolicyFactory(["Bash", "Read", "Write", "Edit", "Grep", "Glob", "LS"])(r.reg);

    const lower = (await r.fireToolCall({ toolName: "bash", input: { command: "ls" } })) as {
      block: true;
      reason: string;
    };
    expect(lower.block).toBe(true);
    expect(typeof lower.reason).toBe("string");

    const titleCase = (await r.fireToolCall({ toolName: "Bash", input: { command: "ls" } })) as {
      block: true;
      reason: string;
    };
    expect(titleCase.block).toBe(true);
    expect(typeof titleCase.reason).toBe("string");

    const read = (await r.fireToolCall({ toolName: "read", input: { path: "/tmp/x" } })) as {
      block: true;
      reason: string;
    };
    expect(read.block).toBe(true);
    expect(typeof read.reason).toBe("string");
  });

  it("allows tools not in the denylist", async () => {
    const r = makeRegistrar();
    toolPolicyFactory(["Bash", "Read", "Write", "Edit", "Grep", "Glob", "LS"])(r.reg);

    const webfetch = await r.fireToolCall({ toolName: "webfetch", input: { url: "https://x" } });
    expect(webfetch).toBeUndefined();

    const orchestratorTool = await r.fireToolCall({
      toolName: "task_orch__create_task",
      input: {},
    });
    expect(orchestratorTool).toBeUndefined();
  });

  it("registers no interceptor when the denylist is empty", () => {
    const r = makeRegistrar();
    toolPolicyFactory([])(r.reg);
    expect(r.interceptors.length).toBe(0);
  });
});
