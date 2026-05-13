// Chat session persistence and Claude Agent SDK runner.
//
// Since migration 0009, chats are stored as agent_runs with goal='<chat>'
// and conversation history lives in agent_messages. This module is a thin
// shim that exposes the legacy chat API surface (ChatRow / ChatMessageRow /
// listChats / runChat) on top of the unified tables, so the existing
// /chat UI keeps working until the new /runs UI lands. It will be deleted
// in favour of lib/runs.ts in T-20260513-0048.

import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, isNotNull, or } from "drizzle-orm";

import { db } from "@/db";
import { agentMessages, agentSessions } from "@/db/schema";
import * as repo from "./repo";
import type { SdkContentBlock, SdkMessageEnvelope } from "./sdk-message";
import type { ChatMessageRow, ChatRole, ChatRow } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Fallback cwd if a chat's repository has no local_path yet.
const ORCHESTRATOR_ROOT = resolve(__dirname, "..");
const DEFAULT_MODEL = process.env.TASK_ORCH_CHAT_MODEL ?? "claude-sonnet-4-5";

// SDK-built-in filesystem sandbox; see lib/agent.ts for rationale.
const SANDBOX_OPTS = {
  enabled: true as const,
  autoAllowBashIfSandboxed: true as const,
};

export type { ChatRole, ChatRow, ChatMessageRow };

// Appended to the claude_code preset so the model knows about the orchestrator
// MCP toolset and uses it instead of (or alongside) generic bash/edit when the
// user asks for plan/task/session work.
const TASK_ORCH_TOOL_HINT = [
  "You have an `mcp__task_orch__*` toolset that exposes the full task orchestrator:",
  "  • repositories: list_repositories, get_repository, create_repository, update_repository, delete_repository",
  "  • plans: list_plans, get_plan, create_plan, update_plan, transition_plan, delete_plan, add_plan_repository, remove_plan_repository",
  "  • tasks: list_tasks, get_task, create_task, update_task, transition_task, delete_task",
  "  • notes: add_note, list_notes",
  "  • acceptance criteria: list_criteria, add_criterion, check_criterion, uncheck_criterion, update_criterion, delete_criterion",
  "  • agent sessions: list_sessions, get_session, start_session, cancel_session",
  "",
  "Repository model: a plan is attached to one or more repositories (the git checkouts agents work in). Every task pins to exactly one of its plan's repositories. When creating a plan, pass repo_ids — call list_repositories first if you don't know which IDs exist. When creating a task on a multi-repo plan, repo_id is required. Sessions refuse to start if the task has no repo pinned.",
  "Prefer these tools over shell or file edits when the user asks anything about plans, tasks, criteria, notes, or background agent runs — they go through the same code paths as the UI and respect all invariants (state transitions, criteria-before-done, etc.). Reach for bash/edit only for actual code work in the target repo.",
].join("\n");

export function getDefaultModel(): string {
  return DEFAULT_MODEL;
}

// A "chat run" is any agent_runs row that originated as a chat: either
// freshly created via createChat() (goal='<chat>') or backfilled from the
// old chats table (legacy_chat_id IS NOT NULL).
function isChatRunPredicate() {
  return or(eq(agentSessions.goal, "<chat>"), isNotNull(agentSessions.legacyChatId));
}

// Resolve the cwd a chat agent runs in: chat → repository → local_path,
// falling back to the orchestrator's own checkout when nothing is configured.
export function resolveChatCwd(chat: ChatRow): { cwd: string; repoId: string | null } {
  if (chat.repoId) {
    const r = repo.getRepository(chat.repoId);
    if (r?.localPath) return { cwd: resolve(r.localPath), repoId: r.id };
    if (r) return { cwd: ORCHESTRATOR_ROOT, repoId: r.id };
  }
  const fallback = repo.defaultRepo();
  if (fallback?.localPath) return { cwd: resolve(fallback.localPath), repoId: fallback.id };
  return { cwd: ORCHESTRATOR_ROOT, repoId: fallback?.id ?? null };
}

// ──────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────

export function listChats(userId?: number | null): ChatRow[] {
  const isChatRun = isChatRunPredicate();
  const where =
    userId == null ? isChatRun : and(isChatRun, eq(agentSessions.userId, userId));
  const rows = db
    .select()
    .from(agentSessions)
    .where(where)
    .orderBy(desc(agentSessions.startedAt))
    .all();
  return rows.map(hydrateChat);
}

export function getChat(id: number, userId?: number | null): ChatRow | null {
  const isChatRun = isChatRunPredicate();
  const where =
    userId == null
      ? and(eq(agentSessions.id, id), isChatRun)
      : and(eq(agentSessions.id, id), isChatRun, eq(agentSessions.userId, userId));
  const row = db.select().from(agentSessions).where(where).get();
  return row ? hydrateChat(row) : null;
}

