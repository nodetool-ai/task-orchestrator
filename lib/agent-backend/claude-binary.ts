// lib/agent-backend/claude-binary.ts
//
// Resolution of the external Claude Code executable (spec:
// docs/superpowers/specs/2026-07-18-standalone-worker-bundle-design.md §1).
// Explicit-only: TASK_ORCH_CLAUDE_BINARY set → validate and use it; unset →
// undefined, and the SDK falls back to its bundled platform binary. There is
// deliberately NO PATH auto-detection — probing would silently pair an
// arbitrary locally-installed CLI with the SDK on every dev machine.

import { accessSync, constants, statSync } from "node:fs";
import { config } from "../config";

export function resolveClaudeBinary(): string | undefined {
  const path = config.agent.claudeBinary;
  if (!path) return undefined;
  try {
    if (!statSync(path).isFile()) throw new Error("not a regular file");
    accessSync(path, constants.X_OK);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `TASK_ORCH_CLAUDE_BINARY points at '${path}', which is missing or not executable (${reason}). ` +
        `Unset it to use the Claude Agent SDK's bundled binary, or point it at a working Claude Code executable.`
    );
  }
  return path;
}
