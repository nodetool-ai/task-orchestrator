// lib/chat-ai-loop.ts
//
// The lightweight pi-ai turn loop: an in-process replacement for runOneTurn
// that drives @earendil-works/pi-ai's models().completeSimple() directly,
// loading conversation context from Postgres and persisting each envelope as
// it streams. No SDK session files, no Claude/pi backend harness, no worker
// container — just the model + the orchestrator's server-side tool registry.
//
// Two run goals route through here today (see isLightweightPiChatRun /
// isLightweightPiExecutorRun in lib/runs.ts):
//   • <chat>   — ad-hoc assistant turns. Tools: orchestrator surface only.
//   • <execute> — the plan executor. Tools: orchestrator + spawn + the
//                 always-on event tools (timer__sleep, report_result, …) it
//                 needs to drive its wake/park loop.
// The loop body is identical for both; toolsForRun(run) picks the surface.

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
import {
  ORCHESTRATOR_TOOLS,
  type OrchestratorContentBlock,
  type OrchestratorTool,
} from "@/lib/orchestrator-tools";
import { parseProviderQualifiedModel } from "@/lib/model-id";
import { assistantText, type SdkContentBlock } from "@/lib/sdk-message";
import { runTransport } from "@/lib/worker";

import type { AppendStreamEvent, MessageRow, RunRow } from "@/lib/runs";
import type { RunEnvelope } from "@/lib/pi-event-mapper";

const DEFAULT_CHAT_MODEL = process.env.TASK_ORCH_AGENT_MODEL ?? "anthropic/claude-sonnet-4-6";
const TOOL_PREFIX = "task_orch__";
const DEFAULT_CHAT_MAX_TOOL_ROUNDS = 8;
// The executor drives a multi-step orchestration loop per wake (re-scan tasks,
// start N children, arm watchdog, park) and routinely needs more rounds than a
// chat turn. The watchdog parking tools keep a single wake bounded, but give it
// real headroom so it never has to mid-turn truncate a scan/start/park sequence.
const DEFAULT_EXECUTOR_MAX_TOOL_ROUNDS = 30;

let modelsInstance: ReturnType<typeof builtinModels> | null = null;

function models() {
  if (!modelsInstance) modelsInstance = builtinModels();
  return modelsInstance;
}

function maxToolRounds(run: RunRow): number {
  const isExecutor = run.goal === "<execute>";
  const envVar = isExecutor
    ? "TASK_ORCH_EXECUTOR_MAX_TOOL_ROUNDS"
    : "TASK_ORCH_CHAT_MAX_TOOL_ROUNDS";
  const fallback = isExecutor
    ? DEFAULT_EXECUTOR_MAX_TOOL_ROUNDS
    : DEFAULT_CHAT_MAX_TOOL_ROUNDS;
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** One tool the lightweight loop exposes to the model: the name the model sees
 *  (`modelName`) and the bare registry name we dispatch to via the transport
 *  (`registryName`). Orchestrator tools carry a `task_orch__` prefix on the wire
 *  but a bare name in the registry; events/spawn/planning tools are stored under
 *  the same prefixed name in both places. */
interface LightweightToolEntry {
  tool: Tool;
  registryName: string;
}

async function toolsForRun(run: RunRow): Promise<LightweightToolEntry[]> {
  const categories: OrchestratorTool[] = [...ORCHESTRATOR_TOOLS];
  // The plan executor also needs the always-on event tools (timer__sleep,
  // report_result, raise, ask_parent, answer_question, events__poll) to drive
  // its wake/park loop, plus the spawn tools (spawn__get_run,
  // spawn__append_message) for nudging children. Planning is unused at execute
  // time. Chat stays orchestrator-only — its turns are short and synchronous.
  if (run.goal === "<execute>") {
    const [events, spawn] = await Promise.all([
      import("./extensions/events"),
      import("./extensions/spawn"),
    ]);
    categories.push(...events.EVENT_TOOLS, ...spawn.SPAWN_TOOLS);
  }
  return categories.map((tool) => {
    const isOrchestrator = !tool.name.includes("__");
    const modelName = isOrchestrator ? `${TOOL_PREFIX}${tool.name}` : tool.name;
    return {
      tool: {
        name: modelName,
        description: tool.description,
        parameters: tool.parameters,
      },
      registryName: tool.name,
    };
  });
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
  dispatch: Map<string, string>;
  call: ToolCall;
}): Promise<ToolResultMessage> {
  const { run, author, tools, dispatch, call } = args;
  const now = Date.now();

  try {
    const params = validateToolCall(tools, call);
    const registryName = dispatch.get(call.name);
    if (!registryName) {
      throw new Error(`Unknown lightweight tool: ${call.name}`);
    }
    const result = await (await runTransport()).callTool(run.id, registryName, params, {
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
  const entries = await toolsForRun(run);
  const tools = entries.map((entry) => entry.tool);
  const dispatch = new Map(entries.map((entry) => [entry.tool.name, entry.registryName]));
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

  for (let round = 0; round < maxToolRounds(run); round += 1) {
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
      const toolResult = await executeToolCall({ run, author, tools, dispatch, call });
      context.messages.push(toolResult);
      const blocks = toSdkBlocks(toolResult);
      const persisted = await persistUiMessage(run.id, "tool", blocks, toolResult);
      events.push({ type: "sdk", sdk: sdkEventFor(toolResult), message: persisted });
    }
  }

  throw new Error(`Lightweight turn exceeded ${maxToolRounds(run)} tool rounds`);
}
