import { describe, expect, it } from "vitest";
import { unansweredUserBacklogText, type MessageRow } from "../lib/runs";

// Prompt selection for a re-dispatched plan executor (and implement follow-ups):
// the UNANSWERED user backlog — messages newer than the last agent reply — is
// what a follow-up turn must receive as operator instructions. Before this,
// driveDispatchedRun's <execute> branch replayed only the FIRST user message,
// so "continue with merging" typed into a completed executor never reached the
// model.

function msg(id: number, role: MessageRow["role"], text: string): MessageRow {
  return {
    id,
    runId: 1,
    role,
    content: [{ type: "text", text }] as any,
    createdAt: new Date(),
  };
}

describe("unansweredUserBacklogText", () => {
  it("returns the follow-up message sent after the agent's last reply", () => {
    const msgs = [
      msg(1, "user", "fix merge conflicts with main in reviewed tasks"),
      msg(2, "agent", "Done. I resolved the merge conflicts."),
      msg(3, "user", "continue with merging"),
    ];
    expect(unansweredUserBacklogText(msgs)).toBe("continue with merging");
  });

  it("concatenates several piled-up follow-ups oldest-first", () => {
    const msgs = [
      msg(1, "user", "original instructions"),
      msg(2, "agent", "first reply"),
      msg(3, "user", "also do X"),
      msg(4, "user", "and Y"),
    ];
    expect(unansweredUserBacklogText(msgs)).toBe("also do X\n\nand Y");
  });

  it("returns the first message on a fresh run (no agent reply yet)", () => {
    const msgs = [msg(1, "user", "original instructions")];
    expect(unansweredUserBacklogText(msgs)).toBe("original instructions");
  });

  it("returns null when every user message has been answered", () => {
    const msgs = [
      msg(1, "user", "original instructions"),
      msg(2, "agent", "done"),
    ];
    expect(unansweredUserBacklogText(msgs)).toBeNull();
  });

  it("ignores system/tool rows and empty user messages", () => {
    const msgs = [
      msg(1, "user", "original instructions"),
      msg(2, "agent", "done"),
      msg(3, "system", "scaffold prompt"),
      msg(4, "tool", "tool output"),
      msg(5, "user", "   "),
    ];
    expect(unansweredUserBacklogText(msgs)).toBeNull();
  });
});
