// lib/agent-backend/postgres-turn.ts
//
// The postgres-mode turn driver: an in-process loop that drives
// @earendil-works/pi-ai's models().completeSimple() directly, rebuilding the
// conversation from the DB each turn instead of resuming an SDK session file.
// This is the machinery that used to live in lib/chat-ai-loop.ts; R3 folded it
// in here as a *mode of the pi backend* (PiBackend.runTurn delegates to
// runPostgresTurn when RunTurnArgs.contextSource.kind === 'postgres') so the one
// turn driver — runOneTurn in lib/runs.ts — serves both the lightweight and the
// full-SDK paths through the same Extension[] assembly.
//
// PURITY: like the other adapters under lib/agent-backend, this module never
// touches `db` or lib/runs.ts. Everything it needs from the DB arrives through
// the PostgresContextSource callbacks (loadMessages / annotateMessage) that the
// caller (lib/runs.ts) supplies. Message PERSISTENCE is NOT done here: the
// backend emits each assistant/tool envelope through args.onEvent, and runOneTurn
// persists it — but the content blocks carry an embedded pi Message blob
// (withPiMessage) so the next turn's context loader can reconstruct the pi
// conversation losslessly rather than through the lossy fallback reconstructors.

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  validateToolCall,
  type AssistantMessage,
  type Context,
  type Message,
  type ThinkingLevel,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";

import { assistantText, type SdkContentBlock } from "../sdk-message";
import { resolveCodexAccessToken } from "../codex-oauth-token";
import { interceptorToolName } from "../builtin-tools";
import { config } from "../config";
import type { RunEnvelope } from "../pi-event-mapper";
import { collectExtensions, composeSystemPrompt, runInterceptors } from "./collect";
import { createUsageAccumulator } from "./usage";
import type {
  NeutralTool,
  PostgresContextSource,
  PostgresMessageRow,
  RunTurnArgs,
  ToolResult,
  TurnOutcome,
} from "./types";

// Ordinary lightweight chats can legitimately do long orchestration bursts:
// inspect a plan, list tasks, read notes/attachments, start children, park, or
// answer event digests. Keep a runaway guard, but do not cut off normal work at
// the old 8-round ceiling. Override with TASK_ORCH_CHAT_MAX_TOOL_ROUNDS.
// The executor drives a multi-step orchestration loop per wake (re-scan tasks,
// start N children, arm watchdog, park) and routinely needs more rounds than a
// chat turn. The watchdog parking tools keep a single wake bounded, but give it
// real headroom so it never has to mid-turn truncate a scan/start/park sequence.

let modelsInstance: ReturnType<typeof builtinModels> | null = null;

function models() {
  if (!modelsInstance) modelsInstance = builtinModels();
  return modelsInstance;
}

function maxToolRounds(goal: string): number {
  return goal === "<execute>"
    ? config.agent.executorMaxToolRounds
    : config.agent.chatMaxToolRounds;
}

/** One tool the loop exposes to the model: the pi Tool the model sees plus the
 *  neutral executor bound by the collected extension. */
interface LoopToolEntry {
  tool: Tool;
  execute: (callId: string, params: any) => Promise<ToolResult>;
}

type PiSdkContentBlock = SdkContentBlock & { piMessage?: Message };

function withPiMessage(blocks: SdkContentBlock[], message: Message): SdkContentBlock[] {
  const next = blocks.length > 0 ? blocks.map((block) => ({ ...block })) : [{ type: "text", text: "" }];
  (next[0] as PiSdkContentBlock).piMessage = message;
  return next;
}

function embeddedPiMessage(blocks: SdkContentBlock[]): Message | null {
  for (const block of blocks) {
    const maybe = (block as PiSdkContentBlock).piMessage;
    if (maybe && typeof maybe === "object" && "role" in maybe) return maybe;
  }
  return null;
}

