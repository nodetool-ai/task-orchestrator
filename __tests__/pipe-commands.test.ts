import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../db";
import { agentSessions, channelThreads, plans, tasks } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import { handleCommand } from "../lib/pipe/commands";
import { currentRunId, getOrCreateRun } from "../lib/pipe/session-store";
import type { InboundMessage, PipeConfig } from "../lib/pipe/types";

// The Discord slash-command handler. Covers the "essential" agent controls
// (/stop, /status) plus the existing session commands. The live-turn cases poke
// the same in-process `runners` map that runs.ts uses, so we can exercise the
// stop path without actually spawning an agent turn.

// Persona bots are runtime='server' runs, so the persona under test must carry
// a server-safe tools profile (lib/profiles.ts) — 'executor' is orchestration
// only. 'implementor' would be rejected by the create-time guardrail.
const PERSONA = "executor";

const config: PipeConfig = {
  bots: [
    { personaId: PERSONA, token: "x", allowedUsers: ["u1"], allowedChannels: [] },
  ],
  defaultModel: "anthropic/claude-sonnet-4-6",
  editThrottleMs: 500,
};

const msg = (text: string, externalId = "chan-1"): InboundMessage => ({
  channel: "discord",
  externalId,
  text,
  authorId: "u1",
  authorLabel: "discord:tester",
  authorName: "tester",
  personaId: PERSONA,
  isDirectMessage: true,
});

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

/**
 * Pretend a turn is in flight in ANOTHER process (the web server): a live DB
 * lease — active status + fresh heartbeat — but no runner in *this* process's
 * registry. This is exactly what /status and /stop see for a web-composer turn.
 */
async function markLeaseLive(runId: number): Promise<void> {
  await db
    .update(agentSessions)
    .set({ status: "running", heartbeatAt: new Date() })
    .where(eq(agentSessions.id, runId));
}

beforeEach(async () => {
  await seedPersonas();
  runnerRegistry().clear();
  await db.delete(channelThreads);
  await db.delete(agentSessions);
  await db.delete(tasks);
  await db.delete(plans);
});

describe("/help", () => {
  it("advertises the essential agent commands", async () => {
    const r = await handleCommand(msg("/help"), config);
    expect(r.handled).toBe(true);
    expect(r.reply).toContain("/stop");
    expect(r.reply).toContain("/status");
    expect(r.reply).toContain("/new");
  });
});

describe("unknown slash", () => {
  it("falls through so the agent gets the text", async () => {
    const r = await handleCommand(msg("/frobnicate the thing"), config);
    expect(r.handled).toBe(false);
    expect(r.reply).toBeUndefined();
  });
});

describe("/stop", () => {
  it("reports nothing to stop when no conversation exists yet", async () => {
    const r = await handleCommand(msg("/stop"), config);
    expect(r.handled).toBe(true);
    expect(r.reply).toMatch(/no active conversation/i);
  });

  it("reports nothing to stop when the run is idle", async () => {
    const runId = await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel });
    const r = await handleCommand(msg("/stop"), config);
    expect(r.reply).toContain(`#${runId}`);
    expect(r.reply).toMatch(/isn't working/i);
  });

  it("aborts the in-flight turn and returns the run to idle", async () => {
    const runId = await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel });
    const abort = await markLive(runId);

    const r = await handleCommand(msg("/stop"), config);

    expect(r.handled).toBe(true);
    expect(r.reply).toMatch(/stopped/i);
    expect(abort.signal.aborted).toBe(true);
    const row = (await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0];
    expect(row?.status).toBe("idle"); // resumable, not terminal 'cancelled'
  });

  it("reports the turn is owned by another process when only the DB lease is live", async () => {
    // A turn started from the web composer: live lease, no local runner. /stop
    // used to claim "isn't working" here; it must now say it's owned elsewhere.
    const runId = await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel });
    await markLeaseLive(runId);
    const r = await handleCommand(msg("/stop"), config);
    expect(r.handled).toBe(true);
    expect(r.reply).toMatch(/another process/i);
    expect(r.reply).not.toMatch(/isn't working/i);
  });

  it("is reachable via the /cancel and /abort aliases", async () => {
    const runId = await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel });
    const a1 = await markLive(runId);
    expect((await handleCommand(msg("/cancel"), config)).reply).toMatch(/stopped/i);
    expect(a1.signal.aborted).toBe(true);

    const a2 = await markLive(runId);
    expect((await handleCommand(msg("/abort"), config)).reply).toMatch(/stopped/i);
    expect(a2.signal.aborted).toBe(true);
  });
});

describe("/status", () => {
  it("says there's no conversation before the first message", async () => {
    const r = await handleCommand(msg("/status"), config);
    expect(r.reply).toMatch(/no active conversation/i);
  });

  it("reports idle for a mapped run with no turn in flight", async () => {
    const runId = await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel });
    const r = await handleCommand(msg("/status"), config);
    expect(r.reply).toMatch(/idle/i);
    expect(r.reply).toContain(`#${runId}`);
  });

  it("reports working while a turn is in flight", async () => {
    const runId = await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel });
    await markLive(runId);
    const r = await handleCommand(msg("/status"), config);
    expect(r.reply).toMatch(/working/i);
    expect(r.reply).toContain(`#${runId}`);
  });

  it("reports working in another process when only the DB lease is live", async () => {
    // Web-composer turn: live lease, no local runner. /status used to say
    // "Idle" here despite a turn genuinely in flight in the other process.
    const runId = await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel });
    await markLeaseLive(runId);
    const r = await handleCommand(msg("/status"), config);
    expect(r.reply).toMatch(/working/i);
    expect(r.reply).toMatch(/another process/i);
    expect(r.reply).not.toMatch(/idle/i);
    expect(r.reply).toContain(`#${runId}`);
  });
});

describe("getOrCreateRun dangling-mapping recovery", () => {
  it("recreates the run when the mapped run has been closed", async () => {
    const first = await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel });
    // Simulate closing the run from the web /runs UI: closed runs are
    // non-resumable, so runs.append would reject every future message.
    await db.update(agentSessions).set({ status: "closed" }).where(eq(agentSessions.id, first));

    const second = await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel });
    expect(second).not.toBe(first);
    // The mapping now points at the fresh run, not the wedged closed one.
    expect(await currentRunId("discord", "chan-1", PERSONA)).toBe(second);
  });

  it("recreates the run when the mapped run was cancelled", async () => {
    const first = await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel });
    await db.update(agentSessions).set({ status: "cancelled" }).where(eq(agentSessions.id, first));
    const second = await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel });
    expect(second).not.toBe(first);
  });

  it("keeps the mapping for a resumable run (idle / completed)", async () => {
    const first = await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel });
    // A chat worktree run that landed 'completed' is still resumable.
    await db.update(agentSessions).set({ status: "completed" }).where(eq(agentSessions.id, first));
    expect(await getOrCreateRun("discord", "chan-1", PERSONA, { model: config.defaultModel })).toBe(first);
  });
});
