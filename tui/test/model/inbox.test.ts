import { describe, expect, it } from "vitest";
import type { GlobalInboxRow } from "../../src/api/types.js";
import { toInboxItems } from "../../src/model/inbox.js";

function row(over: Partial<GlobalInboxRow> = {}): GlobalInboxRow {
  return {
    id: "q45",
    runId: 45,
    personaId: "implementor",
    personaName: null,
    runTitle: "T-0006",
    kind: "question",
    type: "run.question",
    text: "Default backend — pi or claude?",
    prUrl: null,
    createdAt: "2026-08-22T10:00:00.000Z",
    ...over,
  };
}

describe("toInboxItems", () => {
  it("orders newest first regardless of the order it was handed", () => {
    const items = toInboxItems([
      row({ id: "a", createdAt: "2026-08-22T09:00:00.000Z" }),
      row({ id: "c", createdAt: "2026-08-22T11:00:00.000Z" }),
      row({ id: "b", createdAt: "2026-08-22T10:00:00.000Z" }),
    ]);
    expect(items.map((i) => i.id)).toEqual(["c", "b", "a"]);
  });

  it("resolves the persona and normalises the text", () => {
    expect(toInboxItems([row({ personaName: "Implementor" })])[0].persona).toBe("Implementor");
    expect(toInboxItems([row({ personaName: null, personaId: null })])[0].persona).toBe("agent");
    expect(toInboxItems([row({ text: "  two\n lines  " })])[0].text).toBe("two lines");
  });

  it("carries the PR url and the epoch timestamp through", () => {
    const item = toInboxItems([row({ kind: "review", prUrl: "https://github.com/o/r/pull/312" })])[0];
    expect(item).toMatchObject({ runId: 45, kind: "review", prUrl: "https://github.com/o/r/pull/312" });
    expect(item.at).toBe(Date.parse("2026-08-22T10:00:00.000Z"));
  });
});
