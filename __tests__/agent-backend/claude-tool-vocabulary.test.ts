import { describe, expect, it } from "vitest";
import { __test } from "../../lib/agent-backend/claude-backend";

const { normalizeToolCall, denormalizeToolInput } = __test;

describe("Claude built-in tool vocabulary translation", () => {
  it("normalizes Write/Edit names and file_path → path", () => {
    expect(normalizeToolCall("Write", { file_path: "/a/b.ts", content: "x" })).toEqual({
      toolName: "write",
      input: { file_path: "/a/b.ts", content: "x", path: "/a/b.ts" },
    });
    expect(normalizeToolCall("Edit", { file_path: "/a/b.ts" }).toolName).toBe("edit");
  });

  it("normalizes Bash without touching command", () => {
    expect(normalizeToolCall("Bash", { command: "ls" })).toEqual({
      toolName: "bash",
      input: { command: "ls" },
    });
  });

  it("normalizes Read name and file_path → path", () => {
    expect(normalizeToolCall("Read", { file_path: "/a/b.ts" })).toEqual({
      toolName: "read",
      input: { file_path: "/a/b.ts", path: "/a/b.ts" },
    });
  });

  it("normalizes the search family to the shared vocabulary without remapping params", () => {
    // Grep/Glob already use `path`/`pattern` in both harnesses, so only the name folds.
    expect(normalizeToolCall("Grep", { pattern: "foo", path: "src" })).toEqual({
      toolName: "grep",
      input: { pattern: "foo", path: "src" },
    });
    expect(normalizeToolCall("Glob", { pattern: "**/*.ts" })).toEqual({
      toolName: "glob",
      input: { pattern: "**/*.ts" },
    });
  });

  it("passes through unrecognized (MCP / orchestrator) tools unchanged", () => {
    expect(normalizeToolCall("task_orch__create_task", { title: "x" })).toEqual({
      toolName: "task_orch__create_task",
      input: { title: "x" },
    });
  });

  it("de-normalizes a bash mutation back to the SDK input shape", () => {
    const original = { command: "ls" };
    const canonical = { command: "export X=1\nls" };
    expect(denormalizeToolInput("Bash", original, canonical)).toEqual({ command: "export X=1\nls" });
  });

  it("de-normalizes write mutations path → file_path", () => {
    const original = { file_path: "/a/b.ts", content: "x" };
    const canonical = { content: "x", path: "/a/c.ts" };
    expect(denormalizeToolInput("Write", original, canonical)).toEqual({
      content: "x",
      file_path: "/a/c.ts",
    });
  });
});
