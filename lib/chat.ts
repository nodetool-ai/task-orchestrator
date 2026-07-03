// Chat shim around lib/runs.ts.
//
// Since migration 0009 chats are stored as agent_runs with goal='<chat>'
// and conversation history in agent_messages. As of T-20260513-0048 the
// runChat() generator delegates to lib/runs.ts:append() — this module is a
// thin compatibility surface for the existing /chat UI and /api/chats
// routes. New callers should use lib/runs.ts directly.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, isNotNull, or } from "drizzle-orm";

import { db } from "@/db";
import { agentMessages, agentSessions } from "@/db/schema";
import * as repo from "./repo";
import * as runs from "./runs";
import type { SdkContentBlock } from "./sdk-message";
import type { RunEnvelope } from "./pi-event-mapper";
import type { CwdStrategy } from "./runs";
import type { ChatMessageRow, ChatRole, ChatRow } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_ROOT = resolve(__dirname, "..");
// Provider-qualified ("provider/modelId") so it overrides the persona's
// provider downstream. A bare id would inherit the persona's provider
// ("kimi-coding" for the seeded personas), which the Claude backend rejects —
// the first turn of a new chat would fail. The model picker emits the same
// qualified shape, so this matches what an explicit pick produces.
const DEFAULT_MODEL = process.env.TASK_ORCH_CHAT_MODEL ?? "anthropic/claude-sonnet-4-6";

export type { ChatRole, ChatRow, ChatMessageRow };

export function getDefaultModel(): string {
  return DEFAULT_MODEL;
}

// A "chat run" is any agent_runs row that originated as a chat: either
// freshly created via createChat() (goal='<chat>') or backfilled from the
// old chats table (legacy_chat_id IS NOT NULL).
function isChatRunPredicate() {
  return or(eq(agentSessions.goal, "<chat>"), isNotNull(agentSessions.legacyChatId));
}

export async function resolveChatCwd(
  chat: ChatRow
): Promise<{ cwd: string; repoId: string | null }> {
  if (chat.repoId) {
    const r = await repo.getRepository(chat.repoId);
    if (r?.localPath) return { cwd: resolve(r.localPath), repoId: r.id };
    if (r) return { cwd: ORCHESTRATOR_ROOT, repoId: r.id };
  }
  const fallback = await repo.defaultRepo();
  if (fallback?.localPath) return { cwd: resolve(fallback.localPath), repoId: fallback.id };
  return { cwd: ORCHESTRATOR_ROOT, repoId: fallback?.id ?? null };
}

// ──────────────────────────────────────────────────────────
// CRUD (queries the unified table)
// ──────────────────────────────────────────────────────────

export async function listChats(userId?: number | null): Promise<ChatRow[]> {
  const isChatRun = isChatRunPredicate();
  const where =
    userId == null ? isChatRun : and(isChatRun, eq(agentSessions.userId, userId));
  const rows = await db
    .select()
    .from(agentSessions)
    .where(where)
    .orderBy(desc(agentSessions.startedAt));
  return rows.map(hydrateChat);
}

export async function getChat(id: number, userId?: number | null): Promise<ChatRow | null> {
  const isChatRun = isChatRunPredicate();
  const where =
    userId == null
      ? and(eq(agentSessions.id, id), isChatRun)
      : and(eq(agentSessions.id, id), isChatRun, eq(agentSessions.userId, userId));
  const row = (await db.select().from(agentSessions).where(where))[0];
  return row ? hydrateChat(row) : null;
}

export async function createChat(
  userId: number | null,
  title = "New chat",
  repoId?: string | null,
  // Every chat runs in its own git worktree so concurrent conversations never
  // share (and clobber) the repo's working tree. Callers can override, but both
  // the web composer and the Discord pipe take the default.
  cwdStrategy: CwdStrategy = "worktree"
): Promise<ChatRow> {
  if (repoId === undefined) repoId = await repo.defaultRepoId();
  if (repoId && !(await repo.getRepository(repoId))) {
    throw new repo.RepoError(`Repository ${repoId} not found`, 404);
  }
  // Delegate to runs.create so the row gets goal/cwdStrategy/profile in one
  // place. goal='<chat>' lands the run at status='idle' awaiting first append.
  const created = await runs.create({
    goal: "<chat>",
    cwdStrategy,
    toolsProfile: "orchestrator,repo_write",
    repoId,
    userId,
    title,
    model: DEFAULT_MODEL,
  });
  return (await getChat(created.id, userId))!;
}

export async function deleteChat(id: number, userId?: number | null): Promise<void> {
  const isChatRun = isChatRunPredicate();
  const where =
    userId == null
      ? and(eq(agentSessions.id, id), isChatRun)
      : and(eq(agentSessions.id, id), isChatRun, eq(agentSessions.userId, userId));
  await db.delete(agentSessions).where(where);
}

