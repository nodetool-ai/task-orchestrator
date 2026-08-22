// What the verbs print. Two rules are load-bearing and easy to break by
// accident: `--json` is a document a program can parse (no ANSI, no padding),
// and the text form is one line per row with nothing drawn on it. The frame
// lines carry a third: `orch tail` must name a tool call exactly as the
// cockpit's `⎿` line does, because both go through model/frames.ts.

import { describe, expect, it } from "vitest";
import {
  floorJson,
  floorRows,
  floorText,
  frameJson,
  frameLine,
  inboxJson,
  inboxText,
  type Speaker,
} from "../../src/cli/format.js";
import { buildForest } from "../../src/model/forest.js";
import { framesFromMessages, type Frame } from "../../src/model/frames.js";
import { toInboxItems } from "../../src/model/inbox.js";
import type { GlobalInboxRow, MessageRow, RunIndexRow } from "../../src/api/types.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function row(over: Partial<RunIndexRow> & { id: number }): RunIndexRow {
  return {
    goal: "goal",
    status: "running",
    origin: "chat",
    title: `run ${over.id}`,
    taskId: null,
    taskTitle: null,
    planId: null,
    planTitle: null,
    repoId: null,
    repoName: null,
    parentRunId: null,
    prUrl: null,
    model: null,
    totalCostUsd: 0,
    error: null,
    startedAt: ago(10),
    completedAt: null,
    parkReason: null,
    pendingReason: null,
    pendingEvents: 0,
    personaId: "implementor",
    personaName: "Implementor",
    ...over,
  };
}

describe("floor", () => {
  const forest = buildForest([
    row({ id: 1, title: "orchestrate", personaName: "Concierge", totalCostUsd: 1.5 }),
    row({ id: 2, parentRunId: 1, title: "write the client", status: "completed", completedAt: ago(1) }),
    row({ id: 3, title: "old chat", status: "idle", startedAt: ago(600) }),
  ]);

  it("puts live subtrees first and keeps children under their parent", () => {
    expect(floorRows(forest).map((r) => [r.run.id, r.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
    ]);
  });

  it("prints one line per run, indented by depth, with no box drawing", () => {
    const lines = floorText(floorRows(forest), NOW);
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      // Box drawing and ANSI both belong to the cockpit, not to a pipe.
      expect(l).not.toMatch(/[\u2500-\u257f\u001b\n]/);
    }
    expect(lines[0]).toContain("#1");
    expect(lines[0]).toContain("running");
    expect(lines[0]).toContain("$1.50");
    expect(lines[0]).toMatch(/orchestrate$/);
    expect(lines[1]).toMatch(/ {2}write the client$/); // the child is indented
  });

  it("answers --json with the fields a script needs, not the rendering", () => {
    const json = floorJson(floorRows(forest)) as Array<Record<string, unknown>>;
    expect(JSON.parse(JSON.stringify(json))).toEqual(json); // plain data, no classes
    expect(json[0]).toMatchObject({ id: 1, depth: 0, persona: "Concierge", status: "running", costUsd: 1.5 });
    expect(json[1]).toMatchObject({ id: 2, parentId: 1, depth: 1, status: "done" });
  });
});

describe("inbox", () => {
  const rows: GlobalInboxRow[] = [
    {
      id: "q7",
      runId: 7,
      personaId: "reviewer",
      personaName: "Reviewer",
      runTitle: "review the PR",
      kind: "question",
      type: "run.question",
      text: "pi or\n  claude?",
      prUrl: null,
      createdAt: ago(3),
    },
  ];

  it("prints one line per item and collapses the text onto it", () => {
    const lines = inboxText(toInboxItems(rows), NOW);
    expect(lines).toEqual([expect.stringContaining("pi or claude?")]);
    expect(lines[0]).toContain("#7");
    expect(lines[0]).toContain("question");
    expect(lines[0]).not.toContain("\n");
  });

  it("answers --json with the item, not the line", () => {
    expect(inboxJson(toInboxItems(rows))).toEqual([
      { id: "q7", runId: 7, persona: "Reviewer", kind: "question", text: "pi or claude?", at: Date.parse(ago(3)), prUrl: null },
    ]);
  });
});

describe("frameLine", () => {
  const who: Speaker = { self: 44, persona: "implementor" };

  const messages: MessageRow[] = [
    { id: 1, runId: 44, role: "user", content: [{ type: "text", text: "use pi" }], createdAt: ago(9) },
    { id: 2, runId: 44, role: "agent", content: [{ type: "text", text: "on it" }], createdAt: ago(8) },
    {
      id: 3,
      runId: 44,
      role: "agent",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }],
      createdAt: ago(7),
    },
  ];

  it("is the cockpit's own one-line tool format, without the colour", () => {
    const frames = framesFromMessages(messages);
    expect(frames.map((f) => frameLine(f, who))).toEqual([
      "> use pi",
      "implementor: on it",
      "  ⎿ npm test", // views/chat.tsx paints exactly this string, dimmed
    ]);
  });

  it("names a foreign run by id and keeps every frame on one line", () => {
    const child: Frame = { kind: "agent", at: NOW, run: 45, text: "done\nwith it" };
    expect(frameLine(child, who)).toBe("#45: done with it");
    expect(frameLine({ kind: "event", at: NOW, run: 44, text: "completed", tone: "ok" }, who)).toBe("  · completed");
    expect(frameLine({ kind: "spawn", at: NOW, run: 44, children: [51, 52] }, who)).toBe("  ⎿ spawned #51 #52");
  });

  it("shows a question and the answer that settled it", () => {
    const q: Frame = { kind: "question", at: NOW, run: 44, text: "pi or claude?" };
    expect(frameLine(q, who)).toBe("⚑ implementor asks: pi or claude?");
    expect(frameLine({ ...q, answered: "pi" }, who)).toBe("⚑ implementor asks: pi or claude? ↳ you: pi");
  });

  it("answers --json with the frame plus who said it", () => {
    expect(frameJson({ kind: "tool", at: NOW, run: 44, text: "npm test", detail: ["exit 0"] }, who)).toEqual({
      kind: "tool",
      at: NOW,
      run: 44,
      text: "npm test",
      detail: ["exit 0"],
      persona: "implementor",
    });
    // A user frame carries no run of its own; it belongs to the tailed run.
    expect(frameJson({ kind: "user", at: NOW, text: "use pi" }, who)).toMatchObject({ run: 44, persona: "implementor" });
  });
});
