import { describe, expect, it, beforeEach } from "vitest";
import { GET, POST } from "../app/api/mcp/route";
import { db } from "../db";
import { apiTokens, users } from "../db/schema";
import { createToken } from "../lib/api-tokens";

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/mcp", () => {
  let token: string;

  beforeEach(async () => {
    await db.delete(apiTokens);
    await db.delete(users);
    const u = (
      await db
        .insert(users)
        .values({ email: "mcp@test.local", passwordHash: "x" })
        .returning()
    )[0];
    const t = await createToken(u.id, "test");
    token = t.token;
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await POST(
      makeReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as never
    );
    expect(res.status).toBe(401);
  });

  it("names the failure mode and links to the token page on 401", async () => {
    const res = await POST(
      makeReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as never
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    const body = await res.json();
    expect(body.reason).toBe("missing_authorization_header");
    expect(body.tokens_url).toBe("http://localhost/settings?tab=tokens");
  });

  it("distinguishes a malformed header from a dead token", async () => {
    const malformed = await POST(
      makeReq(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { Authorization: "tot_no_bearer_prefix" }
      ) as never
    );
    expect((await malformed.json()).reason).toBe("malformed_authorization_header");

    const dead = await POST(
      makeReq(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { Authorization: "Bearer tot_revoked" }
      ) as never
    );
    expect((await dead.json()).reason).toBe("invalid_or_revoked_token");
  });

  it("answers GET with 405 plus setup hints", async () => {
    const res = GET(new Request("http://localhost/api/mcp") as never);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    const body = await res.json();
    expect(body.server.protocolVersion).toBe("2024-11-05");
    expect(body.tokens_url).toBe("http://localhost/settings?tab=tokens");
  });

  it("rejects invalid token with 401", async () => {
    const res = await POST(
      makeReq(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { Authorization: "Bearer tot_garbage" }
      ) as never
    );
    expect(res.status).toBe(401);
  });

  it("initialize returns protocolVersion + serverInfo", async () => {
    const res = await POST(
      makeReq(
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { Authorization: `Bearer ${token}` }
      ) as never
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.serverInfo.name).toBe("task-orchestrator");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("tools/list returns the orchestrator registry", async () => {
    const res = await POST(
      makeReq(
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { Authorization: `Bearer ${token}` }
      ) as never
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.result.tools)).toBe(true);
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(["codeact_catalog", "codeact_execute"]);
  });

  it("tools/call CodeAct returns a content block", async () => {
    const res = await POST(
      makeReq(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "codeact_execute", arguments: { code: "return await app.plans.list({});" } },
        },
        { Authorization: `Bearer ${token}` }
      ) as never
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(Array.isArray(body.result.content)).toBe(true);
    expect(body.result.content[0].type).toBe("text");
  });

  it("tools/call returns method-not-found for unknown tool", async () => {
    const res = await POST(
      makeReq(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "nope", arguments: {} },
        },
        { Authorization: `Bearer ${token}` }
      ) as never
    );
    const body = await res.json();
    expect(body.error.code).toBe(-32601);
  });

  it("rejects direct calls to application operations", async () => {
    for (const name of ["list_plans", "create_plan", "schedules_create", "app.schedules.create"]) {
      const res = await POST(makeReq({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name, arguments: {} } }, { Authorization: `Bearer ${token}` }) as never);
      expect((await res.json()).error.code).toBe(-32601);
    }
  });

  it("validates the outer CodeAct schema", async () => {
    for (const args of [{}, { code: 42 }]) {
      const res = await POST(makeReq({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "codeact_execute", arguments: args } }, { Authorization: `Bearer ${token}` }) as never);
      expect((await res.json()).error.code).toBe(-32602);
    }
  });

  it("enforces application schemas inside CodeAct before mutation", async () => {
    for (const input of [{}, { title: "Bogus State Plan", state: "bogus" }, { title: "P-done", state: "done" }]) {
      const res = await POST(makeReq({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {
        name: "codeact_execute", arguments: { code: `return await app.plans.create(${JSON.stringify(input)});` },
      } }, { Authorization: `Bearer ${token}` }) as never);
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("Invalid params");
    }
  });

  it("creates scheduled jobs through CodeAct with the authenticated owner", async () => {
    const [owner] = await db.select().from(users);
    const res = await POST(makeReq({ jsonrpc: "2.0", id: 9, method: "tools/call", params: {
      name: "codeact_execute", arguments: { code: `const job = await app.schedules.create({name: 'Weekly', prompt: 'Check dependencies', repoId: 'R-default', kind: 'cron', cronExpression: '0 9 * * 1', userId: 999}); return JSON.parse(job.content[0].text);` },
    } }, { Authorization: `Bearer ${token}` }) as never);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0].text).result).toMatchObject({ name: "Weekly", userId: owner.id });
  });

  it("notifications/initialized returns 202 with empty body", async () => {
    const res = await POST(
      makeReq(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { Authorization: `Bearer ${token}` }
      ) as never
    );
    expect(res.status).toBe(202);
  });

  it("ping returns empty result", async () => {
    const res = await POST(
      makeReq(
        { jsonrpc: "2.0", id: 5, method: "ping" },
        { Authorization: `Bearer ${token}` }
      ) as never
    );
    const body = await res.json();
    expect(body.result).toEqual({});
  });
});
