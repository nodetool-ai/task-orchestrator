// DB-backed pipe config: bots configured in Settings → Discord, merged with the
// DISCORD_* environment (which keeps working — see pipe-multibot.test.ts for the
// unchanged env-only behaviour).
//
// The three things worth pinning down: precedence (a DB row wins for its
// persona, env-only personas still boot), the derived user allowlist (linked
// identities ∪ DISCORD_ALLOWED_USERS — nobody curates a list by hand), and the
// asymmetric failure posture (an env bot refuses boot; a DB bot is skipped and
// flagged, because it is editable in the UI and must not lock the pipe out).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import {
  channelIdentities,
  discordBots,
  personas as personasTable,
  users,
} from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import { botProblems, discordBotStatuses, loadPipeConfig } from "../lib/pipe/config";
import * as repo from "../lib/repo";

const ARIA = "aria"; // orchestrator,spawn — server-safe
const REX = "rex"; // orchestrator — server-safe
const HANDS = "hands"; // orchestrator,repo_write — NOT server-safe

// A persona carries no engine (migration 0031), so the tools profile is the
// only thing that can disqualify it from hosting a bot.
async function makePersona(id: string, toolsProfile: string): Promise<void> {
  await db
    .insert(personasTable)
    .values({ id, name: id.toUpperCase(), systemPrompt: "x", toolsProfile })
    .onConflictDoUpdate({ target: personasTable.id, set: { toolsProfile } });
}

/** Link a Discord id the way Settings → Discord does: one row per person. */
async function link(externalUserId: string, email = `${externalUserId}@test.local`): Promise<void> {
  const userId = (await db.insert(users).values({ email, passwordHash: "x" }).returning())[0].id;
  await repo.upsertChannelIdentity({ channel: "discord", externalUserId, userId });
}

beforeEach(async () => {
  await db.delete(discordBots);
  await db.delete(channelIdentities);
  await db.delete(users);
  await seedPersonas();
  await makePersona(ARIA, "orchestrator,spawn");
  await makePersona(REX, "orchestrator");
  await makePersona(HANDS, "orchestrator,repo_write");
});

describe("loadPipeConfig with DB-configured bots", () => {
  it("loads a bot from the database with no env vars at all", async () => {
    await link("u1");
    await repo.upsertDiscordBot({ personaId: ARIA, token: "db-token", applicationId: "app-1" });

    const cfg = await loadPipeConfig({});
    expect(cfg.bots).toHaveLength(1);
    expect(cfg.bots[0]).toMatchObject({
      personaId: ARIA,
      token: "db-token",
      applicationId: "app-1",
      source: "db",
    });
    expect(cfg.bots[0].allowedUsers).toEqual(["u1"]);
  });

  it("merges env-only personas alongside DB bots", async () => {
    await link("u1");
    await repo.upsertDiscordBot({ personaId: ARIA, token: "db-aria" });

    const cfg = await loadPipeConfig({ DISCORD_BOT_TOKEN_REX: "env-rex" });
    expect(cfg.bots.map((b) => b.personaId)).toEqual([ARIA, REX]);
    expect(cfg.bots.map((b) => b.source)).toEqual(["db", "env"]);
  });

  it("lets a DB row win over the env token for the same persona", async () => {
    await link("u1");
    await repo.upsertDiscordBot({ personaId: ARIA, token: "db-wins" });

    const cfg = await loadPipeConfig({
      DISCORD_BOT_TOKEN_ARIA: "env-loses",
      DISCORD_ALLOWED_USERS: "u9",
    });
    expect(cfg.bots).toHaveLength(1);
    expect(cfg.bots[0]).toMatchObject({ token: "db-wins", source: "db" });
  });

  it("skips disabled rows", async () => {
    await link("u1");
    await repo.upsertDiscordBot({ personaId: ARIA, token: "on" });
    await repo.upsertDiscordBot({ personaId: REX, token: "off", enabled: false });

    const cfg = await loadPipeConfig({});
    expect(cfg.bots.map((b) => b.personaId)).toEqual([ARIA]);
  });

  it("falls back to the env token when the DB row is disabled", async () => {
    await link("u1");
    await repo.upsertDiscordBot({ personaId: ARIA, token: "off", enabled: false });

    const cfg = await loadPipeConfig({ DISCORD_BOT_TOKEN_ARIA: "env-token" });
    expect(cfg.bots).toHaveLength(1);
    expect(cfg.bots[0]).toMatchObject({ token: "env-token", source: "env" });
  });

  it("refuses to start when neither the DB nor the env has a bot", async () => {
    await expect(loadPipeConfig({})).rejects.toThrow(/No Discord bot tokens found/);
  });
});