export function createChat(
  userId: number | null,
  title = "New chat",
  repoId: string | null = repo.defaultRepoId()
): ChatRow {
  if (repoId && !repo.getRepository(repoId)) {
    throw new repo.RepoError(`Repository ${repoId} not found`, 404);
  }
  const inserted = db
    .insert(agentSessions)
    .values({
      userId,
      title,
      model: DEFAULT_MODEL,
      repoId,
      goal: "<chat>",
      toolsProfile: "orchestrator,repo_write",
      cwdStrategy: "none",
      status: "idle",
      startedAt: new Date(),
    })
    .returning()
    .all();
  return hydrateChat(inserted[0]);
}

export function deleteChat(id: number, userId?: number | null): void {
  const isChatRun = isChatRunPredicate();
  const where =
    userId == null
      ? and(eq(agentSessions.id, id), isChatRun)
      : and(eq(agentSessions.id, id), isChatRun, eq(agentSessions.userId, userId));
  db.delete(agentSessions).where(where).run();
}

export function renameChat(id: number, title: string, userId?: number | null): void {
  const isChatRun = isChatRunPredicate();
  const where =
    userId == null
      ? and(eq(agentSessions.id, id), isChatRun)
      : and(eq(agentSessions.id, id), isChatRun, eq(agentSessions.userId, userId));
  db.update(agentSessions).set({ title }).where(where).run();
}

export interface UpdateChatSettings {
  title?: string;
  model?: string | null;
  repoId?: string | null;
}

export function updateChatSettings(
  id: number,
  patch: UpdateChatSettings,
  userId?: number | null
): void {
  if (patch.repoId !== undefined && patch.repoId !== null) {
    if (!repo.getRepository(patch.repoId)) {
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
  db.update(agentSessions).set(values).where(where).run();
}

export function listMessages(chatId: number): ChatMessageRow[] {
  // Only surface "conversational" roles (user/agent/tool) here; the
  // /chat UI was designed for chat_messages-shaped rows. System messages
  // backfilled from agent_events are rendered by the new /runs UI.
  return db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.runId, chatId))
    .orderBy(asc(agentMessages.id))
    .all()
    .filter((row) => row.role !== "system")
    .map(hydrateMessage);
}

function appendMessage(
  chatId: number,
  role: ChatRole,
  content: SdkContentBlock[]
): ChatMessageRow {
  const inserted = db
    .insert(agentMessages)
    .values({
      runId: chatId,
      role: chatRoleToMessageRole(role),
      content: JSON.stringify(content),
      createdAt: new Date(),
    })
    .returning()
    .all();
  return hydrateMessage(inserted[0]);
}

// ──────────────────────────────────────────────────────────
// SDK runner
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
  sdk?: SdkMessageEnvelope;
  error?: string;
}

export async function* runChat({
  chatId,
  userText,
  abort,
  author,
}: RunChatArgs): AsyncGenerator<ChatStreamEvent> {
  const chat = getChat(chatId);
  if (!chat) {
    yield { type: "error", error: `Chat ${chatId} not found` };
    return;
  }

  const userMessage = appendMessage(chatId, "user", [{ type: "text", text: userText }]);
  yield { type: "user_message", message: userMessage };

  // Auto-title the chat from the first user message.
  if (chat.title === "New chat") {
    const title = userText.trim().slice(0, 60).replace(/\s+/g, " ");
    if (title) renameChat(chatId, title);
  }

  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: (args: { prompt: string; options?: any }) => AsyncIterable<unknown>;
  };
  // Lazy import — pulls in zod via the SDK.
  const { createOrchestratorMcpServer } = await import("./agent-mcp");
  const mcpServer = createOrchestratorMcpServer({ author: author ?? "chat" });

  const { cwd } = resolveChatCwd(chat);
  // Per-chat sandbox DB: any tsx/test invocation inside the target repo hits
  // this file, not prod. Reused across turns of the same chat so script state
  // built up earlier in the conversation is still there next message.
  const sandboxDbPath = join(tmpdir(), `task-orch-chat-${chatId}.sandbox.db`);
  const env = sanitizeEnv(process.env, { sandboxDbPath });
  // Capture stderr from the spawned `claude` process so failures (auth,
  // permission, missing credentials) surface in the chat error event instead
  // of just "Claude Code process exited with code 1".
  let stderrBuf = "";
  const stream = sdk.query({
    prompt: userText,
    options: {
      cwd,
      permissionMode: "bypassPermissions",
      model: chat.model ?? DEFAULT_MODEL,
      env,
      abortController: abort,
      stderr: (data: string) => {
        stderrBuf += data;
        if (stderrBuf.length > 16_000) stderrBuf = stderrBuf.slice(-16_000);
        console.error(`[chat ${chatId}] sdk stderr:`, data.trimEnd());
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: TASK_ORCH_TOOL_HINT,
      },
      mcpServers: { task_orch: mcpServer },
      resume: chat.sdkSessionId ?? undefined,
      sandbox: SANDBOX_OPTS,
    },
  });

  // Accumulate the assistant turn's content blocks across streamed messages
  // and persist them as one assistant message on `result`. Tool results from
  // the SDK arrive as "user" envelopes and are persisted separately so the
  // UI can render them in order.
  const assistantBlocks: SdkContentBlock[] = [];
  let newSdkSessionId: string | null = null;
  let totalCostUsd: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  try {
    for await (const raw of stream) {
      if (abort.signal.aborted) break;
      const m = raw as SdkMessageEnvelope;
      yield { type: "sdk", sdk: m };

      if (m.type === "system" && m.subtype === "init" && m.session_id) {
        newSdkSessionId = m.session_id;
      }

      if (m.type === "assistant" && m.message?.content) {
        for (const block of m.message.content) assistantBlocks.push(block);
      }

      if (m.type === "user" && m.message?.content) {
        const toolResults = m.message.content.filter((b) => b.type === "tool_result");
        if (toolResults.length > 0) {
          const persisted = appendMessage(chatId, "tool_result", toolResults);
          yield { type: "sdk", sdk: m };
          // Also surface the persisted row so the client can reconcile ids
          // on refresh, but the live stream already showed the content above.
          void persisted;
        }
      }

      if (m.type === "result") {
        totalCostUsd = m.total_cost_usd ?? totalCostUsd;
        inputTokens = m.usage?.input_tokens ?? inputTokens;
        outputTokens = m.usage?.output_tokens ?? outputTokens;
      }
    }

    if (assistantBlocks.length > 0) {
      appendMessage(chatId, "assistant", assistantBlocks);
    }

    db.update(agentSessions)
      .set({
        sdkSessionId: newSdkSessionId ?? chat.sdkSessionId,
        totalCostUsd: totalCostUsd ?? chat.totalCostUsd,
        inputTokens: inputTokens ?? chat.inputTokens,
        outputTokens: outputTokens ?? chat.outputTokens,
      })
      .where(eq(agentSessions.id, chatId))
      .run();

    yield { type: "done" };
  } catch (err) {
    if (abort.signal.aborted) {
      yield { type: "done" };
      return;
    }
    const base = err instanceof Error ? err.message : String(err);
    const tail = stderrBuf.trim().slice(-1500);
    const message = tail ? `${base}\n\nstderr:\n${tail}` : base;
    console.error(`[chat ${chatId}] sdk failed:`, message);
    yield { type: "error", error: message };
  }
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

