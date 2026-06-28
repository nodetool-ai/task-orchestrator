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

export interface GetOrCreateOptions {
  /** Provider-qualified model ("provider/id") to set on a freshly created run. */
  model?: string;
  /** Title for a freshly created run; defaults to "<channel>:<externalId>". */
  title?: string;
}

/** Find the existing run for (channel, externalId), or create a fresh chat run. */
export function getOrCreateRun(
  channel: string,
  externalId: string,
  opts: GetOrCreateOptions = {}
): number {
  const existing = db
    .select()
    .from(channelThreads)
    .where(and(eq(channelThreads.channel, channel), eq(channelThreads.externalId, externalId)))
    .get();

  // Guard against a dangling mapping whose run was deleted out from under us.
  // ON DELETE CASCADE should prevent this, but a manual delete or a stale row is
  // possible — drop it and fall through to create a fresh run.
  if (existing && chat.getChat(existing.runId)) return existing.runId;
  if (existing) db.delete(channelThreads).where(eq(channelThreads.id, existing.id)).run();

  // Leave the title at createChat's "New chat" default (unless a caller overrides
  // it) so runChat auto-titles the run from the first user message — the web
  // /runs list then shows the conversation topic instead of a raw channel id.
  // Discord conversations run unattended and concurrently, so isolate each in
  // its own git worktree ('worktree') rather than the shared repo checkout.
  const created = chat.createChat(null, opts.title, repo.defaultRepoId(), "worktree");
  if (opts.model) chat.updateChatSettings(created.id, { model: opts.model });
  db.insert(channelThreads).values({ channel, externalId, runId: created.id }).run();
  return created.id;
}

/** Drop the mapping so the next message starts a brand-new run (/new, /reset). */
export function resetThread(channel: string, externalId: string): void {
  db.delete(channelThreads)
    .where(and(eq(channelThreads.channel, channel), eq(channelThreads.externalId, externalId)))
    .run();
}

/** Current run id for a conversation, or null if none is mapped yet. */
export function currentRunId(channel: string, externalId: string): number | null {
  const row = db
    .select({ runId: channelThreads.runId })
    .from(channelThreads)
    .where(and(eq(channelThreads.channel, channel), eq(channelThreads.externalId, externalId)))
    .get();
  return row?.runId ?? null;
}
