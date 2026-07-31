// Repo accessors for the DB half of the Discord bot config (Settings → Discord).
//
// The interesting behaviour is not CRUD-for-its-own-sake: it is that persona_id
// is the key (saving twice edits one bot, never stacks two gateway connections),
// that a partial update KEEPS the stored token (the UI never holds it), and that
// the user allowlist is derived from linked identities rather than stored here.

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import {
  channelIdentities,
  discordBots,
  personas as personasTable,
  users,
} from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import * as repo from "../lib/repo";

const ARIA = "aria";
const REX = "rex";

beforeEach(async () => {
  await db.delete(discordBots);
  await db.delete(channelIdentities);
  await db.delete(users);
  for (const id of [ARIA, REX]) {
    await db
      .insert(personasTable)
      .values({ id, name: id.toUpperCase(), systemPrompt: "x", toolsProfile: "orchestrator" })
      .onConflictDoNothing();
  }
  await seedPersonas();
});

async function freshUser(email: string): Promise<number> {
  return (await db.insert(users).values({ email, passwordHash: "x" }).returning())[0].id;
}

describe("discord bot rows", () => {
  it("upserts a bot and reads its channel list back as an array", async () => {
    const row = await repo.upsertDiscordBot({
      personaId: ARIA,
      token: "tok-aria",
      applicationId: "app-1",
      allowedChannels: ["c1", "c2"],
    });
    expect(row).toMatchObject({
      personaId: ARIA,
      token: "tok-aria",
      applicationId: "app-1",
      enabled: true,
    });
    expect(row.allowedChannels).toEqual(["c1", "c2"]);
    expect((await repo.getDiscordBot(ARIA))?.allowedChannels).toEqual(["c1", "c2"]);
  });

  it("keys on persona id — a second upsert replaces rather than duplicates", async () => {
    await repo.upsertDiscordBot({ personaId: ARIA, token: "first" });
    await repo.upsertDiscordBot({ personaId: ARIA, token: "second", enabled: false });
    const rows = await repo.listDiscordBots();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token: "second", enabled: false });
  });

  it("trims and de-duplicates channel entries", async () => {
    const row = await repo.upsertDiscordBot({
      personaId: ARIA,
      token: "t",
      allowedChannels: [" c1 ", "c1", "", "c2"],
    });
    expect(row.allowedChannels).toEqual(["c1", "c2"]);
  });

  it("rejects an empty token and an unknown persona", async () => {
    await expect(repo.upsertDiscordBot({ personaId: ARIA, token: "  " })).rejects.toThrow(/token/i);
    await expect(repo.upsertDiscordBot({ personaId: "nobody", token: "t" })).rejects.toThrow(
      /not found/i
    );
  });

  it("keeps the stored token when an update omits it", async () => {
    await repo.upsertDiscordBot({ personaId: ARIA, token: "secret", allowedChannels: ["c1"] });
    const updated = await repo.updateDiscordBot(ARIA, { allowedChannels: ["c9"], enabled: false });
    expect(updated).toMatchObject({ token: "secret", enabled: false });
    expect(updated?.allowedChannels).toEqual(["c9"]);
  });

  it("returns null when updating a bot that does not exist", async () => {
    expect(await repo.updateDiscordBot(REX, { enabled: false })).toBeNull();
  });

  it("deletes, reporting whether a row was removed", async () => {
    await repo.upsertDiscordBot({ personaId: ARIA, token: "t" });
    expect(await repo.deleteDiscordBot(ARIA)).toBe(true);
    expect(await repo.deleteDiscordBot(ARIA)).toBe(false);
    expect(await repo.listDiscordBots()).toEqual([]);
  });

  it("lists bots ordered by persona id", async () => {
    await repo.upsertDiscordBot({ personaId: REX, token: "r" });
    await repo.upsertDiscordBot({ personaId: ARIA, token: "a" });
    expect((await repo.listDiscordBots()).map((b) => b.personaId)).toEqual([ARIA, REX]);
  });

  it("goes away with its persona (FK cascade)", async () => {
    await repo.upsertDiscordBot({ personaId: ARIA, token: "t" });
    await db.delete(personasTable).where(eq(personasTable.id, ARIA));
    expect(await repo.getDiscordBot(ARIA)).toBeNull();
  });
});

describe("linked discord identities are the allowlist", () => {
  it("lists every external id linked on the channel", async () => {
    const a = await freshUser("a@test.local");
    const b = await freshUser("b@test.local");
    await repo.upsertChannelIdentity({ channel: "discord", externalUserId: "u1", userId: a });
    await repo.upsertChannelIdentity({ channel: "discord", externalUserId: "u2", userId: b });
    // A different channel must not leak into the Discord allowlist.
    await repo.upsertChannelIdentity({ channel: "slack", externalUserId: "s1", userId: a });

    expect(await repo.listChannelIdentityExternalIds("discord")).toEqual(["u1", "u2"]);
    expect(await repo.listChannelIdentityExternalIds("slack")).toEqual(["s1"]);
  });

  it("is empty before anyone links, and after they unlink", async () => {
    expect(await repo.listChannelIdentityExternalIds("discord")).toEqual([]);
    const a = await freshUser("a@test.local");
    await repo.upsertChannelIdentity({ channel: "discord", externalUserId: "u1", userId: a });
    expect(await repo.listChannelIdentityExternalIds("discord")).toEqual(["u1"]);
    await repo.deleteChannelIdentity("discord", "u1");
    expect(await repo.listChannelIdentityExternalIds("discord")).toEqual([]);
  });
});