// agent_messages stores roles as 'user' | 'agent' | 'tool' | 'system'.
// The legacy chat API uses 'user' | 'assistant' | 'tool_result'.
function messageRoleToChatRole(role: string): ChatRole {
  switch (role) {
    case "agent":
      return "assistant";
    case "tool":
      return "tool_result";
    case "user":
      return "user";
    default:
      // System messages don't have a chat-side equivalent; fall back to
      // 'tool_result' so the UI renders them as a generic non-assistant
      // entry. listMessages() filters them out anyway.
      return "tool_result";
  }
}

function chatRoleToMessageRole(role: ChatRole): string {
  switch (role) {
    case "assistant":
      return "agent";
    case "tool_result":
      return "tool";
    case "user":
      return "user";
  }
}

function hydrateChat(row: typeof agentSessions.$inferSelect): ChatRow {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title ?? "New chat",
    model: row.model,
    sdkSessionId: row.sdkSessionId,
    totalCostUsd: row.totalCostUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    repoId: row.repoId,
    createdAt: row.startedAt,
    // Chats don't have a separate updated_at on agent_runs; use the
    // latest message's created_at if any, falling back to started_at.
    // (Cheap path: just use started_at; it's only used for sort order
    // in listChats which is already by startedAt DESC.)
    updatedAt: row.startedAt,
  };
}

function hydrateMessage(row: typeof agentMessages.$inferSelect): ChatMessageRow {
  let content: SdkContentBlock[] = [];
  try {
    const parsed = JSON.parse(row.content);
    if (Array.isArray(parsed)) content = parsed as SdkContentBlock[];
  } catch {
    // Tolerate corrupted rows by surfacing the raw text.
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

function sanitizeEnv(
  input: NodeJS.ProcessEnv,
  opts: { sandboxDbPath: string }
): Record<string, string> {
  // Mirrors lib/agent.ts: strip Claude Code session env vars so the nested
  // SDK invocation isn't confused by a parent Claude Code process. Also
  // override TASK_ORCH_DB with a per-chat sandbox path and drop AUTH_SECRET
  // so the agent can't accidentally mutate prod or leak credentials when
  // it runs scripts in the target repo.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (
      k === "CLAUDECODE" ||
      k.startsWith("CLAUDE_CODE_") ||
      k.startsWith("CLAUDE_SESSION_") ||
      k.startsWith("CLAUDE_ENABLE_") ||
      k.startsWith("CLAUDE_AFTER_") ||
      k.startsWith("CLAUDE_AUTO_") ||
      k === "TASK_ORCH_DB" ||
      k === "AUTH_SECRET"
    ) {
      continue;
    }
    out[k] = v;
  }
  out.TASK_ORCH_DB = opts.sandboxDbPath;
  return out;
}
