// __tests__/memory-scopes.test.ts
//
// Milestone 3 of the Discord-persona plan: memory grows two scopes —
// `persona:<personaId>` and `user:<userId>` — on top of global/repo/task.
// Pinned here:
//   • the scope VISIBILITY MATRIX: two personas never cross-read each other's
//     persona memories, two users never cross-read each other's user memories,
//     and global/repo/task behave exactly as before;
//   • memory_remember accepts the new scopes and writes the right scope_key
//     (user keys are String(users.id));
//   • the ambient mount reserves slots for the persona/user group so a chatty
//     repo can't evict them;
//   • auto-recall: the inbound user text BM25-searches every visible scope and
//     the hits ride the turn's PROMPT (never a persisted agent_messages row),
//     and a bare event wake gets no injected block.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  agentMessages,
  agentSessions,
  memories,
  personaMemories,
  personas as personasTable,
  users,
} from "../db/schema";
import * as backend from "../lib/agent-backend";
import * as repo from "../lib/repo";
import * as runs from "../lib/runs";
import { emitInboxEvent } from "../lib/inbox";
import {
  MEMORY_INJECTION_HEADING,
  buildMemoryInjection,
  personaMemoryFactory,
} from "../lib/extensions/persona-memory";
import { makeRegistrar } from "./helpers/fake-registrar";

const CWD = "/tmp/memory-scopes-test";

function personaFor(id: string) {
  return {
    id,
    name: id,
    description: "",
    systemPrompt: "x",
    toolsProfile: "orchestrator",
    skillPaths: [] as string[],
  };
}

async function seedPersona(id: string): Promise<void> {
  await db
    .insert(personasTable)
    .values({ id, name: id, systemPrompt: "x", toolsProfile: "orchestrator" })
    .onConflictDoNothing();
}

async function seedUser(email: string): Promise<number> {
  const rows = await db.insert(users).values({ email, passwordHash: "x" }).returning();
  return rows[0].id;
}

const SERVER_CHAT = {
  goal: "<chat>" as const,
  runtime: "server" as const,
  cwdStrategy: "none" as const,
  toolsProfile: "orchestrator",
  backend: "pi" as const,
};

async function makeRun(opts: {
  personaId?: string;
  userId?: number | null;
  taskId?: string | null;
  repoId?: string | null;
} = {}) {
  return await runs.create({
    ...SERVER_CHAT,
    personaId: opts.personaId ?? "alpha",
    userId: opts.userId ?? null,
    taskId: opts.taskId ?? null,
    repoId: opts.repoId ?? null,
    defer: true,
  } as any);
}

/** Mount the memory extension against a run and return its registrar capture. */
async function mount(run: { id: number; taskId: string | null; repoId: string | null }, personaId: string) {
  const r = makeRegistrar();
  await personaMemoryFactory(personaFor(personaId) as any, run, CWD)(r.reg);
  return r;
}

async function searchVia(
  r: Awaited<ReturnType<typeof mount>>,
  query: string
): Promise<Array<{ scope: string; scopeKey: string | null; body: string }>> {
  const res = await r.tools.get("memory_search")!.execute("c", { query, limit: 25 });
  expect(res.isError).toBeFalsy();
  return JSON.parse((res.content[0] as any).text).results;
}

