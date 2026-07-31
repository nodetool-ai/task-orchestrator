// Milestone 5 — orchestration + progress relay.
//
// Four surfaces are covered here, all of them things that are easy to get
// subtly wrong and impossible to notice in production until a user complains:
//
//   • the RELAY: which threads a child run's breadcrumbs belong to (the
//     channel_threads 3-tuple join), per-status dedupe, the ≤1-per-10-minutes
//     progress throttle, the >3-in-a-minute digest collapse, breadcrumb
//     formatting, and the invariant that none of it ever writes agent_messages;
//   • the THREAD-TITLE state machine, including standing down permanently once
//     a human has retitled the thread;
//   • REACTIONS as input: 👍/👎 only answer an OPEN question, and ❌ on a
//     breadcrumb is a confirm-gated run cancel rather than a turn interrupt;
//   • the LONG-THREAD guard and its model-free summary carry-over.
//
// Style follows the other pipe tests: fake channels, direct method calls, real
// Postgres. The relay is driven by calling tick() rather than by its interval.

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  agentMessages,
  agentSessions,
  channelIdentities,
  channelThreads,
  personas as personasTable,
  plans,
  tasks,
  users,
} from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import * as backend from "../lib/agent-backend";
import { reconstructContext } from "../lib/agent-backend/postgres-turn";
import { emitInboxEvent, hasPendingInboxEvents } from "../lib/inbox";
import { dispatchRun } from "../lib/run-dispatch";
import * as runs from "../lib/runs";
import { AgentLoop } from "../lib/pipe/agent-loop";
import { ChannelManager } from "../lib/pipe/channel-manager";
import { agentTurnCount, buildCarryOverSummary } from "../lib/pipe/carryover";
import { handleCommand } from "../lib/pipe/commands";
import { classify, orderItems, renderDigest, type DigestItem } from "../lib/pipe/digest";
import {
  BATCH_THRESHOLD,
  PROGRESS_THROTTLE_MS,
  ProgressRelay,
  formatBreadcrumb,
  titleStateFor,
  withGlyph,
  type RelayChannel,
} from "../lib/pipe/relay";
import { getOrCreateRun } from "../lib/pipe/session-store";
import type { Channel, InboundMessage, OutboundDraft, PipeConfig } from "../lib/pipe/types";

const PERSONA = "aria";
const OTHER = "rex";

const config: PipeConfig = {
  bots: [{ personaId: PERSONA, token: "x", allowedUsers: ["u1"], allowedChannels: [] }],
  defaultModel: "anthropic/claude-sonnet-4-6",
  editThrottleMs: 0,
};

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "discord",
  externalId: "thread-1",
  text: "hello",
  authorId: "u1",
  authorLabel: "discord:tester",
  authorName: "tester",
  personaId: PERSONA,
  isDirectMessage: true,
  ...over,
});

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeMessage {
  id: string;
  text: string;
  edits: string[];
}

/** A RelayChannel that records every message it "posts" and every rename. */
function fakeRelayChannel(personaId = PERSONA, initialTitle = "Dark-mode toggle") {
  const posts: FakeMessage[] = [];
  const renames: string[] = [];
  let title = initialTitle;
  let seq = 0;
  const channel: RelayChannel = {
    name: "discord",
    personaId,
    async openDraft(_externalId, initial): Promise<OutboundDraft> {
      const m: FakeMessage = { id: `m-${++seq}`, text: initial, edits: [] };
      posts.push(m);
      return {
        messageId: m.id,
        async update(text) {
          m.edits.push(text);
          m.text = text;
        },
        async finalize(text) {
          m.text = text;
        },
      };
    },
    async threadTitle() {
      return title;
    },
    async renameThread(_externalId, next) {
      renames.push(next);
      title = next;
    },
  };
  return {
    channel,
    posts,
    renames,
    setTitle: (t: string) => {
      title = t;
    },
    get title() {
      return title;
    },
  };
}

/** A full pipe Channel stub for AgentLoop tests. */
function fakeChannel() {
  const sends: string[] = [];
  const reactions: string[] = [];
  /** Finalized draft texts (the turn's answer), kept apart from plain sends. */
  const finals: string[] = [];
  /** mentionUsers passed with each finalize/send, in order. */
  const mentions: Array<string[] | undefined> = [];
  /** Ids of the drafts opened, in order — the persona's own messages. */
  const drafts: string[] = [];
  let seq = 0;
  const channel: Channel = {
    name: "discord",
    async start() {},
    async stop() {},
    onMessage() {},
    async openDraft(): Promise<OutboundDraft> {
      // A real transport gives the draft an addressable id; the loop needs it to
      // tell "👍 on my question" from "👍 on some other message".
      const id = `own-${++seq}`;
      drafts.push(id);
      return {
        messageId: id,
        async update() {},
        async finalize(text, opts) {
          finals.push(text);
          mentions.push(opts?.mentionUsers);
        },
      };
    },
    async send(_id, text, _token, opts) {
      sends.push(text);
      mentions.push(opts?.mentionUsers);
    },
    async react(_id, _mid, emoji) {
      reactions.push(emoji);
    },
    async unreact(_id, _mid, emoji) {
      reactions.push(`-${emoji}`);
    },
  };
  return { channel, sends, finals, mentions, drafts, reactions };
}

// ── fixtures ────────────────────────────────────────────────────────────────

