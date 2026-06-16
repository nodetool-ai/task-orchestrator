// lib/agent-backend/claude-backend.ts
//
// Claude Agent SDK adapter. Maps the neutral RunTurnArgs onto query():
//   - registered tools  → an in-process MCP server (createSdkMcpServer/tool),
//                          schemas converted TypeBox → Zod raw shape.
//   - system-prompt fns  → composed and appended to the claude_code preset.
//   - ambient skills      → appended to the system prompt (Claude's on-disk skill
//                          mechanism is heavier; injection gives cross-backend parity).
//   - tool-call interceptors → a PreToolUse hook (deny / updatedInput).
//   - abort wiring        → query's native abortController.
// The Claude SDK (and its native bits) is dynamically imported so it never loads
// under the pi backend.

import { randomUUID } from "node:crypto";
import { mapClaudeMessage } from "./claude-event-mapper";
import { collectExtensions, composeSystemPrompt, runInterceptors } from "./collect";
import { toZodRawShape } from "./typebox-to-zod";
import type { AgentBackend, RunTurnArgs, TurnOutcome } from "./types";
import type { RunEnvelope } from "../pi-event-mapper";

const TAG = "claude:";
const MCP_SERVER_NAME = "task_orch";

/** pi `write`/`edit`/`bash` (path/command) vs Claude `Write`/`Edit`/`Bash`
 *  (file_path/command). Normalize to the canonical vocabulary the sandbox
 *  interceptor expects, and de-normalize mutations on the way back. */
const NAME_MAP: Record<string, string> = { Write: "write", Edit: "edit", Bash: "bash" };

function normalizeToolCall(name: string, input: Record<string, any>): { toolName: string; input: Record<string, any> } {
  const toolName = NAME_MAP[name] ?? name;
  if (toolName === "write" || toolName === "edit") {
    return { toolName, input: { ...input, path: input.file_path ?? input.path } };
  }
  return { toolName, input };
}

function denormalizeToolInput(name: string, original: Record<string, any>, canonical: Record<string, any>): Record<string, any> {
  const toolName = NAME_MAP[name] ?? name;
  if (toolName === "write" || toolName === "edit") {
    const { path, ...rest } = canonical;
    return { ...rest, file_path: path ?? original.file_path };
  }
  return canonical;
}

// Exported for unit tests of the built-in tool vocabulary translation.
export const __test = { normalizeToolCall, denormalizeToolInput };

function claudeResumeId(token: string | null): string | undefined {
  if (token && token.startsWith(TAG)) return token.slice(TAG.length);
  return undefined; // foreign/none → fresh session
}

export class ClaudeBackend implements AgentBackend {
  readonly id = "claude" as const;