beforeEach(async () => {
  await db.delete(agentMessages);
  await db.delete(memories);
  await db.delete(personaMemories);
  await db.delete(agentSessions);
  await db.delete(users);
  await db.delete(personasTable);
  await seedPersona("alpha");
  await seedPersona("beta");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scope visibility matrix", () => {
  it("two personas do not cross-read each other's persona-scope memories", async () => {
    await repo.createMemory({ scope: "persona", scopeKey: "alpha", body: "alpha prefers terse replies" });
    await repo.createMemory({ scope: "persona", scopeKey: "beta", body: "beta prefers verbose replies" });

    const alpha = await mount(await makeRun({ personaId: "alpha" }), "alpha");
    const beta = await mount(await makeRun({ personaId: "beta" }), "beta");

    const alphaHits = (await searchVia(alpha, "prefers replies")).map((h) => h.body);
    const betaHits = (await searchVia(beta, "prefers replies")).map((h) => h.body);

    expect(alphaHits).toEqual(["alpha prefers terse replies"]);
    expect(betaHits).toEqual(["beta prefers verbose replies"]);
  });

  it("two users do not cross-read each other's user-scope memories", async () => {
    const u1 = await seedUser("one@test.local");
    const u2 = await seedUser("two@test.local");
    await repo.createMemory({ scope: "user", scopeKey: String(u1), body: "user one works in Berlin" });
    await repo.createMemory({ scope: "user", scopeKey: String(u2), body: "user two works in Tokyo" });

    const r1 = await mount(await makeRun({ personaId: "alpha", userId: u1 }), "alpha");
    const r2 = await mount(await makeRun({ personaId: "beta", userId: u2 }), "beta");

    expect((await searchVia(r1, "works")).map((h) => h.body)).toEqual(["user one works in Berlin"]);
    expect((await searchVia(r2, "works")).map((h) => h.body)).toEqual(["user two works in Tokyo"]);

    // The user scope follows the USER, not the persona: a different persona
    // talking to user one still sees user one's memories.
    const crossPersona = await mount(await makeRun({ personaId: "beta", userId: u1 }), "beta");
    expect((await searchVia(crossPersona, "works")).map((h) => h.body)).toEqual([
      "user one works in Berlin",
    ]);
  });

  it("an unattributed run sees no user memories at all", async () => {
    const u1 = await seedUser("one@test.local");
    await repo.createMemory({ scope: "user", scopeKey: String(u1), body: "user one works in Berlin" });
    const anon = await mount(await makeRun({ personaId: "alpha", userId: null }), "alpha");
    expect(await searchVia(anon, "works")).toEqual([]);
  });

  it("global / repo / task visibility is unchanged", async () => {
    const repoRow = await repo.createRepository({ name: "mem-scope-repo", defaultBranch: "main" });
    const plan = await repo.createPlan({ title: "Scope plan", date: "2026-07-31" });
    const task = await repo.createTask({ planId: plan.id, title: "Scope task", date: "2026-07-31" });
    const otherTask = await repo.createTask({ planId: plan.id, title: "Other task", date: "2026-07-31" });

    await repo.createMemory({ scope: "global", scopeKey: null, body: "workspace ships on fridays" });
    await repo.createMemory({ scope: "repo", scopeKey: repoRow.id, body: "repo ships with vitest" });
    await repo.createMemory({ scope: "task", scopeKey: task.id, body: "task ships behind a flag" });
    await repo.createMemory({ scope: "task", scopeKey: otherTask.id, body: "other ships nothing" });

    const scoped = await mount(
      await makeRun({ personaId: "alpha", repoId: repoRow.id, taskId: task.id }),
      "alpha"
    );
    const bodies = (await searchVia(scoped, "ships")).map((h) => h.body).sort();
    expect(bodies).toEqual([
      "repo ships with vitest",
      "task ships behind a flag",
      "workspace ships on fridays",
    ]);

    // A run with neither repo nor task keeps seeing only global.
    const bare = await mount(await makeRun({ personaId: "alpha" }), "alpha");
    expect((await searchVia(bare, "ships")).map((h) => h.body)).toEqual([
      "workspace ships on fridays",
    ]);
  });
});

describe("memory_remember at the new scopes", () => {
  it("writes persona scope keyed by the run's persona id", async () => {
    const r = await mount(await makeRun({ personaId: "beta" }), "beta");
    const res = await r.tools.get("memory_remember")!.execute("c", {
      scope: "persona",
      note: "always restate the plan before acting",
      keywords: ["style"],
    });
    expect(res.isError).toBeFalsy();

    const rows = await db.select().from(memories).where(eq(memories.scope, "persona"));
    expect(rows).toHaveLength(1);
    expect(rows[0].scopeKey).toBe("beta");
    // persona/user scopes are not mirrored into the legacy persona_memories
    // table (nothing reads them back from there).
    expect(await db.select().from(personaMemories)).toHaveLength(0);
  });

  it("writes user scope keyed by String(users.id)", async () => {
    const uid = await seedUser("remember@test.local");
    const r = await mount(await makeRun({ personaId: "alpha", userId: uid }), "alpha");
    const res = await r.tools.get("memory_remember")!.execute("c", {
      scope: "user",
      note: "prefers metric units",
    });
    expect(res.isError).toBeFalsy();

    const rows = await db.select().from(memories).where(eq(memories.scope, "user"));
    expect(rows).toHaveLength(1);
    expect(rows[0].scopeKey).toBe(String(uid));
  });

  it("errors on user scope when the run is not attributed to a user", async () => {
    const r = await mount(await makeRun({ personaId: "alpha", userId: null }), "alpha");
    const res = await r.tools.get("memory_remember")!.execute("c", {
      scope: "user",
      note: "nobody in particular",
    });
    expect(res.isError).toBe(true);
    expect(await db.select().from(memories)).toHaveLength(0);
  });

  it("memory_forget removes a persona-scope note", async () => {
    const run = await makeRun({ personaId: "alpha" });
    const r = await mount(run, "alpha");
    await r.tools.get("memory_remember")!.execute("c", { scope: "persona", note: "drop me" });
    const res = await r.tools.get("memory_forget")!.execute("c", { scope: "persona", match: "drop" });
    expect((res.content[0] as any).text).toContain("Removed 1");
    expect(await db.select().from(memories)).toHaveLength(0);
  });
});