async function makePersona(id: string, toolsProfile = "orchestrator,spawn"): Promise<void> {
  await db
    .insert(personasTable)
    .values({ id, name: id.toUpperCase(), systemPrompt: "x", toolsProfile, backend: "pi" })
    .onConflictDoUpdate({ target: personasTable.id, set: { toolsProfile, backend: "pi" } });
}

/** A persona conversation run + its channel_threads mapping. */
async function makeConversation(
  externalId: string,
  personaId = PERSONA
): Promise<number> {
  const [run] = await db
    .insert(agentSessions)
    .values({
      goal: "<chat>",
      status: "idle",
      runtime: "server",
      cwdStrategy: "none",
      toolsProfile: "orchestrator,spawn",
      personaId,
      backend: "pi",
      title: "Dark-mode toggle",
    })
    .returning({ id: agentSessions.id });
  await db
    .insert(channelThreads)
    .values({ channel: "discord", externalId, personaId, runId: run.id });
  return run.id;
}

async function makeChild(
  parentRunId: number,
  over: Partial<typeof agentSessions.$inferInsert> = {}
): Promise<number> {
  const [row] = await db
    .insert(agentSessions)
    .values({
      goal: "implement dark mode",
      status: "running",
      parentRunId,
      title: "Dark-mode toggle",
      ...over,
    })
    .returning({ id: agentSessions.id });
  return row.id;
}

async function setChild(id: number, patch: Partial<typeof agentSessions.$inferInsert>) {
  await db.update(agentSessions).set(patch).where(eq(agentSessions.id, id));
}

/** A task in a plan, for the title machine's task-state path. */
async function makeTask(id: string, state: string): Promise<string> {
  await db
    .insert(plans)
    .values({ id: "P-1", title: "Dark mode" })
    .onConflictDoNothing();
  await db.insert(tasks).values({ id, title: "Dark-mode toggle", planId: "P-1", state });
  return id;
}

/**
 * A relay that has completed its PRIMING tick (relay.ts header): the first tick
 * after startup records whatever it finds as already-announced and says nothing,
 * so a restart cannot replay history into the thread. Every test that expects a
 * breadcrumb therefore creates its children AFTER priming — which is also the
 * real-world shape: the pipe is running, then work starts.
 */
async function primedRelay(
  channels: RelayChannel[],
  opts?: ConstructorParameters<typeof ProgressRelay>[1]
): Promise<ProgressRelay> {
  const relay = new ProgressRelay(channels, opts);
  await relay.tick();
  return relay;
}

async function addAgentMessages(runId: number, n: number) {
  for (let i = 0; i < n; i++) {
    await db.insert(agentMessages).values({
      runId,
      role: "agent",
      content: JSON.stringify([{ type: "text", text: `turn ${i}` }]),
      createdAt: new Date(),
    });
  }
}

beforeEach(async () => {
  await seedPersonas();
  await makePersona(PERSONA);
  await makePersona(OTHER);
  await db.delete(channelThreads);
  await db.delete(channelIdentities);
  await db.delete(agentSessions);
  await db.delete(tasks);
  await db.delete(plans);
  await db.delete(users);
  startedTurns.length = 0;
});

// ──────────────────────────────────────────────────────────
// Mapping + dedupe
// ──────────────────────────────────────────────────────────

