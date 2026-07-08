import { asc, desc, eq } from "drizzle-orm";
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

import { db } from "@/db";
import { agentMessages } from "@/db/schema";
import { ORCHESTRATOR_TOOLS, type OrchestratorContentBlock } from "@/lib/orchestrator-tools";
import { parseProviderQualifiedModel } from "@/lib/model-id";
import { assistantText, type SdkContentBlock } from "@/lib/sdk-message";
import { runTransport } from "@/lib/worker";

import type { AppendStreamEvent, MessageRow, RunRow } from "@/lib/runs";
import type { RunEnvelope } from "@/lib/pi-event-mapper";

const DEFAULT_CHAT_MODEL = process.env.TASK_ORCH_AGENT_MODEL ?? "anthropic/claude-sonnet-4-6";
const TOOL_PREFIX = "task_orch__";
const DEFAULT_MAX_TOOL_ROUNDS = 8;

let modelsInstance: ReturnType<typeof builtinModels> | null = null;

function models() {
  if (!modelsInstance) modelsInstance = builtinModels();
  return modelsInstance;
}

function maxToolRounds(): number {
  const raw = Number(process.env.TASK_ORCH_CHAT_MAX_TOOL_ROUNDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_TOOL_ROUNDS;
}

function chatTools(): Tool[] {
  return ORCHESTRATOR_TOOLS.map((tool) => ({
    name: `${TOOL_PREFIX}${tool.name}`,
    description: tool.description,
    parameters: tool.parameters,
  }));
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

function toPiContent(blocks: OrchestratorContentBlock[]) {
  return blocks.map((block) => {
    if (block.type === "text" || block.type === "image") return block;
    return { type: "text" as const, text: JSON.stringify(block) };
  });
}

interface RawMessageRow {
  id: number;
  runId: number;
  role: MessageRow["role"];
  content: SdkContentBlock[];
  createdAt: Date;
}

function parseRawMessageRow(row: typeof agentMessages.$inferSelect): RawMessageRow {
  let content: SdkContentBlock[] = [];
  try {
    const parsed = JSON.parse(row.content);
    if (Array.isArray(parsed)) content = parsed as SdkContentBlock[];
  } catch {
    content = [{ type: "text", text: row.content }];
  }
  return {
    id: row.id,
    runId: row.runId,
    role: (row.role as MessageRow["role"]) ?? "system",
    content,
    createdAt: row.createdAt,
  };
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

function fallbackAssistantMessage(run: RunRow, row: RawMessageRow): AssistantMessage {
  const { provider, id } = parseProviderQualifiedModel(run.model ?? DEFAULT_CHAT_MODEL);
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
    provider,
    model: id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: row.createdAt.getTime(),
  };
}

function fallbackToolResultMessage(row: RawMessageRow): ToolResultMessage | null {
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
    timestamp: row.createdAt.getTime(),
  };
}

async function listContextMessages(run: RunRow, currentInputText: string): Promise<Message[]> {
  const rows = (
    await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.runId, run.id))
      .orderBy(asc(agentMessages.id))
  ).map(parseRawMessageRow);
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
        timestamp: row.createdAt.getTime(),
      });
      lastUserIndex = messages.length - 1;
    } else if (row.role === "agent") {
      messages.push(fallbackAssistantMessage(run, row));
    } else if (row.role === "tool") {
      const toolResult = fallbackToolResultMessage(row);
      if (toolResult) messages.push(toolResult);
    }
  }
  if (lastUserIndex >= 0) {
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

async function persistUiMessage(
  runId: number,
  role: "agent" | "tool",
  blocks: SdkContentBlock[],
  message: AssistantMessage | ToolResultMessage
): Promise<MessageRow> {
  return (await runTransport()).appendMessage(runId, role, withPiMessage(blocks, message) as any);
}

async function annotateCurrentUserMessage(
  runId: number,
  inputText: string
): Promise<UserMessage> {
  const row = (
    await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.runId, runId))
      .orderBy(desc(agentMessages.id))
      .limit(1)
  ).map(parseRawMessageRow).find((candidate) => candidate.role === "user");
  const visibleBlocks = row?.content.length ? row.content : [{ type: "text", text: inputText }];
  const message: UserMessage = {
    role: "user",
    content: userContentFromBlocks(visibleBlocks, inputText),
    timestamp: row?.createdAt.getTime() ?? Date.now(),
  };
  const content = JSON.stringify(withPiMessage(visibleBlocks, message));
  if (row) {
    await db.update(agentMessages).set({ content }).where(eq(agentMessages.id, row.id));
  }
  return message;
}

