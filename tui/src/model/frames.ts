// The transcript model: server messages and agent events → the frames the chat
// view draws. The interpretation of content blocks follows the web transcript
// (components/runs/run-view.tsx): text blocks are prose, tool_use starts an
// interaction, tool_result folds into the interaction it names via
// tool_use_id, falling back to the most recent interaction without a result.
//
// The terminal difference: a tool call is ONE line by default (T-tui-03), in
// Claude Code's own grammar — `⏺ Read(cli.ts)` with the result folded under a
// single `⎿`. Everything the web puts behind a disclosure triangle goes into
// `detail` and the tail of `result`, which the view only shows when `^o` is on.

import type { MessageRow, SdkContentBlock } from "../api/types.js";

export type Frame =
  | { kind: "user"; at: number; text: string; to?: number }
  | { kind: "agent"; at: number; run: number; text: string }
  | { kind: "thinking"; at: number; run: number; text: string }
  | {
      kind: "tool";
      at: number;
      run: number;
      /** The one-line label the CLI prints: `read cli.ts`. */
      text: string;
      /** The same call split the way the transcript draws it — `Read(cli.ts)`. */
      name: string;
      arg: string;
      /** Arguments the call line had no room for; `^o` shows them. */
      detail: string[];
      /** What came back. The first line is always drawn, the rest under `^o`. */
      result: string[];
      /** A call with its result folded in. An unfinished call blinks. */
      done?: boolean;
      error?: boolean;
    }
  | { kind: "spawn"; at: number; run: number; children: number[] }
  | { kind: "event"; at: number; run: number; text: string; tone: "info" | "warn" | "ok" }
  | { kind: "question"; at: number; run: number; text: string; answered?: string };

// ── tool naming ───────────────────────────────────────────────────────────
// Mirrors lib/builtin-tools.ts (the two harnesses name the same capabilities
// differently), collapsed to the lowercase vocabulary the cockpit prints.
const CANONICAL: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  bash: "bash",
  bashoutput: "bash",
  grep: "grep",
  ripgrep: "grep",
  rg: "grep",
  glob: "glob",
  find: "glob",
  fd: "glob",
  ls: "ls",
  tree: "ls",
  webfetch: "fetch",
  websearch: "search",
  todowrite: "todo",
  task: "task",
};

// Most-identifying argument first, per canonical tool (lib/builtin-tools.ts
// TOOL_INPUT_KEYS), then a generic tail for orchestrator / MCP tools.
const ARG_KEYS: Record<string, string[]> = {
  read: ["file_path", "path"],
  write: ["file_path", "path"],
  edit: ["file_path", "path"],
  bash: ["command", "description"],
  grep: ["pattern", "query"],
  glob: ["pattern", "glob", "path"],
  ls: ["path", "directory"],
  fetch: ["url"],
  search: ["query"],
  todo: [],
  task: ["description"],
};

const GENERIC_ARG_KEYS = [
  "task_id",
  "plan_id",
  "session_id",
  "run_id",
  "child_run_id",
  "id",
  "goal",
  "persona",
  "question",
  "title",
  "note",
  "file_path",
  "path",
  "url",
  "pattern",
  "query",
  "command",
  "name",
];

/** The two tools that create child runs. Names are exact: lib/extensions/spawn.ts
 *  and the `start_session` orchestrator tool. */
const SPAWN_TOOLS = new Set(["spawn__spawn_agent", "start_session"]);

const MAX_TEXT = 72;
const MAX_DETAIL = 120;
const DETAIL_LINES = 4;
const RESULT_LINES = 8;

function canonical(raw: string): string | null {
  return CANONICAL[raw.toLowerCase()] ?? null;
}

/** Terminal label for any tool: built-ins keep their canonical lowercase name,
 *  `mcp__server__tool` and `task_orch__x` lose their prefixes, everything else
 *  passes through as written. */
export function toolLabel(raw: string | undefined | null): string {
  if (!raw) return "tool";
  const c = canonical(raw);
  if (c) return c;
  const mcp = /^mcp__.+?__(.+)$/.exec(raw);
  return (mcp ? mcp[1] : raw).replace(/^task_orch__/, "");
}

/** The tool's name as the transcript writes it: `Read`, `Bash`, `Task`. A
 *  built-in is title-cased from its canonical word; anything else — an
 *  orchestrator verb, an MCP tool — keeps the name it was given, because
 *  `Transition_task` is a worse name than `transition_task`. */
