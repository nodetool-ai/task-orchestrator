// lib/agent-backend/index.ts
//
// Backend selection. A run picks its adapter per-run (agent_runs.backend);
// callers without a run-level choice fall back to TASK_ORCH_AGENT_BACKEND
// (default "pi"). Backend modules are dynamically imported and cached per id
// so an unused SDK — and its native bits — never loads.

import { config } from "../config";
import type { AgentBackend, BackendId } from "./types";

export * from "./types";

const cached = new Map<BackendId, AgentBackend>();

export const BACKEND_IDS: readonly BackendId[] = ["pi", "claude", "codex"];

/** Normalize + validate a backend id. `raw` may be a per-run value; when
 *  null/undefined the deployment default (TASK_ORCH_AGENT_BACKEND) applies. */
export function resolveBackendId(
  raw: string | null | undefined = config.agent.backend
): BackendId {
  const id = (raw ?? config.agent.backend ?? "pi").trim().toLowerCase();
  if (id === "pi" || id === "claude" || id === "codex") return id;
  throw new Error(
    `Unknown agent backend '${raw}'. Expected one of ${BACKEND_IDS.join(", ")}.`
  );
}

/** The adapter for `id`; omitted/null falls back to the deployment default. */
export async function getBackend(id?: string | null): Promise<AgentBackend> {
  const resolved = resolveBackendId(id);
  const hit = cached.get(resolved);
  if (hit) return hit;
  let backend: AgentBackend;
  if (resolved === "claude") {
    const { ClaudeBackend } = await import("./claude-backend");
    backend = new ClaudeBackend();
  } else if (resolved === "codex") {
    const { CodexBackend } = await import("./codex-backend");
    backend = new CodexBackend();
  } else {
    const { PiBackend } = await import("./pi-backend");
    backend = new PiBackend();
  }
  cached.set(resolved, backend);
  return backend;
}

/** Clear the cached backends (test-only — lets a test flip the env var). */
export function resetBackendCache(): void {
  cached.clear();
}
