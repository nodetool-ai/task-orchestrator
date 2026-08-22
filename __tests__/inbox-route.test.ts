// __tests__/inbox-route.test.ts
//
// GET /api/inbox — the terminal cockpit's cross-run needs-you list (T-tui-04).
// Real DB, real handler: the two sources this endpoint merges (pending
// inbox_events on live runs + runs parked on an open question) can only be set
// up and asserted against the actual tables, and the live/terminal decision the
// route encodes is exactly the kind of thing a mock would happily agree with
// while the query said otherwise.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../auth", () => ({
  // Resolves to the same module as the route's "@/auth" (vitest alias).
  auth: vi.fn(async () => ({ user: { email: "t@example.com" } })),
}));

import { db } from "../db";
import { agentSessions, inboxEvents, runTimers } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import {
  emitInboxEvent,
  inboxKindForType,
  listGlobalInbox,
  summarizeInboxEvent,
} from "../lib/inbox";
import type { GlobalInboxRow } from "../lib/inbox";
import type { PendingQuestion } from "../lib/run-state";
import { GET } from "../app/api/inbox/route";

async function insertRun(
  values: Partial<typeof agentSessions.$inferInsert> = {}
): Promise<number> {
  const rows = await db
    .insert(agentSessions)
    .values({
      goal: "<execute>",
      toolsProfile: "orchestrator",
      cwdStrategy: "none",
      personaId: "implementor",
      status: "idle",
      startedAt: new Date(),
      ...values,
    })
    .returning({ id: agentSessions.id });
  return rows[0].id;
}

function openQuestion(question: string, askedAt: Date): PendingQuestion {
  return {
    question_id: `q-${askedAt.getTime()}`,
    question,
    asked_at: askedAt.toISOString(),
    deadline: new Date(askedAt.getTime() + 3_600_000).toISOString(),
    state: "open",
  };
}

async function callRoute(query = ""): Promise<{ status: number; body: any }> {
  const res = await GET(new NextRequest(`http://localhost/api/inbox${query}`));
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  await seedPersonas();
  await db.delete(runTimers);
  await db.delete(inboxEvents);
  await db.delete(agentSessions);
});

describe("inboxKindForType", () => {
  it("maps the dotted taxonomy onto the four cockpit buckets", () => {
    expect(inboxKindForType("gh.pr.review_submitted")).toBe("review");
    expect(inboxKindForType("gh.pr.merged")).toBe("review");
    expect(inboxKindForType("gh.ci.completed")).toBe("review");
    expect(inboxKindForType("budget.warning")).toBe("budget");
    expect(inboxKindForType("child.budget_exhausted")).toBe("budget");
    expect(inboxKindForType("child.question")).toBe("question");
    expect(inboxKindForType("run.question")).toBe("question");
    expect(inboxKindForType("child.exception")).toBe("stuck");
    expect(inboxKindForType("child.died")).toBe("stuck");
    // Unknown types fail safe into the queue rather than disappearing.
    expect(inboxKindForType("something.brand_new")).toBe("stuck");
  });
});

describe("summarizeInboxEvent", () => {
  it("prefixes the type and takes the payload's first non-empty line", () => {
    expect(summarizeInboxEvent("child.exception", { message: "merge conflict\ndetails" })).toBe(
      "child.exception: merge conflict"
    );
    expect(summarizeInboxEvent("child.result", { result: { summary: "shipped" } })).toBe(
      "child.result: shipped"
    );
    // Nothing renderable in the payload → the type alone is the summary.
    expect(summarizeInboxEvent("timer.fired", { timer_id: 4 })).toBe("timer.fired");
  });
});