  async runTurn(args: RunTurnArgs): Promise<TurnOutcome> {
    const { cwd, model, thinkingLevel, extensions, abort, prompt, onEvent } = args;

    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is required for the Claude agent backend " +
          "(TASK_ORCH_AGENT_BACKEND=claude). Set it or switch the backend to 'pi'."
      );
    }

    // The Claude backend speaks only to Anthropic. Fail early with an actionable
    // message rather than letting a non-Anthropic provider reach the SDK and
    // surface a more opaque error downstream.
    if (model.provider && model.provider !== "anthropic") {
      throw new Error(
        `The Claude agent backend only supports the 'anthropic' provider, but the ` +
          `persona is configured with provider '${model.provider}' (model '${model.id}'). ` +
          `Switch the persona to an Anthropic model or set TASK_ORCH_AGENT_BACKEND=pi.`
      );
    }

    const collected = await collectExtensions(extensions);
    const { query, tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");

    // Tools → in-process MCP server.
    const mcpTools = collected.tools.map((t) =>
      tool(
        t.name,
        t.description,
        toZodRawShape(t.parameters),
        async (a: any) => {
          const r = await t.execute(randomUUID(), a);
          return { content: r.content as any, isError: r.isError };
        }
      )
    );
    const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: mcpTools });

    // System prompt: persona transforms + ambient skills, appended to the preset.
    const parts: string[] = [];
    const persona = (await composeSystemPrompt("", collected.systemPromptFns)).trim();
    if (persona) parts.push(persona);
    for (const s of collected.skills) parts.push(`# ${s.name}\n${s.description}\n\n${s.body}`);
    const append = parts.join("\n\n");

    // Tool-call interceptors → PreToolUse hook.
    const preToolUse = collected.interceptors.length > 0
      ? [{
          hooks: [async (input: any) => {
            const norm = normalizeToolCall(input.tool_name, (input.tool_input as Record<string, any>) ?? {});
            const decision = await runInterceptors(collected.interceptors, norm.toolName, norm.input);
            if (!decision) return {};
            if ("block" in decision) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: decision.reason,
                },
              };
            }
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "allow" as const,
                updatedInput: denormalizeToolInput(input.tool_name, (input.tool_input as Record<string, any>) ?? {}, decision.input),
              },
            };
          }],
        }]
      : undefined;

    // Abort wiring: query takes the AbortController natively; also drive any
    // onAgentStart hooks (abort-bridge) so they observe the same controller.
    for (const fn of collected.agentStartFns) fn({ abort: () => abort.abort() });

    const resume = claudeResumeId(args.resumeToken);

    const envelopes: RunEnvelope[] = [];
    let summary: string | null = null;
    let lastAssistantText: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let totalCostUsd: number | null = null;
    let turns = 0;
    let sessionId: string | null = null;

    const stream = query({
      prompt,
      options: {
        cwd,
        model: model.id,
        // Persona thinkingLevel maps 1:1 onto the SDK's effort levels
        // ('low' | 'medium' | 'high'); omitted lets the model default apply.
        ...(thinkingLevel ? { effort: thinkingLevel } : {}),
        permissionMode: "bypassPermissions",
        systemPrompt: { type: "preset", preset: "claude_code", ...(append ? { append } : {}) },
        mcpServers: { [MCP_SERVER_NAME]: server },
        ...(preToolUse ? { hooks: { PreToolUse: preToolUse } } : {}),
        abortController: abort,
        includePartialMessages: true,
        ...(resume ? { resume } : {}),
        ...(args.env ? { env: args.env } : {}),
      } as any,
    });

    for await (const msg of stream) {
      if (abort.signal.aborted) break;
      if (msg.type === "result") turns = (msg as any).num_turns ?? turns;
      if (msg.type === "system" && (msg as any).subtype === "init" && (msg as any).session_id) {
        sessionId = (msg as any).session_id;
      }

      for (const env of mapClaudeMessage(msg)) {
        if (env.type === "system" && env.subtype === "init" && env.session_id) {
          env.session_id = `${TAG}${env.session_id}`;
        }
        envelopes.push(env);
        onEvent(env);

        if (env.type === "assistant" && env.message?.content) {
          const text = env.message.content
            .filter((b: any) => b.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("\n").trim();
          if (text) lastAssistantText = text;
        }
        if (env.type === "result") {
          if (!env.is_error && typeof env.result === "string") summary = env.result.trim() || null;
          inputTokens = env.usage?.input_tokens ?? inputTokens;
          outputTokens = env.usage?.output_tokens ?? outputTokens;
          totalCostUsd = env.total_cost_usd ?? totalCostUsd;
        }
      }
    }

    return {
      envelopes,
      summary: summary ?? lastAssistantText,
      resumeToken: sessionId ? `${TAG}${sessionId}` : args.resumeToken,
      totalCostUsd,
      inputTokens,
      outputTokens,
      turns,
    };
  }

  listProviders() {
    // The Claude backend speaks only to Anthropic. Mirror the catalog shape the
    // persona editor expects. Kept in sync with the recommended Claude models.
    return [
      {
        id: "anthropic",
        models: [
          { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
          { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
          { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
        ],
      },
    ];
  }
}
