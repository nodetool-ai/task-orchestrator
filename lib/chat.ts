// Chat session persistence and Claude Agent SDK runner.
//
// Each chat lives in the `chats` table with a stream of `chat_messages`. The
// Claude Agent SDK is invoked with the Claude Code preset so the assistant
// has bash/edit tools. Sessions resume across turns via `sdk_session_id`.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { chatMessages, chats } from "@/db/schema";
import type { SdkContentBlock, SdkMessageEnvelope } from "./sdk-message";
import type { ChatMessageRow, ChatRole, ChatRow } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.TASK_ORCH_TARGET_REPO
  ? resolve(process.env.TASK_ORCH_TARGET_REPO)
  : resolve(__dirname, "..");
const DEFAULT_MODEL = process.env.TASK_ORCH_CHAT_MODEL ?? "claude-sonnet-4-5";

export type { ChatRole, ChatRow, ChatMessageRow };

// Appended to the claude_code preset so the model knows about the orchestrator
// MCP toolset and uses it instead of (or alongside) generic bash/edit when the
// user asks for plan/task/session work.
const TASK_ORCH_TOOL_HINT = [
  "You have an `mcp__task_orch__*` toolset that exposes the full task orchestrator:",
  "  • plans: list_plans, get_plan, create_plan, update_plan, transition_plan, delete_plan",
  "  • tasks: list_tasks, get_task, create_task, update_task, transition_task, delete_task",
  "  • notes: add_note, list_notes",
  "  • acceptance criteria: list_criteria, add_criterion, check_criterion, uncheck_criterion, update_criterion, delete_criterion",
  "  • agent sessions: list_sessions, get_session, start_session, cancel_session",
  "",
  "Prefer these tools over shell or file edits when the user asks anything about plans, tasks, criteria, notes, or background agent runs — they go through the same code paths as the UI and respect all invariants (state transitions, criteria-before-done, etc.). Reach for bash/edit only for actual code work in the target repo.",
].join("\n");

// The directory the SDK runs in. Project-wide setting via TASK_ORCH_TARGET_REPO,
// falls back to the orchestrator's own repo.
export function getRepoRoot(): string {
  return REPO_ROOT;
}

export function getDefaultModel(): string {
  return DEFAULT_MODEL;
}

// ──────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────

export function listChats(userId?: number | null): ChatRow[] {
  const rows =
    userId == null
      ? db.select().from(chats).orderBy(desc(chats.updatedAt)).all()
      : db
          .select()
          .from(chats)
          .where(eq(chats.userId, userId))
          .orderBy(desc(chats.updatedAt))
          .all();
  return rows.map(hydrateChat);
}

export function getChat(id: number, userId?: number | null): ChatRow | null {
  const where = userId == null
    ? eq(chats.id, id)
    : and(eq(chats.id, id), eq(chats.userId, userId));
  const row = db.select().from(chats).where(where).get();
  return row ? hydrateChat(row) : null;
}

export function createChat(userId: number | null, title = "New chat"): ChatRow {
  const inserted = db
    .insert(chats)
    .values({
      userId,
      title,
      model: DEFAULT_MODEL,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .all();
  return hydrateChat(inserted[0]);
}

export function deleteChat(id: number, userId?: number | null): void {
  const where = userId == null
    ? eq(chats.id, id)
    : and(eq(chats.id, id), eq(chats.userId, userId));
  db.delete(chats).where(where).run();
}

export function renameChat(id: number, title: string, userId?: number | null): void {
  const where = userId == null
    ? eq(chats.id, id)
    : and(eq(chats.id, id), eq(chats.userId, userId));
  db.update(chats).set({ title, updatedAt: new Date() }).where(where).run();
}

export interface UpdateChatSettings {
  title?: string;
  model?: string | null;
}

export function updateChatSettings(
  id: number,
  patch: UpdateChatSettings,
  userId?: number | null
): void {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.model !== undefined) values.model = patch.model;
  const where = userId == null
    ? eq(chats.id, id)
    : and(eq(chats.id, id), eq(chats.userId, userId));
  db.update(chats).set(values).where(where).run();
}

export function listMessages(chatId: number): ChatMessageRow[] {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(asc(chatMessages.id))
    .all()
    .map(hydrateMessage);
}

function appendMessage(
  chatId: number,
  role: ChatRole,
  content: SdkContentBlock[]
): ChatMessageRow {
  const inserted = db
    .insert(chatMessages)
    .values({
      chatId,
      role,
      content: JSON.stringify(content),
      createdAt: new Date(),
    })
    .returning()
    .all();
  db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chatId)).run();
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

  const env = sanitizeEnv(process.env);
  // Capture stderr from the spawned `claude` process so failures (auth,
  // permission, missing credentials) surface in the chat error event instead
  // of just "Claude Code process exited with code 1".
  let stderrBuf = "";
  const stream = sdk.query({
    prompt: userText,
    options: {
      cwd: REPO_ROOT,
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

    db.update(chats)
      .set({
        sdkSessionId: newSdkSessionId ?? chat.sdkSessionId,
        totalCostUsd: totalCostUsd ?? chat.totalCostUsd,
        inputTokens: inputTokens ?? chat.inputTokens,
        outputTokens: outputTokens ?? chat.outputTokens,
        updatedAt: new Date(),
      })
      .where(eq(chats.id, chatId))
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

function hydrateChat(row: typeof chats.$inferSelect): ChatRow {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    model: row.model,
    sdkSessionId: row.sdkSessionId,
    totalCostUsd: row.totalCostUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function hydrateMessage(row: typeof chatMessages.$inferSelect): ChatMessageRow {
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
    chatId: row.chatId,
    role: row.role as ChatRole,
    content,
    createdAt: row.createdAt,
  };
}

function sanitizeEnv(input: NodeJS.ProcessEnv): Record<string, string> {
  // Mirrors lib/agent.ts: strip Claude Code session env vars so the nested
  // SDK invocation isn't confused by a parent Claude Code process.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (
      k === "CLAUDECODE" ||
      k.startsWith("CLAUDE_CODE_") ||
      k.startsWith("CLAUDE_SESSION_") ||
      k.startsWith("CLAUDE_ENABLE_") ||
      k.startsWith("CLAUDE_AFTER_") ||
      k.startsWith("CLAUDE_AUTO_")
    ) {
      continue;
    }
    out[k] = v;
  }
  return out;
}