export async function renameChat(
  id: number,
  title: string,
  userId?: number | null
): Promise<void> {
  const isChatRun = isChatRunPredicate();
  const where =
    userId == null
      ? and(eq(agentSessions.id, id), isChatRun)
      : and(eq(agentSessions.id, id), isChatRun, eq(agentSessions.userId, userId));
  await db.update(agentSessions).set({ title }).where(where);
}

export interface UpdateChatSettings {
  title?: string;
  model?: string | null;
  repoId?: string | null;
}

export async function updateChatSettings(
  id: number,
  patch: UpdateChatSettings,
  userId?: number | null
): Promise<void> {
  if (patch.repoId !== undefined && patch.repoId !== null) {
    if (!(await repo.getRepository(patch.repoId))) {
      throw new repo.RepoError(`Repository ${patch.repoId} not found`, 404);
    }
  }
  const values: Record<string, unknown> = {};
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.model !== undefined) values.model = patch.model;
  if (patch.repoId !== undefined) values.repoId = patch.repoId;
  if (Object.keys(values).length === 0) return;
  const isChatRun = isChatRunPredicate();
  const where =
    userId == null
      ? and(eq(agentSessions.id, id), isChatRun)
      : and(eq(agentSessions.id, id), isChatRun, eq(agentSessions.userId, userId));
  await db.update(agentSessions).set(values).where(where);
}

export async function listMessages(chatId: number): Promise<ChatMessageRow[]> {
  // Only surface "conversational" roles (user/agent/tool) here; the legacy
  // /chat UI was designed for chat_messages-shaped rows. System messages
  // backfilled from agent_events are rendered by the new /runs UI.
  return (
    await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.runId, chatId))
      .orderBy(asc(agentMessages.id))
  )
    .filter((row) => row.role !== "system")
    .map(hydrateMessage);
}

// ──────────────────────────────────────────────────────────
// SDK runner (delegates to lib/runs.ts:append)
// ──────────────────────────────────────────────────────────

export interface RunChatArgs {
  chatId: number;
  userText: string;
  abort: AbortController;
  /** Recorded as the author on tasks/notes the agent creates. */
  author?: string;
}

export interface ChatStreamEvent {
  type: "user_message" | "sdk" | "done" | "error";
  message?: ChatMessageRow;
  sdk?: RunEnvelope;
  error?: string;
}

export async function* runChat({
  chatId,
  userText,
  abort,
  author,
}: RunChatArgs): AsyncGenerator<ChatStreamEvent> {
  const chat = await getChat(chatId);
  if (!chat) {
    yield { type: "error", error: `Chat ${chatId} not found` };
    return;
  }

  // Auto-title the chat from the first user message.
  if (chat.title === "New chat") {
    const title = userText.trim().slice(0, 60).replace(/\s+/g, " ");
    if (title) await renameChat(chatId, title);
  }

  // Chat runs are agent_runs with goal='<chat>'; sendMessageToRun routes the turn
  // through a long-lived worker container in the real deploy (root server can't run
  // the agent), falling back to in-process append() in dev. Frame contract unchanged.
  for await (const event of runs.sendMessageToRun({
    runId: chatId,
    role: "user",
    text: userText,
    author: author ?? "chat",
    abort,
  })) {
    if (event.type === "user_message" && event.message) {
      yield { type: "user_message", message: messageToChatRow(event.message) };
    } else if (event.type === "sdk") {
      yield { type: "sdk", sdk: event.sdk };
    } else if (event.type === "done") {
      yield { type: "done" };
      return;
    } else if (event.type === "error") {
      yield { type: "error", error: event.error };
      return;
    }
  }
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function messageRoleToChatRole(role: string): ChatRole {
  switch (role) {
    case "agent":
      return "assistant";
    case "tool":
      return "tool_result";
    case "user":
      return "user";
    default:
      return "tool_result";
  }
}

function messageToChatRow(m: runs.MessageRow): ChatMessageRow {
  return {
    id: m.id,
    chatId: m.runId,
    role: messageRoleToChatRole(m.role),
    content: m.content,
    createdAt: m.createdAt,
  };
}

function hydrateChat(row: typeof agentSessions.$inferSelect): ChatRow {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title ?? "New chat",
    cwdStrategy: row.cwdStrategy as CwdStrategy,
    model: row.model,
    sdkSessionId: row.sdkSessionId,
    totalCostUsd: row.totalCostUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    repoId: row.repoId,
    createdAt: row.startedAt,
    updatedAt: row.startedAt,
  };
}

function hydrateMessage(row: typeof agentMessages.$inferSelect): ChatMessageRow {
  let content: SdkContentBlock[] = [];
  try {
    const parsed = JSON.parse(row.content);
    if (Array.isArray(parsed)) content = parsed as SdkContentBlock[];
  } catch {
    content = [{ type: "text", text: row.content }];
  }
  return {
    id: row.id,
    chatId: row.runId,
    role: messageRoleToChatRole(row.role),
    content,
    createdAt: row.createdAt,
  };
}
