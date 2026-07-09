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
//   - auth                → inherited from the env, resolved like Claude Code:
//                          ANTHROPIC_API_KEY when set, else the claude.ai
//                          subscription (`claude login` / CLAUDE_CODE_OAUTH_TOKEN).
// The Claude SDK (and its native bits) is dynamically imported so it never loads
// under the pi backend.

import { randomUUID } from "node:crypto";
import { mapClaudeMessage } from "./claude-event-mapper";
import { collectExtensions, composeSystemPrompt, runInterceptors } from "./collect";
import { createUsageAccumulator } from "./usage";
import { toZodRawShape } from "./typebox-to-zod";
import { interceptorToolName, isFileTool } from "../builtin-tools";
import { scrubClaudeCliEnv } from "./env-scrub";
import type { AgentBackend, RunTurnArgs, TurnOutcome } from "./types";
import type { RunEnvelope } from "../pi-event-mapper";

const TAG = "claude:";
const MCP_SERVER_NAME = "task_orch";

/** The CLI's error when a `--resume <id>` transcript isn't on this machine's
 *  disk. Surfaced by the SDK as a thrown stream error ("Claude Code returned an
 *  error result: No conversation found with session ID: <id>"). */
const RESUME_LOST_RE = /No conversation found with session ID/i;

const RESUME_LOST_NOTE =
  "Context recovery: this run's previous session transcript is no longer available " +
  "(its storage was recycled or the run moved machines), so this is a fresh session. " +
  "Prior conversation history is NOT in your context — re-derive the current state from " +
  "the prompt, the repository/checkout, and any recorded notes, tasks, or PRs before acting.";

/** Claude names the built-in tools TitleCase (`Read`/`Write`/`Grep`/`Glob`/…) and
 *  passes file paths as `file_path`; pi (and the canonical interceptor seam) use
 *  lowercase names and `path`. Normalize to the shared vocabulary before
 *  interceptors run, and de-normalize file mutations on the way back.
 *
 *  Tools registered on the in-process MCP server are additionally exposed to the
 *  model (and to PreToolUse hooks) under the SDK-namespaced name
 *  `mcp__<server>__<tool>` — e.g. `mcp__task_orch__task_orch__create_task` and
 *  `mcp__task_orch__propose_spec`. Interceptors (the planning stage gates, etc.)
 *  key on the neutral names, so strip that prefix for MATCHING only. The SDK
 *  still dispatches the tool by its original name; we never rename the call. */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

