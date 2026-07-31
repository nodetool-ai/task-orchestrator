// lib/pipe/session-store.ts
//
// Maps a channel conversation (channel + externalId + personaId) to a run id,
// persisted in the channel_threads table so the bridge survives restarts and the
// web UI can be pointed at the same run.
//
// A persona conversation is an agent_runs row with goal='<chat>' and
// `runtime: 'server'` (design §3): its turns execute IN the pipe process through
// the postgres-turn loop — no container, no worktree, no SDK session file — with
// the persona's own (server-safe) tools profile. That is why this module calls
// runs.create directly instead of chat.createChat: createChat's '<chat>' default
// profile is 'orchestrator,repo_write', which the server-runtime guardrail in
// runs.create rejects outright.
//
// The persona dimension is carried through every query. channel_threads is
// unique on (channel, external_id, persona_id), so N persona bots each hold
// their own conversation in one Discord channel.

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { agentSessions, channelThreads, type ChannelThread } from "@/db/schema";
import { resolveBackendId } from "@/lib/agent-backend";
import * as chat from "@/lib/chat";
import * as repo from "@/lib/repo";
import * as runs from "@/lib/runs";
import { isTerminalStatus } from "@/lib/types";

export interface GetOrCreateOptions {
  /** Provider-qualified model ("provider/id") to set on a freshly created run. */
  model?: string;
  /** Title for a freshly created run; defaults to "New chat" so runChat auto-titles. */
  title?: string;
  /**
   * Channel-native author id (e.g. a Discord snowflake). When it resolves to a
   * linked channel_identity the run and the mapping are attributed to that user;
   * unlinked authors keep working, just unattributed (design §2).
   */
  authorId?: string;
}

/**
 * A run the bridge can no longer resume: runs.append would hard-reject it
 * (closed/cancelled, or any other non-resumable terminal state). Mirrors the
 * resumability guard in runs.append so getOrCreateRun recreates exactly when a
 * further message would otherwise fail. `idle` and in-flight/pending runs are
 * NOT dangling (they resume or queue normally); resumable worktree chats that
 * landed `completed`/`failed`/`budget_exhausted` are kept too.
 */
function isDanglingRun(run: runs.RunRow): boolean {
  if (run.goal === "<chat>" && run.status === "completed") return false;
  return (
    isTerminalStatus(run.status) &&
    run.status !== "idle" &&
    !runs.isResumableWorktreeRun(run.status, run.cwdStrategy)
  );
}

/** Look up the mapping row for (channel, externalId, personaId), if any. */
async function findMapping(
  channel: string,
  externalId: string,
  personaId: string
): Promise<ChannelThread | undefined> {
  return (
    await db
      .select()
      .from(channelThreads)
      .where(
        and(
          eq(channelThreads.channel, channel),
          eq(channelThreads.externalId, externalId),
          eq(channelThreads.personaId, personaId)
        )
      )
  )[0];
}

/**
 * True for a Postgres unique-violation error (SQLSTATE 23505) — postgres.js
 * surfaces this as an error object with a `code` property, not a subclass we
 * can `instanceof` against.
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

/** The linked local user for a channel account, or null when unlinked. */
export async function resolveUserId(
  channel: string,
  authorId?: string
): Promise<number | null> {
  if (!authorId) return null;
  const identity = await repo.getChannelIdentity(channel, authorId);
  return identity?.userId ?? null;
}

/**
 * Backfill attribution onto a conversation that predates the author's `/link`.
 * The PRD's onboarding flow is "talk first, link later" (J1), so the common case
 * is a thread that already exists when the identity lands; without this it would
 * stay unattributed forever while every LATER thread is attributed.
 *
 * Only ever fills a NULL, and the NULL check lives in the WHERE clause rather
 * than in a read-then-write: two bots (or a bot and the web UI) touching the
 * same row must never re-point an already-attributed run at a different user.
 */
async function backfillAttribution(mapping: ChannelThread, userId: number): Promise<void> {
  if (mapping.userId === userId) return;
  await db
    .update(channelThreads)
    .set({ userId })
    .where(and(eq(channelThreads.id, mapping.id), isNull(channelThreads.userId)));
  await db
    .update(agentSessions)
    .set({ userId })
    .where(and(eq(agentSessions.id, mapping.runId), isNull(agentSessions.userId)));
}

