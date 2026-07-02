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

  it("strips the mcp__task_orch__ prefix so interceptors match neutral names", () => {
    // Runtime contract: the SDK exposes in-process MCP tools to PreToolUse hooks
    // as `mcp__<server>__<tool>`. Orchestrator tools are themselves registered as
    // `task_orch__<name>`, so the hook sees a DOUBLED prefix
    // (`mcp__task_orch__task_orch__create_task`); planning tools are bare
    // (`mcp__task_orch__propose_spec`). Both must fold to the neutral names the
    // planning stage gates key on. (Previously this test fed the bare
    // `task_orch__create_task` — an input that never occurs at runtime.)
    expect(normalizeToolCall("mcp__task_orch__task_orch__create_task", { title: "x" })).toEqual({
      toolName: "task_orch__create_task",
      input: { title: "x" },
    });
    expect(normalizeToolCall("mcp__task_orch__propose_spec", { spec_markdown: "# s" })).toEqual({
      toolName: "propose_spec",
      input: { spec_markdown: "# s" },
    });
  });

  it("passes through a name with no mcp prefix unchanged", () => {
    expect(normalizeToolCall("task_orch__create_task", { title: "x" })).toEqual({
      toolName: "task_orch__create_task",
      input: { title: "x" },
    });
  });

  it("maps NotebookEdit notebook_path → path so the write sandbox runs", () => {
    // NotebookEdit folds to canonical Edit (a file tool), but the SDK passes the
    // path as `notebook_path`, not `file_path`. Surface it as `path` so the
    // sandbox containment check (which bails when path isn't a string) executes.
    expect(
      normalizeToolCall("NotebookEdit", { notebook_path: "/a/n.ipynb", new_source: "x" })
    ).toEqual({
      toolName: "edit",
      input: { notebook_path: "/a/n.ipynb", new_source: "x", path: "/a/n.ipynb" },
    });
  });

  it("de-normalizes a NotebookEdit path mutation back to notebook_path", () => {
    const original = { notebook_path: "/a/n.ipynb", new_source: "x" };
    const canonical = { new_source: "x", path: "/safe/n.ipynb" };
    expect(denormalizeToolInput("NotebookEdit", original, canonical)).toEqual({
      new_source: "x",
      notebook_path: "/safe/n.ipynb",
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
