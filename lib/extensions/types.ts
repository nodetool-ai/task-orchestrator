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
