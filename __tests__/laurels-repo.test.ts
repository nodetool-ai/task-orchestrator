import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../db";
import { agentSessions, laurels as laurelsTable, personas as personasTable } from "../db/schema";
import * as repo from "../lib/repo";

describe("laurels & seat records", () => {
  beforeEach(async () => {
    await db.delete(laurelsTable);
    await db.delete(agentSessions);
    await db.delete(personasTable);
    await db.insert(personasTable).values({
      id: "reviewer", name: "Reviewer", systemPrompt: "x",
      toolsProfile: "repo_read",
    });
  });

  it("createLaurel trims the body and defaults the author", async () => {
    const laurel = await repo.createLaurel({ personaId: "reviewer", body: "  great catch!  " });
    expect(laurel.body).toBe("great catch!");
    expect(laurel.author).toBe("user");
    expect(laurel.deliveredAt).toBeNull();
  });

  it("createLaurel rejects an empty body and an unknown persona", async () => {
    await expect(repo.createLaurel({ personaId: "reviewer", body: "   " }))
      .rejects.toThrow(/required/);
    await expect(repo.createLaurel({ personaId: "nobody", body: "hi" }))
      .rejects.toThrow(/not found/);
  });

  it("listLaurels returns newest first and can filter to undelivered", async () => {
    const a = await repo.createLaurel({ personaId: "reviewer", body: "first" });
    const b = await repo.createLaurel({ personaId: "reviewer", body: "second" });
    await repo.markLaurelsDelivered([a.id]);

    const all = await repo.listLaurels({ personaId: "reviewer" });
    expect(all.map((l) => l.body)).toEqual(["second", "first"]);

    const fresh = await repo.listLaurels({ personaId: "reviewer", undeliveredOnly: true });
    expect(fresh.map((l) => l.id)).toEqual([b.id]);
  });

  it("markLaurelsDelivered stamps only the given ids", async () => {
    const a = await repo.createLaurel({ personaId: "reviewer", body: "one" });
    await repo.createLaurel({ personaId: "reviewer", body: "two" });
    await repo.markLaurelsDelivered([a.id]);
    const fresh = await repo.listLaurels({ personaId: "reviewer", undeliveredOnly: true });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].body).toBe("two");
  });

  it("getSeatRecord aggregates runs, PRs, and laurels for the persona", async () => {
    await db.insert(agentSessions).values([
      { personaId: "reviewer", status: "completed", prUrl: "https://github.com/x/y/pull/1" },
      { personaId: "reviewer", status: "completed" },
      { personaId: "reviewer", status: "failed" },
      // Another persona's run must not count.
      { personaId: null, status: "completed" },
    ]);
    await repo.createLaurel({ personaId: "reviewer", body: "nice" });

    const seat = await repo.getSeatRecord("reviewer");
    expect(seat).not.toBeNull();
    expect(seat!.name).toBe("Reviewer");
    expect(seat!.runsTotal).toBe(3);
    expect(seat!.runsCompleted).toBe(2);
    expect(seat!.prsOpened).toBe(1);
    expect(seat!.laurelsTotal).toBe(1);
    expect(seat!.seatSince).toBeInstanceOf(Date);
  });

  it("getSeatRecord returns null for an unknown persona", async () => {
    expect(await repo.getSeatRecord("nobody")).toBeNull();
  });
});
