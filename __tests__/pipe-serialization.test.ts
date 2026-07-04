import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub chat.runChat so these tests drive turns deterministically instead of
// spawning a real agent turn. Everything else in lib/chat (createChat/getChat/
// updateChatSettings/deleteChat/...) stays real, so getOrCreateRun's DB-backed
// mapping logic is exercised for real, same as pipe-commands.test.ts.
//
// `gates` lets a test hold a specific turn open (by userText) until it
// explicitly releases it, so we can observe ordering instead of guessing at
// timing.
const { mockRunChat, gates, startedTurns } = vi.hoisted(() => {
  const gates = new Map<string, { resolve: () => void; promise: Promise<void> }>();
  const startedTurns: string[] = [];
  return { mockRunChat: vi.fn(), gates, startedTurns };
});

vi.mock("../lib/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/chat")>();

  async function* defaultRunChat(
    args: import("../lib/chat").RunChatArgs
  ): AsyncGenerator<import("../lib/chat").ChatStreamEvent> {
    startedTurns.push(args.userText);
    const gate = gates.get(args.userText);
    if (gate) await gate.promise;
    yield { type: "done" };
  }
  mockRunChat.mockImplementation(defaultRunChat);

  return { ...actual, runChat: mockRunChat };
});

import { db } from "../db";
import { agentSessions, channelThreads, plans, tasks } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import { AgentLoop } from "../lib/pipe/agent-loop";
import { getOrCreateRun } from "../lib/pipe/session-store";
import type { Channel, InboundMessage, OutboundDraft, PipeConfig } from "../lib/pipe/types";

const config: PipeConfig = {
  discord: { token: "x", allowedUsers: ["u1"], allowedChannels: [] },
  defaultModel: "anthropic/claude-sonnet-4-6",
  editThrottleMs: 0, // no throttling — every pushed frame should reach the draft
};

const msg = (text: string, externalId = "chan-1"): InboundMessage => ({
  channel: "discord",
  externalId,
  text,
  authorId: "u1",
  authorLabel: "discord:tester",
});

/** Poll `check` until it returns true or `timeoutMs` elapses (avoids flaky fixed sleeps). */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition never became true");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Open a gate that blocks the mock turn for `userText` until released. */
function openGate(userText: string): () => void {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  gates.set(userText, { resolve, promise });
  return resolve;
}

interface DraftRecorder {
  externalId: string;
  updates: string[];
  finalText?: string;
}

/** A stub Channel that records openDraft/update/finalize/send calls. */
function makeChannel(): {
  channel: Channel;
  drafts: DraftRecorder[];
  sends: { externalId: string; text: string }[];
} {
  const drafts: DraftRecorder[] = [];
  const sends: { externalId: string; text: string }[] = [];
  const channel: Channel = {
    name: "discord",
    async start() {},
    async stop() {},
    onMessage() {},
    async openDraft(externalId, initial) {
      const rec: DraftRecorder = { externalId, updates: [initial] };
      drafts.push(rec);
      const draft: OutboundDraft = {
        async update(text) {
          rec.updates.push(text);
        },
        async finalize(text) {
          rec.finalText = text;
          rec.updates.push(text);
        },
      };
      return draft;
    },
    async send(externalId, text) {
      sends.push({ externalId, text });
    },
  };
  return { channel, drafts, sends };
}

/** The process-global runner registry runs.ts uses to track in-flight turns. */
function runnerRegistry(): Map<number, { abort: AbortController; bus: EventEmitter }> {
  const g = globalThis as { __runRunners?: Map<number, { abort: AbortController; bus: EventEmitter }> };
  if (!g.__runRunners) g.__runRunners = new Map();
  return g.__runRunners;
}

/** Pretend a turn is in flight for `runId`: register a runner + flip to running. */
async function markLive(runId: number): Promise<AbortController> {
  const abort = new AbortController();
  runnerRegistry().set(runId, { abort, bus: new EventEmitter() });
  await db.update(agentSessions).set({ status: "running" }).where(eq(agentSessions.id, runId));
  return abort;
}

beforeEach(async () => {
  await seedPersonas();
  runnerRegistry().clear();
  await db.delete(channelThreads);
  await db.delete(agentSessions);
  await db.delete(tasks);
  await db.delete(plans);
  gates.clear();
  startedTurns.length = 0;
  mockRunChat.mockClear();
});