describe("relay mapping", () => {
  it("posts a child's breadcrumb into the thread that owns its parent run", async () => {
    const parent = await makeConversation("thread-1");
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel]);
    const child = await makeChild(parent);

    await relay.tick();

    expect(ch.posts).toHaveLength(1);
    expect(ch.posts[0].text).toContain(`run #${child} started`);
  });

  it("primes on the first tick after a restart instead of replaying history", async () => {
    const parent = await makeConversation("thread-1");
    const child = await makeChild(parent, { prUrl: "https://gh/pr/7" });
    const ch = fakeRelayChannel();

    // A relay that boots into an existing world says NOTHING about it: the
    // "started" and "PR opened" breadcrumbs for this child are already history.
    const relay = new ProgressRelay([ch.channel]);
    await relay.tick();
    expect(ch.posts).toEqual([]);

    // Transitions observed AFTER priming do announce.
    await setChild(child, { status: "completed" });
    await relay.tick();
    expect(ch.posts).toHaveLength(1);
    expect(ch.posts[0].text).toContain(`run #${child} done`);
  });

  it("ignores a conversation belonging to a persona this pipe doesn't run", async () => {
    const parent = await makeConversation("thread-2", OTHER);
    const ch = fakeRelayChannel(PERSONA);
    const relay = await primedRelay([ch.channel]);
    await makeChild(parent);
    await relay.tick();
    expect(ch.posts).toEqual([]);
  });

  it("ignores an orphan run with no parent conversation", async () => {
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel]);
    await db.insert(agentSessions).values({ goal: "loose", status: "running" });
    await relay.tick();
    expect(ch.posts).toEqual([]);
  });

  it("dedupes per run per status across ticks", async () => {
    const parent = await makeConversation("thread-1");
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel]);
    const child = await makeChild(parent);

    await relay.tick();
    await relay.tick();
    await relay.tick();
    expect(ch.posts).toHaveLength(1); // "started", once

    await setChild(child, { prUrl: "https://gh/pr/1" });
    await relay.tick();
    await relay.tick();
    expect(ch.posts).toHaveLength(2);
    expect(ch.posts[1].text).toContain("PR opened: https://gh/pr/1");

    await setChild(child, { status: "completed" });
    await relay.tick();
    expect(ch.posts).toHaveLength(3);
    expect(ch.posts[2].text).toContain("done");
  });

  it("never writes agent_messages — breadcrumbs are transport-only", async () => {
    const parent = await makeConversation("thread-1");
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel]);
    const child = await makeChild(parent);
    await relay.tick();
    await setChild(child, { prUrl: "https://gh/pr/9", status: "completed" });
    await relay.tick();

    // An agent-role row here would be fed straight back to the model by the
    // postgres-turn context loader — the persona would "remember" saying it.
    const rows = await db.select().from(agentMessages);
    expect(rows).toEqual([]);
    expect(ch.posts.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────
// Throttling, batching, edit-in-place
// ──────────────────────────────────────────────────────────

describe("breadcrumb etiquette", () => {
  it("emits at most one progress breadcrumb per run per 10 minutes", async () => {
    const parent = await makeConversation("thread-1");
    let now = 1_000_000;
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel], { now: () => now });
    const child = await makeChild(parent);

    await relay.tick(); // started
    await addAgentMessages(child, 2);
    await relay.tick(); // no progress yet: the window hasn't elapsed
    expect(ch.posts).toHaveLength(1);

    now += PROGRESS_THROTTLE_MS;
    await relay.tick(); // progress #1
    expect(ch.posts).toHaveLength(2);
    expect(ch.posts[1].text).toContain("2 turns in");

    await addAgentMessages(child, 1);
    await relay.tick(); // inside the window again — nothing
    expect(ch.posts).toHaveLength(2);

    now += PROGRESS_THROTTLE_MS;
    await relay.tick(); // progress #2 EDITS the previous message in place
    expect(ch.posts).toHaveLength(2);
    expect(ch.posts[1].edits).toHaveLength(1);
    expect(ch.posts[1].text).toContain("3 turns in");
  });

  it("says nothing when a running child produced no new turns", async () => {
    const parent = await makeConversation("thread-1");
    let now = 1_000_000;
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel], { now: () => now });
    await makeChild(parent);
    await relay.tick();
    now += PROGRESS_THROTTLE_MS * 5;
    await relay.tick();
    expect(ch.posts).toHaveLength(1);
  });

  it("collapses a burst of more than three breadcrumbs into one digest message", async () => {
    const parent = await makeConversation("thread-1");
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel], { now: () => 5_000 });
    for (let i = 0; i < BATCH_THRESHOLD + 1; i++) await makeChild(parent);
    await relay.tick();

    expect(ch.posts).toHaveLength(1);
    expect(ch.posts[0].text.split("\n")).toHaveLength(BATCH_THRESHOLD + 1);
  });

  it("sends a small burst as separate lines", async () => {
    const parent = await makeConversation("thread-1");
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel], { now: () => 5_000 });
    for (let i = 0; i < BATCH_THRESHOLD; i++) await makeChild(parent);
    await relay.tick();
    expect(ch.posts).toHaveLength(BATCH_THRESHOLD);
  });

  it("formats breadcrumbs as one glyph-prefixed line with no mention", () => {
    const child = { id: 214, title: "Dark-mode toggle", taskId: "T-1", goal: "x", prUrl: null };
    const started = formatBreadcrumb("started", child);
    expect(started.startsWith("⏳")).toBe(true);
    expect(started).toContain("run #214");
    expect(started).toContain("task `T-1`");
    for (const kind of ["started", "done", "failed"] as const) {
      const line = formatBreadcrumb(kind, child);
      expect(line.split("\n")).toHaveLength(1);
      expect(line).not.toContain("@");
    }
    expect(formatBreadcrumb("failed", child).startsWith("❌")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────
// Thread-title state machine
// ──────────────────────────────────────────────────────────

describe("thread title", () => {
  it("walks 🚧 → 🔍 → ✅, taking the terminal glyph from TASK state", async () => {
    const parent = await makeConversation("thread-1");
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel], { now: () => 1000 });
    await makeTask("T-1", "in_progress");
    const child = await makeChild(parent, { taskId: "T-1" });

    await relay.tick();
    expect(ch.title).toBe("🚧 Dark-mode toggle");

    // Run finished with a PR, task still open → the work is in REVIEW, not done.
    await setChild(child, { status: "completed", prUrl: "https://gh/pr/1" });
    await relay.tick();
    expect(ch.title).toBe("🔍 Dark-mode toggle");

    // The PR merged: the task lands, and the thread is done — with the PR link
    // still on the run (no artificial prUrl:null needed to reach ✅).
    await db.update(tasks).set({ state: "merged" }).where(eq(tasks.id, "T-1"));
    await relay.tick();
    expect(ch.title).toBe("✅ Dark-mode toggle");
  });

  it("falls back to run state for a child with no task", async () => {
    const parent = await makeConversation("thread-1");
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel], { now: () => 1000 });
    const child = await makeChild(parent);

    await setChild(child, { status: "completed", prUrl: "https://gh/pr/2" });
    await relay.tick();
    expect(ch.title).toBe("🔍 Dark-mode toggle"); // a PR on a completed run = review

    await setChild(child, { prUrl: null });
    await relay.tick();
    expect(ch.title).toBe("✅ Dark-mode toggle");
  });

  it("marks the thread ❌ when the child fails", async () => {
    const parent = await makeConversation("thread-1");
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel], { now: () => 1000 });
    const child = await makeChild(parent);
    await relay.tick();
    await setChild(child, { status: "failed" });
    await relay.tick();
    expect(ch.title).toBe("❌ Dark-mode toggle");
  });

  it("leaves a title it doesn't recognise alone after a restart", async () => {
    // The relay restarted into a thread whose title carries none of its glyphs:
    // either a human renamed it or an older deployment owned it. Either way it
    // stands down rather than overwriting somebody's words.
    const parent = await makeConversation("thread-1");
    await makeChild(parent);
    const ch = fakeRelayChannel(PERSONA, "Ivo's dark mode work");
    const relay = new ProgressRelay([ch.channel], { now: () => 1000 });

    await relay.tick(); // priming pass — sees a title it never set
    await relay.tick();
    expect(ch.renames).toEqual([]);
    expect(ch.title).toBe("Ivo's dark mode work");
  });

  it("adopts a glyphed title after a restart — that one is its own", async () => {
    const parent = await makeConversation("thread-1");
    const child = await makeChild(parent);
    const ch = fakeRelayChannel(PERSONA, "🚧 Dark-mode toggle");
    const relay = new ProgressRelay([ch.channel], { now: () => 1000 });

    await relay.tick(); // priming: the 🚧 says the machine owns this title
    await setChild(child, { status: "completed" });
    await relay.tick();
    expect(ch.title).toBe("✅ Dark-mode toggle");
  });

  it("stands down permanently once a human has retitled the thread", async () => {
    const parent = await makeConversation("thread-1");
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel], { now: () => 1000 });
    const child = await makeChild(parent);
    await relay.tick();
    expect(ch.renames).toHaveLength(1);

    ch.setTitle("Ivo's dark mode work"); // a human renamed it
    await setChild(child, { status: "completed" });
    await relay.tick();
    expect(ch.renames).toHaveLength(1);
    expect(ch.title).toBe("Ivo's dark mode work");

    await setChild(child, { status: "failed" });
    await relay.tick();
    expect(ch.renames).toHaveLength(1); // still standing down
  });

  it("does not rewrite the title when the state hasn't changed", async () => {
    const parent = await makeConversation("thread-1");
    const ch = fakeRelayChannel();
    const relay = await primedRelay([ch.channel], { now: () => 1000 });
    await makeChild(parent);
    await relay.tick();
    await relay.tick();
    await relay.tick();
    expect(ch.renames).toEqual(["🚧 Dark-mode toggle"]);
  });

  it("computes the aggregate state and swaps the leading glyph", () => {
    expect(titleStateFor([{ status: "running", prUrl: null }])).toBe("working");
    expect(
      titleStateFor([
        { status: "completed", prUrl: "u" },
        { status: "completed", prUrl: null },
      ])
    ).toBe("review");
    // Task state decides the terminal glyph where a child has one.
    expect(
      titleStateFor([{ status: "completed", prUrl: "u", taskId: "T-1" }], new Map([["T-1", "merged"]]))
    ).toBe("done");
    expect(
      titleStateFor(
        [{ status: "completed", prUrl: "u", taskId: "T-1" }],
        new Map([["T-1", "passing"]])
      )
    ).toBe("review");
    expect(titleStateFor([{ status: "completed", prUrl: null }])).toBe("done");
    expect(titleStateFor([{ status: "failed", prUrl: null }])).toBe("failed");
    // A still-running sibling outranks a finished one.
    expect(
      titleStateFor([
        { status: "failed", prUrl: null },
        { status: "running", prUrl: null },
      ])
    ).toBe("working");
    expect(withGlyph("🚧 Ship it", "done")).toBe("✅ Ship it");
    expect(withGlyph("Ship it", "working")).toBe("🚧 Ship it");
  });
});

