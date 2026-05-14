import { describe, expect, it } from "vitest";
import { sandboxFactory } from "../../lib/extensions/sandbox";

function makeStub() {
  const handlers = new Map<string, Function>();
  const pi: any = {
    on: (event: string, handler: Function) => { handlers.set(event, handler); },
    registerTool: () => {},
  };
  return { handlers, pi };
}

async function fireToolCall(handlers: Map<string, Function>, event: any) {
  const fn = handlers.get("tool_call");
  if (!fn) throw new Error("no tool_call handler");
  return fn(event, {});
}

describe("sandboxFactory", () => {
  it("blocks write outside cwd", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi);
    const result = await fireToolCall(handlers, {
      toolName: "write",
      input: { path: "/etc/passwd" },
    });
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("/work"),
    });
  });

  it("allows write inside cwd", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi);
    const result = await fireToolCall(handlers, {
      toolName: "write",
      input: { path: "/work/src/foo.ts" },
    });
    expect(result).toBeUndefined();
  });

  it("allows write with relative path resolved inside cwd", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi);
    const result = await fireToolCall(handlers, {
      toolName: "write",
      input: { path: "src/foo.ts" },
    });
    expect(result).toBeUndefined();
  });

  it("blocks edit outside cwd", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi);
    const result = await fireToolCall(handlers, {
      toolName: "edit",
      input: { path: "/etc/hosts" },
    });
    expect(result).toEqual({ block: true, reason: expect.stringContaining("/work") });
  });

  it("rejects path-traversal escape via ..", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi);
    const result = await fireToolCall(handlers, {
      toolName: "write",
      input: { path: "/work/../etc/passwd" },
    });
    expect(result).toEqual({ block: true, reason: expect.stringContaining("/work") });
  });

  it("injects TASK_ORCH_DB into bash commands", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi);
    const event = { toolName: "bash", input: { command: "ls" } };
    await fireToolCall(handlers, event);
    expect(event.input.command).toContain("export TASK_ORCH_DB='/sandbox/data.db'");
    expect(event.input.command).toContain("ls");
  });

  it("escapes single quotes in sandbox db path", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/with'quote.db")(pi);
    const event = { toolName: "bash", input: { command: "ls" } };
    await fireToolCall(handlers, event);
    expect(event.input.command).toContain("'/sandbox/with'\\''quote.db'");
  });

  it("ignores non-string write paths", async () => {
    const { handlers, pi } = makeStub();
    sandboxFactory("/work", "/sandbox/data.db")(pi);
    const result = await fireToolCall(handlers, {
      toolName: "write",
      input: { path: undefined },
    });
    expect(result).toBeUndefined();
  });
});
