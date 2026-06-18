// lib/agent-backend/index.ts
//
// Backend selection. TASK_ORCH_AGENT_BACKEND picks the active agent SDK adapter
// (default "pi"). The chosen backend module is dynamically imported so the
// unused SDK — and its native bits — never load.

import type { AgentBackend, BackendId } from "./types";

export * from "./types";

let cached: AgentBackend | null = null;

export function resolveBackendId(raw = process.env.TASK_ORCH_AGENT_BACKEND): BackendId {
  const id = (raw ?? "pi").trim().toLowerCase();
  if (id === "pi" || id === "claude") return id;
  throw new Error(
    `Unknown TASK_ORCH_AGENT_BACKEND='${raw}'. Expected 'pi' or 'claude'.`
  );
}

export async function getBackend(): Promise<AgentBackend> {
  if (cached) return cached;
  const id = resolveBackendId();
  if (id === "claude") {
    const { ClaudeBackend } = await import("./claude-backend");
    cached = new ClaudeBackend();
  } else {
    const { PiBackend } = await import("./pi-backend");
    cached = new PiBackend();
  }
  return cached;
}

/** Clear the cached backend (test-only — lets a test flip the env var). */
export function resetBackendCache(): void {
  cached = null;
}
