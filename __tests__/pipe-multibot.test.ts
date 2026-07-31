// Milestone 4: the pipe runs one bot per persona in a single process.
//
// Covers the three things that change shape: config discovery (N tokens, the
// legacy single-bot mapping, per-bot overrides, and the boot-time refusals that
// keep an unsafe persona off the in-process runtime), the persona dimension in
// the session store (two bots, one Discord channel, two conversations), and the
// PRD's onboarding / not-enabled replies.
//
// Style follows the existing pipe tests: fake channel objects and direct method
// calls, never a live gateway.

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The agent loop's turns are stubbed the same way pipe-serialization.test.ts
// does it — everything else in lib/chat stays real.
const { mockRunChat, startedTurns } = vi.hoisted(() => ({
  mockRunChat: vi.fn(),
  startedTurns: [] as string[],
}));

vi.mock("../lib/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat")>();
  mockRunChat.mockImplementation(async function* (args: import("../lib/chat").RunChatArgs) {
    startedTurns.push(args.userText);
    yield { type: "done" as const };
  });
  return { ...actual, runChat: mockRunChat };
});

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
import { AgentLoop } from "../lib/pipe/agent-loop";
import { OneTimeNotices } from "../lib/pipe/channels/discord";
import { SLASH_COMMANDS } from "../lib/pipe/commands";
import { loadPipeConfig, personaEnvSuffix } from "../lib/pipe/config";
import { currentRunId, getOrCreateRun } from "../lib/pipe/session-store";
import type { Channel, InboundMessage, OutboundDraft, PipeConfig } from "../lib/pipe/types";

// Test personas. Only 'orchestrator'-family profiles are server-safe
// (lib/profiles.ts), which is exactly what the boot check enforces.
const ARIA = "aria"; // orchestrator,spawn — server-safe
const REX = "rex"; // orchestrator — server-safe
const HANDS = "hands"; // orchestrator,repo_write — NOT server-safe
const CLAUDIA = "claudia"; // server-safe profile but pinned to the claude backend
const DEEP = "deep-thought"; // dashed id → DEEP_THOUGHT env suffix

async function makePersona(
  id: string,
  toolsProfile: string,
  backend: string | null = null
): Promise<void> {
  await db
    .insert(personasTable)
    .values({ id, name: id.toUpperCase(), systemPrompt: "x", toolsProfile, backend })
    .onConflictDoUpdate({ target: personasTable.id, set: { toolsProfile, backend } });
}

const config: PipeConfig = {
  bots: [{ personaId: ARIA, token: "x", allowedUsers: ["u1"], allowedChannels: [] }],
  defaultModel: "anthropic/claude-sonnet-4-6",
  editThrottleMs: 0,
};

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "discord",
  externalId: "chan-1",
  text: "hello",
  authorId: "u1",
  authorLabel: "discord:tester",
  authorName: "tester",
  personaId: ARIA,
  isDirectMessage: true,
  ...over,
});

/** A stub Channel that records sends and draft writes. */
function makeChannel(): { channel: Channel; sends: string[]; finals: string[] } {
  const sends: string[] = [];
  const finals: string[] = [];
  const channel: Channel = {
    name: "discord",
    async start() {},
    async stop() {},
    onMessage() {},
    async openDraft(): Promise<OutboundDraft> {
      return {
        async update() {},
        async finalize(text) {
          finals.push(text);
        },
      };
    },
    async send(_externalId, text) {
      sends.push(text);
    },
  };
  return { channel, sends, finals };
}

beforeEach(async () => {
  await seedPersonas();
  await makePersona(ARIA, "orchestrator,spawn");
  await makePersona(REX, "orchestrator");
  await makePersona(HANDS, "orchestrator,repo_write");
  await makePersona(CLAUDIA, "orchestrator", "claude");
  await makePersona(DEEP, "orchestrator");
  await db.delete(channelThreads);
  await db.delete(channelIdentities);
  await db.delete(agentSessions);
  await db.delete(tasks);
  await db.delete(plans);
  await db.delete(users);
  startedTurns.length = 0;
});

// ──────────────────────────────────────────────────────────
// loadPipeConfig — discovery
// ──────────────────────────────────────────────────────────