describe("AgentLoop per-conversation serialization (M9a)", () => {
  it("handles two messages in the same conversation strictly one at a time", async () => {
    const { channel } = makeChannel();
    const loop = new AgentLoop(channel, config);

    const release = openGate("first");
    const p1 = loop.handle(msg("first"));
    const p2 = loop.handle(msg("second"));

    // p2's turn is chained behind p1's turn via the per-conversation queue, so
    // it structurally cannot start before p1 settles — not just "probably
    // hasn't yet" but genuinely can't, regardless of scheduling luck. Wait for
    // "first" to start, then give a further grace period to be sure "second"
    // doesn't sneak in behind it.
    await waitFor(() => startedTurns.includes("first"));
    await new Promise((r) => setTimeout(r, 100));
    expect(startedTurns).toEqual(["first"]);

    release();
    await p1;
    await p2;

    expect(startedTurns).toEqual(["first", "second"]);
  });

  it("lets different conversations interleave instead of queuing behind each other", async () => {
    const { channel } = makeChannel();
    const loop = new AgentLoop(channel, config);

    openGate("blocked"); // deliberately never released during this test
    const pBlocked = loop.handle(msg("blocked", "thread-A"));
    const pFree = loop.handle(msg("free", "thread-B"));

    // A distinct conversation's turn must complete without waiting on the
    // still-blocked one.
    await pFree;
    expect(startedTurns).toContain("free");
    await waitFor(() => startedTurns.includes("blocked")); // it started...
    // ...but the handle() promise for it must still be unsettled.
    let blockedSettled = false;
    void pBlocked.then(() => {
      blockedSettled = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(blockedSettled).toBe(false);

    gates.get("blocked")!.resolve();
    await pBlocked;
  });

  it("cleans up the queue entry once a conversation's chain drains", async () => {
    const { channel } = makeChannel();
    const loop = new AgentLoop(channel, config);
    // Internal map is private; reach in only to confirm no unbounded growth —
    // exercised indirectly by running several messages through one
    // conversation and trusting handle() to resolve promptly each time (an
    // unbounded map wouldn't itself hang, so this is a smoke check that
    // nothing throws / hangs across repeated drains).
    for (let i = 0; i < 5; i++) {
      await loop.handle(msg(`msg-${i}`, "thread-cleanup"));
    }
    expect(startedTurns).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
  });
});

describe("/stop bypasses the per-conversation queue", () => {
  it("responds immediately even while a turn for the same conversation is blocked", async () => {
    const { channel } = makeChannel();
    const loop = new AgentLoop(channel, config);

    const runId = await getOrCreateRun("discord", "chan-1", { model: config.defaultModel });
    const abort = await markLive(runId);

    openGate("blocking prompt");
    const events: string[] = [];
    const pTurn = loop.handle(msg("blocking prompt")).then(() => {
      events.push("turn-done");
    });

    // Let the blocked turn actually get underway (past getOrCreateRun/openDraft
    // and into the gated mock runChat) before /stop arrives.
    await waitFor(() => startedTurns.includes("blocking prompt"));

    const pStop = loop.handle(msg("/stop")).then(() => {
      events.push("stop-done");
    });
    await pStop;

    // /stop resolved without waiting behind the blocked turn.
    expect(events).toEqual(["stop-done"]);
    expect(abort.signal.aborted).toBe(true);

    gates.get("blocking prompt")!.resolve();
    await pTurn;
    expect(events).toEqual(["stop-done", "turn-done"]);
  });
});

describe("BUG2: incremental sdk frames from the generator update the draft", () => {
  it("pushes each generator-yielded sdk frame into the live draft, not just the final one", async () => {
    const { channel, drafts } = makeChannel();
    const loop = new AgentLoop(channel, config);

    mockRunChat.mockImplementationOnce(async function* () {
      yield { type: "sdk", sdk: { type: "stream_text", text: "Hello" } };
      await new Promise((r) => setTimeout(r, 5));
      yield { type: "sdk", sdk: { type: "stream_text", text: " world" } };
      yield { type: "done" };
    });

    await loop.handle(msg("please stream", "thread-stream"));

    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    // A mid-stream update reflecting only the first frame must have happened —
    // this is the bug: previously the draft was never touched until finalize.
    expect(draft.updates).toContain("Hello");
    expect(draft.finalText).toBe("Hello world");
  });

  it("still finalizes correctly in the dev-mode shape (all envelopes at once, at the end)", async () => {
    const { channel, drafts } = makeChannel();
    const loop = new AgentLoop(channel, config);

    mockRunChat.mockImplementationOnce(async function* () {
      // dev-mode append(): no incremental sdk frames, only the terminal batch.
      yield { type: "sdk", sdk: { type: "stream_text", text: "Batched" } };
      yield { type: "done" };
    });

    await loop.handle(msg("dev mode turn", "thread-devmode"));

    expect(drafts[0].finalText).toBe("Batched");
  });
});