export function toolName(raw: string | undefined | null): string {
  const label = toolLabel(raw);
  return canonical(raw ?? "") === null ? label : label.charAt(0).toUpperCase() + label.slice(1);
}

/** The argument inside the parentheses: the same one `toolText` puts after the
 *  label, and empty when the call has nothing worth naming. */
export function toolArg(raw: string | undefined | null, input: unknown): string {
  const args = new Map(argEntries(input));
  const keys = [...(ARG_KEYS[canonical(raw ?? "") ?? ""] ?? []), ...GENERIC_ARG_KEYS];
  for (const k of keys) {
    const v = args.get(k);
    if (v) return clip(v, MAX_TEXT);
  }
  if (args.size === 1) return clip([...args.values()][0] as string, MAX_TEXT);
  return "";
}

function argEntries(input: unknown): Array<[string, string]> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [k, oneLine(typeof v === "string" ? v : JSON.stringify(v))] as [string, string]);
}

/** The one line a tool call gets by default: name plus its single most
 *  identifying argument. Must stand alone without `detail`. */
export function toolText(raw: string | undefined | null, input: unknown): string {
  const label = toolLabel(raw);
  const args = new Map(argEntries(input));
  const keys = [...(ARG_KEYS[canonical(raw ?? "") ?? ""] ?? []), ...GENERIC_ARG_KEYS];
  let arg: string | undefined;
  for (const k of keys) {
    const v = args.get(k);
    if (v) {
      arg = v;
      break;
    }
  }
  if (arg === undefined && args.size === 1) arg = [...args.values()][0];
  // A shell command already names the program it runs; "bash npm test" reads
  // as noise, so the command stands on its own.
  if (label === "bash" && arg) return clip(arg, MAX_TEXT + 20);
  return arg ? `${label} ${clip(arg, MAX_TEXT)}` : label;
}

function toolDetail(raw: string | undefined | null, input: unknown, shown: string): string[] {
  return argEntries(input)
    .filter(([, v]) => !shown.endsWith(clip(v, MAX_TEXT)))
    .slice(0, DETAIL_LINES)
    .map(([k, v]) => `${k}=${clip(v, MAX_DETAIL)}`);
}

/** Flatten a tool_result's content (string, block array, or bare object) into
 *  the few lines worth showing under `^o`. */
export function resultLines(content: unknown): string[] {
  const text = resultText(content);
  if (!text) return [];
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, RESULT_LINES)
    .map((l) => clip(l, MAX_DETAIL));
}

function resultText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        const blk = b as { text?: string; content?: unknown };
        return typeof blk.text === "string" ? blk.text : resultText(blk.content);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") return JSON.stringify(content);
  return String(content);
}

/** Child run ids out of a spawn tool's result. `spawn__spawn_agent` answers
 *  with JSON carrying `run_id`; `start_session` answers in prose
 *  ("Started session #123 on T-0005"). Neither is guaranteed to parse — an
 *  unrecoverable result yields no ids and the frame stays, empty. */