describe("ambient mount reserves slots for the identity scopes", () => {
  it("keeps persona/user memories mounted under repo-memory pressure", async () => {
    const uid = await seedUser("ambient@test.local");
    const repoRow = await repo.createRepository({ name: "chatty-repo", defaultBranch: "main" });

    // The persona/user notes are the OLDEST rows: a single flat recency cap
    // would drop both of them.
    await repo.createMemory({ scope: "persona", scopeKey: "alpha", body: "persona working style note" });
    await repo.createMemory({ scope: "user", scopeKey: String(uid), body: "user timezone note" });
    for (let i = 0; i < 30; i += 1) {
      await repo.createMemory({ scope: "repo", scopeKey: repoRow.id, body: `repo chatter ${i}` });
    }

    const run = await makeRun({ personaId: "alpha", userId: uid, repoId: repoRow.id });
    const r = await mount(run, "alpha");
    const body = r.skills[0].body;

    expect(body).toContain("persona working style note");
    expect(body).toContain("user timezone note");
    expect(body).toContain("repo chatter 29"); // the newest repo notes still mount
    expect(body).not.toContain("repo chatter 0"); // …but not all 30 of them
  });

  it("still fills the mount from global/repo/task when there are no identity memories", async () => {
    const repoRow = await repo.createRepository({ name: "quiet-repo", defaultBranch: "main" });
    for (let i = 0; i < 12; i += 1) {
      await repo.createMemory({ scope: "repo", scopeKey: repoRow.id, body: `repo note ${i}` });
    }
    const r = await mount(await makeRun({ personaId: "alpha", repoId: repoRow.id }), "alpha");
    for (let i = 0; i < 12; i += 1) {
      expect(r.skills[0].body).toContain(`repo note ${i}`);
    }
  });
});

describe("search candidate pool is per scope, not one shared recency window", () => {
  it("finds (and forgets) an old user memory buried under 60+ newer repo notes", async () => {
    const uid = await seedUser("pool@test.local");
    const repoRow = await repo.createRepository({ name: "loud-repo", defaultBranch: "main" });

    // The one note that matters is the OLDEST row in the run's visible scopes.
    await repo.createMemory({
      scope: "user",
      scopeKey: String(uid),
      body: "works in Berlin",
      keywords: ["berlin", "location"],
    });
    // Newer user notes push it out of the ambient mount as well, so search is
    // genuinely the only way back to it.
    for (let i = 0; i < 10; i += 1) {
      await repo.createMemory({ scope: "user", scopeKey: String(uid), body: `user note ${i}` });
    }
    // A shared cross-scope recency window (the old candidate fetch) holds ~50
    // rows, so this chatter alone made the note above unfindable.
    for (let i = 0; i < 64; i += 1) {
      await repo.createMemory({ scope: "repo", scopeKey: repoRow.id, body: `repo chatter ${i}` });
    }

    const run = await makeRun({ personaId: "alpha", userId: uid, repoId: repoRow.id });
    const r = await mount(run, "alpha");

    expect((await searchVia(r, "berlin")).map((h) => h.body)).toContain("works in Berlin");

    // …and auto-recall, which searches the same pool, still pushes it.
    const block = await buildMemoryInjection({
      run: { id: run.id, personaId: "alpha", userId: uid, repoId: repoRow.id, taskId: null },
      text: "where does she work again? berlin?",
    });
    expect(block).toContain("works in Berlin");
    expect(block).toContain(`[user:${uid}]`);

    // …and memory_forget can still reach it.
    const res = await r.tools.get("memory_forget")!.execute("c", { scope: "user", match: "Berlin" });
    expect((res.content[0] as any).text).toContain("Removed 1");
    const left = await db.select().from(memories).where(eq(memories.scope, "user"));
    expect(left.map((m) => m.body)).not.toContain("works in Berlin");
    expect(left).toHaveLength(10); // the unrelated user notes survive
  });
});

