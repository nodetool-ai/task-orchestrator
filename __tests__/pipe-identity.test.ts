// Milestone 4: `/link` and the identity-aware `/whoami`.
//
// `/link` is the one true command (PRD §7): the user mints an API token in the
// web UI and pastes it in a DM, and the pipe stores the resulting
// channel_identities row. Two properties matter beyond "it works":
//   • DM only — a bearer token in a guild channel is readable by the room
//     (design §6), and the command must refuse without deleting anything.
//   • the token never comes back out — not in the confirmation, not on an error.

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../db";
import {
  agentSessions,
  channelIdentities,
  channelThreads,
  personas as personasTable,
  plans,
  tasks,
  users,
} from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import { createToken, revokeToken } from "../lib/api-tokens";
import { handleCommand } from "../lib/pipe/commands";
import { getOrCreateRun } from "../lib/pipe/session-store";
import type { InboundMessage, PipeConfig } from "../lib/pipe/types";

const PERSONA = "aria";

const config: PipeConfig = {
  bots: [{ personaId: PERSONA, token: "x", allowedUsers: ["u1"], allowedChannels: [] }],
  defaultModel: "anthropic/claude-sonnet-4-6",
  editThrottleMs: 0,
};

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "discord",
  externalId: "dm-1",
  text: "",
  authorId: "u1",
  authorLabel: "discord:tester",
  authorName: "tester",
  personaId: PERSONA,
  isDirectMessage: true,
  ...over,
});

async function freshUser(email: string): Promise<number> {
  return (await db.insert(users).values({ email, passwordHash: "x" }).returning())[0].id;
}

beforeEach(async () => {
  await seedPersonas();
  await db
    .insert(personasTable)
    .values({
      id: PERSONA,
      name: "Aria",
      systemPrompt: "x",
      toolsProfile: "orchestrator,spawn",
    })
    .onConflictDoNothing();
  await db.delete(channelThreads);
  await db.delete(channelIdentities);
  await db.delete(agentSessions);
  await db.delete(tasks);
  await db.delete(plans);
  await db.delete(users);
});

describe("/link", () => {
  it("links the Discord account to the token's user", async () => {
    const userId = await freshUser("matti@example.com");
    const { token } = await createToken(userId, "discord");

    const r = await handleCommand(msg({ text: `/link ${token}` }), config);

    expect(r.handled).toBe(true);
    expect(r.reply).toContain("matti@example.com");
    const rows = await db
      .select()
      .from(channelIdentities)
      .where(eq(channelIdentities.externalUserId, "u1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "discord", userId, label: "tester" });
  });

  it("never echoes the token back", async () => {
    const userId = await freshUser("matti@example.com");
    const { token } = await createToken(userId, "discord");
    const r = await handleCommand(msg({ text: `/link ${token}` }), config);
    expect(r.reply).not.toContain(token);
    // Not even a fragment: the display prefix is 8 chars, so check a chunk.
    expect(r.reply).not.toContain(token.slice(4, 12));
  });

  it("refuses in a guild channel and stores nothing", async () => {
    const userId = await freshUser("matti@example.com");
    const { token } = await createToken(userId, "discord");

    const r = await handleCommand(
      msg({ text: `/link ${token}`, isDirectMessage: false, externalId: "guild-1" }),
      config
    );

    expect(r.handled).toBe(true);
    expect(r.reply).toMatch(/only works in a DM/i);
    expect(r.reply).toMatch(/revoke/i); // the only advice that actually helps
    expect(r.reply).not.toContain(token);
    expect(await db.select().from(channelIdentities)).toHaveLength(0);
  });

  it("rejects an unknown or revoked token without linking", async () => {
    const userId = await freshUser("matti@example.com");
    const created = await createToken(userId, "discord");
    await revokeToken(created.id, userId);

    expect((await handleCommand(msg({ text: "/link tot_nope" }), config)).reply).toMatch(
      /didn't verify/i
    );
    expect(
      (await handleCommand(msg({ text: `/link ${created.token}` }), config)).reply
    ).toMatch(/didn't verify/i);
    expect(await db.select().from(channelIdentities)).toHaveLength(0);
  });

  it("explains itself when called with no token", async () => {
    const r = await handleCommand(msg({ text: "/link" }), config);
    expect(r.handled).toBe(true);
    expect(r.reply).toMatch(/Usage: `\/link <token>`/);
  });

  it("re-points an existing link when a different user's token is pasted", async () => {
    const first = await freshUser("first@example.com");
    const second = await freshUser("second@example.com");
    await handleCommand(msg({ text: `/link ${(await createToken(first, "a")).token}` }), config);
    await handleCommand(msg({ text: `/link ${(await createToken(second, "b")).token}` }), config);

    const rows = await db.select().from(channelIdentities);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(second);
  });

  it("attributes the conversation created after linking", async () => {
    const userId = await freshUser("matti@example.com");
    const { token } = await createToken(userId, "discord");
    await handleCommand(msg({ text: `/link ${token}` }), config);

    const runId = await getOrCreateRun("discord", "dm-1", PERSONA, { authorId: "u1" });
    const run = (await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0];
    expect(run.userId).toBe(userId);
  });
});

describe("/whoami", () => {
  it("names the persona and says the account is unlinked", async () => {
    const r = await handleCommand(msg({ text: "/whoami" }), config);
    expect(r.handled).toBe(true);
    expect(r.reply).toContain("Aria");
    expect(r.reply).toContain(PERSONA);
    expect(r.reply).toMatch(/not linked/i);
    expect(r.reply).toMatch(/no conversation yet/i);
  });

  it("reports the linked account and the active thread's run", async () => {
    const userId = await freshUser("matti@example.com");
    const { token } = await createToken(userId, "discord");
    await handleCommand(msg({ text: `/link ${token}` }), config);
    const runId = await getOrCreateRun("discord", "dm-1", PERSONA, { authorId: "u1" });

    const r = await handleCommand(msg({ text: "/whoami" }), config);
    expect(r.reply).toContain("matti@example.com");
    expect(r.reply).toContain(`run #${runId}`);
    expect(r.reply).toContain(`/runs/${runId}`);
    expect(r.reply).not.toMatch(/not linked/i);
  });

  it("names the task when the thread's run is task-scoped", async () => {
    const runId = await getOrCreateRun("discord", "dm-1", PERSONA, {});
    await db
      .insert(plans)
      .values({ id: "P-1", title: "p" })
      .onConflictDoNothing();
    await db
      .insert(tasks)
      .values({ id: "T-1", planId: "P-1", title: "t" })
      .onConflictDoNothing();
    await db.update(agentSessions).set({ taskId: "T-1" }).where(eq(agentSessions.id, runId));

    const r = await handleCommand(msg({ text: "/whoami" }), config);
    expect(r.reply).toContain("T-1");
  });

  it("is reachable via /session", async () => {
    const r = await handleCommand(msg({ text: "/session" }), config);
    expect(r.handled).toBe(true);
    expect(r.reply).toContain("Aria");
  });
});

describe("/help", () => {
  it("documents /link and the plain-language stop, and hides /model", async () => {
    const r = await handleCommand(msg({ text: "/help" }), config);
    expect(r.reply).toContain("/link");
    expect(r.reply).toContain("/whoami");
    expect(r.reply).toMatch(/stop/);
    expect(r.reply).not.toContain("/model");
  });
});