export function spawnedIds(content: unknown): number[] {
  const text = resultText(content);
  if (!text) return [];
  const out = new Set<number>();
  try {
    const parsed = JSON.parse(text) as unknown;
    for (const v of asArray(parsed)) {
      const o = v as Record<string, unknown>;
      for (const k of ["run_id", "session_id", "id"]) {
        const n = o?.[k];
        if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) out.add(n);
      }
    }
  } catch {
    // prose result — fall through to the #id scan
  }
  if (out.size === 0) {
    for (const m of text.matchAll(/#(\d+)/g)) out.add(Number(m[1]));
  }
  // Prose without a `#`: start_session says "Started session #43", but a tool
  // that phrases it "started run 43" would otherwise render a childless spawn
  // frame. Anchored on the noun so stray numbers ("946 lines") never match.
  if (out.size === 0) {
    for (const m of text.matchAll(/\b(?:run|session)\s+#?(\d+)/gi)) out.add(Number(m[1]));
  }
  return [...out];
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

// ── messages → frames ─────────────────────────────────────────────────────

export function framesFromMessages(messages: MessageRow[]): Frame[] {
  const frames: Frame[] = [];
  // tool_use_id → index of the tool/spawn frame it produced.
  const byToolId = new Map<string, number>();
  // Results with no id (or an id we never saw) attach to the newest
  // interaction still missing one, like the web view does.
  const openIdx: number[] = [];

  const attach = (id: string | undefined, i: number) => {
    if (id) byToolId.set(id, i);
    openIdx.push(i);
  };
  const target = (id: string | undefined): number | undefined => {
    if (id) {
      const i = byToolId.get(id);
      if (i !== undefined) return i;
    }
    return openIdx.length ? openIdx[openIdx.length - 1] : undefined;
  };
  const close = (i: number) => {
    const at = openIdx.lastIndexOf(i);
    if (at >= 0) openIdx.splice(at, 1);
  };

  for (const m of messages) {
    const at = epoch(m.createdAt);
    if (m.role === "system") {
      // Inbox mirrors (lib/inbox.ts) are stored as a single system block
      // `[{type:"inbox_event", event_type, payload}]`.
      for (const b of m.content) {
        const f = frameFromEvent(m.runId, { ...(b as Record<string, unknown>), type: String(b.type ?? "") });
        if (f) frames.push(f.at ? f : withAt(f, at));
      }
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_use") {
        const idx = frames.length;
        if (SPAWN_TOOLS.has(b.name ?? "")) {
          frames.push({ kind: "spawn", at, run: m.runId, children: [] });
        } else {
          const text = toolText(b.name, b.input);
          frames.push({
            kind: "tool",
            at,
            run: m.runId,
            text,
            name: toolName(b.name),
            arg: toolArg(b.name, b.input),
            detail: toolDetail(b.name, b.input, text),
            result: [],
          });
        }
        attach(b.id, idx);
        continue;
      }
      if (b.type === "tool_result") {
        const i = target(b.tool_use_id);
        if (i === undefined) continue; // orphan result: nothing to fold it into
        const f = frames[i];
        if (f.kind === "spawn") {
          frames[i] = { ...f, children: dedupe([...f.children, ...spawnedIds(b.content)]) };
        } else if (f.kind === "tool") {
          frames[i] = {
            ...f,
            result: dedupe([...f.result, ...resultLines(b.content)]),
            done: true,
            ...(b.is_error === true ? { error: true } : {}),
          };
        }
        close(i);
        continue;
      }
      if (b.type === "thinking" || (b.type === "redacted_thinking" && m.role === "agent")) {
        const think = (b.thinking ?? "").trim();
        if (think) frames.push({ kind: "thinking", at, run: m.runId, text: think });
        continue;
      }
      if (b.type === "text" || (b.type === undefined && typeof b.text === "string")) {
        const text = (b.text ?? "").trim();
        if (!text) continue; // blank assistant turns are phantom gaps
        if (m.role === "user") frames.push({ kind: "user", at, text });
        else if (m.role === "agent") frames.push({ kind: "agent", at, run: m.runId, text });
      }
    }
  }
  return frames;
}

// ── events → frames ───────────────────────────────────────────────────────

/** Stream control and things the transcript deliberately does not draw. */
const HIDDEN = new Set([
  "_cursor",
  "_eos",
  "message",
  "heartbeat",
  "runner_deferred",
  "auto_launch",
  // The human's own append is already in the transcript as a user frame.
  "user.message",
]);

const OK_TYPES = new Set(["child.result", "gh.pr.merged", "pr_merged", "task.transitioned", "plan.transitioned"]);
const WARN_TYPES = new Set([
  "child.exception",
  "child.died",
  "child.timeout",
  "child.cancelled",
  "child.budget_exhausted",
  "child.stalled",
  "budget.warning",
  "run.cancel_requested",
  "gh.pr.closed",
  "github_autofix_exhausted",
]);

export function frameFromEvent(
  runId: number,
  event: { type: string } & Record<string, unknown>
): Frame | null {
  // Inbox mirror / digest frames wrap the real event one level down.
  if (event.type === "inbox_event" || event.type === "event_digest") {
    const inner = (event.payload ?? {}) as Record<string, unknown>;
    const type = str(event.event_type) ?? str(inner.type);
    if (!type) return null;
    return frameFromEvent(runId, { ...inner, type, at: event.at ?? event.created_at });
  }
  const type = event.type;
  if (!type || HIDDEN.has(type)) return null;
  const at = eventAt(event);
  const payload = event as Record<string, unknown>;

  if (type === "status") {
    const status = str(payload.status) ?? "";
    const err = str(payload.error);
    const tone: "info" | "warn" | "ok" =
      status === "completed" || status === "closed"
        ? "ok"
        : status === "failed" || status === "cancelled" || status === "budget_exhausted"
          ? "warn"
          : "info";
    return { kind: "event", at, run: runId, text: err ? `${status}: ${clip(err, MAX_DETAIL)}` : status, tone };
  }

  if (type === "child.question" || type === "run.question") {
    const text = str(payload.question) ?? "asks you a question";
    const answered = str(payload.answer) ?? str(payload.answered);
    const run = num(payload.run_id) ?? runId;
    return answered
      ? { kind: "question", at, run, text, answered }
      : { kind: "question", at, run, text };
  }

  const text = eventText(type, payload);
  if (!text) return null;
  return { kind: "event", at, run: runId, text, tone: tone(type, payload) };
}

/** Tone is mostly a property of the type, but the three types that carry an
 *  outcome in their payload (CI, review, child result) decide it themselves. */
function tone(type: string, p: Record<string, unknown>): "info" | "warn" | "ok" {
  if (type === "gh.ci.completed") return str(p.conclusion) === "success" ? "ok" : "warn";
  if (type === "gh.pr.review_submitted") {
    const state = str(p.state);
    return state === "approved" ? "ok" : state === "changes_requested" ? "warn" : "info";
  }
  if (type === "child.result") {
    const r = p.result;
    const status = r && typeof r === "object" ? str((r as Record<string, unknown>).status) : str(p.status);
    return status && status !== "ok" && status !== "done" && status !== "completed" ? "warn" : "ok";
  }
  return OK_TYPES.has(type) ? "ok" : WARN_TYPES.has(type) ? "warn" : "info";
}

function eventText(type: string, p: Record<string, unknown>): string | null {
  const child = num(p.run_id);
  const who = child ? `#${child}` : "";
  switch (type) {
    case "child.spawned":
      return `spawned ${who} ${str(p.persona) ?? ""}`.trim();
    case "child.started":
      return `${who} started`.trim();
    case "child.progress":
      return `${who} ${str(p.note) ?? "progress"}`.trim();
    case "child.result":
      return `${who} finished${resultWord(p)}`.trim();
    case "child.exception":
      return `${who} raised ${str(p.code) ?? "exception"}${p.message ? `: ${clip(String(p.message), MAX_DETAIL)}` : ""}`.trim();
    case "child.died":
      return `${who} died${p.exit_code !== undefined ? ` (exit ${String(p.exit_code)})` : ""}`.trim();
    case "child.timeout":
      return `${who} timed out`.trim();
    case "child.cancelled":
      return `${who} cancelled`.trim();
    case "child.budget_exhausted":
      return `${who} out of budget`.trim();
    case "child.stalled":
      return `${who} stalled`.trim();
    case "gh.pr.review_submitted":
      return `PR review ${str(p.state) ?? "submitted"}${p.reviewer ? ` by ${String(p.reviewer)}` : ""}`;
    case "gh.pr.comment":
      return `PR comment${p.author ? ` from ${String(p.author)}` : ""}`;
    case "gh.pr.merged":
    case "pr_merged":
      return "PR merged";
    case "gh.pr.closed":
      return "PR closed";
    case "gh.pr.pushed":
      return "PR branch pushed";
    case "gh.ci.completed":
      return `CI ${str(p.conclusion) ?? "completed"}${p.check_name ? ` · ${String(p.check_name)}` : ""}`;
    case "github":
      return `github ${str(p.event) ?? str(p.action) ?? "event"}`;
    case "github_autofix":
      return `CI autofix: ${str(p.reason) ?? "retrying"}`;
    case "github_autofix_exhausted":
      return "CI autofix gave up";
    case "timer.fired":
      return `timer fired${p.note ? ` · ${String(p.note)}` : ""}`;
    case "task.transitioned":
      return `${str(p.task_id) ?? "task"} ${str(p.from) ?? "?"} → ${str(p.to) ?? "?"}`;
    case "plan.transitioned":
      return `${str(p.plan_id) ?? "plan"} ${str(p.from) ?? "?"} → ${str(p.to) ?? "?"}`;
    case "budget.warning":
      return `budget warning${p.spent_usd !== undefined ? ` · $${Number(p.spent_usd).toFixed(2)}` : ""}`;
    case "run.cancel_requested":
      return "cancel requested";
    default:
      // An unrecognised type reaching the transcript is, by definition, one
      // nobody taught the cockpit about; showing it fails safe (same rule as
      // the inbox bucket mapping in lib/inbox.ts).
      return type.replace(/[._]/g, " ");
  }
}

function resultWord(p: Record<string, unknown>): string {
  const r = p.result;
  const status = r && typeof r === "object" ? str((r as Record<string, unknown>).status) : str(p.status);
  return status ? ` · ${status}` : "";
}

// ── live-stream reducer ───────────────────────────────────────────────────

// How far back a fold may reach. A tool_result normally lands in the very next
// message, but an interleaved event can push it a line or two down; beyond this
// window an identical call is treated as a genuinely new call.
const FOLD_WINDOW = 12;

/**
 * Append one frame to the transcript, folding it into an existing frame where
 * that is what the server meant: a repeated tool_result adds nothing (the same
 * array comes back), an answer settles the open question in place instead of
 * duplicating it, and the stream's copy of a message the cockpit already
 * echoed optimistically is dropped.
 */
export function appendFrame(frames: Frame[], next: Frame): Frame[] {
  if (next.kind === "user") {
    // The cockpit echoes a typed message optimistically, then the stream
    // replays the server's own copy of it. Same text inside the window means
    // the same message, so the second one is dropped — and the FIRST is kept,
    // because that is the one carrying the `to` chip the operator aimed at.
    const from = Math.max(0, frames.length - FOLD_WINDOW);
    for (let i = frames.length - 1; i >= from; i--) {
      const f = frames[i];
      if (f.kind === "user" && f.text === next.text) return frames;
    }
    return [...frames, next];
  }

  if (next.kind === "thinking") {
    // A reconnect replays the turn, and a thinking block is long: the same
    // prose twice reads as the agent having said it twice.
    const from = Math.max(0, frames.length - FOLD_WINDOW);
    for (let i = frames.length - 1; i >= from; i--) {
      const f = frames[i];
      if (f.kind === "thinking" && f.run === next.run && f.text === next.text) return frames;
    }
    return [...frames, next];
  }

  if (next.kind === "question") {
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (f.kind !== "question" || f.run !== next.run || f.text !== next.text) continue;
      if (!next.answered || f.answered === next.answered) return frames;
      const out = frames.slice();
      out[i] = { ...f, answered: next.answered };
      return out;
    }
    return [...frames, next];
  }

  if (next.kind === "tool" || next.kind === "spawn") {
    const from = Math.max(0, frames.length - FOLD_WINDOW);
    for (let i = frames.length - 1; i >= from; i--) {
      const f = frames[i];
      if (f.kind !== next.kind || f.run !== next.run) continue;
      if (f.kind === "tool" && next.kind === "tool") {
        if (f.text !== next.text) continue;
        const detail = dedupe([...f.detail, ...next.detail]);
        const result = dedupe([...f.result, ...next.result]);
        // The one thing a repeat can still say is that the call finished:
        // the stream sends the call, then the same call with its result.
        const settles = (next.done === true && f.done !== true) || (next.error === true && f.error !== true);
        if (detail.length === f.detail.length && result.length === f.result.length && !settles) return frames;
        const out = frames.slice();
        out[i] = {
          ...f,
          detail,
          result,
          ...(next.done === true ? { done: true } : {}),
          ...(next.error === true ? { error: true } : {}),
        };
        return out;
      }
      if (f.kind === "spawn" && next.kind === "spawn") {
        // Only the same spawn: an empty frame waiting for its result, or one
        // whose children the new frame repeats.
        const overlap = f.children.length === 0 || next.children.some((c) => f.children.includes(c));
        if (!overlap) continue;
        const children = dedupe([...f.children, ...next.children]);
        if (children.length === f.children.length) return frames;
        const out = frames.slice();
        out[i] = { ...f, children };
        return out;
      }
    }
  }

  return [...frames, next];
}

// ── small helpers ─────────────────────────────────────────────────────────

function withAt(f: Frame, at: number): Frame {
  return { ...f, at };
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function epoch(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function eventAt(e: Record<string, unknown>): number {
  for (const k of ["at", "occurred_at", "created_at", "createdAt"]) {
    const v = e[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return 0;
}
