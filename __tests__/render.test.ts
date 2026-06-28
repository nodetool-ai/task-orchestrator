import { describe, expect, it } from "vitest";
import { TranscriptBuilder, chunkForDiscord } from "../lib/pipe/render";
import type { RunEnvelope } from "../lib/pi-event-mapper";

const assistant = (content: unknown[]): RunEnvelope =>
  ({ type: "assistant", message: { content } } as RunEnvelope);

describe("TranscriptBuilder tool lines", () => {
  it("wraps tool name + input in inline code so `__` in MCP names survives Discord markdown", () => {
    const b = new TranscriptBuilder();
    b.push(
      assistant([
        { type: "text", text: "Looking it up." },
        { type: "tool_use", name: "mcp__task_orch__task_orch__list_repositories", input: {} },
      ])
    );
    const out = b.text();
    expect(out).toContain("Looking it up.");
    // The full name is preserved verbatim inside backticks (no stripped `__`).
    expect(out).toContain("> 🔧 `mcp__task_orch__task_orch__list_repositories()`");
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
    expect(b.text()).toBe("> 🔧 `tool()`");
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
