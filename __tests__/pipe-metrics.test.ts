// Milestone 6 — the PRD §11 success metrics.
//
// These are cheap counters, and the failure mode that matters is not "the
// number is off by one" but "the number was never emitted" (or, worse, "the
// emission broke a turn"). So the tests assert against the real prom-client
// exposition text from the shared registry — the exact bytes `/api/metrics` and
// the pipe's own listener serve — and cover the two heuristics that are easy to
// get subtly wrong: what counts as a clarifying question, and when the
// time-to-first-PR clock is allowed to stop.

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db";
import {
  agentSessions,
  channelIdentities,
  channelThreads,
  inboxEvents,
  personas as personasTable,
  users,
} from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import { handleCommand } from "../lib/pipe/commands";
import { recordAgentReply, recordThreadCreated } from "../lib/pipe/metrics";
import { ProgressRelay, type RelayChannel } from "../lib/pipe/relay";
import type { InboundMessage, OutboundDraft, PipeConfig } from "../lib/pipe/types";
import { telemetry } from "../lib/runner/telemetry";

const PERSONA = "aria";

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
  personaId: PERSONA,
  isDirectMessage: true,
  ...over,
});

/** The exposition text — what a scraper would actually read. */
async function scrape(): Promise<string> {
  return telemetry().registry.metrics();
}

/** Wait for a fire-and-forget emission (the user label is resolved off-chain). */
async function scrapeUntil(needle: string): Promise<string> {
  return vi.waitFor(async () => {
    const text = await scrape();
    expect(text).toContain(needle);
    return text;
  });
}

/** The value of one exposed series, or undefined when it was never emitted. */
function series(text: string, name: string, labels: string): number | undefined {
  const line = text
    .split("\n")
    .find((l) => l.startsWith(`${name}{`) && labels.split(",").every((p) => l.includes(p.trim())));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : undefined;
}

function fakeRelayChannel(personaId = PERSONA) {
  const posts: string[] = [];
  let seq = 0;
  const channel: RelayChannel = {
    name: "discord",
    personaId,
    async openDraft(_externalId, initial): Promise<OutboundDraft> {
      posts.push(initial);
      return {
        messageId: `m-${++seq}`,
        async update() {},
        async finalize() {},
      };
    },
  };
  return { channel, posts };
}

async function makeConversation(externalId: string, createdAt?: Date): Promise<number> {
  const [run] = await db
    .insert(agentSessions)
    .values({
      goal: "<chat>",
      status: "idle",
      runtime: "server",
      cwdStrategy: "none",
      toolsProfile: "orchestrator,spawn",
      personaId: PERSONA,
      backend: "pi",
      title: "Dark-mode toggle",
    })
    .returning({ id: agentSessions.id });
  await db.insert(channelThreads).values({
    channel: "discord",
    externalId,
    personaId: PERSONA,
    runId: run.id,
    ...(createdAt ? { createdAt } : {}),
  });
  return run.id;
}

async function makeChild(
  parentRunId: number,
  over: Partial<typeof agentSessions.$inferInsert> = {}
): Promise<number> {
  const [row] = await db
    .insert(agentSessions)
    .values({ goal: "implement dark mode", status: "running", parentRunId, ...over })
    .returning({ id: agentSessions.id });
  return row.id;
}

beforeEach(async () => {
  await seedPersonas();
  await db
    .insert(personasTable)
    .values({
      id: PERSONA,
      name: "Aria",
      systemPrompt: "x",
      toolsProfile: "orchestrator,spawn",
    })
    .onConflictDoNothing();
  await db.delete(channelThreads);
  await db.delete(channelIdentities);
  await db.delete(agentSessions);
  await db.delete(users);
});

describe("command + digest metrics", () => {
  it("counts a handled command and times the /status digest", async () => {
    await handleCommand(msg({ text: "/status" }), config);

    const text = await scrapeUntil('task_orch_pipe_commands_total{persona="aria"');
    expect(series(text, "task_orch_pipe_commands_total", 'persona="aria",command="status"')).toBe(1);
    // The digest histogram must have an observation, and it must be fast: the
    // PRD's target is < 5s, and this is a pure DB+format path.
    expect(series(text, "task_orch_pipe_digest_seconds_count", 'persona="aria"')).toBe(1);
    expect(
      series(text, "task_orch_pipe_digest_seconds_bucket", 'persona="aria",le="5"')
    ).toBe(1);
  });

  it("counts a plain-language stop under its command name", async () => {
    await handleCommand(msg({ text: "stop" }), config);
    const text = await scrapeUntil('command="stop"');
    expect(series(text, "task_orch_pipe_commands_total", 'persona="aria",command="stop"')).toBe(1);
  });

  it("does not count an unknown slash — it was never a command", async () => {
    const before = await scrape();
    const r = await handleCommand(msg({ text: "/frobnicate" }), config);
    expect(r.handled).toBe(false);
    // Nothing to wait for; assert the series is unchanged after a tick.
    await new Promise((res) => setTimeout(res, 20));
    expect(series(await scrape(), "task_orch_pipe_commands_total", 'command="frobnicate"')).toBe(
      series(before, "task_orch_pipe_commands_total", 'command="frobnicate"')
    );
  });
});

