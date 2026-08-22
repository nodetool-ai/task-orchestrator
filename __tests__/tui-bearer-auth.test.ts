// __tests__/tui-bearer-auth.test.ts
//
// Bearer-token auth for the terminal cockpit's routes (tui T-tui-11).
//
// `orch` has no cookie jar, so it sends `Authorization: Bearer tot_…` — the
// same api_tokens rows /api/mcp already accepts. Real DB, real handlers, real
// bcrypt-hashed token: the whole point of the task is that the SERVER accepts
// the header, and a mocked verifier would happily agree while the routes said
// 401. The NextAuth session is mocked to "signed out" throughout, so anything
// that succeeds here succeeded on the strength of the token alone.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../auth", () => ({
  // Resolves to the same module as "@/auth" (vitest alias).
  auth: vi.fn(async () => null),
}));

import { db } from "../db";
import { agentSessions, apiTokens, users } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import { createToken } from "../lib/api-tokens";
import { isCockpitRoute } from "../lib/cockpit-routes";
import { GET as overviewGET } from "../app/api/runs/overview/route";
import { GET as inboxGET } from "../app/api/inbox/route";
import { GET as personasGET } from "../app/api/personas/route";
import { GET as tasksGET } from "../app/api/tasks/route";
import { GET as plansGET } from "../app/api/plans/route";

let token: string;

function req(path: string, auth?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(async () => {
  await seedPersonas();
  await db.delete(agentSessions);
  await db.delete(apiTokens);
  await db.delete(users);
  const user = (
    await db
      .insert(users)
      .values({ email: "cockpit@test.local", passwordHash: "x" })
      .returning()
  )[0];
  token = (await createToken(user.id, "orch")).token;
  await db.insert(agentSessions).values({
    goal: "<execute>",
    toolsProfile: "orchestrator",
    cwdStrategy: "none",
    personaId: "implementor",
    status: "idle",
    startedAt: new Date(),
  });
});

describe("GET /api/runs/overview with a Bearer token", () => {
  it("serves the real rows for a valid token even with no session", async () => {
    const res = await overviewGET(req("/api/runs/overview", `Bearer ${token}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.length).toBe(1);
  });

  it("401s a token that does not verify, with a JSON error", async () => {
    const res = await overviewGET(req("/api/runs/overview", "Bearer tot_garbage"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Unauthorized" });
  });

  it("401s a malformed Authorization header", async () => {
    const res = await overviewGET(req("/api/runs/overview", "Basic abc123"));
    expect(res.status).toBe(401);
  });

  it("401s a revoked token", async () => {
    await db.update(apiTokens).set({ revokedAt: new Date() });
    const res = await overviewGET(req("/api/runs/overview", `Bearer ${token}`));
    expect(res.status).toBe(401);
  });

  // The dev path: no header at all is not an error, it is "no rows" — the
  // posture the browser index and a local dev server both rely on.
  it("keeps the empty-list posture when no credentials are presented", async () => {
    const res = await overviewGET(req("/api/runs/overview"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [] });
  });
});

describe("GET /api/inbox with a Bearer token", () => {
  it("authenticates a valid token", async () => {
    const res = await inboxGET(req("/api/inbox?audience=owner", `Bearer ${token}`));
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).items)).toBe(true);
  });

  it("401s an invalid token", async () => {
    const res = await inboxGET(req("/api/inbox?audience=owner", "Bearer tot_nope"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Unauthorized" });
  });
});

// The palette routes carry no identity of their own: a valid token passes
// through, an invalid one is stopped here (middleware forwarded it precisely
// so it could be).
describe("the cockpit's list routes", () => {
  const routes: Array<[string, string, (r: NextRequest) => Promise<Response>]> = [
    ["personas", "/api/personas", personasGET],
    ["tasks", "/api/tasks", tasksGET],
    ["plans", "/api/plans", plansGET],
  ];

  for (const [name, path, handler] of routes) {
    it(`${name}: accepts a valid token and 401s an invalid one`, async () => {
      const ok = await handler(req(path, `Bearer ${token}`));
      expect(ok.status).toBe(200);

      const bad = await handler(req(path, "Bearer tot_garbage"));
      expect(bad.status).toBe(401);
      expect(await bad.json()).toMatchObject({ error: "Unauthorized" });

      // Unchanged for the session/dev path.
      expect((await handler(req(path))).status).toBe(200);
    });
  }
});

// The middleware bypass and the routes that verify must cover the same paths:
// a path in the allowlist that no route checks would be an open door, and a
// cockpit path outside it would 401 before the token was ever read.
describe("isCockpitRoute", () => {
  it("matches every route the cockpit uses", () => {
    for (const p of [
      "/api/runs/overview",
      "/api/runs/overview/events",
      "/api/runs/12",
      "/api/runs/12/events",
      "/api/runs/12/messages",
      "/api/runs/12/inbox",
      "/api/inbox",
      "/api/runs",
      "/api/tasks",
      "/api/plans",
      "/api/personas",
    ]) {
      expect(isCockpitRoute(p), p).toBe(true);
    }
  });

  it("matches nothing else", () => {
    for (const p of [
      "/api/chats",
      "/api/tokens",
      "/api/runs/12/attachments",
      "/api/tasks/T-1",
      "/api/plans/P-1",
      "/api/personas/implementor",
      "/api/runs/abc",
      "/settings",
    ]) {
      expect(isCockpitRoute(p), p).toBe(false);
    }
  });
});
