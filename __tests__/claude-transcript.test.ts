import { describe, expect, it } from "vitest";
import {
  mapTranscriptEntry,
  parseTranscriptChunk,
} from "../lib/claude-transcript";

// Fixture shapes copied from a real Claude Code 2.1.x transcript
// (~/.claude/projects/<cwd>/<session-id>.jsonl), trimmed for brevity.

const PROMPT = "You are an autonomous coding agent working on task T-1.\n\n# Do it";

function opts(over: Partial<{ initialPrompt: string }> = {}) {
  return {
    initialPrompt: over.initialPrompt ?? PROMPT,
    seenUuids: new Set<string>(),
  };
}

function assistantEntry(over: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid: "a-1",
    isSidechain: false,
    parentUuid: null,
    sessionId: "s-1",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Working on it." }],
    },
    ...over,
  };
}

describe("mapTranscriptEntry", () => {
  it("maps assistant text entries to assistant envelopes", () => {
    const envs = mapTranscriptEntry(assistantEntry(), opts());
    expect(envs).toEqual([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Working on it." }] },
      },
    ]);
  });

  it("passes tool_use blocks through unchanged", () => {
    const block = {
      type: "tool_use",
      id: "toolu_01DMckiUVhyHX9DtJKex466Q",
      name: "Bash",
      input: { command: "ls" },
    };
    const envs = mapTranscriptEntry(
      assistantEntry({ message: { role: "assistant", content: [block] } }),
      opts()
    );
    expect(envs).toHaveLength(1);
    expect((envs[0] as any).message.content[0]).toEqual(block);
  });

  it("maps user tool_result entries to user envelopes", () => {
    const entry = {
      type: "user",
      uuid: "u-1",
      isSidechain: false,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            content: "file1\nfile2",
            is_error: false,
          },
        ],
      },
    };
    const envs = mapTranscriptEntry(entry, opts());
    expect(envs).toHaveLength(1);
    expect(envs[0].type).toBe("user");
    expect((envs[0] as any).message.content[0].tool_use_id).toBe("toolu_01");
  });

  it("skips the echoed initial prompt", () => {
    const entry = {
      type: "user",
      uuid: "u-2",
      message: { role: "user", content: PROMPT },
    };
    expect(mapTranscriptEntry(entry, opts())).toEqual([]);
  });

  it("emits plain user text typed by an attached human", () => {
    const entry = {
      type: "user",
      uuid: "u-3",
      message: { role: "user", content: "push" },
    };
    const envs = mapTranscriptEntry(entry, opts());
    expect(envs).toEqual([
      { type: "user", message: { content: [{ type: "text", text: "push" }] } },
    ]);
  });

  it("skips local slash-command echoes", () => {
    const entry = {
      type: "user",
      uuid: "u-4",
      message: {
        role: "user",
        content:
          "<command-message>impeccable</command-message>\n<command-name>/impeccable</command-name>",
      },
    };
    expect(mapTranscriptEntry(entry, opts())).toEqual([]);
  });

  it("skips sidechain (subagent) entries", () => {
    expect(
      mapTranscriptEntry(assistantEntry({ isSidechain: true }), opts())
    ).toEqual([]);
  });

  it("skips isMeta skill injections", () => {
    const entry = {
      type: "user",
      uuid: "u-5",
      isMeta: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "Base directory for this skill: …" }],
      },
    };
    expect(mapTranscriptEntry(entry, opts())).toEqual([]);
  });

  it("skips non-message entry types", () => {
    for (const type of [
      "summary",
      "system",
      "file-history-snapshot",
      "permission-mode",
      "last-prompt",
      "attachment",
    ]) {
      expect(mapTranscriptEntry({ type, uuid: `x-${type}` }, opts())).toEqual([]);
    }
  });

  it("dedupes by uuid across calls", () => {
    const o = opts();
    expect(mapTranscriptEntry(assistantEntry(), o)).toHaveLength(1);
    expect(mapTranscriptEntry(assistantEntry(), o)).toEqual([]);
  });

  it("tolerates junk input", () => {
    expect(mapTranscriptEntry(null, opts())).toEqual([]);
    expect(mapTranscriptEntry("nope", opts())).toEqual([]);
    expect(mapTranscriptEntry({ type: "user" }, opts())).toEqual([]);
  });
});

describe("parseTranscriptChunk", () => {
  it("parses complete lines and carries the partial tail", () => {
    const { entries, carry } = parseTranscriptChunk(
      '{"a":1}\n{"b":2}\n{"c":',
      ""
    );
    expect(entries).toEqual([{ a: 1 }, { b: 2 }]);
    expect(carry).toBe('{"c":');
  });

  it("completes a line across chunks via carry", () => {
    const first = parseTranscriptChunk('{"a":', "");
    expect(first.entries).toEqual([]);
    const second = parseTranscriptChunk('1}\n', first.carry);
    expect(second.entries).toEqual([{ a: 1 }]);
    expect(second.carry).toBe("");
  });

  it("skips blank and corrupt complete lines", () => {
    const { entries } = parseTranscriptChunk('\n\nnot json\n{"ok":true}\n', "");
    expect(entries).toEqual([{ ok: true }]);
  });
});