describe("the derived user allowlist", () => {
  it("is the union of linked identities and DISCORD_ALLOWED_USERS", async () => {
    await link("u1");
    await link("u2");
    await repo.upsertDiscordBot({ personaId: ARIA, token: "t" });

    const cfg = await loadPipeConfig({ DISCORD_ALLOWED_USERS: "legacy-1, u2" });
    // De-duplicated: u2 is both linked and in the legacy list.
    expect(cfg.bots[0].allowedUsers).toEqual(["u1", "u2", "legacy-1"]);
  });

  it("adds the per-persona env override rather than replacing the linked set", async () => {
    await link("u1");
    await repo.upsertDiscordBot({ personaId: ARIA, token: "t" });

    const cfg = await loadPipeConfig({ DISCORD_ALLOWED_USERS_ARIA: "u7" });
    expect(cfg.bots[0].allowedUsers).toEqual(["u1", "u7"]);
  });

  it("grows as soon as someone links, with no config edit", async () => {
    await link("u1");
    await repo.upsertDiscordBot({ personaId: ARIA, token: "t" });
    expect((await loadPipeConfig({})).bots[0].allowedUsers).toEqual(["u1"]);

    await link("u2");
    expect((await loadPipeConfig({})).bots[0].allowedUsers).toEqual(["u1", "u2"]);
  });

  it("takes channel restrictions from the row, falling back to the env global", async () => {
    await link("u1");
    await repo.upsertDiscordBot({ personaId: ARIA, token: "a", allowedChannels: ["c9"] });
    await repo.upsertDiscordBot({ personaId: REX, token: "r" });

    const cfg = await loadPipeConfig({ DISCORD_ALLOWED_CHANNELS: "c1" });
    expect(cfg.bots.find((b) => b.personaId === ARIA)!.allowedChannels).toEqual(["c9"]);
    expect(cfg.bots.find((b) => b.personaId === REX)!.allowedChannels).toEqual(["c1"]);
  });
});

describe("validation posture: DB bots are skipped, env bots refuse boot", () => {
  it("warns (and does not crash) when nobody has linked a Discord account", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await repo.upsertDiscordBot({ personaId: ARIA, token: "unreachable" });

    await expect(loadPipeConfig({})).rejects.toThrow(/failed validation/);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/linked a Discord account/);
    warn.mockRestore();
  });

  it("skips a DB bot on an unsafe persona, and keeps the healthy ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await link("u1");
    await repo.upsertDiscordBot({ personaId: ARIA, token: "good" });
    await repo.upsertDiscordBot({ personaId: HANDS, token: "unsafe" });

    const cfg = await loadPipeConfig({});
    expect(cfg.bots.map((b) => b.personaId)).toEqual([ARIA]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/hands/);
    warn.mockRestore();
  });

  it("refuses to boot when every DB bot fails validation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await link("u1");
    await repo.upsertDiscordBot({ personaId: HANDS, token: "unsafe-profile" });

    await expect(loadPipeConfig({})).rejects.toThrow(/failed validation/);
    warn.mockRestore();
  });

  it("still HARD-FAILS on an env-sourced bot — that path is unchanged", async () => {
    await link("u1");
    await expect(
      loadPipeConfig({ DISCORD_BOT_TOKEN_HANDS: "t", DISCORD_ALLOWED_USERS: "u1" })
    ).rejects.toThrow(/not\s+server-safe \(repo_write\)/);
  });
});

describe("botProblems", () => {
  it("reports nothing for a healthy bot", async () => {
    expect(
      await botProblems({ personaId: ARIA, token: "t", allowedUsers: ["u1"], allowedChannels: [] })
    ).toEqual([]);
  });

  it("names the empty allowlist and the unsafe profile", async () => {
    const empty = await botProblems({
      personaId: ARIA,
      token: "t",
      allowedUsers: [],
      allowedChannels: [],
    });
    expect(empty.join(" ")).toMatch(/linked a Discord account/);

    const unsafe = await botProblems({
      personaId: HANDS,
      token: "t",
      allowedUsers: ["u1"],
      allowedChannels: [],
    });
    expect(unsafe.join(" ")).toMatch(/not server-safe \(repo_write\)/);
  });

  it("reports a persona that no longer exists", async () => {
    const problems = await botProblems({
      personaId: "ghost",
      token: "t",
      allowedUsers: ["u1"],
      allowedChannels: [],
    });
    expect(problems.join(" ")).toMatch(/no longer exists/);
  });
});

describe("discordBotStatuses", () => {
  it("exposes only the last 4 token characters, plus the effective allowlist", async () => {
    await link("u1");
    await repo.upsertDiscordBot({ personaId: ARIA, token: "super-secret-token-ABCD" });

    const [status] = await discordBotStatuses({ DISCORD_ALLOWED_USERS: "legacy" });
    expect(status.tokenLast4).toBe("ABCD");
    expect(JSON.stringify(status)).not.toContain("super-secret");
    expect(status.allowedUsers).toEqual(["u1", "legacy"]);
    expect(status.linkedUserCount).toBe(1);
    expect(status.problems).toEqual([]);
    expect(status.personaName).toBe("ARIA");
  });

  it("flags a misconfigured bot without hiding it", async () => {
    await link("u1");
    await repo.upsertDiscordBot({ personaId: HANDS, token: "t" });
    const [status] = await discordBotStatuses({});
    expect(status.problems.join(" ")).toMatch(/not server-safe/);
  });

  it("lists disabled bots too (they are configuration, not absence)", async () => {
    await link("u1");
    await repo.upsertDiscordBot({ personaId: ARIA, token: "t", enabled: false });
    const [status] = await discordBotStatuses({});
    expect(status.enabled).toBe(false);
  });
});