// ──────────────────────────────────────────────────────────
// /status digest
// ──────────────────────────────────────────────────────────

describe("/status digest", () => {
  const item = (over: Partial<DigestItem> = {}): DigestItem => ({
    runId: 1,
    label: "Dark-mode toggle",
    glyph: "⏳",
    action: "working",
    links: ["/runs/1"],
    blockedOnUser: false,
    startedAt: new Date(2026, 0, 1),
    ...over,
  });

  it("puts blocked-on-user items first, then oldest first", () => {
    const ordered = orderItems([
      item({ runId: 1, startedAt: new Date(2026, 0, 3) }),
      item({ runId: 2, blockedOnUser: true, startedAt: new Date(2026, 0, 5) }),
      item({ runId: 3, startedAt: new Date(2026, 0, 1) }),
      item({ runId: 4, blockedOnUser: true, startedAt: new Date(2026, 0, 2) }),
    ]);
    expect(ordered.map((i) => i.runId)).toEqual([4, 2, 3, 1]);
  });

  it("caps at five lines and summarises the rest, pointing at the runs overview", () => {
    const items = Array.from({ length: 8 }, (_, i) => item({ runId: i + 1 }));
    const out = renderDigest(items);
    expect(out).toContain("**In flight (8):**");
    expect(out.split("\n")).toHaveLength(1 + 5 + 1);
    expect(out).toContain("…and 3 more");
    // The link is the OVERVIEW, not the first item shown (which the reader can
    // already see) — "3 more" is about the ones that aren't on screen.
    expect(out.split("\n").at(-1)).toContain("/runs");
    expect(out).not.toContain("/runs/1 ·"); // not the first shown item's link
  });

  it("folds the todo counts and the caller's footer into the one summary line", () => {
    const items = Array.from({ length: 8 }, (_, i) => item({ runId: i + 1 }));
    const out = renderDigest(items, { tasks: 12, plans: 2 }, "⚪ This thread: run #4 idle.");
    // Header + 5 items + ONE trailing line, not one line per extra fact.
    expect(out.split("\n")).toHaveLength(1 + 5 + 1);
    const tail = out.split("\n").at(-1)!;
    expect(tail).toContain("…and 3 more");
    expect(tail).toContain("12 tasks todo across 2 plans.");
    expect(tail).toContain("This thread: run #4 idle.");
  });

  it("gives every line one glyph, one action and a link", () => {
    const out = renderDigest([
      item({ glyph: "🔍", action: "PR open — awaiting review", links: ["/tasks/T-1", "https://gh/pr/1"] }),
    ]);
    const line = out.split("\n")[1];
    expect(line).toBe("🔍 Dark-mode toggle — PR open — awaiting review · /tasks/T-1 · https://gh/pr/1");
  });

  // pending_question is a PendingQuestion OBJECT (lib/run-state.ts), never a
  // bare string: `{ question_id, question, state, … }`, settled in place by
  // answer_question writing state:'answered'.
  const parked = (pendingQuestion: unknown) => ({
    id: 7,
    goal: "x",
    title: "Import cleanup",
    taskId: "T-9",
    planId: null,
    status: "parked",
    parkReason: "question",
    pendingQuestion,
    prUrl: null,
    startedAt: new Date(),
  });

  it("classifies an open question as blocked, showing the question itself", () => {
    const it1 = classify(
      parked({
        question_id: "q-1",
        question: "Which API shape?",
        asked_at: "2026-01-01T00:00:00Z",
        deadline: "2026-01-02T00:00:00Z",
        state: "open",
      })
    );
    expect(it1.blockedOnUser).toBe(true);
    expect(it1.glyph).toBe("🚧");
    expect(it1.action).toContain("Which API shape?");
    expect(it1.links).toContain("/tasks/T-9");
  });

  it("stops calling a run blocked once its question has been answered", () => {
    // answer_question settles the question IN PLACE — it does not null the
    // column and does not clear park_reason, so presence alone is not blockage.
    const it1 = classify(
      parked({
        question_id: "q-1",
        question: "Which API shape?",
        asked_at: "2026-01-01T00:00:00Z",
        deadline: "2026-01-02T00:00:00Z",
        state: "answered",
        answered_at: "2026-01-01T01:00:00Z",
      })
    );
    expect(it1.blockedOnUser).toBe(false);
    expect(it1.action).not.toContain("Which API shape?");
  });

  it("treats a bare park_reason='question' with no question row as blocked", () => {
    expect(classify(parked(null)).blockedOnUser).toBe(true);
  });

  it("answers /status from live state, excluding the persona's own chat runs", async () => {
    const parent = await makeConversation("thread-1");
    const child = await makeChild(parent, { title: "Dark-mode toggle" });
    await setChild(child, { personaId: PERSONA, taskId: null });
    const reply = (await handleCommand(msg({ text: "/status" }), config)).reply!;
    expect(reply).toContain("**In flight (1):**");
    expect(reply).toContain(`/runs/${child}`);
    // The conversation's own '<chat>' run is never a digest line — it shows up
    // only in the trailing per-thread liveness line.
    expect(reply).not.toContain(`/runs/${parent}`);
    expect(reply).toMatch(new RegExp(`This thread: run #${parent} idle`));
  });
});

