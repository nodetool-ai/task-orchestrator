// The Settings → Discord REST surface: bots, self-service identity linking, and
// token verification.
//
// The load-bearing assertions are the security ones — every route is behind the
// session, the identity routes only ever touch the CALLER'S OWN row, and the
// full bot token never appears in a response body.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sessionEmail } = vi.hoisted(() => ({ sessionEmail: { value: "a@test.local" } }));
// Resolves to the same module as the routes' "@/auth" (vitest alias).
vi.mock("../auth", () => ({
  auth: vi.fn(async () =>
    sessionEmail.value ? { user: { email: sessionEmail.value } } : null
  ),
}));

import { db } from "../db";
import {
  channelIdentities,
  discordBots,
  personas as personasTable,
  users,
} from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import * as repo from "../lib/repo";
import { GET as listBots, POST as createBot } from "../app/api/discord/bots/route";
import {
  DELETE as deleteBot,
  PATCH as patchBot,
} from "../app/api/discord/bots/[personaId]/route";
import {
  DELETE as unlinkIdentity,
  GET as getIdentity,
  PUT as putIdentity,
} from "../app/api/discord/identity/route";
import { GET as verifyStored, POST as verifyToken } from "../app/api/discord/verify/route";

const ARIA = "aria";
const HANDS = "hands";
const TOKEN = "MTIzNDU2Nzg5.super-secret.WXYZ";

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function json(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = (personaId: string) => ({ params: Promise.resolve({ personaId }) });

async function freshUser(email: string): Promise<number> {
  return (await db.insert(users).values({ email, passwordHash: "x" }).returning())[0].id;
}

beforeEach(async () => {
  sessionEmail.value = "a@test.local";
  delete process.env.DISCORD_ALLOWED_USERS;
  await db.delete(discordBots);
  await db.delete(channelIdentities);
  await db.delete(users);
  await seedPersonas();
  await db
    .insert(personasTable)
    .values({ id: ARIA, name: "ARIA", systemPrompt: "x", toolsProfile: "orchestrator" })
    .onConflictDoUpdate({ target: personasTable.id, set: { toolsProfile: "orchestrator" } });
  await db
    .insert(personasTable)
    .values({
      id: HANDS,
      name: "HANDS",
      systemPrompt: "x",
      toolsProfile: "orchestrator,repo_write",
    })
    .onConflictDoUpdate({
      target: personasTable.id,
      set: { toolsProfile: "orchestrator,repo_write" },
    });
  await freshUser("a@test.local");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("auth", () => {
  it("401s every route without a session", async () => {
    sessionEmail.value = "";
    expect((await listBots()).status).toBe(401);
    expect((await createBot(post("http://t/api/discord/bots", {}))).status).toBe(401);
    expect(
      (await patchBot(json("http://t/x", "PATCH", {}), params(ARIA))).status
    ).toBe(401);
    expect((await deleteBot(new Request("http://t/x", { method: "DELETE" }), params(ARIA))).status).toBe(
      401
    );
    expect((await getIdentity()).status).toBe(401);
    expect((await putIdentity(json("http://t/x", "PUT", { externalUserId: "1".repeat(18) }))).status).toBe(
      401
    );
    expect((await unlinkIdentity()).status).toBe(401);
    expect((await verifyToken(post("http://t/x", { token: "t" }))).status).toBe(401);
  });
});

describe("POST/GET /api/discord/bots", () => {
  it("creates a bot and never returns its token", async () => {
    const res = await createBot(
      post("http://t/api/discord/bots", { personaId: ARIA, token: TOKEN, applicationId: "app-1" })
    );
    expect(res.status).toBe(200);
    const created = await res.text();
    expect(created).not.toContain(TOKEN);
    expect(created).not.toContain("super-secret");
    expect(JSON.parse(created).bot).toMatchObject({
      personaId: ARIA,
      tokenLast4: "WXYZ",
      configured: true,
    });

    const listed = await (await listBots()).text();
    expect(listed).not.toContain("super-secret");
    const { bots } = JSON.parse(listed);
    expect(bots).toHaveLength(1);
    expect(bots[0].inviteUrl).toContain("client_id=app-1");
    expect(bots[0].inviteUrl).toContain("permissions=309237712960");
  });

  it("rejects a body with no token", async () => {
    const res = await createBot(post("http://t/api/discord/bots", { personaId: ARIA }));
    expect(res.status).toBe(400);
  });

  it("404s an unknown persona", async () => {
    const res = await createBot(post("http://t/api/discord/bots", { personaId: "ghost", token: "t" }));
    expect(res.status).toBe(404);
  });

  it("reports per-bot validation problems so the UI can flag them", async () => {
    await repo.upsertDiscordBot({ personaId: HANDS, token: TOKEN });
    const { bots } = await (await listBots()).json();
    expect(bots[0].valid).toBe(false);
    expect(bots[0].problems.join(" ")).toMatch(/not server-safe/);
  });

  it("counts a linked identity as the allowlist", async () => {
    await repo.upsertDiscordBot({ personaId: ARIA, token: TOKEN });
    await putIdentity(json("http://t/x", "PUT", { externalUserId: "1".repeat(18) }));
    const { bots } = await (await listBots()).json();
    expect(bots[0].allowedUsers).toEqual(["1".repeat(18)]);
    expect(bots[0].linkedUserCount).toBe(1);
    expect(bots[0].valid).toBe(true);
  });
});

describe("PATCH/DELETE /api/discord/bots/[personaId]", () => {
  beforeEach(async () => {
    await repo.upsertDiscordBot({ personaId: ARIA, token: TOKEN });
  });

  it("keeps the stored token when the patch omits it", async () => {
    const res = await patchBot(json("http://t/x", "PATCH", { enabled: false }), params(ARIA));
    expect(res.status).toBe(200);
    expect((await res.json()).bot.enabled).toBe(false);
    expect((await repo.getDiscordBot(ARIA))?.token).toBe(TOKEN);
  });

  it("replaces the token when the patch provides one", async () => {
    await patchBot(json("http://t/x", "PATCH", { token: "brand-new-9999" }), params(ARIA));
    expect((await repo.getDiscordBot(ARIA))?.token).toBe("brand-new-9999");
  });

  it("404s an unknown bot, and deletes a known one", async () => {
    expect(
      (await patchBot(json("http://t/x", "PATCH", { enabled: false }), params(HANDS))).status
    ).toBe(404);
    expect(
      (await deleteBot(new Request("http://t/x", { method: "DELETE" }), params(ARIA)))
        .status
    ).toBe(200);
    expect(await repo.getDiscordBot(ARIA)).toBeNull();
  });
});

describe("/api/discord/identity (self-service linking)", () => {
  const MINE = "1".repeat(18);
  const THEIRS = "2".repeat(18);

  it("links, reads back and unlinks the caller's own id", async () => {
    expect(await (await getIdentity()).json()).toMatchObject({ identity: null, linkedCount: 0 });

    const put = await putIdentity(json("http://t/x", "PUT", { externalUserId: MINE }));
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      identity: { externalUserId: MINE },
      linkedCount: 1,
    });

    const del = await unlinkIdentity();
    expect(del.status).toBe(200);
    expect(await (await getIdentity()).json()).toMatchObject({ identity: null });
  });

  it("replaces rather than accumulates when the same user re-links", async () => {
    await putIdentity(json("http://t/x", "PUT", { externalUserId: MINE }));
    await putIdentity(json("http://t/x", "PUT", { externalUserId: THEIRS }));
    expect(await repo.listChannelIdentityExternalIds("discord")).toEqual([THEIRS]);
  });

  it("rejects anything that is not a Discord snowflake", async () => {
    const res = await putIdentity(json("http://t/x", "PUT", { externalUserId: "@someone" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Developer Mode/);
  });

  it("touches only the caller's row — one user cannot unlink another", async () => {
    await freshUser("b@test.local");
    sessionEmail.value = "b@test.local";
    await putIdentity(json("http://t/x", "PUT", { externalUserId: THEIRS }));

    sessionEmail.value = "a@test.local";
    await putIdentity(json("http://t/x", "PUT", { externalUserId: MINE }));
    expect((await unlinkIdentity()).status).toBe(200);

    // b@ is still linked: a@'s DELETE only removed a@'s own row.
    expect(await repo.listChannelIdentityExternalIds("discord")).toEqual([THEIRS]);
  });

  it("404s DELETE when the caller has nothing linked", async () => {
    expect((await unlinkIdentity()).status).toBe(404);
  });
});

describe("/api/discord/verify", () => {
  function stubFetch(handler: (url: string) => Promise<Response> | Response) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
  }

  it("returns the bot username and application id on success", async () => {
    stubFetch((url) =>
      url.endsWith("/users/@me")
        ? new Response(JSON.stringify({ username: "concierge-bot", id: "111" }), { status: 200 })
        : new Response(JSON.stringify({ id: "app-42" }), { status: 200 })
    );

    const body = await (await verifyToken(post("http://t/x", { token: "good" }))).json();
    expect(body).toMatchObject({ ok: true, username: "concierge-bot", applicationId: "app-42" });
    expect(body.inviteUrl).toContain("client_id=app-42");
  });

  it("reports a rejected token as ok:false, not a 500", async () => {
    stubFetch(() => new Response("{}", { status: 401 }));
    const res = await verifyToken(post("http://t/x", { token: "bad" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/rejected/i);
  });

  it("reports a network failure gracefully", async () => {
    stubFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND discord.com");
    });
    const body = await (await verifyToken(post("http://t/x", { token: "x" }))).json();
    expect(body).toMatchObject({ ok: false });
    expect(body.error).toMatch(/Could not reach Discord/);
  });

  it("still verifies when the application lookup fails", async () => {
    stubFetch((url) =>
      url.endsWith("/users/@me")
        ? new Response(JSON.stringify({ username: "bot", id: "111" }), { status: 200 })
        : new Response("{}", { status: 403 })
    );
    const body = await (await verifyToken(post("http://t/x", { token: "ok" }))).json();
    expect(body).toMatchObject({ ok: true, username: "bot", applicationId: "111" });
  });

  it("checks a STORED token by persona id, without the browser holding it", async () => {
    await repo.upsertDiscordBot({ personaId: ARIA, token: TOKEN });
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(String((init?.headers as Record<string, string>)?.Authorization));
        return new Response(JSON.stringify({ username: "stored", id: "1" }), { status: 200 });
      })
    );

    const res = await verifyStored(
      new Request(`http://t/api/discord/verify?personaId=${ARIA}`)
    );
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, username: "stored" });
    expect(text).not.toContain(TOKEN); // the response never echoes the secret
    expect(seen[0]).toBe(`Bot ${TOKEN}`); // …but the server did use it
  });

  it("404s a persona with no stored bot, and 400s a missing personaId", async () => {
    expect(
      (await verifyStored(new Request("http://t/api/discord/verify?personaId=ghost")))
        .status
    ).toBe(404);
    expect(
      (await verifyStored(new Request("http://t/api/discord/verify"))).status
    ).toBe(400);
  });
});