describe("GET /api/inbox", () => {
  it("returns pending owner events across live runs, newest first, denormalised", async () => {
    const a = await insertRun({ status: "parked", title: "ship the CLI" });
    const b = await insertRun({
      status: "running",
      personaId: "qa",
      prUrl: "https://github.com/o/r/pull/312",
    });

    const first = await emitInboxEvent({
      targetRunId: a,
      type: "child.exception",
      sourceKind: "run",
      sourceId: "99",
      attempt: 1,
      payload: { message: "merge conflict in lib/repo.ts" },
      noWake: true,
    });
    const second = await emitInboxEvent({
      targetRunId: b,
      type: "gh.pr.review_submitted",
      sourceKind: "github",
      payload: { state: "changes_requested", body: "needs a test" },
      noWake: true,
    });

    const { status, body } = await callRoute("?audience=owner");
    expect(status).toBe(200);
    const items = body.items as GlobalInboxRow[];

    // Newest first: the later event id leads.
    expect(items.map((i) => i.id)).toEqual([`e${second.eventId}`, `e${first.eventId}`]);

    expect(items[0]).toMatchObject({
      runId: b,
      personaId: "qa",
      kind: "review",
      type: "gh.pr.review_submitted",
      prUrl: "https://github.com/o/r/pull/312",
      text: "gh.pr.review_submitted: needs a test",
    });
    expect(items[0].personaName).toBeTruthy();
    expect(items[1]).toMatchObject({
      runId: a,
      kind: "stuck",
      runTitle: "ship the CLI",
      text: "child.exception: merge conflict in lib/repo.ts",
    });
    // A run with no title falls back to its goal.
    expect(items[0].runTitle).toBe("<execute>");
    expect(Date.parse(items[0].createdAt)).not.toBeNaN();
  });

  it("excludes pending events on terminal runs — they can never be injected", async () => {
    const live = await insertRun({ status: "parked" });
    const dead = await insertRun({ status: "failed" });

    await emitInboxEvent({
      targetRunId: live,
      type: "timer.fired",
      sourceKind: "timer",
      sourceId: "1",
      noWake: true,
    });
    await emitInboxEvent({
      targetRunId: dead,
      type: "timer.fired",
      sourceKind: "timer",
      sourceId: "2",
      noWake: true,
    });

    const rows = await listGlobalInbox("owner");
    expect(rows.map((r) => r.runId)).toEqual([live]);
  });

  it("folds in live runs parked on an OPEN question and skips answered ones", async () => {
    const asked = new Date(Date.now() - 60_000);
    const open = await insertRun({
      status: "parked",
      parkReason: "question",
      pendingQuestion: openQuestion("pi or claude for the new chat command?", asked),
    });
    await insertRun({
      status: "parked",
      parkReason: "question",
      pendingQuestion: { ...openQuestion("already settled", asked), state: "answered" },
    });
    // Parked on a question but terminal: nothing a human answers can revive it.
    await insertRun({
      status: "cancelled",
      parkReason: "question",
      pendingQuestion: openQuestion("dead run's question", asked),
    });

    const rows = await listGlobalInbox("owner");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `q${open}`,
      runId: open,
      kind: "question",
      type: "run.question",
      text: "pi or claude for the new chat command?",
    });
    // A question row sorts by when it was asked, not by run start.
    expect(rows[0].createdAt).toBe(asked.toISOString());

    // The supervisor stream is the informational copy — no question rows there.
    expect(await listGlobalInbox("supervisor")).toEqual([]);
  });

  it("orders questions and events together, newest first", async () => {
    const run = await insertRun({ status: "parked" });
    await emitInboxEvent({
      targetRunId: run,
      type: "budget.warning",
      sourceKind: "budget",
      payload: { note: "80% of cap" },
      noWake: true,
    });

    // Asked an hour ago — older than the event just emitted.
    const parked = await insertRun({
      status: "parked",
      parkReason: "question",
      pendingQuestion: openQuestion("older question", new Date(Date.now() - 3_600_000)),
    });

    const rows = await listGlobalInbox("owner");
    expect(rows.map((r) => r.kind)).toEqual(["budget", "question"]);
    expect(rows[1].runId).toBe(parked);
  });

  it("rejects an unknown audience with 400", async () => {
    const { status, body } = await callRoute("?audience=nobody");
    expect(status).toBe(400);
    expect(body.error).toMatch(/audience/i);
    expect(body.items).toBeUndefined();
  });

  it("defaults to the owner audience", async () => {
    const run = await insertRun({ status: "parked" });
    await emitInboxEvent({
      targetRunId: run,
      type: "timer.fired",
      sourceKind: "timer",
      sourceId: "1",
      noWake: true,
    });
    const { body } = await callRoute();
    expect((body.items as GlobalInboxRow[]).map((i) => i.runId)).toEqual([run]);
  });

  it("clamps limit to 1..500 and honours a valid one", async () => {
    const run = await insertRun({ status: "parked" });
    for (let i = 0; i < 3; i += 1) {
      await emitInboxEvent({
        targetRunId: run,
        type: "timer.fired",
        sourceKind: "timer",
        sourceId: String(i),
        noWake: true,
      });
    }

    expect((await callRoute("?limit=2")).body.items).toHaveLength(2);
    // 0 / negative / garbage fall back to the default rather than returning nothing.
    expect((await callRoute("?limit=0")).body.items).toHaveLength(3);
    expect((await callRoute("?limit=abc")).body.items).toHaveLength(3);
    // Above the ceiling still works — it is clamped, not rejected.
    expect((await callRoute("?limit=9999")).body.items).toHaveLength(3);
    expect(await listGlobalInbox("owner", 1)).toHaveLength(1);
  });
});