// ──────────────────────────────────────────────────────────
// Reactions as input
// ──────────────────────────────────────────────────────────

describe("reactions as input", () => {
  async function askAQuestion(runId: number, text: string) {
    await db.insert(agentMessages).values({
      runId,
      role: "agent",
      content: JSON.stringify([{ type: "text", text }]),
      createdAt: new Date(),
    });
  }

  it("injects 👍 as a real turn when the persona's last word was a question", async () => {
    const runId = await getOrCreateRun("discord", "thread-1", PERSONA);
    await askAQuestion(runId, "I'll target `main` unless you say otherwise. Sound right?");
    const { channel } = fakeChannel();
    const loop = new AgentLoop(channel, config);

    await loop.handle(
      msg({ text: "yes", reaction: { emoji: "👍", messageId: "m-1", ownMessage: true } })
    );
    expect(startedTurns).toEqual(["yes"]);
  });

  it("injects 👍 only when it lands ON the persona's own last message", async () => {
    const runId = await getOrCreateRun("discord", "thread-1", PERSONA);
    const { channel, drafts } = fakeChannel();
    const loop = new AgentLoop(channel, config);

    // One real turn, so the loop knows which message is its own latest.
    await loop.handle(msg({ text: "what branch?" }));
    const own = drafts.at(-1)!;
    await askAQuestion(runId, "I'll target `main`. Sound right?");
    startedTurns.length = 0;

    // A 👍 on some OTHER message is a thumbs-up, not an answer.
    await loop.handle(
      msg({ text: "yes", reaction: { emoji: "👍", messageId: "someone-else", ownMessage: false } })
    );
    expect(startedTurns).toEqual([]);

    // A 👍 on the persona's question is the answer.
    await loop.handle(
      msg({ text: "yes", reaction: { emoji: "👍", messageId: own, ownMessage: true } })
    );
    expect(startedTurns).toEqual(["yes"]);
  });

  it("ignores 👍 on a breadcrumb even while a question is open", async () => {
    const parent = await makeConversation("thread-1"); // this IS the conversation's run
    await askAQuestion(parent, "Want me to start on the second one?");

    const relayCh = fakeRelayChannel();
    const relay = await primedRelay([relayCh.channel], { now: () => 1000 });
    await makeChild(parent);
    await relay.tick();
    const breadcrumbId = relayCh.posts[0].id;

    const { channel } = fakeChannel();
    await new AgentLoop(channel, config, relay).handle(
      msg({ text: "yes", reaction: { emoji: "👍", messageId: breadcrumbId, ownMessage: true } })
    );
    // The 👍 meant "nice", not "yes, start the second one" — starting work off
    // the back of it would be the expensive kind of wrong.
    expect(startedTurns).toEqual([]);
  });

  it("injects 👎 as \"no\"", async () => {
    const runId = await getOrCreateRun("discord", "thread-1", PERSONA);
    await askAQuestion(runId, "Want Rex to review it?");
    const { channel } = fakeChannel();
    await new AgentLoop(channel, config).handle(
      msg({ text: "no", reaction: { emoji: "👎", messageId: "m-1", ownMessage: true } })
    );
    expect(startedTurns).toEqual(["no"]);
  });

  it("ignores 👍 when no question is open", async () => {
    const runId = await getOrCreateRun("discord", "thread-1", PERSONA);
    await askAQuestion(runId, "✅ Merged. Thread archived.");
    const { channel, sends } = fakeChannel();
    await new AgentLoop(channel, config).handle(
      msg({ text: "yes", reaction: { emoji: "👍", messageId: "m-1", ownMessage: true } })
    );
    expect(startedTurns).toEqual([]);
    expect(sends).toEqual([]); // silent, not chatty
  });

  /** A primed relay holding one breadcrumb for a fresh child of `parent`. */
  async function breadcrumb(
    parent: number,
    now: () => number = () => 1000
  ): Promise<{ relay: ProgressRelay; messageId: string; child: number }> {
    const relayCh = fakeRelayChannel();
    const relay = await primedRelay([relayCh.channel], { now });
    const child = await makeChild(parent);
    await relay.tick();
    return { relay, messageId: relayCh.posts[0].id, child };
  }

  it("❌ on a breadcrumb confirms first, then cancels on 👍", async () => {
    const parent = await makeConversation("thread-1");
    const { relay, messageId: breadcrumbId, child } = await breadcrumb(parent);

    const { channel, sends } = fakeChannel();
    const loop = new AgentLoop(channel, config, relay);

    await loop.handle(
      msg({ text: "/stop", reaction: { emoji: "❌", messageId: breadcrumbId, ownMessage: true } })
    );
    expect(sends[0]).toContain(`Cancel run #${child}?`);
    expect(sends[0]).toContain("👍 to confirm");
    expect((await db.select().from(agentSessions).where(eq(agentSessions.id, child)))[0].status).toBe(
      "running"
    );

    await loop.handle(
      msg({ text: "yes", reaction: { emoji: "👍", messageId: "m-2", ownMessage: true } })
    );
    expect(sends[1]).toContain(`Cancelled run #${child}`);
    expect((await db.select().from(agentSessions).where(eq(agentSessions.id, child)))[0].status).toBe(
      "cancelled"
    );
    expect(startedTurns).toEqual([]); // never became an agent turn
  });

  it("won't let a bystander confirm somebody else's cancel", async () => {
    const parent = await makeConversation("thread-1");
    const { relay, messageId: breadcrumbId, child } = await breadcrumb(parent);
    const { channel, sends } = fakeChannel();
    const loop = new AgentLoop(channel, config, relay);

    await loop.handle(
      msg({
        text: "/stop",
        authorId: "u1",
        reaction: { emoji: "❌", messageId: breadcrumbId, ownMessage: true },
      })
    );
    expect(sends[0]).toContain(`Cancel run #${child}?`);

    // A different user's 👍 is not the confirmation that was asked for.
    await loop.handle(
      msg({
        text: "yes",
        authorId: "u2",
        reaction: { emoji: "👍", messageId: "m-2", ownMessage: true },
      })
    );
    expect((await db.select().from(agentSessions).where(eq(agentSessions.id, child)))[0].status).toBe(
      "running"
    );
    expect(startedTurns).toEqual([]); // and it did not become a "yes" turn either

    // The arm survives, so the person who asked can still confirm it.
    await loop.handle(
      msg({
        text: "yes",
        authorId: "u1",
        reaction: { emoji: "👍", messageId: "m-3", ownMessage: true },
      })
    );
    expect((await db.select().from(agentSessions).where(eq(agentSessions.id, child)))[0].status).toBe(
      "cancelled"
    );
  });

  it("says a cancel confirmation lapsed instead of answering some other question", async () => {
    const parent = await makeConversation("thread-1");
    let now = 1000;
    const { relay, messageId: breadcrumbId, child } = await breadcrumb(parent, () => now);
    // A question is open, so a fall-through 👍 would have become a "yes" turn.
    await askAQuestion(parent, "Shall I also bump the minor version?");

    const { channel, sends } = fakeChannel();
    const loop = new AgentLoop(channel, config, relay);
    await loop.handle(
      msg({ text: "/stop", reaction: { emoji: "❌", messageId: breadcrumbId, ownMessage: true } })
    );

    now += 6 * 60 * 1000; // past the 5-minute confirmation window
    await loop.handle(
      msg({ text: "yes", reaction: { emoji: "👍", messageId: "m-2", ownMessage: true } })
    );
    expect(sends.at(-1)).toMatch(/lapsed — react ❌ again/);
    expect((await db.select().from(agentSessions).where(eq(agentSessions.id, child)))[0].status).toBe(
      "running"
    );
    expect(startedTurns).toEqual([]);
  });

  it("❌ on an ordinary bot message still falls through to /stop", async () => {
    await getOrCreateRun("discord", "thread-1", PERSONA);
    const relay = new ProgressRelay([], { now: () => 1000 });
    const { channel, sends } = fakeChannel();
    await new AgentLoop(channel, config, relay).handle(
      msg({ text: "/stop", reaction: { emoji: "❌", messageId: "not-a-breadcrumb", ownMessage: true } })
    );
    expect(sends[0]).toMatch(/nothing to stop|stopped/i);
    expect(startedTurns).toEqual([]);
  });

  it("acks a slow turn with 👀 and clears it when the turn ends", async () => {
    // Real timers with a tiny threshold: the ack delay is configuration
    // (TASK_ORCH_PIPE_ACK_MS), so the behavior is testable without faking time
    // underneath a DB-backed turn.
    process.env.TASK_ORCH_PIPE_ACK_MS = "5";
    try {
      await getOrCreateRun("discord", "thread-1", PERSONA);
      const { channel, reactions } = fakeChannel();
      mockRunChat.mockImplementationOnce(async function* () {
        await new Promise((r) => setTimeout(r, 40));
        yield { type: "done" as const };
      });
      await new AgentLoop(channel, config).handle(msg({ text: "slow one", messageId: "m-9" }));
      await new Promise((r) => setTimeout(r, 10)); // the un-react is fire-and-forget
      expect(reactions).toEqual(["👀", "-👀"]);
    } finally {
      delete process.env.TASK_ORCH_PIPE_ACK_MS;
    }
  });

  it("does not ack a fast turn", async () => {
    process.env.TASK_ORCH_PIPE_ACK_MS = "2000";
    try {
      await getOrCreateRun("discord", "thread-1", PERSONA);
      const { channel, reactions } = fakeChannel();
      await new AgentLoop(channel, config).handle(msg({ text: "quick", messageId: "m-9" }));
      expect(reactions).toEqual([]);
    } finally {
      delete process.env.TASK_ORCH_PIPE_ACK_MS;
    }
  });
});