function toSdkBlocks(message: Message, opts: { includePiMessage?: boolean } = {}): SdkContentBlock[] {
  let blocks: SdkContentBlock[];
  if (message.role === "user") {
    blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content.map((block) => ({ ...block })) as SdkContentBlock[]);
  } else if (message.role === "assistant") {
    blocks = message.content.flatMap((block) => {
      if (block.type === "toolCall") {
        return [{
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.arguments,
        }];
      }
      if (block.type === "text") return [{ ...block } as SdkContentBlock];
      return [];
    });
  } else {
    blocks = [{
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content.map((block) =>
        block.type === "text" ? block.text : { ...block }
      ),
      is_error: message.isError,
    } as SdkContentBlock];
  }
  return opts.includePiMessage ? withPiMessage(blocks, message) : blocks;
}

function textFromAssistant(message: AssistantMessage): string | null {
  return assistantText(toSdkBlocks(message)).trim() || null;
}

function toPiContent(
  blocks: Array<{ type: string; [k: string]: unknown }>
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  return blocks.map((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
    return { type: "text" as const, text: JSON.stringify(block) };
  });
}

function userContentFromBlocks(blocks: SdkContentBlock[], textOverride?: string): UserMessage["content"] {
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    }
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  const text = textOverride ?? content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const images = content.filter((block): block is { type: "image"; data: string; mimeType: string } => block.type === "image");
  if (images.length === 0) return text;
  return [{ type: "text", text }, ...images];
}

function fallbackAssistantMessage(
  model: { provider: string; id: string },
  row: PostgresMessageRow
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  for (const block of row.content) {
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      content.push({
        type: "toolCall",
        id: block.id ?? `tool-${row.id}`,
        name: block.name,
        arguments: (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, any>,
      });
    }
  }
  return {
    role: "assistant",
    content,
    api: "unknown",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: row.createdAt,
  };
}