describe("ambient mount caps each rendered body", () => {
  it("truncates a very long note instead of paying for it on every turn", async () => {
    const long = `LONGNOTE ${"x".repeat(2000)} TAIL`;
    await repo.createMemory({ scope: "persona", scopeKey: "alpha", body: long });
    const r = await mount(await makeRun({ personaId: "alpha" }), "alpha");
    expect(r.skills[0].body).toContain("LONGNOTE");
    expect(r.skills[0].body).not.toContain("TAIL");
    expect(r.skills[0].body).toContain("…");
  });
});

describe("auto-recall injection", () => {
  it("builds a labelled block from the visible scopes and skips ambient duplicates", async () => {
    const uid = await seedUser("recall@test.local");
    const repoRow = await repo.createRepository({ name: "recall-repo", defaultBranch: "main" });
    await repo.createMemory({
      scope: "repo",
      scopeKey: repoRow.id,
      body: "deploys must be announced in #ops first",
      keywords: ["deploy"],
    });
    // Push that note out of the ambient mount with newer repo rows: auto-recall
    // is what has to surface it now.
    for (let i = 0; i < 20; i += 1) {
      await repo.createMemory({ scope: "repo", scopeKey: repoRow.id, body: `filler ${i}` });
    }
    const run = await makeRun({ personaId: "alpha", userId: uid, repoId: repoRow.id });
    const scopeRun = { id: run.id, personaId: "alpha", userId: uid, repoId: repoRow.id, taskId: null };

    const block = await buildMemoryInjection({ run: scopeRun, text: "can I deploy now?" });
    expect(block).toContain(MEMORY_INJECTION_HEADING);
    expect(block).toContain(`[repo:${repoRow.id}]`);
    expect(block).toContain("deploys must be announced");

    // A query whose only match IS ambient-mounted injects nothing — the model
    // already has that note in the mounted skill.
    await repo.createMemory({ scope: "repo", scopeKey: repoRow.id, body: "zebra quasar convention" });
    const dupe = await buildMemoryInjection({ run: scopeRun, text: "zebra quasar" });
    expect(dupe).toBeNull();
  });

  it("returns null when nothing matches", async () => {
    const run = await makeRun({ personaId: "alpha" });
    await repo.createMemory({ scope: "global", scopeKey: null, body: "unrelated note" });
    expect(
      await buildMemoryInjection({
        run: { id: run.id, personaId: "alpha", userId: null, repoId: null, taskId: null },
        text: "zebra quasar",
      })
    ).toBeNull();
  });
});

/** Stubbed backend that records the prompt each turn was handed. */
function stubBackend() {
  const seen: Array<{ contextKind: string; prompt: string }> = [];
  vi.spyOn(backend, "getBackend").mockResolvedValue({
    id: "pi",
    async runTurn(args: any) {
      seen.push({ contextKind: args.contextSource?.kind, prompt: args.prompt });
      args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
      args.onEvent({ type: "result", is_error: false, result: "ok", usage: {} });
      return {
        summary: "ok",
        resumeToken: null,
        turns: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalCostUsd: 0,
      };
    },
  } as any);
  return seen;
}