describe("loadPipeConfig discovery", () => {
  it("discovers one bot per DISCORD_BOT_TOKEN_<PERSONA_ID>", async () => {
    const cfg = await loadPipeConfig({
      DISCORD_BOT_TOKEN_ARIA: "tok-aria",
      DISCORD_BOT_TOKEN_REX: "tok-rex",
      DISCORD_ALLOWED_USERS: "u1,u2",
    });
    expect(cfg.bots.map((b) => b.personaId)).toEqual([ARIA, REX]);
    expect(cfg.bots.map((b) => b.token)).toEqual(["tok-aria", "tok-rex"]);
    // The globals apply to every bot that has no override.
    for (const bot of cfg.bots) expect(bot.allowedUsers).toEqual(["u1", "u2"]);
  });

  it("upper-snakes a dashed persona id (deep-thought → DEEP_THOUGHT)", async () => {
    expect(personaEnvSuffix(DEEP)).toBe("DEEP_THOUGHT");
    const cfg = await loadPipeConfig({
      DISCORD_BOT_TOKEN_DEEP_THOUGHT: "t",
      DISCORD_ALLOWED_USERS: "u1",
    });
    expect(cfg.bots.map((b) => b.personaId)).toEqual([DEEP]);
  });

  it("maps the legacy DISCORD_BOT_TOKEN onto DISCORD_DEFAULT_PERSONA", async () => {
    const cfg = await loadPipeConfig({
      DISCORD_BOT_TOKEN: "legacy",
      DISCORD_DEFAULT_PERSONA: REX,
      DISCORD_ALLOWED_USERS: "u1",
    });
    expect(cfg.bots).toHaveLength(1);
    expect(cfg.bots[0]).toMatchObject({ personaId: REX, token: "legacy" });
  });

  it("rejects a legacy token bound to an unknown default persona", async () => {
    await expect(
      loadPipeConfig({
        DISCORD_BOT_TOKEN: "legacy",
        DISCORD_DEFAULT_PERSONA: "nobody",
        DISCORD_ALLOWED_USERS: "u1",
      })
    ).rejects.toThrow(/DISCORD_DEFAULT_PERSONA='nobody' is not a known persona/);
  });

  it("lets an explicit per-persona token win over the legacy one", async () => {
    const cfg = await loadPipeConfig({
      DISCORD_BOT_TOKEN: "legacy",
      DISCORD_DEFAULT_PERSONA: ARIA,
      DISCORD_BOT_TOKEN_ARIA: "explicit",
      DISCORD_ALLOWED_USERS: "u1",
    });
    expect(cfg.bots).toHaveLength(1);
    expect(cfg.bots[0].token).toBe("explicit");
  });

  it("applies per-bot allowlist and app-id overrides", async () => {
    const cfg = await loadPipeConfig({
      DISCORD_BOT_TOKEN_ARIA: "a",
      DISCORD_BOT_TOKEN_REX: "r",
      DISCORD_ALLOWED_USERS: "u1",
      DISCORD_ALLOWED_CHANNELS: "c1",
      DISCORD_ALLOWED_USERS_REX: "u2, u3",
      DISCORD_ALLOWED_CHANNELS_REX: "c9",
      DISCORD_APP_ID_REX: "app-rex",
    });
    const aria = cfg.bots.find((b) => b.personaId === ARIA)!;
    const rex = cfg.bots.find((b) => b.personaId === REX)!;
    expect(aria.allowedUsers).toEqual(["u1"]);
    expect(aria.allowedChannels).toEqual(["c1"]);
    expect(aria.applicationId).toBeUndefined();
    // An override REPLACES the global list rather than extending it.
    expect(rex.allowedUsers).toEqual(["u2", "u3"]);
    expect(rex.allowedChannels).toEqual(["c9"]);
    expect(rex.applicationId).toBe("app-rex");
  });

  it("refuses to start with no tokens at all", async () => {
    await expect(loadPipeConfig({ DISCORD_ALLOWED_USERS: "u1" })).rejects.toThrow(
      /No Discord bot tokens found/
    );
  });
});

// ──────────────────────────────────────────────────────────
// loadPipeConfig — boot refusals
// ──────────────────────────────────────────────────────────