function sdkEventFor(message: AssistantMessage | ToolResultMessage): RunEnvelope {
  if (message.role === "assistant") {
    return {
      type: "assistant",
      message: { content: toSdkBlocks(message) },
    } as RunEnvelope;
  }
  return {
    type: "user",
    message: { content: toSdkBlocks(message) },
  } as RunEnvelope;
}

async function resolveModel(rawModel: string) {
  const { provider, id } = parseProviderQualifiedModel(rawModel);
  const collection = models();
  let model = collection.getModel(provider, id);
  if (!model) {
    await collection.refresh(provider).catch(() => {});
    model = collection.getModel(provider, id);
  }
  if (!model) {
    throw new Error(
      `Model '${provider}/${id}' was not found in @earendil-works/pi-ai. ` +
        `Check the persona/run model setting.`
    );
  }
  return model;
}

async function executeToolCall(args: {
  run: RunRow;
  author: string;
  tools: Tool[];
  call: ToolCall;
}): Promise<ToolResultMessage> {
  const { run, author, tools, call } = args;
  const now = Date.now();

  try {
    const params = validateToolCall(tools, call);
    if (!call.name.startsWith(TOOL_PREFIX)) {
      throw new Error(`Unknown chat tool prefix for ${call.name}`);
    }
    const bareName = call.name.slice(TOOL_PREFIX.length);
    const result = await (await runTransport()).callTool(run.id, bareName, params, {
      author,
      defaultTaskId: run.taskId ?? undefined,
      defaultPlanId: run.planId ?? undefined,
    });
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

export interface ChatAiTurnResult {
  events: AppendStreamEvent[];
  summary: string | null;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  turns: number;
}

export async function runChatAiTurn(args: {
  run: RunRow;
  inputText: string;
  author: string;
  abort: AbortController;
}): Promise<ChatAiTurnResult> {
  const { run, inputText, author, abort } = args;
  const transport = await runTransport();
  const persona = await transport.getPersona(run.personaId ?? "implementor");
  if (!persona) {
    throw new Error(`Persona '${run.personaId ?? "implementor"}' not found; seed personas via db/seed-personas.ts.`);
  }

  await annotateCurrentUserMessage(run.id, inputText);

  const contextMessages = await listContextMessages(run, inputText);
  const tools = chatTools();
  const model = await resolveModel(run.model ?? DEFAULT_CHAT_MODEL);
  const reasoning = (run.thinkingLevel ?? persona.thinkingLevel ?? undefined) as ThinkingLevel | undefined;
  const context: Context = {
    systemPrompt: persona.systemPrompt,
    messages: contextMessages,
    tools,
  };

  const events: AppendStreamEvent[] = [];
  let summary: string | null = null;
  let totalCostUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawCost = false;
  let turns = 0;

  for (let round = 0; round < maxToolRounds(); round += 1) {
    if (abort.signal.aborted) throw new Error("Turn aborted");
    const assistant = await models().completeSimple(model, context, {
      reasoning,
      signal: abort.signal,
      sessionId: `task-orch-chat-${run.id}`,
    });
    turns += 1;
    context.messages.push(assistant);

    const assistantBlocks = toSdkBlocks(assistant);
    const persisted = await persistUiMessage(run.id, "agent", assistantBlocks, assistant);
    const env = sdkEventFor(assistant);
    events.push({ type: "sdk", sdk: env, message: persisted });

    summary = textFromAssistant(assistant) ?? summary;
    inputTokens += assistant.usage?.input ?? 0;
    outputTokens += assistant.usage?.output ?? 0;
    if (assistant.usage?.cost?.total != null) {
      totalCostUsd += assistant.usage.cost.total;
      sawCost = true;
    }

    if (assistant.stopReason === "error") {
      throw new Error(assistant.errorMessage ?? "pi-ai chat completion failed");
    }
    if (assistant.stopReason === "aborted") {
      throw new Error("Turn aborted");
    }

    const calls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
    if (calls.length === 0) {
      return {
        events,
        summary,
        totalCostUsd: sawCost ? totalCostUsd : null,
        inputTokens,
        outputTokens,
        turns,
      };
    }

    for (const call of calls) {
      if (abort.signal.aborted) throw new Error("Turn aborted");
      const toolResult = await executeToolCall({ run, author, tools, call });
      context.messages.push(toolResult);
      const blocks = toSdkBlocks(toolResult);
      const persisted = await persistUiMessage(run.id, "tool", blocks, toolResult);
      events.push({ type: "sdk", sdk: sdkEventFor(toolResult), message: persisted });
    }
  }

  throw new Error(`Chat exceeded ${maxToolRounds()} tool rounds`);
}