describe("clarify rate", () => {
  it("counts a reply ending in '?' as a question, and one that doesn't as not", async () => {
    recordAgentReply(PERSONA, "PR is up. Want me to merge it?", "discord", "u1");
    recordAgentReply(PERSONA, "Merged — nothing needed from you.", "discord", "u1");

    const text = await scrapeUntil('task_orch_pipe_agent_replies_total{persona="aria"');
    expect(series(text, "task_orch_pipe_agent_replies_total", 'persona="aria",user="anon"')).toBe(2);
    expect(series(text, "task_orch_pipe_agent_questions_total", 'persona="aria",user="anon"')).toBe(
      1
    );
  });

  it("tags a linked author with their user id", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "linked@example.com", passwordHash: "x" })
      .returning({ id: users.id });
    await db
      .insert(channelIdentities)
      .values({ channel: "discord", externalUserId: "linked-1", userId: user.id });

    recordAgentReply(PERSONA, "Anything else?", "discord", "linked-1");

    const text = await scrapeUntil(`user="${user.id}"`);
    expect(
      series(text, "task_orch_pipe_agent_questions_total", `persona="aria",user="${user.id}"`)
    ).toBe(1);
  });
});

describe("thread counter", () => {
  it("labels an unattributed conversation as anon", async () => {
    recordThreadCreated(PERSONA, null);
    const text = await scrapeUntil('task_orch_pipe_threads_total{persona="aria",user="anon"');
    expect(series(text, "task_orch_pipe_threads_total", 'persona="aria",user="anon"')).toBe(1);
  });
});

describe("DB-derived gauges on /api/metrics", () => {
  it("splits run creation into messaging vs web, and flags stale pending events", async () => {
    const { GET } = await import("../app/api/metrics/route");
    const parent = await makeConversation("thread-share"); // messaging: the conversation itself
    await makeChild(parent); // messaging: spawned by a conversation
    await db.insert(agentSessions).values({ goal: "<implement>", status: "running" }); // web

    const text = await (await GET()).text();

    expect(series(text, "task_orch_pipe_creation_share", 'entity="run",source="messaging"')).toBe(2);
    expect(series(text, "task_orch_pipe_creation_share", 'entity="run",source="web"')).toBe(1);
    // Nothing pending, so the health gauge reports no series at all.
    expect(series(text, "task_orch_pipe_stale_pending_events", 'persona="aria"')).toBe(undefined);

    // A milestone event nobody has drained for half an hour: the pipe is down.
    await db.insert(inboxEvents).values({
      targetRunId: parent,
      type: "child.result",
      sourceKind: "run",
      status: "pending",
      audience: "owner",
      createdAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    // A FRESH one on the same conversation is not yet a problem and must not count.
    await db.insert(inboxEvents).values({
      targetRunId: parent,
      type: "timer.fired",
      sourceKind: "timer",
      status: "pending",
      audience: "owner",
    });

    const after = await (await GET()).text();
    expect(series(after, "task_orch_pipe_stale_pending_events", 'persona="aria"')).toBe(1);
  });
});

describe("relay metrics", () => {
  it("counts posted breadcrumbs by kind and observes TTFPR once", async () => {
    // A thread that was created an hour ago, so the TTFPR observation lands in a
    // bucket we can assert on rather than in the 60s one.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const parent = await makeConversation("thread-metrics", hourAgo);
    const ch = fakeRelayChannel();
    const relay = new ProgressRelay([ch.channel]);
    await relay.tick(); // priming: records, announces nothing

    const child = await makeChild(parent);
    await relay.tick(); // ⏳ started

    const started = await scrapeUntil('task_orch_pipe_breadcrumbs_total{persona="aria",kind="started"');
    expect(series(started, "task_orch_pipe_breadcrumbs_total", 'kind="started"')).toBe(1);
    // No PR yet, so the TTFPR clock is still running.
    expect(series(started, "task_orch_pipe_time_to_first_pr_seconds_count", 'persona="aria"')).toBe(
      undefined
    );

    await db
      .update(agentSessions)
      .set({ prUrl: "https://gh/pr/1" })
      .where(eq(agentSessions.id, child));
    await relay.tick(); // ✅ PR opened

    const withPr = await scrapeUntil("task_orch_pipe_time_to_first_pr_seconds_count");
    expect(series(withPr, "task_orch_pipe_time_to_first_pr_seconds_count", 'persona="aria"')).toBe(1);
    // ~1h: above the 1800s bucket, inside the 3600s+ ones.
    expect(
      series(withPr, "task_orch_pipe_time_to_first_pr_seconds_bucket", 'persona="aria",user="anon",le="1800"')
    ).toBe(0);
    expect(
      series(withPr, "task_orch_pipe_time_to_first_pr_seconds_bucket", 'persona="aria",user="anon",le="7200"')
    ).toBe(1);

    // A SECOND child's PR must not restart the clock — TTFPR is a first-PR
    // metric, and re-observing it would drag the median towards "whenever the
    // last PR of the thread landed".
    const second = await makeChild(parent);
    await relay.tick();
    await db
      .update(agentSessions)
      .set({ prUrl: "https://gh/pr/2" })
      .where(eq(agentSessions.id, second));
    await relay.tick();

    expect(
      series(await scrape(), "task_orch_pipe_time_to_first_pr_seconds_count", 'persona="aria"')
    ).toBe(1);
  });

  it("records nothing for a priming pass — a restart is not a new PR", async () => {
    const parent = await makeConversation("thread-priming");
    await makeChild(parent, { prUrl: "https://gh/pr/9", status: "completed" });
    const ch = fakeRelayChannel();
    // Counters are process-global and other cases in this file have already
    // fed them, so the assertion is "unchanged", not "absent".
    const name = "task_orch_pipe_time_to_first_pr_seconds_count";
    const before = series(await scrape(), name, 'persona="aria"');

    await new ProgressRelay([ch.channel]).tick();

    expect(ch.posts).toEqual([]);
    expect(series(await scrape(), name, 'persona="aria"')).toBe(before);
  });
});