describe("loadPipeConfig boot validation", () => {
  it("refuses an unknown persona id", async () => {
    await expect(
      loadPipeConfig({ DISCORD_BOT_TOKEN_NOBODY: "t", DISCORD_ALLOWED_USERS: "u1" })
    ).rejects.toThrow(/unknown persona/i);
  });

  it("refuses an empty effective user allowlist", async () => {
    await expect(loadPipeConfig({ DISCORD_BOT_TOKEN_ARIA: "t" })).rejects.toThrow(
      /No allowed users for the 'aria' bot/
    );
  });

  it("refuses a persona whose tools profile is not server-safe, naming the profile", async () => {
    await expect(
      loadPipeConfig({ DISCORD_BOT_TOKEN_HANDS: "t", DISCORD_ALLOWED_USERS: "u1" })
    ).rejects.toThrow(/not\s+server-safe \(repo_write\)/);
  });

  it("refuses a persona that resolves to the claude backend", async () => {
    await expect(
      loadPipeConfig({ DISCORD_BOT_TOKEN_CLAUDIA: "t", DISCORD_ALLOWED_USERS: "u1" })
    ).rejects.toThrow(/resolves to the 'claude' backend/);
  });

  it("refuses every bot, not just the first — one bad persona stops the process", async () => {
    await expect(
      loadPipeConfig({
        DISCORD_BOT_TOKEN_ARIA: "t",
        DISCORD_BOT_TOKEN_HANDS: "t",
        DISCORD_ALLOWED_USERS: "u1",
      })
    ).rejects.toThrow(/'hands'/);
  });
});

// ──────────────────────────────────────────────────────────
// Persona dimension in the session store
// ──────────────────────────────────────────────────────────

describe("two bots in one Discord channel", () => {
  it("hold separate conversations (distinct mappings, distinct runs)", async () => {
    const ariaRun = await getOrCreateRun("discord", "chan-1", ARIA, {
      model: config.defaultModel,
    });
    const rexRun = await getOrCreateRun("discord", "chan-1", REX, {
      model: config.defaultModel,
    });

    expect(rexRun).not.toBe(ariaRun);
    expect(await currentRunId("discord", "chan-1", ARIA)).toBe(ariaRun);
    expect(await currentRunId("discord", "chan-1", REX)).toBe(rexRun);

    const rows = await db
      .select()
      .from(channelThreads)
      .where(eq(channelThreads.externalId, "chan-1"));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.personaId).sort()).toEqual([ARIA, REX]);

    // Each run carries its own persona, and both are in-process placements
    // with the persona's own (server-safe) tool surface.
    const aria = (await db.select().from(agentSessions).where(eq(agentSessions.id, ariaRun)))[0];
    const rex = (await db.select().from(agentSessions).where(eq(agentSessions.id, rexRun)))[0];
    expect(aria.personaId).toBe(ARIA);
    expect(rex.personaId).toBe(REX);
    expect(aria.runtime).toBe("server");
    expect(aria.cwdStrategy).toBe("none");
    expect(aria.toolsProfile).toBe("orchestrator,spawn");
    expect(rex.toolsProfile).toBe("orchestrator");
    expect(aria.backend).toBe("pi");
  });

  it("resets one persona's thread without touching the other's", async () => {
    const ariaRun = await getOrCreateRun("discord", "chan-1", ARIA, {});
    const rexRun = await getOrCreateRun("discord", "chan-1", REX, {});
    const { resetThread } = await import("../lib/pipe/session-store");
    await resetThread("discord", "chan-1", ARIA);
    expect(await currentRunId("discord", "chan-1", ARIA)).toBeNull();
    expect(await currentRunId("discord", "chan-1", REX)).toBe(rexRun);
    expect(ariaRun).not.toBe(rexRun);
  });

  it("refuses to create a conversation for a persona with an unsafe profile", async () => {
    // Boot validation is the first line of defence; this is the second, for a
    // persona edited under a running process.
    await expect(getOrCreateRun("discord", "chan-1", HANDS, {})).rejects.toThrow(
      /server-safe|repo_write/
    );
  });
});

describe("attribution", () => {
  async function freshUser(email: string): Promise<number> {
    return (await db.insert(users).values({ email, passwordHash: "x" }).returning())[0].id;
  }

  it("leaves an unlinked author's run unattributed (talking never requires linking)", async () => {
    const runId = await getOrCreateRun("discord", "chan-1", ARIA, { authorId: "u1" });
    const run = (await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0];
    expect(run.userId).toBeNull();
    const mapping = (
      await db.select().from(channelThreads).where(eq(channelThreads.runId, runId))
    )[0];
    expect(mapping.userId).toBeNull();
  });

  it("attributes the run and the mapping to a linked user", async () => {
    const userId = await freshUser("linked@example.com");
    await db.insert(channelIdentities).values({
      channel: "discord",
      externalUserId: "u1",
      userId,
      label: "tester",
    });

    const runId = await getOrCreateRun("discord", "chan-1", ARIA, { authorId: "u1" });
    const run = (await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0];
    expect(run.userId).toBe(userId);
    expect(run.personaId).toBe(ARIA);
    const mapping = (
      await db
        .select()
        .from(channelThreads)
        .where(and(eq(channelThreads.runId, runId), eq(channelThreads.personaId, ARIA)))
    )[0];
    expect(mapping.userId).toBe(userId);
  });

  it("backfills attribution onto a conversation that predates the link", async () => {
    const runId = await getOrCreateRun("discord", "chan-1", ARIA, { authorId: "u1" });
    const userId = await freshUser("later@example.com");
    await db.insert(channelIdentities).values({
      channel: "discord",
      externalUserId: "u1",
      userId,
    });

    expect(await getOrCreateRun("discord", "chan-1", ARIA, { authorId: "u1" })).toBe(runId);
    const run = (await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0];
    expect(run.userId).toBe(userId);
  });
});

