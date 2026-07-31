import { describe, expect, it, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  agentSessions,
  channelIdentities,
  channelThreads,
  memories,
  personas as personasTable,
  users,
} from "../db/schema";
import * as repo from "../lib/repo";

async function clear() {
  await db.delete(channelThreads);
  await db.delete(channelIdentities);
  await db.delete(memories);
  await db.delete(users);
}

async function freshUser(email: string): Promise<number> {
  const rows = await db.insert(users).values({ email, passwordHash: "x" }).returning();
  return rows[0].id;
}

async function ensurePersona(id: string): Promise<void> {
  await db
    .insert(personasTable)
    .values({ id, name: id, systemPrompt: "x", toolsProfile: "orchestrator" })
    .onConflictDoNothing();
}

async function freshRun(): Promise<number> {
  const rows = await db
    .insert(agentSessions)
    .values({ goal: "<chat>", status: "idle" })
    .returning({ id: agentSessions.id });
  return rows[0].id;
}

describe("channel identities", () => {
  beforeEach(clear);

  it("getChannelIdentity returns null when unlinked", async () => {
    expect(await repo.getChannelIdentity("discord", "1234")).toBeNull();
  });

  it("upsertChannelIdentity links an external account to a user", async () => {
    const userId = await freshUser("link@test.local");
    const row = await repo.upsertChannelIdentity({
      channel: "discord",
      externalUserId: "1234",
      userId,
      label: "someone#0",
    });
    expect(row.userId).toBe(userId);
    expect(row.label).toBe("someone#0");
    const found = await repo.getChannelIdentity("discord", "1234");
    expect(found!.id).toBe(row.id);
    expect(found!.userId).toBe(userId);
  });

  it("upsertChannelIdentity re-points an existing link instead of duplicating", async () => {
    const first = await freshUser("first@test.local");
    const second = await freshUser("second@test.local");
    const a = await repo.upsertChannelIdentity({
      channel: "discord",
      externalUserId: "1234",
      userId: first,
      label: "first",
    });
    const b = await repo.upsertChannelIdentity({
      channel: "discord",
      externalUserId: "1234",
      userId: second,
      label: "second",
    });
    expect(b.id).toBe(a.id);
    expect(b.userId).toBe(second);
    expect(b.label).toBe("second");
    expect(await db.select().from(channelIdentities)).toHaveLength(1);
  });

  it("the unique key is per (channel, externalUserId)", async () => {
    const userId = await freshUser("multi@test.local");
    await repo.upsertChannelIdentity({ channel: "discord", externalUserId: "1234", userId });
    await repo.upsertChannelIdentity({ channel: "slack", externalUserId: "1234", userId });
    expect((await repo.getChannelIdentity("discord", "1234"))!.channel).toBe("discord");
    expect((await repo.getChannelIdentity("slack", "1234"))!.channel).toBe("slack");
    expect(await repo.listChannelIdentitiesForUser(userId)).toHaveLength(2);
  });

  it("upsertChannelIdentity rejects empty channel / external user id", async () => {
    const userId = await freshUser("bad@test.local");
    await expect(
      repo.upsertChannelIdentity({ channel: "  ", externalUserId: "1", userId })
    ).rejects.toThrow(/Channel is required/);
    await expect(
      repo.upsertChannelIdentity({ channel: "discord", externalUserId: " ", userId })
    ).rejects.toThrow(/External user id is required/);
  });

  it("deleteChannelIdentity unlinks and reports whether a row was removed", async () => {
    const userId = await freshUser("unlink@test.local");
    await repo.upsertChannelIdentity({ channel: "discord", externalUserId: "1234", userId });
    expect(await repo.deleteChannelIdentity("discord", "1234")).toBe(true);
    expect(await repo.getChannelIdentity("discord", "1234")).toBeNull();
    expect(await repo.deleteChannelIdentity("discord", "1234")).toBe(false);
  });

  it("deleting the user cascades the identity away", async () => {
    const userId = await freshUser("cascade@test.local");
    await repo.upsertChannelIdentity({ channel: "discord", externalUserId: "1234", userId });
    await db.delete(users).where(eq(users.id, userId));
    expect(await repo.getChannelIdentity("discord", "1234")).toBeNull();
  });
});

