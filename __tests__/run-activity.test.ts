import { describe, expect, it } from "vitest";

import { summarizeRunActivity } from "../lib/run-activity";

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
});
