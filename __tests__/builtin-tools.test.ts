import { describe, expect, it } from "vitest";
import {
  canonicalToolName,
  interceptorToolName,
  isFileTool,
  TOOL_INPUT_KEYS,
} from "../lib/builtin-tools";

describe("canonicalToolName", () => {
  it("maps pi lowercase names to canonical identities", () => {
    expect(canonicalToolName("read")).toBe("Read");
    expect(canonicalToolName("grep")).toBe("Grep");
    expect(canonicalToolName("find")).toBe("Glob");
    expect(canonicalToolName("ls")).toBe("LS");
  });

  it("maps Claude TitleCase names to the same identities", () => {
    expect(canonicalToolName("Read")).toBe("Read");
    expect(canonicalToolName("Grep")).toBe("Grep");
    expect(canonicalToolName("Glob")).toBe("Glob");
    expect(canonicalToolName("MultiEdit")).toBe("Edit");
  });

  it("folds NotebookEdit into the Edit family (premise of the notebook write-sandbox fix)", () => {
    // NotebookEdit must resolve to canonical Edit so the sandbox interceptor
    // treats its path as a file-write target; the backend then maps
    // notebook_path → path so containment actually runs.
    expect(canonicalToolName("NotebookEdit")).toBe("Edit");
  });

  it("collapses both harnesses' search tools to one identity", () => {
    expect(canonicalToolName("find")).toBe(canonicalToolName("Glob"));
    expect(canonicalToolName("grep")).toBe(canonicalToolName("Grep"));
  });

  it("returns null for MCP / orchestrator tools and empties", () => {
    expect(canonicalToolName("task_orch__create_task")).toBeNull();
    expect(canonicalToolName(undefined)).toBeNull();
    expect(canonicalToolName("")).toBeNull();
  });
});

describe("interceptorToolName", () => {
  it("folds built-ins from either harness to one lowercase vocabulary", () => {
    expect(interceptorToolName("Glob")).toBe("glob");
    expect(interceptorToolName("find")).toBe("glob");
    expect(interceptorToolName("Read")).toBe("read");
    expect(interceptorToolName("ls")).toBe("ls");
  });

  it("passes unrecognized tool names through untouched", () => {
    expect(interceptorToolName("task_orch__create_task")).toBe("task_orch__create_task");
    expect(interceptorToolName("mcp__server__thing")).toBe("mcp__server__thing");
    // The SDK MCP prefix is stripped by the Claude backend (normalizeToolCall)
    // BEFORE this seam runs, so interceptorToolName itself leaves the fully
    // namespaced name untouched — it only folds recognized built-ins.
    expect(interceptorToolName("mcp__task_orch__propose_spec")).toBe("mcp__task_orch__propose_spec");
  });
});

describe("isFileTool", () => {
  it("is true only for the Read/Write/Edit family", () => {
    expect(isFileTool("read")).toBe(true);
    expect(isFileTool("Write")).toBe(true);
    expect(isFileTool("MultiEdit")).toBe(true);
    expect(isFileTool("NotebookEdit")).toBe(true);
    expect(isFileTool("grep")).toBe(false);
    expect(isFileTool("Glob")).toBe(false);
    expect(isFileTool("bash")).toBe(false);
  });
});

describe("TOOL_INPUT_KEYS", () => {
  it("covers both harnesses' param names for file tools", () => {
    expect(TOOL_INPUT_KEYS.Read).toContain("file_path");
    expect(TOOL_INPUT_KEYS.Read).toContain("path");
  });
});
