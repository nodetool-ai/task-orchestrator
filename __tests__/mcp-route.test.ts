import { describe, expect, it, beforeEach } from "vitest";
import { POST } from "../app/api/mcp/route";
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
    expect(body.result.tools.length).toBe(37);
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("list_plans");
    expect(names).not.toContain("start_review");
    expect(names).toContain("await_session");
    expect(names).toContain("create_task");
    expect(names).toContain("transition_task");
    expect(names).toContain("list_attachments");
    expect(names).toContain("get_attachment");
    expect(names).toContain("add_attachment");
    expect(names).toContain("delete_attachment");
    // Bare names — no task_orch__ prefix.
    expect(names.some((n: string) => n.startsWith("task_orch__"))).toBe(false);
  });

  it("tools/call list_plans returns a content block", async () => {
    const res = await POST(
      makeReq(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "list_plans", arguments: {} },
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

  it("tools/call rejects an unknown enum value with -32602 and does not execute", async () => {
    const res = await POST(
      makeReq(
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "create_plan", arguments: { title: "Bogus State Plan", state: "bogus" } },
        },
        { Authorization: `Bearer ${token}` }
      ) as never
    );
    const body = await res.json();
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(/state/);
    expect(body.result).toBeUndefined();
    // The plan must never have been created.
    const list = await POST(
      makeReq(
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "list_plans", arguments: {} },
        },
        { Authorization: `Bearer ${token}` }
      ) as never
    );
    const listBody = await list.json();
    const text = listBody.result.content[0].text as string;
    expect(text).not.toMatch(/Bogus State Plan/);
  });

  it("tools/call rejects create_plan with a terminal/accepted initial state", async () => {
    for (const state of ["accepted", "done", "cancelled"]) {
      const res = await POST(
        makeReq(
          {
            jsonrpc: "2.0",
            id: 8,
            method: "tools/call",
            params: { name: "create_plan", arguments: { title: `P-${state}`, state } },
          },
          { Authorization: `Bearer ${token}` }
        ) as never
      );
      const body = await res.json();
      expect(body.error?.code).toBe(-32602);
    }
  });

  it("tools/call rejects a missing required field with -32602", async () => {
    const res = await POST(
      makeReq(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "create_plan", arguments: {} },
        },
        { Authorization: `Bearer ${token}` }
      ) as never
    );
    const body = await res.json();
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(/title/);
  });

  it("tools/call rejects a wrong-typed field with -32602", async () => {
    const res = await POST(
      makeReq(
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "get_repository", arguments: { id: 123 } },
        },
        { Authorization: `Bearer ${token}` }
      ) as never
    );
    const body = await res.json();
    expect(body.error.code).toBe(-32602);
  });

  it("tools/call still executes with valid args (regression)", async () => {
    const res = await POST(
      makeReq(
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "create_plan", arguments: { title: "Valid Plan", state: "draft" } },
        },
        { Authorization: `Bearer ${token}` }
      ) as never
    );
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result.content[0].text).toMatch(/Created plan/);
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
