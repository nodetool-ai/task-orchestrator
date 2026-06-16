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

  it("passes through unknown tools unchanged", () => {
    expect(normalizeToolCall("Read", { file_path: "x" })).toEqual({
      toolName: "Read",
      input: { file_path: "x" },
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