describe("auto-recall reaches the model as prompt text only", () => {
  it("injects for an inbound user message and never persists the block", async () => {
    const repoRow = await repo.createRepository({ name: "turn-repo", defaultBranch: "main" });
    await repo.createMemory({
      scope: "repo",
      scopeKey: repoRow.id,
      body: "deploys must be announced in #ops first",
      keywords: ["deploy"],
    });
    for (let i = 0; i < 20; i += 1) {
      await repo.createMemory({ scope: "repo", scopeKey: repoRow.id, body: `filler ${i}` });
    }
    const seen = stubBackend();
    const run = await runs.create({
      ...SERVER_CHAT,
      personaId: "alpha",
      repoId: repoRow.id,
    } as any);

    const abort = new AbortController();
    for await (const _ of runs.sendMessageToRun({
      runId: run.id,
      role: "user",
      text: "can I deploy now?",
      abort,
    })) {
      // drain
    }

    expect(seen).toHaveLength(1);
    expect(seen[0].contextKind).toBe("postgres");
    expect(seen[0].prompt).toContain(MEMORY_INJECTION_HEADING);
    expect(seen[0].prompt).toContain("deploys must be announced");
    // …and the user's own text still rides the same prompt.
    expect(seen[0].prompt).toContain("can I deploy now?");

    // Nothing persisted carries the block: postgres mode rebuilds context from
    // agent_messages every turn, so a persisted block would be re-fed forever.
    const rows = await db.select().from(agentMessages).where(eq(agentMessages.runId, run.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.content).not.toContain(MEMORY_INJECTION_HEADING);
    }
    const userRow = rows.find((r) => r.role === "user");
    expect(userRow!.content).toContain("can I deploy now?");
  });

  // The hook lives in runOneTurn ABOVE the context-mode branch, so it must fire
  // for the sdk-session path too (a worker-runtime chat driven in-process on a
  // deployment without a remote runner — see run-runtime-server.test.ts).
  // Gating the hook on `usePostgres` has to fail this test.
  it("injects on the sdk-session path too, and not for an ephemeral wake", async () => {
    const repoRow = await repo.createRepository({ name: "sdk-repo", defaultBranch: "main" });
    await repo.createMemory({
      scope: "repo",
      scopeKey: repoRow.id,
      body: "deploys must be announced in #ops first",
      keywords: ["deploy"],
    });
    for (let i = 0; i < 20; i += 1) {
      await repo.createMemory({ scope: "repo", scopeKey: repoRow.id, body: `filler ${i}` });
    }
    const seen = stubBackend();
    // runtime='worker' (the default) + no worktree: the in-process append path
    // drives it through the SDK-session context mode.
    const run = await runs.create({
      goal: "<chat>",
      personaId: "alpha",
      repoId: repoRow.id,
      cwdStrategy: "none",
      backend: "pi",
    } as any);
    expect(run.runtime).toBe("worker");

    const abort = new AbortController();
    for await (const _ of runs.sendMessageToRun({
      runId: run.id,
      role: "user",
      text: "can I deploy now?",
      abort,
    })) {
      // drain
    }

    expect(seen).toHaveLength(1);
    expect(seen[0].contextKind).not.toBe("postgres");
    expect(seen[0].prompt).toContain(MEMORY_INJECTION_HEADING);
    expect(seen[0].prompt).toContain("deploys must be announced");
    expect(seen[0].prompt).toContain("can I deploy now?");
  });

  it("injects nothing on a bare event wake", async () => {
    const repoRow = await repo.createRepository({ name: "wake-repo", defaultBranch: "main" });
    await repo.createMemory({
      scope: "repo",
      scopeKey: repoRow.id,
      body: "child results must be announced in #ops first",
      keywords: ["child", "result"],
    });
    for (let i = 0; i < 20; i += 1) {
      await repo.createMemory({ scope: "repo", scopeKey: repoRow.id, body: `filler ${i}` });
    }
    const seen = stubBackend();
    const run = await runs.create({
      ...SERVER_CHAT,
      personaId: "alpha",
      repoId: repoRow.id,
    } as any);
    // Parked: the emit-time wake hands a server-runtime row to the in-process
    // turn driver (see __tests__/run-runtime-server.test.ts).
    await db.update(agentSessions).set({ status: "parked" }).where(eq(agentSessions.id, run.id));

    await emitInboxEvent({
      targetRunId: run.id,
      type: "child.result",
      sourceKind: "run",
      sourceId: String(run.id),
      payload: { summary: "child finished" },
    });

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0].prompt).toContain("child.result"); // the digest still rides the prompt
    expect(seen[0].prompt).not.toContain(MEMORY_INJECTION_HEADING);
  });
});
