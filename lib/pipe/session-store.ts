// lib/pipe/session-store.ts
//
// Maps a channel conversation (channel + externalId) to a chat run id, persisted
// in the channel_threads table so the bridge survives restarts and the web UI can
// be pointed at the same run. A "chat run" is an agent_runs row with goal='<chat>'
// created via lib/chat.ts — identical config to the web /chat composer.

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { channelThreads } from "@/db/schema";
import * as chat from "@/lib/chat";
import * as repo from "@/lib/repo";
import * as runs from "@/lib/runs";
import { isTerminalStatus } from "@/lib/types";

export interface GetOrCreateOptions {
  /** Provider-qualified model ("provider/id") to set on a freshly created run. */
  model?: string;
  /** Title for a freshly created run; defaults to "<channel>:<externalId>". */
  title?: string;
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
  return (
    isTerminalStatus(run.status) &&
    run.status !== "idle" &&
    !runs.isResumableWorktreeRun(run.status, run.cwdStrategy)
  );
}

/** Find the existing run for (channel, externalId), or create a fresh chat run. */
export async function getOrCreateRun(
  channel: string,
  externalId: string,
  opts: GetOrCreateOptions = {}
): Promise<number> {
  const existing = (
    await db
      .select()
      .from(channelThreads)
      .where(and(eq(channelThreads.channel, channel), eq(channelThreads.externalId, externalId)))
  )[0];

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
    if (run && !isDanglingRun(run)) return existing.runId;
    await db.delete(channelThreads).where(eq(channelThreads.id, existing.id));
  }

  // Leave the title at createChat's "New chat" default (unless a caller overrides
  // it) so runChat auto-titles the run from the first user message — the web
  // /runs list then shows the conversation topic instead of a raw channel id.
  const created = await chat.createChat(null, opts.title, await repo.defaultRepoId());
  if (opts.model) await chat.updateChatSettings(created.id, { model: opts.model });
  await db.insert(channelThreads).values({ channel, externalId, runId: created.id });
  return created.id;
}

/** Drop the mapping so the next message starts a brand-new run (/new, /reset). */
export async function resetThread(channel: string, externalId: string): Promise<void> {
  await db
    .delete(channelThreads)
    .where(and(eq(channelThreads.channel, channel), eq(channelThreads.externalId, externalId)));
}

/** Current run id for a conversation, or null if none is mapped yet. */
export async function currentRunId(
  channel: string,
  externalId: string
): Promise<number | null> {
  const row = (
    await db
      .select({ runId: channelThreads.runId })
      .from(channelThreads)
      .where(and(eq(channelThreads.channel, channel), eq(channelThreads.externalId, externalId)))
  )[0];
  return row?.runId ?? null;
}
