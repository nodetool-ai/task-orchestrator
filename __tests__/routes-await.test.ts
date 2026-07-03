// __tests__/routes-await.test.ts
//
// Runtime coverage for the API route handlers. The Postgres migration made
// lib/repo.* async; route handlers that called them without `await` typechecked
// fine but returned `{}` (a serialized pending Promise) and had dead `if(!x) 404`
// guards. tsc + the lib-level suite never caught it because nothing invoked the
// handlers. These tests invoke them and assert REAL data / working guards.
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET as listRepos, POST as createRepo } from "../app/api/repositories/route";
import { GET as getRepo } from "../app/api/repositories/[id]/route";

describe("repositories API routes (await regression)", () => {
  it("GET returns a real array (not a serialized Promise) incl. seeded R-default", async () => {
    const res = await listRepos();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true); // the bug returned {} (not an array)
    expect(body.some((r: { id: string }) => r.id === "R-default")).toBe(true);
  });

  it("POST creates a repo and returns its real id + 201", async () => {
    const req = new NextRequest("http://localhost/api/repositories", {
      method: "POST",
      body: JSON.stringify({ id: "R-await-test", name: "await test" }),
    });
    const res = await createRepo(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("R-await-test"); // the bug returned {} with no id
  });

  it("GET [id] 404 guard actually fires for a missing repo", async () => {
    const res = await getRepo({} as NextRequest, { params: Promise.resolve({ id: "R-does-not-exist" }) });
    expect(res.status).toBe(404); // the bug made `if (!promise)` always false -> never 404
  });
});
