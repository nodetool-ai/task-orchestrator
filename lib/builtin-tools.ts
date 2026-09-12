// lib/builtin-tools.ts
//
// Single source of truth for the built-in file / search / shell tools the agent
// harnesses ship. The SDKs name the same capabilities differently:
//
//   pi      read  write  edit  bash  grep  find  ls          (lowercase)
//   Claude  Read  Write  Edit  Bash  Grep  Glob  (no LS)     (TitleCase)
//   Codex   spawn_agent + the rest of the multi-agent family (snake_case)
//
// Sub-agent spawning is part of that vocabulary: canonical `Agent` covers
// Claude's `Agent` (and its legacy `Task` spelling) and Codex's `spawn_agent`
// (and the v1-namespaced form). lib/subagent-tools.ts is the per-harness table
// behind those names; this module is where either spelling collapses to one
// identity for the UI and the interceptor seam. pi has no sub-agent built-in.
//
// Without a shared vocabulary the UI rendered pi's lowercase tools as anonymous
// wrenches (so grep/glob looked unused), and the neutral interceptor seam only
// recognized write/edit/bash. This module lets the UI render either backend's
// tools identically and lets interceptors key on one vocabulary regardless of
// which harness produced the call.

export type CanonicalTool =
  | "Read"
  | "Write"
  | "Edit"
  | "Bash"
  | "Grep"
  | "Glob"
  | "LS"
  | "WebFetch"
  | "WebSearch"
  | "TodoWrite"
  | "Agent";

// Every raw tool name we recognize (compared lowercased), mapped to its canonical
// identity. Covers pi names, Claude names, and common variants of each.
const RAW_TO_CANONICAL: Record<string, CanonicalTool> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "Edit",
  notebookedit: "Edit",
  bash: "Bash",
  bashoutput: "Bash",
  grep: "Grep",
  ripgrep: "Grep",
  rg: "Grep",
  glob: "Glob",
  find: "Glob",
  fd: "Glob",
  ls: "LS",
  tree: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  // Sub-agent spawning, every harness spelling (lib/subagent-tools.ts).
  agent: "Agent",
  task: "Agent",
  spawn_agent: "Agent",
  "multi_agent_v1.spawn_agent": "Agent",
};

/** Resolve any harness's raw tool name to its canonical identity, or null when
 *  it isn't a built-in we recognize (MCP / orchestrator tools return null). */
export function canonicalToolName(raw: string | undefined | null): CanonicalTool | null {
  if (!raw) return null;
  return RAW_TO_CANONICAL[raw.toLowerCase()] ?? null;
}

/**
 * Human-readable label for any tool name. Built-ins keep their clean canonical
 * name (Read / Write / Bash / Grep …); the cryptic ones — orchestrator snake_case
 * (`create_task`) and MCP `mcp__<server>__<tool>` — are de-prefixed and
 * sentence-cased: `create_task` → "Create task", `mcp__gmail__search_threads` →
 * "Search threads".
 */
export function humanizeToolName(raw: string | undefined | null): string {
  if (!raw) return "Tool";
  const canonical = canonicalToolName(raw);
  if (canonical) return canonical;
  // Strip an MCP prefix (mcp__<server>__<tool>) down to the tool part, then any
  // orchestrator prefix, then split snake_case / camelCase into words.
  let n = raw;
  const mcp = /^mcp__.+?__(.+)$/.exec(raw);
  if (mcp) n = mcp[1];
  n = n.replace(/^task_orch__/, "");
  const spaced = n
    .replace(/__/g, " ")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return raw;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Lowercase canonical id for the neutral interceptor seam. Built-ins collapse to
 *  one vocabulary across harnesses (pi `find` and Claude `Glob` both → "glob");
 *  unrecognized tools pass through untouched so interceptors that key on full
 *  names like "task_orch__create_task" keep firing. */
export function interceptorToolName(raw: string): string {
  const c = canonicalToolName(raw);
  return c ? c.toLowerCase() : raw;
}

// File-target tools whose path argument the Claude SDK calls `file_path` while
// the canonical seam (and pi) call `path`.
const FILE_TOOLS: ReadonlySet<CanonicalTool> = new Set<CanonicalTool>(["Read", "Write", "Edit"]);

/** True when the tool takes a single file path (Read/Write/Edit family). */
export function isFileTool(raw: string): boolean {
  const c = canonicalToolName(raw);
  return c ? FILE_TOOLS.has(c) : false;
}

// Input keys worth surfacing in a one-line preview, per canonical tool, unioned
// across both harnesses and ordered most-informative first.
export const TOOL_INPUT_KEYS: Record<CanonicalTool, string[]> = {
  Read: ["file_path", "path"],
  Write: ["file_path", "path"],
  Edit: ["file_path", "path"],
  Bash: ["command", "description"],
  Grep: ["pattern", "query", "path", "glob"],
  Glob: ["pattern", "glob", "path"],
  LS: ["path", "directory"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  TodoWrite: [],
  // Claude: subagent_type/description/prompt. Codex: task_name/message.
  Agent: ["description", "task_name", "subagent_type", "prompt", "message"],
};
