import { describe, expect, it } from "vitest";
import { sandboxFactory } from "../../lib/extensions/sandbox";
import { makeRegistrar } from "../helpers/fake-registrar";

describe("sandboxFactory", () => {
  it("blocks write outside cwd", async () => {
    const r = makeRegistrar();
    sandboxFactory("/work", "/sandbox/data.db")(r.reg);
    const result = await r.fireToolCall({ toolName: "write", input: { path: "/etc/passwd" } });
    expect(result).toEqual({ block: true, reason: expect.stringContaining("/work") });
  });

  it("allows write inside cwd", async () => {
    const r = makeRegistrar();
    sandboxFactory("/work", "/sandbox/data.db")(r.reg);
    const result = await r.fireToolCall({ toolName: "write", input: { path: "/work/src/foo.ts" } });
    expect(result).toBeUndefined();
  });

  it("allows write with relative path resolved inside cwd", async () => {
    const r = makeRegistrar();
    sandboxFactory("/work", "/sandbox/data.db")(r.reg);
    const result = await r.fireToolCall({ toolName: "write", input: { path: "src/foo.ts" } });
    expect(result).toBeUndefined();
  });

  it("blocks edit outside cwd", async () => {
    const r = makeRegistrar();
    sandboxFactory("/work", "/sandbox/data.db")(r.reg);
    const result = await r.fireToolCall({ toolName: "edit", input: { path: "/etc/hosts" } });
    expect(result).toEqual({ block: true, reason: expect.stringContaining("/work") });
  });

  it("rejects path-traversal escape via ..", async () => {
    const r = makeRegistrar();
    sandboxFactory("/work", "/sandbox/data.db")(r.reg);
    const result = await r.fireToolCall({ toolName: "write", input: { path: "/work/../etc/passwd" } });
    expect(result).toEqual({ block: true, reason: expect.stringContaining("/work") });
  });

  it("injects TASK_ORCH_DB into bash commands (returned as mutated input)", async () => {
    const r = makeRegistrar();
    sandboxFactory("/work", "/sandbox/data.db")(r.reg);
    const result = (await r.fireToolCall({ toolName: "bash", input: { command: "ls" } })) as {
      input: { command: string };
    };
    expect(result.input.command).toContain("export TASK_ORCH_DB='/sandbox/data.db'");
    expect(result.input.command).toContain("ls");
  });

  it("escapes single quotes in sandbox db path", async () => {
    const r = makeRegistrar();
    sandboxFactory("/work", "/sandbox/with'quote.db")(r.reg);
    const result = (await r.fireToolCall({ toolName: "bash", input: { command: "ls" } })) as {
      input: { command: string };
    };
    expect(result.input.command).toContain("'/sandbox/with'\\''quote.db'");
  });

  it("ignores non-string write paths", async () => {
    const r = makeRegistrar();
    sandboxFactory("/work", "/sandbox/data.db")(r.reg);
    const result = await r.fireToolCall({ toolName: "write", input: { path: undefined } });
    expect(result).toBeUndefined();
  });
});
