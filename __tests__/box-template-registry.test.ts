import { describe, expect, it } from "vitest";
import { db } from "../db";
import { boxTemplates } from "../db/schema";

describe("box_templates schema", () => {
  it("inserts a building row and enforces one live row per sha", async () => {
    const sha = "f".repeat(39) + "1";
    const [row] = await db
      .insert(boxTemplates)
      .values({ workerSha: sha, repository: "nodetool-ai/nodetool", triggeringRunId: 1 })
      .returning();
    expect(row.state).toBe("building");
    await expect(
      db.insert(boxTemplates).values({ workerSha: sha, repository: "nodetool-ai/nodetool" })
    ).rejects.toThrow();
  });
});
