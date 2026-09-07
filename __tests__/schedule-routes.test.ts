import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { surface, createSchedule, getScheduleSurface, listScheduleSurfaces, updateSchedule, pauseSchedule, resumeSchedule, deleteSchedule, runScheduleNow } = vi.hoisted(() => {
  const surface = { id: 7, name: "Nightly", kind: "once", repoId: "R-default", recentOccurrence: null, recentRun: null, prUrl: null };
  return {
    surface,
    createSchedule: vi.fn(async (input: { userId?: number | null }) => ({ ...surface, userId: input.userId ?? null })),
    getScheduleSurface: vi.fn(async () => surface), listScheduleSurfaces: vi.fn(async () => [surface]),
    updateSchedule: vi.fn(async () => surface), pauseSchedule: vi.fn(async () => surface), resumeSchedule: vi.fn(async () => surface),
    deleteSchedule: vi.fn(async () => ({ id: 7 })), runScheduleNow: vi.fn(async () => 41),
  };
});

vi.mock("../lib/api-auth", () => ({
  resolveApiActor: vi.fn(async () => ({ ok: true, actor: { userId: 22, email: "operator@example.com", via: "token" } })),
  unauthorizedResponse: () => NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
}));
vi.mock("../lib/schedules", () => ({ createSchedule, getScheduleSurface, listScheduleSurfaces, updateSchedule, pauseSchedule, resumeSchedule, deleteSchedule, runScheduleNow }));

import { resolveApiActor } from "../lib/api-auth";
import { GET as list, POST as create } from "../app/api/schedules/route";
import { GET as show, PATCH as patch, DELETE as remove } from "../app/api/schedules/[id]/route";
import { POST as run } from "../app/api/schedules/[id]/run/route";
import { POST as pause } from "../app/api/schedules/[id]/pause/route";
import { POST as resume } from "../app/api/schedules/[id]/resume/route";

describe("authenticated schedule routes", () => {
  const params = { params: Promise.resolve({ id: "7" }) };
  it("rejects an unauthenticated collection request", async () => {
    vi.mocked(resolveApiActor).mockResolvedValueOnce({ ok: false });
    expect((await list(new NextRequest("http://localhost/api/schedules"))).status).toBe(401);
  });
  it("serves the enriched collection and attributes creates to the actor", async () => {
    expect((await (await list(new NextRequest("http://localhost/api/schedules"))).json())).toEqual([surface]);
    const response = await create(new NextRequest("http://localhost/api/schedules", { method: "POST", body: JSON.stringify({ name: "Nightly", prompt: "work", repoId: "R-default", kind: "once", runAt: "2026-09-08T02:00:00Z" }) }));
    expect(response.status).toBe(201);
    expect(createSchedule).toHaveBeenCalledWith(expect.objectContaining({ userId: 22 }));
  });
  it("supports detail, patch, delete, and lifecycle actions", async () => {
    expect((await show(new NextRequest("http://localhost/api/schedules/7"), params)).status).toBe(200);
    expect((await patch(new NextRequest("http://localhost/api/schedules/7", { method: "PATCH", body: JSON.stringify({ name: "Updated" }) }), params)).status).toBe(200);
    expect((await remove(new NextRequest("http://localhost/api/schedules/7", { method: "DELETE" }), params)).status).toBe(200);
    expect((await run(new NextRequest("http://localhost/api/schedules/7/run", { method: "POST" }), params)).status).toBe(202);
    expect((await pause(new NextRequest("http://localhost/api/schedules/7/pause", { method: "POST" }), params)).status).toBe(200);
    expect((await resume(new NextRequest("http://localhost/api/schedules/7/resume", { method: "POST" }), params)).status).toBe(200);
    expect(runScheduleNow).toHaveBeenCalledWith(7);
    expect(pauseSchedule).toHaveBeenCalledWith(7);
    expect(resumeSchedule).toHaveBeenCalledWith(7);
  });
});