describe("channel_threads persona dimension", () => {
  beforeEach(clear);

  it("defaults persona_id to implementor and leaves user_id null", async () => {
    await ensurePersona("implementor");
    const runId = await freshRun();
    const rows = await db
      .insert(channelThreads)
      .values({ channel: "discord", externalId: "c1", runId })
      .returning();
    expect(rows[0].personaId).toBe("implementor");
    expect(rows[0].userId).toBeNull();
  });

  it("two personas can hold separate conversations in one channel", async () => {
    await ensurePersona("implementor");
    await ensurePersona("qa");
    const a = await freshRun();
    const b = await freshRun();
    await db.insert(channelThreads).values({ channel: "discord", externalId: "c1", runId: a });
    await db
      .insert(channelThreads)
      .values({ channel: "discord", externalId: "c1", personaId: "qa", runId: b });
    const qaRow = (
      await db
        .select()
        .from(channelThreads)
        .where(
          and(eq(channelThreads.externalId, "c1"), eq(channelThreads.personaId, "qa"))
        )
    )[0];
    expect(qaRow.runId).toBe(b);
  });

  it("rejects a duplicate (channel, external_id, persona_id)", async () => {
    await ensurePersona("implementor");
    const a = await freshRun();
    const b = await freshRun();
    await db.insert(channelThreads).values({ channel: "discord", externalId: "c1", runId: a });
    await expect(
      db.insert(channelThreads).values({ channel: "discord", externalId: "c1", runId: b })
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("attributes a thread to a linked user", async () => {
    await ensurePersona("implementor");
    const userId = await freshUser("thread@test.local");
    const runId = await freshRun();
    const rows = await db
      .insert(channelThreads)
      .values({ channel: "discord", externalId: "c2", userId, runId })
      .returning();
    expect(rows[0].userId).toBe(userId);
  });
});

describe("memory scopes", () => {
  beforeEach(clear);

  it("accepts the persona and user scopes", async () => {
    const persona = await repo.createMemory({
      scope: "persona",
      scopeKey: "concierge",
      body: "Answers status-first, keeps replies short.",
      keywords: ["voice", "style"],
    });
    const user = await repo.createMemory({
      scope: "user",
      scopeKey: "7",
      body: "Prefers PR links over diffs.",
      keywords: ["preference"],
    });
    expect(persona.scope).toBe("persona");
    expect(persona.scopeKey).toBe("concierge");
    expect(user.scope).toBe("user");
    expect(user.scopeKey).toBe("7");
  });

  it("requires a scope key for the new scopes", async () => {
    await expect(repo.createMemory({ scope: "persona", body: "x" })).rejects.toThrow(
      /requires a scope key/
    );
    await expect(repo.createMemory({ scope: "user", body: "x" })).rejects.toThrow(
      /requires a scope key/
    );
  });

  it("persona and user memories do not leak across scope keys", async () => {
    await repo.createMemory({ scope: "persona", scopeKey: "concierge", body: "concierge fact" });
    await repo.createMemory({ scope: "persona", scopeKey: "qa", body: "qa fact" });
    await repo.createMemory({ scope: "user", scopeKey: "7", body: "user seven fact" });
    await repo.createMemory({ scope: "user", scopeKey: "8", body: "user eight fact" });

    const visible = await repo.listRecentMemories({
      scopes: [
        { scope: "persona", scopeKey: "concierge" },
        { scope: "user", scopeKey: "7" },
      ],
      limit: 50,
    });
    expect(visible.map((m) => m.body).sort()).toEqual(["concierge fact", "user seven fact"]);
  });

  it("searchMemories ranks within the visible persona/user scopes only", async () => {
    await repo.createMemory({
      scope: "user",
      scopeKey: "7",
      body: "Deploys on Fridays are fine.",
      keywords: ["deploy"],
    });
    await repo.createMemory({
      scope: "user",
      scopeKey: "8",
      body: "Never deploy on Fridays.",
      keywords: ["deploy"],
    });
    const hits = await repo.searchMemories({
      query: "deploy fridays",
      scopes: [{ scope: "user", scopeKey: "7" }],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].memory.body).toContain("are fine");
  });

  it("isMemoryScope guards the widened scope set", () => {
    expect(repo.MEMORY_SCOPES).toEqual(["global", "repo", "task", "persona", "user"]);
    expect(repo.isMemoryScope("persona")).toBe(true);
    expect(repo.isMemoryScope("user")).toBe(true);
    expect(repo.isMemoryScope("nonsense")).toBe(false);
  });
});
