import { describe, expect, it } from "vitest";
import {
  TranscriptBuilder,
  chunkForDiscord,
  convertMarkdownTables,
} from "../lib/pipe/render";
import type { RunEnvelope } from "../lib/pi-event-mapper";

const assistant = (content: unknown[]): RunEnvelope =>
  ({ type: "assistant", message: { content } } as RunEnvelope);

describe("TranscriptBuilder tool collapsing", () => {
  it("collapses multiple tool calls in one message into a single counter line", () => {
    const b = new TranscriptBuilder();
    b.push(
      assistant([
        { type: "text", text: "Looking it up." },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
        { type: "tool_use", name: "Read", input: { file_path: "/tmp/a" } },
        { type: "tool_use", name: "mcp__task_orch__list_repositories", input: {} },
      ])
    );
    expect(b.text()).toBe("Looking it up.\n\n> 🔧 3 tools called");
  });

  it("collapses consecutive tool-only assistant messages into a single counter", () => {
    const b = new TranscriptBuilder();
    b.push(assistant([{ type: "tool_use", name: "Bash", input: { command: "ls" } }]));
    b.push(assistant([{ type: "tool_use", name: "Read", input: { file_path: "/tmp/a" } }]));
    b.push(assistant([{ type: "tool_use", name: "Bash", input: { command: "pwd" } }]));
    expect(b.text()).toBe("> 🔧 3 tools called");
  });

  it("flushes the pending counter when a text-bearing assistant message arrives", () => {
    const b = new TranscriptBuilder();
    b.push(assistant([{ type: "tool_use", name: "Bash", input: { command: "ls" } }]));
    b.push(assistant([{ type: "tool_use", name: "Bash", input: { command: "pwd" } }]));
    b.push(assistant([{ type: "text", text: "Done." }]));
    expect(b.text()).toBe("> 🔧 2 tools called\n\nDone.");
  });

  it("uses singular wording for a single tool call", () => {
    const b = new TranscriptBuilder();
    b.push(assistant([{ type: "tool_use", name: "Bash", input: { command: "ls" } }]));
    expect(b.text()).toBe("> 🔧 1 tool called");
  });

  it("renders nothing for an assistant message with no text and no tools", () => {
    const b = new TranscriptBuilder();
    b.push(assistant([]));
    expect(b.text()).toBe("");
  });
});

describe("convertMarkdownTables", () => {
  it("converts a GFM table into a Discord-renderable bullet list", () => {
    const md = [
      "| Name  | Status  |",
      "| ----- | ------- |",
      "| build | ok      |",
      "| test  | failing |",
    ].join("\n");
    const out = convertMarkdownTables(md);
    expect(out).not.toContain("|");
    expect(out).toContain("- **build** · Status: ok");
    expect(out).toContain("- **test** · Status: failing");
  });

  it("renders a single-column table as a plain bullet list", () => {
    const md = ["| Item |", "| ---- |", "| a |", "| b |"].join("\n");
    const out = convertMarkdownTables(md);
    expect(out).not.toContain("|");
    expect(out).toContain("- a");
    expect(out).toContain("- b");
  });

  it("leaves surrounding prose intact", () => {
    const md = ["Before.", "", "| A | B |", "| - | - |", "| 1 | 2 |", "", "After."].join("\n");
    const out = convertMarkdownTables(md);
    expect(out.startsWith("Before.")).toBe(true);
    expect(out.endsWith("After.")).toBe(true);
    expect(out).toContain("- **1** · B: 2");
  });

  it("leaves text without tables untouched", () => {
    expect(convertMarkdownTables("just prose\nwith | a pipe")).toBe("just prose\nwith | a pipe");
  });
});

describe("TranscriptBuilder table handling", () => {
  it("converts markdown tables in assistant text to bullet lists", () => {
    const b = new TranscriptBuilder();
    b.push(
      assistant([{ type: "text", text: "Results:\n\n| A | B |\n| - | - |\n| 1 | 2 |" }])
    );
    const out = b.text();
    expect(out).not.toContain("|");
    expect(out).toContain("- **1** · B: 2");
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