// ──────────────────────────────────────────────────────────
// Long-thread guard + carry-over
// ──────────────────────────────────────────────────────────

describe("long-thread guard", () => {
  it("resets the conversation past the turn cap and carries a summary into the new run", async () => {
    process.env.TASK_ORCH_PIPE_TURN_CAP = "3";
    try {
      const oldRun = await getOrCreateRun("discord", "thread-1", PERSONA);
      await db
        .update(agentSessions)
        .set({ title: "Dark-mode toggle" })
        .where(eq(agentSessions.id, oldRun));
      await addAgentMessages(oldRun, 3);
      expect(await agentTurnCount(oldRun)).toBe(3);

      const { channel, sends } = fakeChannel();
      await new AgentLoop(channel, config).handle(msg({ text: "and another thing" }));

      expect(sends[0]).toMatch(/getting long/i);
      const mapping = (
        await db
          .select()
          .from(channelThreads)
          .where(
            and(eq(channelThreads.externalId, "thread-1"), eq(channelThreads.personaId, PERSONA))
          )
      )[0];
      expect(mapping.runId).not.toBe(oldRun);

      // The summary persists as a system frame on the NEW run…
      const frames = await db
        .select()
        .from(agentMessages)
        .where(and(eq(agentMessages.runId, mapping.runId), eq(agentMessages.role, "system")));
      expect(frames).toHaveLength(1);
      expect(frames[0].content).toContain("Carried over from the previous conversation");
      // The turn still ran, on the fresh run.
      expect(startedTurns).toEqual(["and another thing"]);

      // …and — the part that actually matters — it REACHES THE MODEL. Drive a
      // real turn on the fresh run against a stubbed backend, take the context
      // the postgres loop is handed, and reconstruct it exactly as the loop
      // does. A persisted row the reconstruction drops is a summary nobody ever
      // reads (M5 review B1).
      let rows: Awaited<ReturnType<typeof runs.loadPostgresContextMessages>> = [];
      vi.spyOn(backend, "getBackend").mockResolvedValue({
        id: "pi",
        async runTurn(args: any) {
          rows = await args.contextSource.loadMessages();
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
      for await (const _ev of runs.append({
        runId: mapping.runId,
        role: "user",
        text: "where were we?",
      })) {
        void _ev;
      }

      const context = reconstructContext(
        rows as any,
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        "where were we?",
        false
      );
      const prompt = JSON.stringify(context);
      expect(prompt).toContain("Carried over from the previous conversation");
      expect(prompt).toContain("Dark-mode toggle");
    } finally {
      delete process.env.TASK_ORCH_PIPE_TURN_CAP;
    }
  });

  it("builds the carry-over summary without a model call", async () => {
    const runId = await getOrCreateRun("discord", "thread-1", PERSONA);
    await db
      .update(agentSessions)
      .set({ title: "Payment retries" })
      .where(eq(agentSessions.id, runId));
    await db.insert(agentMessages).values({
      runId,
      role: "agent",
      content: JSON.stringify([{ type: "text", text: "PR is up and CI is green." }]),
      createdAt: new Date(),
    });

    mockRunChat.mockClear();
    const summary = await buildCarryOverSummary(runId);
    expect(summary).toContain(`run #${runId}`);
    expect(summary).toContain("Topic: Payment retries");
    expect(summary).toContain("PR is up and CI is green.");
    expect(mockRunChat).not.toHaveBeenCalled();
  });

  it("leaves a short conversation alone", async () => {
    const runId = await getOrCreateRun("discord", "thread-1", PERSONA);
    await addAgentMessages(runId, 2);
    const { channel, sends } = fakeChannel();
    await new AgentLoop(channel, config).handle(msg({ text: "carry on" }));
    expect(sends).toEqual([]);
    expect(startedTurns).toEqual(["carry on"]);
  });
});

// ──────────────────────────────────────────────────────────
// Inbox-driven milestone turns
// ──────────────────────────────────────────────────────────
//
// The persona's own narration IS the milestone message (design §5 "inbox
// echo"); the relay only does breadcrumbs. The design claimed this "already
// works because injection goes through the same append() path" — it doesn't,
// quite: on a wake nobody is holding a draft. So the pipe drives the wake and
// holds the draft itself. This proves the whole path end to end: a child.result
// event on the persona run → the pipe's pump → wakeServerRun → a real
// server-runtime turn on a stubbed backend → text in the Discord thread.
describe("inbox-driven milestone turn", () => {
  it("streams a woken persona turn into the thread, and mentions the thread owner", async () => {
    // A linked owner, so the milestone has someone to ping (PRD §9).
    const [user] = await db
      .insert(users)
      .values({ email: "ivo@example.com", passwordHash: "x" })
      .returning({ id: users.id });
    await db
      .insert(channelIdentities)
      .values({ channel: "discord", externalUserId: "u1", userId: user.id, label: "ivo" });

    const runId = await getOrCreateRun("discord", "thread-1", PERSONA, { authorId: "u1" });
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "pi",
      async runTurn(args: any) {
        args.onEvent({
          type: "assistant",
          message: { content: [{ type: "text", text: "PR's up and CI is green — 8/8 criteria met." }] },
        });
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

    // Emitted the way the WEB process emits it — no noWake. In a real
    // deployment the worker child's terminal status is finalized over there, so
    // this event (and its wake) originates in a process that holds no Discord
    // draft.
    await db.update(agentSessions).set({ status: "parked" }).where(eq(agentSessions.id, runId));
    await emitInboxEvent({
      targetRunId: runId,
      type: "child.result",
      sourceKind: "run",
      sourceId: "999",
      payload: { run_id: 999, outcome: "success", pr_url: "https://gh/pr/1" },
    });
    expect(await hasPendingInboxEvents(runId)).toBe(true);

    // The control plane's own dispatch must DEFER: waking here would burn the
    // event on a turn nobody can see, and the pipe would then find nothing to
    // narrate (M5 review B2).
    await dispatchRun(runId);
    expect(await hasPendingInboxEvents(runId)).toBe(true);

    const { channel, sends, finals, mentions } = fakeChannel();
    (channel as any).personaId = PERSONA;

    const manager = new ChannelManager([channel], config);
    await manager.start();
    try {
      await manager.pumpOnce();
    } finally {
      await manager.stop();
    }

    // The narration reached the thread through the draft path…
    expect([...finals, ...sends].join("\n")).toContain("PR's up and CI is green");
    // …@-mentioning the thread's owner, and only on that message…
    expect(finals[0]).toContain("<@u1>");
    expect(mentions[0]).toEqual(["u1"]);
    // …and the event was consumed, so the next pump says nothing.
    expect(await hasPendingInboxEvents(runId)).toBe(false);
  });

  it("does not mention anyone when the thread has no linked owner", async () => {
    const runId = await getOrCreateRun("discord", "thread-1", PERSONA);
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "pi",
      async runTurn(args: any) {
        args.onEvent({
          type: "assistant",
          message: { content: [{ type: "text", text: "Child run finished." }] },
        });
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
    await emitInboxEvent({
      targetRunId: runId,
      type: "child.result",
      sourceKind: "run",
      sourceId: "998",
      payload: { run_id: 998, outcome: "success" },
      noWake: true,
    });

    const { channel, finals, mentions } = fakeChannel();
    (channel as any).personaId = PERSONA;
    const manager = new ChannelManager([channel], config);
    await manager.start();
    try {
      await manager.pumpOnce();
    } finally {
      await manager.stop();
    }
    expect(finals[0]).toContain("Child run finished.");
    expect(finals[0]).not.toContain("<@");
    expect(mentions[0]).toBeUndefined();
  });

  it("says nothing when there is no pending event", async () => {
    await getOrCreateRun("discord", "thread-1", PERSONA);
    const { channel, sends } = fakeChannel();
    (channel as any).personaId = PERSONA;
    const manager = new ChannelManager([channel], config);
    await manager.start();
    try {
      await manager.pumpOnce();
    } finally {
      await manager.stop();
    }
    expect(sends).toEqual([]);
  });
});
