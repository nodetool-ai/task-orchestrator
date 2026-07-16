// lib/extensions/types.ts
//
// Shared types for the task-orchestrator extensions. ExtensionFactory is the
// backend-neutral Extension type (lib/agent-backend), so extensions register
// against a BackendRegistrar rather than a concrete SDK's API. Each backend
// adapter translates the registrar calls to its SDK.

import type { Extension, BackendRegistrar } from "../agent-backend/types";
import type { RunRow } from "../runs";

export type ExtensionFactory = Extension;
export type { BackendRegistrar };

/** A content block a tool may return (text or an inline image). */
export type InvokerContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Normalized tool result an invoker resolves to. */
export interface InvokerToolResult {
  content: InvokerContentBlock[];
  isError?: boolean;
}

/**
 * The single seam every orchestrator-backed extension uses to run a tool
 * (plan section 15). It hides HOW the tool executes:
 *   - worker (ws) path: `session.invokeTool` sends `tool.invoke` over the channel
 *     and the control plane runs the tool through lib/worker/server-tools.ts;
 *   - legacy in-process/HTTP path: the run transport resolves the same registry.
 * The extension never imports a transport or a session directly — the caller
 * (lib/worker-runtime/tools.ts for ws, lib/profiles.ts for legacy) supplies the
 * invoker. Scope (author/task/plan) is baked in by the caller; on the ws path
 * the control plane derives it from the channel and the worker cannot override
 * it.
 */
export type ToolInvoker = (tool: string, params: unknown) => Promise<InvokerToolResult>;

/**
 * Per-turn context passed to each profile's extension factory builder.
 * Matches the shape of the old McpServerFactory's ProfileContext so the
 * profile-resolution code can be ported with minimal changes.
 */
export interface ProfileContext {
  runId: number;
  run: RunRow;
  /** Author label for any orchestrator-side mutations the agent makes. */
  author: string;
  /** Optional task scoping for the orchestrator extension. */
  taskId: string | null;
  /** Optional plan scoping for chat-with-a-plan runs. */
  planId: string | null;
  /** Resolved cwd for the SDK turn — extensions that shell out use this. */
  cwd: string;
}
