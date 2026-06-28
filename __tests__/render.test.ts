import { describe, expect, it } from "vitest";
import { TranscriptBuilder, chunkForDiscord, prettyToolName } from "../lib/pipe/render";
import type { RunEnvelope } from "../lib/pi-event-mapper";

const assistant = (content: unknown[]): RunEnvelope =>
  ({ type: "assistant", message: { content } } as RunEnvelope);

describe("prettyToolName", () => {
  it("humanizes an MCP tool name, dropping the mcp__<server>__ noise", () => {
    expect(prettyToolName("mcp__task_orch__list_tasks")).toBe("list tasks");
  });

  it("drops a duplicated server prefix inside the tool name", () => {
    expect(prettyToolName("mcp__task_orch__task_orch__list_repositories")).toBe(
      "list repositories"
    );
  });

  it("handles other MCP servers", () => {
    expect(prettyToolName("mcp__github__create_issue")).toBe("create issue");
  });

  it("leaves builtin tool names untouched", () => {
    expect(prettyToolName("Bash")).toBe("Bash");
    expect(prettyToolName("ToolSearch")).toBe("ToolSearch");
  });
});

describe("TranscriptBuilder tool lines", () => {
  it("shows a humanized MCP tool name wrapped in inline code", () => {
    const b = new TranscriptBuilder();
    b.push(
      assistant([
        { type: "text", text: "Looking it up." },
        { type: "tool_use", name: "mcp__task_orch__task_orch__list_repositories", input: {} },
      ])
    );
    const out = b.text();
    expect(out).toContain("Looking it up.");
    expect(out).toContain("> 🔧 `list repositories`");
  });

  it("includes a summarized input inside the code span", () => {
    const b = new TranscriptBuilder();
    b.push(
      assistant([
        { type: "tool_use", name: "ToolSearch", input: { query: "select:mcp__task_orch__list_tasks" } },
      ])
    );
    expect(b.text()).toBe("> 🔧 `ToolSearch(select:mcp__task_orch__list_tasks)`");
  });

  it("omits empty parens when there is no input", () => {
    const b = new TranscriptBuilder();
    b.push(assistant([{ type: "tool_use", name: "mcp__task_orch__list_plans", input: {} }]));
    expect(b.text()).toBe("> 🔧 `list plans`");
  });

  it("sanitizes backticks in the input so they cannot break out of the code span", () => {
    const b = new TranscriptBuilder();
    b.push(
      assistant([{ type: "tool_use", name: "Bash", input: { command: "echo `whoami`" } }])
    );
    const out = b.text();
    expect(out.startsWith("> 🔧 `")).toBe(true);
    expect(out.endsWith("`")).toBe(true);
    // Exactly two backticks (the opening and closing of the span).
    expect((out.match(/`/g) ?? []).length).toBe(2);
  });

  it("falls back to `tool` when a tool_use block has no name", () => {
    const b = new TranscriptBuilder();
    b.push(assistant([{ type: "tool_use", input: {} }]));
    expect(b.text()).toBe("> 🔧 `tool`");
  });
});

describe("chunkForDiscord", () => {
  it("returns the text unchanged when under the limit", () => {
    expect(chunkForDiscord("hello", 2000)).toEqual(["hello"]);
  });

  it("splits long text into chunks under the limit", () => {
    const text = Array.from({ length: 50 }, (_, i) => `paragraph ${i}`).join("\n\n");
    const chunks = chunkForDiscord(text, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(60);
  });
});