function fallbackToolResultMessage(row: PostgresMessageRow): ToolResultMessage | null {
  const block = row.content.find((candidate) => candidate.type === "tool_result");
  if (!block) return null;
  const raw = block.content;
  const content =
    typeof raw === "string"
      ? [{ type: "text" as const, text: raw }]
      : Array.isArray(raw)
        ? raw.map((item) =>
            typeof item === "string"
              ? { type: "text" as const, text: item }
              : item && typeof item === "object" && "type" in item
                ? item as { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
                : { type: "text" as const, text: JSON.stringify(item) }
          )
        : [{ type: "text" as const, text: JSON.stringify(raw) }];
  return {
    role: "toolResult",
    toolCallId: block.tool_use_id ?? `tool-${row.id}`,
    toolName: block.name ?? "tool",
    content,
    isError: Boolean((block as any).is_error),
    timestamp: row.createdAt,
  };
}

/**
 * Rebuild the pi conversation from the persisted rows. A row a prior postgres
 * turn wrote carries an embedded pi Message (embeddedPiMessage) we replay
 * verbatim; older / cross-path rows are reconstructed from their SDK blocks via
 * the fallback builders. The final user turn's content is overridden with the
 * live prompt (currentInputText) — or appended as an ephemeral message.
 */
function reconstructContext(
  rows: PostgresMessageRow[],
  model: { provider: string; id: string },
  currentInputText: string,
  ephemeralInput: boolean
): Message[] {
  let lastUserIndex = -1;
  const messages: Message[] = [];
  for (const row of rows) {
    const embedded = embeddedPiMessage(row.content);
    if (embedded) {
      messages.push(embedded);
      if (embedded.role === "user") lastUserIndex = messages.length - 1;
      continue;
    }
    if (row.role === "user") {
      messages.push({
        role: "user",
        content: userContentFromBlocks(row.content),
        timestamp: row.createdAt,
      });
      lastUserIndex = messages.length - 1;
    } else if (row.role === "agent") {
      messages.push(fallbackAssistantMessage(model, row));
    } else if (row.role === "tool") {
      const toolResult = fallbackToolResultMessage(row);
      if (toolResult) messages.push(toolResult);
    }
  }
  if (ephemeralInput) {
    messages.push({ role: "user", content: currentInputText, timestamp: Date.now() });
  } else if (lastUserIndex >= 0) {
    const current = messages[lastUserIndex] as UserMessage;
    if (typeof current.content === "string") {
      current.content = currentInputText;
    } else {
      const images = current.content.filter((block) => block.type === "image");
      current.content = images.length > 0 ? [{ type: "text", text: currentInputText }, ...images] : currentInputText;
    }
  }
  return messages;
}

/**
 * Rewrite the latest persisted user row so it embeds a pi user Message containing
 * only the user's durable text. Transient event digests are applied by the live
 * context override above, but must not replay as user-authored context on later
 * turns. No-op for ephemeral event-wake inputs, which have no user row.
 */
async function annotateLatestUserMessage(
  ctx: PostgresContextSource,
  rows: PostgresMessageRow[],
  inputText: string
): Promise<void> {
  const row = [...rows].reverse().find((candidate) => candidate.role === "user");
  const visibleBlocks = row?.content.length ? row.content : [{ type: "text", text: inputText }];
  const message: UserMessage = {
    role: "user",
    content: userContentFromBlocks(visibleBlocks, inputText),
    timestamp: row?.createdAt ?? Date.now(),
  };
  const content = withPiMessage(visibleBlocks, message);
  if (row) {
    await ctx.annotateMessage(row.id, content);
    // Keep the in-memory rows consistent with what we just wrote so the context
    // reconstruction below replays the embedded message rather than the fallback.
    row.content = content;
  }
}

function sdkEventFor(message: AssistantMessage | ToolResultMessage): RunEnvelope {
  if (message.role === "assistant") {
    return {
      type: "assistant",
      message: { content: toSdkBlocks(message, { includePiMessage: true }) },
    } as RunEnvelope;
  }
  return {
    type: "user",
    message: { content: toSdkBlocks(message, { includePiMessage: true }) },
  } as RunEnvelope;
}

async function resolveModel(model: { provider: string; id: string }) {
  const collection = models();
  let resolved = collection.getModel(model.provider, model.id);
  if (!resolved) {
    await collection.refresh(model.provider).catch(() => {});
    resolved = collection.getModel(model.provider, model.id);
  }
  if (!resolved) {
    throw new Error(
      `Model '${model.provider}/${model.id}' was not found in @earendil-works/pi-ai. ` +
        `Check the persona/run model setting.`
    );
  }
  return resolved;
}

/** Build the loop's pi tool set from the extensions' collected tools. */
function toolEntries(tools: NeutralTool[]): LoopToolEntry[] {
  return tools.map((tool) => ({
    tool: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
    execute: tool.execute,
  }));
}

async function executeToolCall(args: {
  tools: Tool[];
  dispatch: Map<string, LoopToolEntry>;
  interceptors: Parameters<typeof runInterceptors>[0];
  call: ToolCall;
}): Promise<ToolResultMessage> {
  const { tools, dispatch, interceptors, call } = args;
  const now = Date.now();

  try {
    let params = validateToolCall(tools, call);
    // Path B never ran interceptors; the unified path does. In practice the
    // postgres extension set registers none (sandbox/env-scrub are skipped —
    // there is no cwd to contain — and the planning gate isn't in a lightweight
    // profile), so this is a structural no-op today, but it keeps the seam honest
    // if a future profile adds an interceptor.
    const decision = await runInterceptors(interceptors, interceptorToolName(call.name), params);
    if (decision && "block" in decision) {
      return {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: decision.reason }],
        isError: true,
        timestamp: now,
      };
    }
    if (decision && "input" in decision) params = decision.input;
    const entry = dispatch.get(call.name);
    if (!entry) {
      throw new Error(`Unknown lightweight tool: ${call.name}`);
    }
    const result = await entry.execute(call.id, params);
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: toPiContent(result.content),
      isError: result.isError ?? false,
      timestamp: now,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: message }],
      isError: true,
      timestamp: now,
    };
  }
}

