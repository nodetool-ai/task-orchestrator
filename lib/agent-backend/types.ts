// lib/agent-backend/types.ts
//
// Neutral agent-backend interface. The task-orchestrator drives an agent SDK
// through this seam so the concrete SDK (pi-coding-agent or the Claude Agent
// SDK) can be swapped via the TASK_ORCH_AGENT_BACKEND env var.
//
// The surface here is deliberately the *intersection* of what the extensions in
// lib/extensions/*.ts actually use against an SDK: register tools, transform the
// system prompt, intercept tool calls (block/mutate), react to agent start
// (abort wiring), and contribute an ambient "skill" (cross-session memory).

import type { TSchema } from "typebox";
import type { RunEnvelope } from "../pi-event-mapper";
import type { CanonicalTool } from "../builtin-tools";

/** A content block a tool may return (text | image | …). Permissive on purpose. */
export type ContentBlock = { type: string; [k: string]: unknown };

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  details?: unknown;
}

/** A backend-neutral tool definition. `parameters` is a TypeBox schema, which
 *  is JSON-Schema-shaped — the shared currency across the whole app (see
 *  app/api/mcp/route.ts, which feeds the same schemas to an MCP inputSchema). */
export interface NeutralTool {
  /** Flat, already-prefixed name, e.g. "task_orch__create_task". */
  name: string;
  label?: string;
  description: string;
  parameters: TSchema;
  execute: (callId: string, params: any) => Promise<ToolResult>;
}

/**
 * Canonical tool-call event handed to interceptors. Built-in tool identities
 * are normalized by each adapter to this vocabulary BEFORE interceptors run:
 *   - write / edit  → input.path
 *   - bash          → input.command
 * (pi already uses these names; the Claude adapter maps Write/Edit/Bash and
 *  file_path → path.)
 */
export interface ToolCallEvent {
  toolName: string;
  input: Record<string, any>;
}

/** Interceptor result: allow (void), deny (block), or replace input (mutate). */
export type ToolCallDecision =
  | void
  | { block: true; reason: string }
  | { input: Record<string, any> };

export type ToolCallInterceptor = (
  ev: ToolCallEvent
) => ToolCallDecision | Promise<ToolCallDecision>;

/** An ambient skill (model-discoverable note). pi writes it to .pi/skills/; the
 *  Claude adapter folds it into the system prompt. */
export interface AmbientSkill {
  name: string;
  description: string;
  body: string;
}

/** The neutral API an extension registers against — the replacement for pi's
 *  ExtensionAPI. */
export interface BackendRegistrar {
  registerTool(tool: NeutralTool): void;
  transformSystemPrompt(fn: (base: string) => string | Promise<string>): void;
  interceptToolCall(fn: ToolCallInterceptor): void;
  onAgentStart(fn: (ctx: { abort: () => void }) => void): void;
  addAmbientSkill(skill: AmbientSkill): void;
}

/** An extension is a function that registers capabilities against a backend. */
export type Extension = (reg: BackendRegistrar) => void | Promise<void>;

export interface RunTurnArgs {
  cwd: string;
  model: { provider: string; id: string };
  thinkingLevel?: "low" | "medium" | "high" | "xhigh";
  extensions: Extension[];
  /** Backend-tagged resume token from a prior turn ("pi:<path>" / "claude:<id>"),
   *  or null for a fresh session. An adapter ignores a token that isn't its own. */
  resumeToken: string | null;
  abort: AbortController;
  prompt: string;
  /** Extra env for tool subprocesses (optional; the sandbox bash hook also
   *  injects TASK_ORCH_DB, so this is belt-and-suspenders). */
  env?: Record<string, string>;
  /** Built-in tools to withhold from the agent this turn (fs/shell family for
   *  cwd=none runs; the mutating file tools for read-only checkouts). Canonical
   *  names; each backend maps them to its own vocabulary. */
  disallowedBuiltins?: CanonicalTool[];
  /** Called for every mapped RunEnvelope as the turn streams. May be async (it
   *  persists the envelope to the DB); backends MUST await it so per-envelope
   *  persistence stays in stream order. */
  onEvent: (env: RunEnvelope) => void | Promise<void>;
}

export interface TurnOutcome {
  envelopes: RunEnvelope[];
  summary: string | null;
  /** Backend-tagged resume token to persist for the next turn. */
  resumeToken: string | null;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  turns: number;
}

export type BackendId = "pi" | "claude";

export interface AgentBackend {
  readonly id: BackendId;
  runTurn(args: RunTurnArgs): Promise<TurnOutcome>;
  /** Provider/model catalog for the persona editor (GET /api/providers). */
  listProviders(): Array<{ id: string; models: Array<{ id: string; name: string }> }>;
}
