// lib/extensions/types.ts
//
// Shared types for pi extensions used by the task-orchestrator runner.
// ExtensionFactory is re-exported from the pi-coding-agent SDK so downstream
// modules don't import directly from the SDK.

import type { ExtensionFactory as PiExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { RunRow } from "../runs";

export type ExtensionFactory = PiExtensionFactory;

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
  /** Resolved cwd for the SDK turn — extensions that shell out use this. */
  cwd: string;
}
