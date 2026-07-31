// lib/pipe/carryover.ts
//
// The long-thread guard and its summary carry-over (PRD §10 "long thread /
// context cap", design §5 "lifecycle").
//
// A persona conversation is one long-lived run whose model context is rebuilt
// from agent_messages on every turn, so an unbounded thread eventually rebuilds
// an unbounded prompt. v1's answer is a turn-count cap: past it the persona
// announces a reset and the conversation continues in a FRESH run that starts
// with a short summary of the old one.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SUMMARY IS NOT MODEL-GENERATED
//
// The plan allows "one summarization turn". We don't spend it. The summary
// exists so the new run knows what the thread was about — and everything worth
// carrying is already structured:
//
//   • the run TITLE is the topic (runChat auto-titles from the first message);
//   • the LAST AGENT TEXT is "where we left off", which is exactly what the
//     user just read on screen;
//   • the in-flight work is the /status digest, which is live state and better
//     than any recollection of it;
//   • durable preferences and facts live in persona/user MEMORY (M3) and travel
//     on their own — re-summarising them would be a second, staler copy.
//
// A summarisation turn would cost a model call, take seconds at the worst
// possible moment (mid-conversation), and could fail — for a paragraph we can
// assemble deterministically. If a future milestone wants richer recall, the
// hook is here and single-purpose.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW IT PERSISTS
//
// NOT as an initial prompt (that is a one-shot input and would be consumed by
// the first turn), and NOT as the M3 prompt-only injection (which is rebuilt
// per turn and never stored). The summary is written as a `system`-role
// agent_messages row on the new run, which is what loadPostgresContextMessages
// feeds the model as durable context on EVERY turn of the new conversation —
// the same mechanism lib/worktree-gc.ts uses to leave a note on a run.

import { and, count, eq } from "drizzle-orm";

import { db } from "@/db";
import { agentMessages } from "@/db/schema";
import * as runs from "@/lib/runs";

import { collectItems } from "./digest";
import { currentRunId, getOrCreateRun, resetThread } from "./session-store";

/** How much of the previous reply is worth carrying. */
const LAST_TEXT_CAP = 400;

export interface CarryOverInput {
  channel: string;
  externalId: string;
  personaId: string;
  authorId?: string;
  model?: string;
}

/**
 * Build the carry-over block for a conversation that is about to be replaced.
 * Pure-ish (two reads, no model call) and exported so the format is testable.
 */
export async function buildCarryOverSummary(priorRunId: number): Promise<string> {
  const run = await runs.getRun(priorRunId);
  const lastText = await runs.lastAgentText(priorRunId);
  const items = run?.personaId ? await collectItems(run.personaId, run.userId) : [];

  const lines = [`Carried over from the previous conversation (run #${priorRunId}).`];
  if (run?.title && run.title !== "New chat") lines.push(`Topic: ${run.title}`);
  if (lastText) lines.push(`Where we left off: ${truncate(oneParagraph(lastText), LAST_TEXT_CAP)}`);
  if (items.length) {
    lines.push("Still in flight:");
    for (const it of items.slice(0, 3)) lines.push(`- ${it.label} — ${it.action}`);
  }
  lines.push(
    "Durable preferences and facts are in your memory; search it rather than " +
      "asking the user to repeat themselves. Don't re-introduce yourself."
  );
  return lines.join("\n");
}

/**
 * Replace a conversation's run with a fresh one carrying the summary. Returns
 * the new run id and the summary that was planted (callers echo a one-liner,
 * not the whole block — the summary is for the model, not the thread).
 */
export async function startFreshConversation(
  input: CarryOverInput
): Promise<{ runId: number; priorRunId: number | null; summary: string | null }> {
  const { channel, externalId, personaId } = input;
  const priorRunId = await currentRunId(channel, externalId, personaId);
  const summary = priorRunId != null ? await buildCarryOverSummary(priorRunId) : null;

  await resetThread(channel, externalId, personaId);
  const runId = await getOrCreateRun(channel, externalId, personaId, {
    model: input.model,
    authorId: input.authorId,
  });
  if (summary) await appendSystemContext(runId, summary);
  return { runId, priorRunId, summary };
}

/**
 * Write a durable system-role context frame onto a run. Plain text (not an
 * `inbox_event`/`event_digest` frame), so loadPostgresContextMessages includes
 * it in the model context of every later turn.
 */
export async function appendSystemContext(runId: number, text: string): Promise<void> {
  await db.insert(agentMessages).values({
    runId,
    role: "system",
    content: JSON.stringify([{ type: "text", text }]),
    createdAt: new Date(),
  });
}

/** Agent turns recorded on a conversation — the long-thread guard's counter. */
export async function agentTurnCount(runId: number): Promise<number> {
  const row = (
    await db
      .select({ n: count() })
      .from(agentMessages)
      .where(and(eq(agentMessages.runId, runId), eq(agentMessages.role, "agent")))
  )[0];
  return Number(row?.n ?? 0);
}

function oneParagraph(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