/** Find the existing run for (channel, externalId, personaId), or create one. */
export async function getOrCreateRun(
  channel: string,
  externalId: string,
  personaId: string,
  opts: GetOrCreateOptions = {}
): Promise<number> {
  const existing = await findMapping(channel, externalId, personaId);
  const userId = await resolveUserId(channel, opts.authorId);

  // Guard against a dangling mapping. Two ways a mapping goes dangling:
  //   • the run row was deleted out from under us (ON DELETE CASCADE should
  //     prevent this, but a manual delete or a stale row is possible), or
  //   • the run still exists but is non-resumable — a closed/cancelled run that
  //     runs.append hard-rejects ("is closed; fork it to continue"). Keeping the
  //     mapping would wedge the thread: every future message would finalize to
  //     that un-actionable error instead of starting a usable conversation.
  // In both cases drop the mapping and fall through to create a fresh run.
  if (existing) {
    const run = await runs.getRun(existing.runId);
    if (run && !isDanglingRun(run)) {
      if (userId != null) await backfillAttribution(existing, userId);
      return existing.runId;
    }
    await db.delete(channelThreads).where(eq(channelThreads.id, existing.id));
  }

  const persona = await repo.getPersona(personaId);
  if (!persona) throw new repo.RepoError(`Persona '${personaId}' not found`, 404);

  // Leave the title at the "New chat" default (unless a caller overrides it) so
  // runChat auto-titles the run from the first user message — the web /runs list
  // then shows the conversation topic instead of a raw channel id.
  //
  // toolsProfile is passed EXPLICITLY: runs.create's '<chat>' default is
  // 'orchestrator,repo_write', which the server-runtime guardrail rejects. The
  // persona's profile is checked for server-safety once at pipe boot
  // (lib/pipe/config.ts), so a rejection here means a persona changed under a
  // running process rather than a misconfiguration nobody has seen yet.
  //
  // backend is resolved rather than left null: create() persists placement and
  // backend as one decision and rejects a server run that resolves to claude —
  // boot validation already proved this persona resolves to 'pi'.
  const created = await runs.create({
    goal: "<chat>",
    personaId,
    userId,
    runtime: "server",
    cwdStrategy: "none",
    toolsProfile: persona.toolsProfile,
    backend: persona.backend ?? resolveBackendId(),
    model: opts.model,
    title: opts.title ?? "New chat",
  });
  try {
    await db
      .insert(channelThreads)
      .values({ channel, externalId, personaId, runId: created.id, userId });
    return created.id;
  } catch (err) {
    // Two near-simultaneous first messages for the same conversation can both
    // get past the `existing` check above and both create a run before either
    // inserts the mapping — the unique index on (channel, externalId, personaId)
    // then makes the loser's insert throw. AgentLoop's per-conversation queue
    // (M9a) makes this vanish for the normal Discord path, but getOrCreateRun is
    // called directly by commands.ts too, so stay robust regardless: re-read
    // the winning mapping and hand back its runId instead of dropping the
    // message, and best-effort delete the orphan run we created (harmless if
    // it fails — it just leaks an unused idle chat row).
    if (!isUniqueViolation(err)) throw err;
    const winner = await findMapping(channel, externalId, personaId);
    if (!winner) throw err; // unique violation but no row to read — surface the original error
    await chat.deleteChat(created.id).catch(() => {});
    return winner.runId;
  }
}

/** Drop the mapping so the next message starts a brand-new run (/new, /reset). */
export async function resetThread(
  channel: string,
  externalId: string,
  personaId: string
): Promise<void> {
  await db
    .delete(channelThreads)
    .where(
      and(
        eq(channelThreads.channel, channel),
        eq(channelThreads.externalId, externalId),
        eq(channelThreads.personaId, personaId)
      )
    );
}

/** Current run id for a conversation, or null if none is mapped yet. */
export async function currentRunId(
  channel: string,
  externalId: string,
  personaId: string
): Promise<number | null> {
  const row = (
    await db
      .select({ runId: channelThreads.runId })
      .from(channelThreads)
      .where(
        and(
          eq(channelThreads.channel, channel),
          eq(channelThreads.externalId, externalId),
          eq(channelThreads.personaId, personaId)
        )
      )
  )[0];
  return row?.runId ?? null;
}

/** True once this conversation has a mapping for this persona (onboarding gate). */
export async function hasMapping(
  channel: string,
  externalId: string,
  personaId: string
): Promise<boolean> {
  return (await findMapping(channel, externalId, personaId)) !== undefined;
}
