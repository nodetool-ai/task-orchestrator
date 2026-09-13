import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../db";
import { agentMessages, agentSessions, runTurns } from "../db/schema";
import { getRunActivitySnapshot, summarizeRunActivity } from "../lib/run-activity";
import { create } from "../lib/runs";

beforeEach(async () => {
  await db.delete(agentSessions);
});

describe("run supervision activity", () => {
  it("reports tool-heavy progress and an in-flight command without exposing content", () => {
    const rows = [
      {
        id: 12,
        role: "agent",
        createdAt: new Date("2026-09-11T13:27:04Z"),
        content: JSON.stringify([
          {
            type: "tool_use",
            id: "tool-2",
            name: "Bash",
            input: { command: "secret-bearing command must not escape" },
          },
        ]),
      },
      {
        id: 11,
        role: "tool",
        createdAt: new Date("2026-09-11T13:27:01Z"),
        content: JSON.stringify([
          { type: "tool_result", tool_use_id: "tool-1", content: "private output" },
        ]),
      },
      {
        id: 10,
        role: "agent",
        createdAt: new Date("2026-09-11T13:26:58Z"),
        content: JSON.stringify([
          { type: "tool_use", id: "tool-1", name: "Edit", input: { path: "/private" } },
        ]),
      },
    ];

    const activity = summarizeRunActivity(
      rows,
      new Date("2026-09-11T13:27:34Z")
    );

    expect(activity).toMatchObject({
      last_worker_activity_at: "2026-09-11T13:27:04.000Z",
      last_agent_activity_at: "2026-09-11T13:27:04.000Z",
      last_tool_result_at: "2026-09-11T13:27:01.000Z",
      in_flight_tools: [
        {
          tool_use_id: "tool-2",
          tool_name: "Bash",
          started_at: "2026-09-11T13:27:04.000Z",
          message_id: 12,
          age_ms: 30_000,
        },
      ],
    });
    const encoded = JSON.stringify(activity);
    expect(encoded).not.toContain("secret-bearing");
    expect(encoded).not.toContain("private output");
    expect(encoded).not.toContain("/private");
  });

  it("does not count supervisor input as worker progress", () => {
    const activity = summarizeRunActivity([
      {
        id: 1,
        role: "user",
        createdAt: new Date("2026-09-11T13:00:00Z"),
        content: JSON.stringify([{ type: "text", text: "status now" }]),
      },
    ]);
    expect(activity.last_worker_activity_at).toBeNull();
  });

  it("does not carry an unmatched tool call across logical turns", () => {
    const rows = [
      {
        id: 13,
        role: "agent",
        createdAt: new Date("2026-09-12T10:00:01Z"),
        content: JSON.stringify([{ type: "text", text: "working on the new turn" }]),
      },
      {
        id: 12,
        role: "agent",
        createdAt: new Date("2026-09-11T13:27:04Z"),
        content: JSON.stringify([{ type: "tool_use", id: "old-tool", name: "Bash" }]),
      },
    ];

    const activity = summarizeRunActivity(
      rows,
      new Date("2026-09-12T10:00:30Z"),
      { startedAt: new Date("2026-09-12T10:00:00Z") },
    );

    expect(activity.in_flight_tools).toEqual([]);
    expect(activity.recent_activity.map((row) => row.message_id)).toEqual([12, 13]);
  });

  it("reports no in-flight tools when there is no unfinished current turn", () => {
    const activity = summarizeRunActivity([
      {
        id: 12,
        role: "agent",
        createdAt: new Date("2026-09-11T13:27:04Z"),
        content: JSON.stringify([{ type: "tool_use", id: "old-tool", name: "Bash" }]),
      },
    ], new Date("2026-09-12T10:00:30Z"), null);

    expect(activity.in_flight_tools).toEqual([]);
  });

  it("selects the unfinished turn for the run's current attempt", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const oldStartedAt = new Date("2026-09-11T13:00:00Z");
    const currentStartedAt = new Date("2026-09-12T10:00:00Z");
    await db.update(agentSessions).set({ attempt: 2, status: "running" })
      .where(eq(agentSessions.id, run.id));
    await db.insert(runTurns).values([
      {
        id: randomUUID(), runId: run.id, ordinal: 1, attempt: 1,
        state: "superseded", startedAt: oldStartedAt,
      },
      {
        id: randomUUID(), runId: run.id, ordinal: 2, attempt: 2,
        state: "active", startedAt: currentStartedAt,
      },
    ]);
    await db.insert(agentMessages).values([
      {
        runId: run.id, role: "agent", createdAt: new Date("2026-09-11T13:01:00Z"),
        content: JSON.stringify([{ type: "tool_use", id: "old-tool", name: "Bash" }]),
      },
      {
        runId: run.id, role: "agent", createdAt: new Date("2026-09-12T10:01:00Z"),
        content: JSON.stringify([{ type: "tool_use", id: "current-tool", name: "Edit" }]),
      },
    ]);

    const activity = await getRunActivitySnapshot(run.id);

    expect(activity.in_flight_tools).toMatchObject([
      { tool_use_id: "current-tool", tool_name: "Edit" },
    ]);
  });
});
