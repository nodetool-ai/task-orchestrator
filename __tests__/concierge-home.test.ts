// Pure selection behind the concierge homepage: which conversations home
// offers, what outcome-level state each one carries, and the single pulse line.
import { describe, expect, it } from "vitest";

import {
  READY_WINDOW_MS,
  conversationPulse,
  selectConversations,
} from "@/lib/concierge-home";
import type { RunIndexRow } from "@/lib/run-index";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");

function row(overrides: Partial<RunIndexRow> & { id: number }): RunIndexRow {
  return {
    goal: "<chat>",
    status: "idle",
    origin: "chat",
    title: null,
    taskId: null,
    taskTitle: null,
    planId: null,
    planTitle: null,
    repoId: null,
    repoName: null,
    personaId: null,
    personaName: null,
    parentRunId: null,
    prUrl: null,
    model: null,
    budgetMaxUsd: null,
    budgetMaxTurns: null,
    totalCostUsd: null,
    error: null,
    startedAt: new Date(NOW).toISOString(),
    completedAt: null,
    parkReason: null,
    pendingReason: null,
    pendingEvents: 0,
    ...overrides,
  } as RunIndexRow;
}

describe("selectConversations", () => {
  it("offers chat runs only — delegated agent runs are not conversations", () => {
    const cards = selectConversations(
      [
        row({ id: 1, title: "Ship the beta" }),
        row({ id: 2, goal: "<implement>", taskTitle: "Fix login" }),
      ],
      { now: NOW }
    );
    expect(cards.map((c) => c.id)).toEqual([1]);
    expect(cards[0].title).toBe("Ship the beta");
  });

  it("counts delegated work without listing one row per specialist", () => {
    const cards = selectConversations(
      [
        row({ id: 1, title: "Ship the beta" }),
        row({ id: 2, goal: "<implement>", parentRunId: 1, status: "completed" }),
        row({ id: 3, goal: "<review>", parentRunId: 2, status: "completed" }),
      ],
      { now: NOW }
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].delegated).toBe(2);
  });

  it("reports a failed specialist as Needs you, outranking running siblings", () => {
    const [card] = selectConversations(
      [
        row({ id: 1, title: "Ship the beta" }),
        row({ id: 2, goal: "<implement>", parentRunId: 1, status: "running" }),
        row({ id: 3, goal: "<review>", parentRunId: 1, status: "failed" }),
      ],
      { now: NOW }
    );
    expect(card.state).toBe("needs_you");
    expect(card.stateLabel).toBe("Needs you");
  });

  it("reports active delegated work as In motion", () => {
    const [card] = selectConversations(
      [
        row({ id: 1 }),
        row({ id: 2, goal: "<implement>", parentRunId: 1, status: "running" }),
      ],
      { now: NOW }
    );
    expect(card.state).toBe("in_motion");
  });

  it("reports a fresh completed delegation as Ready and lets it go quiet", () => {
    const rows = [
      row({ id: 1 }),
      row({
        id: 2,
        goal: "<implement>",
        parentRunId: 1,
        status: "completed",
        startedAt: new Date(NOW - 1000).toISOString(),
      }),
    ];
    expect(selectConversations(rows, { now: NOW })[0].state).toBe("ready");
    expect(
      selectConversations(rows, { now: NOW + READY_WINDOW_MS + 1000 })[0].state
    ).toBe("quiet");
  });

  it("wears no badge when the conversation has never delegated anything", () => {
    const [card] = selectConversations([row({ id: 1 })], { now: NOW });
    expect(card.state).toBe("quiet");
    expect(card.stateLabel).toBeNull();
  });

  it("lifts attention to the top, then orders by most recent activity", () => {
    const cards = selectConversations(
      [
        row({ id: 1, startedAt: new Date(NOW - 60_000).toISOString() }),
        row({ id: 2, startedAt: new Date(NOW - 30_000).toISOString() }),
        row({ id: 3, startedAt: new Date(NOW - 90_000).toISOString() }),
        row({ id: 4, goal: "<implement>", parentRunId: 3, status: "failed" }),
      ],
      { now: NOW }
    );
    expect(cards.map((c) => c.id)).toEqual([3, 2, 1]);
  });

  it("caps the list", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ id: i + 1 }));
    expect(selectConversations(rows, { now: NOW })).toHaveLength(6);
    expect(selectConversations(rows, { now: NOW, limit: 3 })).toHaveLength(3);
  });
});

describe("conversationPulse", () => {
  it("counts across every conversation, not just the rendered ones", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row({ id: i + 1 })),
      row({ id: 100, goal: "<implement>", parentRunId: 1, status: "failed" }),
      row({ id: 101, goal: "<implement>", parentRunId: 2, status: "running" }),
      row({ id: 102, goal: "<implement>", parentRunId: 3, status: "running" }),
    ];
    expect(conversationPulse(rows, { now: NOW })).toEqual({
      needsYou: 1,
      inMotion: 2,
      total: 10,
    });
  });

  it("is all zeros with no conversations", () => {
    expect(conversationPulse([], { now: NOW })).toEqual({
      needsYou: 0,
      inMotion: 0,
      total: 0,
    });
  });
});