/**
 * Drive one postgres-mode turn. Reached only from PiBackend.runTurn when
 * contextSource is 'postgres'. Persistence + streaming happen through
 * args.onEvent (runOneTurn owns them); this loop owns the model round loop,
 * tool dispatch, and per-round usage accumulation.
 */
export async function runPostgresTurn(args: RunTurnArgs): Promise<TurnOutcome> {
  const ctx = args.contextSource;
  if (!ctx || ctx.kind !== "postgres") {
    throw new Error("runPostgresTurn requires contextSource.kind === 'postgres'");
  }
  const { abort, prompt, onEvent } = args;

  const collected = await collectExtensions(args.extensions);

  // System prompt: the persona transforms (persona prompt + memory guidance) plus
  // the ambient skills (the persona's memory notes), the same composition the
  // Claude backend uses — so the lightweight path's prompt now flows through the
  // extensions instead of a hardcoded persona.systemPrompt + MEMORY_SYSTEM_GUIDANCE.
  const promptParts: string[] = [];
  const composedPersona = (await composeSystemPrompt("", collected.systemPromptFns)).trim();
  if (composedPersona) promptParts.push(composedPersona);
  for (const skill of collected.skills) {
    promptParts.push(`# ${skill.name}\n${skill.description}\n\n${skill.body}`);
  }
  const systemPrompt = promptParts.join("\n\n");

  // Let onAgentStart extensions (e.g. the abort bridge) observe our controller.
  for (const fn of collected.agentStartFns) {
    fn({ abort: () => { try { abort.abort(); } catch { /* swallow */ } } });
  }

  const rows = await ctx.loadMessages();
  if (!ctx.ephemeralInput) {
    await annotateLatestUserMessage(ctx, rows, ctx.rawUserText ?? prompt);
  }
  const contextMessages = reconstructContext(rows, args.model, prompt, ctx.ephemeralInput);

  const entries = toolEntries(collected.tools);
  const tools = entries.map((entry) => entry.tool);
  const dispatch = new Map(entries.map((entry) => [entry.tool.name, entry]));

  const model = await resolveModel(args.model);
  const apiKey = model.provider === "openai-codex" ? await resolveCodexAccessToken() : undefined;
  const reasoning = args.thinkingLevel as ThinkingLevel | undefined;
  const context: Context = { systemPrompt, messages: contextMessages, tools };

  const envelopes: RunEnvelope[] = [];
  const usage = createUsageAccumulator();
  let summary: string | null = null;
  let turns = 0;
  const rounds = maxToolRounds(ctx.goal);

  for (let round = 0; round < rounds; round += 1) {
    if (abort.signal.aborted) throw new Error("Turn aborted");
    const assistant = await models().completeSimple(model, context, {
      apiKey,
      reasoning,
      signal: abort.signal,
      sessionId: `task-orch-${ctx.runId}`,
    });
    turns += 1;
    context.messages.push(assistant);

    const env = sdkEventFor(assistant);
    envelopes.push(env);
    await onEvent(env);

    summary = textFromAssistant(assistant) ?? summary;
    usage.addRound({
      input: assistant.usage?.input,
      output: assistant.usage?.output,
      costTotal: assistant.usage?.cost?.total,
    });

    if (assistant.stopReason === "error") {
      throw new Error(assistant.errorMessage ?? "pi-ai chat completion failed");
    }
    if (assistant.stopReason === "aborted") {
      throw new Error("Turn aborted");
    }

    const calls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
    if (calls.length === 0) {
      const totals = usage.totals();
      return {
        envelopes,
        summary,
        resumeToken: null,
        totalCostUsd: totals.totalCostUsd,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        turns,
      };
    }

    for (const call of calls) {
      if (abort.signal.aborted) throw new Error("Turn aborted");
      const toolResult = await executeToolCall({ tools, dispatch, interceptors: collected.interceptors, call });
      context.messages.push(toolResult);
      const toolEnv = sdkEventFor(toolResult);
      envelopes.push(toolEnv);
      await onEvent(toolEnv);
    }
  }

  throw new Error(`Lightweight turn exceeded ${rounds} tool rounds`);
}