// ──────────────────────────────────────────────────────────
// Onboarding + access replies
// ──────────────────────────────────────────────────────────

describe("onboarding (PRD J1)", () => {
  it("prepends a 3-line intro to the first DM, exactly once", async () => {
    const { channel, sends } = makeChannel();
    const loop = new AgentLoop(channel, config);

    await loop.handle(msg({ text: "hi" }));
    expect(sends).toHaveLength(1);
    const intro = sends[0];
    expect(intro.split("\n")).toHaveLength(3);
    expect(intro).toContain("ARIA"); // persona name
    expect(intro).toMatch(/\/link/); // nudge, because this author is unlinked
    expect(startedTurns).toEqual(["hi"]); // the turn still ran

    // Second message: no repeat.
    await loop.handle(msg({ text: "again" }));
    expect(sends).toHaveLength(1);
    expect(startedTurns).toEqual(["hi", "again"]);
  });

  it("drops the /link nudge for an already-linked author", async () => {
    const userId = (
      await db.insert(users).values({ email: "a@b.c", passwordHash: "x" }).returning()
    )[0].id;
    await db
      .insert(channelIdentities)
      .values({ channel: "discord", externalUserId: "u1", userId });

    const { channel, sends } = makeChannel();
    await new AgentLoop(channel, config).handle(msg({ text: "hi" }));
    expect(sends[0].split("\n")).toHaveLength(2);
    expect(sends[0]).not.toMatch(/\/link/);
  });

  it("never greets in a guild channel", async () => {
    const { channel, sends } = makeChannel();
    await new AgentLoop(channel, config).handle(
      msg({ text: "hi", isDirectMessage: false, externalId: "guild-thread" })
    );
    expect(sends).toEqual([]);
  });

  it("does not greet a conversation that already has a mapping (restart-safe)", async () => {
    await getOrCreateRun("discord", "chan-1", ARIA, {});
    const { channel, sends } = makeChannel();
    await new AgentLoop(channel, config).handle(msg({ text: "hi" }));
    expect(sends).toEqual([]);
  });
});

describe("not-allowlisted DM reply", () => {
  it("fires exactly once per user", () => {
    const notices = new OneTimeNotices();
    expect(notices.take("stranger")).toBe(true);
    expect(notices.take("stranger")).toBe(false);
    expect(notices.take("stranger")).toBe(false);
    expect(notices.take("other")).toBe(true);
  });

  it("stays bounded, evicting the oldest entry", () => {
    const notices = new OneTimeNotices(2);
    notices.take("a");
    notices.take("b");
    notices.take("c"); // evicts "a"
    expect(notices.take("b")).toBe(false);
    expect(notices.take("a")).toBe(true); // forgotten — the documented tradeoff
  });
});

// ──────────────────────────────────────────────────────────
// Slash-command registration payload
// ──────────────────────────────────────────────────────────

describe("slash-command surface", () => {
  it("registers the PRD §7 command set and nothing else", () => {
    expect(SLASH_COMMANDS.map((c) => c.name).sort()).toEqual([
      "help",
      "link",
      "new",
      "status",
      "stop",
      "whoami",
    ]);
    // /model stays a hidden power-user text command — not registered.
    expect(SLASH_COMMANDS.map((c) => c.name)).not.toContain("model");
  });

  it("declares a required string token option on /link", () => {
    const link = SLASH_COMMANDS.find((c) => c.name === "link")!;
    expect(link.options).toEqual([
      { type: 3, name: "token", description: expect.any(String), required: true },
    ]);
  });

  it("gives every command a non-empty description (Discord rejects blanks)", () => {
    for (const c of SLASH_COMMANDS) {
      expect(c.name).toMatch(/^[a-z]+$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
  });
});