function stripMcpPrefix(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

function normalizeToolCall(name: string, input: Record<string, any>): { toolName: string; input: Record<string, any> } {
  const neutralName = stripMcpPrefix(name);
  const toolName = interceptorToolName(neutralName);
  if (isFileTool(neutralName)) {
    // NotebookEdit passes `notebook_path` (mapped to canonical Edit); Read/Write/
    // Edit pass `file_path`. Surface whichever is present as `path` so the
    // sandbox containment check (which bails on a non-string path) always runs.
    return { toolName, input: { ...input, path: input.file_path ?? input.notebook_path ?? input.path } };
  }
  return { toolName, input };
}

function denormalizeToolInput(name: string, original: Record<string, any>, canonical: Record<string, any>): Record<string, any> {
  if (isFileTool(stripMcpPrefix(name))) {
    const { path, ...rest } = canonical;
    // Write the (possibly mutated) path back to whichever key the SDK sent so the
    // tool still executes with its native shape: NotebookEdit→notebook_path,
    // Read/Write/Edit→file_path.
    if ("file_path" in original) return { ...rest, file_path: path ?? original.file_path };
    if ("notebook_path" in original) return { ...rest, notebook_path: path ?? original.notebook_path };
    if ("path" in original) return { ...rest, path: path ?? original.path };
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

    // Postgres mode (the lightweight in-process loop) is a pi-only capability:
    // it drives @earendil-works/pi-ai directly, which the Claude Agent SDK has no
    // equivalent for. A lightweight-shaped run is always pi-backed (the placement
    // predicates require backend pi/null), so this only fires as a guard against a
    // future miswiring — fail loud rather than silently ignoring the request.
    if (args.contextSource?.kind === "postgres") {
      throw new Error(
        "The Claude agent backend does not support contextSource='postgres' " +
          "(the postgres/lightweight loop is pi-only). Use the pi backend for lightweight runs."
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

    let resume = claudeResumeId(args.resumeToken);

    // Auth is inherited from the environment, resolved like the Claude Code CLI:
    // ANTHROPIC_API_KEY when set, otherwise the claude.ai subscription (stored
    // OAuth from `claude login`, or CLAUDE_CODE_OAUTH_TOKEN). The SDK's `env`
    // REPLACES the subprocess environment (no merge), so spread process.env to
    // keep PATH/HOME/the key/etc., then layer any caller-supplied env, then
    // scrub: the CLI process (and everything it spawns outside a bash tool
    // call, which the env-scrub extension already covers) has no legitimate
    // need for DATABASE_URL or non-Anthropic provider credentials — only its
    // own Anthropic/Claude auth vars. Applied AFTER the spread so a caller-
    // supplied args.env entry is respected but still subject to the scrub.
    const sdkEnv: Record<string, string | undefined> = scrubClaudeCliEnv({
      ...process.env,
      ...args.env,
    });

    const envelopes: RunEnvelope[] = [];
    let usage = createUsageAccumulator();
    let summary: string | null = null;
    let lastAssistantText: string | null = null;
    let turns = 0;
    let sessionId: string | null = null;

    // One attempt with the stored resume id, plus at most one fresh-session
    // retry when that id's transcript is missing (RESUME_LOST_RE below). The
    // transcript lives on whichever filesystem ran the previous turn
    // (~/.claude under the worker's HOME); a run can legally land on a machine
    // that doesn't have it — its volume was destroyed and recreated, or earlier
    // turns ran in-process/inline in a different container. The CLI then exits
    // with "No conversation found with session ID: <id>", which must degrade to
    // a fresh session (context loss, flagged to the model) rather than fail the
    // turn: the dispatch layer replays the unanswered user-message backlog as
    // the prompt, so the fresh session still receives the actual instruction.
    for (let attempt = 0; ; attempt++) {
      envelopes.length = 0;
      usage = createUsageAccumulator();
      summary = null;
      lastAssistantText = null;
      turns = 0;
      sessionId = null;

      // On the fresh-session retry, tell the model its history is gone so it
      // re-derives state instead of assuming context it no longer has.
      const appendWithNote =
        attempt > 0 ? [append, RESUME_LOST_NOTE].filter(Boolean).join("\n\n") : append;

      const stream = query({
        prompt,
        options: {
          cwd,
          model: model.id,
          // Persona thinkingLevel maps 1:1 onto the SDK's effort levels
          // ('low' | 'medium' | 'high'); omitted lets the model default apply.
          ...(thinkingLevel ? { effort: thinkingLevel } : {}),
          permissionMode: "bypassPermissions",
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            ...(appendWithNote ? { append: appendWithNote } : {}),
          },
          mcpServers: { [MCP_SERVER_NAME]: server },
          // Use ONLY our in-process orchestrator server. Without this, the
          // claude_code preset also loads MCP servers from the ambient Claude
          // config (~/.claude.json project entries, project .mcp.json, plugins).
          // A user who has a "task-orchestrator" server pointed at a *remote*
          // deployment there would have the agent write plans/tasks to that
          // remote DB — the run reports success but nothing appears in this
          // instance. strictMcpConfig isolates the run to the tools we pass.
          strictMcpConfig: true,
          ...(preToolUse ? { hooks: { PreToolUse: preToolUse } } : {}),
          abortController: abort,
          includePartialMessages: true,
          ...(resume ? { resume } : {}),
          env: sdkEnv,
        } as any,
      });

      try {
        for await (const msg of stream) {
          if (abort.signal.aborted) break;
          if (msg.type === "result") {
            turns = (msg as any).num_turns ?? turns;
            // The result envelope also carries the session id; capture it so a
            // resumed query (which may emit no fresh system/init) still yields a
            // resume token instead of silently dropping multi-turn continuity.
            if ((msg as any).session_id) sessionId = (msg as any).session_id;
          }
          if (msg.type === "system" && (msg as any).subtype === "init" && (msg as any).session_id) {
            sessionId = (msg as any).session_id;
          }

          for (const env of mapClaudeMessage(msg)) {
            if (env.type === "system" && env.subtype === "init" && env.session_id) {
              env.session_id = `${TAG}${env.session_id}`;
            }
            envelopes.push(env);
            await onEvent(env);

            if (env.type === "assistant" && env.message?.content) {
              const text = env.message.content
                .filter((b: any) => b.type === "text" && typeof b.text === "string")
                .map((b: any) => b.text)
                .join("\n").trim();
              if (text) lastAssistantText = text;
            }
            if (env.type === "result") {
              if (!env.is_error && typeof env.result === "string") summary = env.result.trim() || null;
              usage.observeResult({
                inputTokens: env.usage?.input_tokens,
                outputTokens: env.usage?.output_tokens,
                totalCostUsd: env.total_cost_usd,
              });
            }
          }
        }
      } catch (err) {
        if (
          attempt === 0 &&
          resume &&
          !abort.signal.aborted &&
          err instanceof Error &&
          RESUME_LOST_RE.test(err.message)
        ) {
          console.error(
            `[ClaudeBackend] resume transcript for session ${resume} not found on this machine; retrying with a fresh session`
          );
          resume = undefined;
          continue;
        }
        throw err;
      }
      break;
    }

    // If the loop exited because of an abort (rather than the SDK throwing),
    // surface it as a thrown error so lib/runs.ts treats the turn as a clean
    // cancel instead of overwriting the `cancelled` status with `completed`.
    if (abort.signal.aborted) {
      throw new Error("Turn aborted");
    }

    const totals = usage.totals();
    return {
      envelopes,
      summary: summary ?? lastAssistantText,
      resumeToken: sessionId ? `${TAG}${sessionId}` : args.resumeToken,
      totalCostUsd: totals.totalCostUsd,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
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
          { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
          { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
          { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
        ],
      },
    ];
  }
}
