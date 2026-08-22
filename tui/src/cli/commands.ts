// Decisions the cockpit and the CLI make the same way: which persona was
// meant, what a new run's body looks like, and the exact wording `/spawn`
// hands the agent. They live here rather than in app.tsx so `orch floor` can
// reach them without importing React and Ink — a list verb must not pay for a
// renderer it never mounts. app.tsx re-exports them, so the keyboard surface
// and its tests still import from one place.

import type { CreateRunInput } from "../api/types.js";
import { isLive, type TuiStatus } from "../model/status.js";

/** A persona reference as `/new` needs it: an id and a human name. */
export interface PersonaRef {
  id: string;
  name: string;
}

/** Resolve what the operator typed to a persona id. The list is empty until
 *  `ensurePersonas()` lands, and refusing to start a run because of that
 *  would be worse than letting the server decide — so an empty list passes
 *  the name through untouched. */
export function resolvePersona(
  personas: readonly PersonaRef[],
  name: string,
): { id: string; notice: null } | { id: null; notice: string } {
  const want = name.trim().toLowerCase();
  if (!want) return { id: null, notice: "/new <persona> <goal>" };
  if (personas.length === 0) return { id: want, notice: null };
  const hit = personas.find((p) => p.id.toLowerCase() === want) ?? personas.find((p) => p.name.toLowerCase() === want);
  if (hit) return { id: hit.id, notice: null };
  return { id: null, notice: `no persona "${name}" · try ${personas.map((p) => p.id).join(", ")}` };
}

/** The body of POST /api/runs for a chat run. Mirrors store.newRun so the CLI
 *  path (`orch "<goal>" -p persona`) starts runs the same way the TUI does.
 *  `budgetFrom` is the persona row when we have it — the server does not apply
 *  persona budgets itself. */
export function newRunInput(
  goal: string,
  personaId: string | null,
  budgetFrom?: { budgetMaxTurns: number | null; budgetMaxSeconds: number | null } | null,
): CreateRunInput {
  const input: CreateRunInput = {
    goal,
    // Deliberate: the server rejects a non-deferred `worktree` run with no
    // taskId (lib/runs.ts:744), and the cockpit has no task picker before the
    // first message.
    cwdStrategy: "none",
  };
  if (personaId) input.personaId = personaId;
  const budget: { maxTurns?: number; maxSeconds?: number } = {};
  if (budgetFrom?.budgetMaxTurns != null) budget.maxTurns = budgetFrom.budgetMaxTurns;
  if (budgetFrom?.budgetMaxSeconds != null) budget.maxSeconds = budgetFrom.budgetMaxSeconds;
  if (Object.keys(budget).length > 0) input.budget = budget;
  return input;
}

/** The `tab` cycle: the id after `current` in `list`, wrapping. Anything not
 *  in the list (including null) starts at the head. */
export function nextInCycle(list: readonly number[], current: number | null): number | null {
  if (list.length === 0) return null;
  const at = current === null ? -1 : list.indexOf(current);
  return list[(at + 1) % list.length] ?? null;
}

const TASK_ID = /^T-[\w-]+$/i;

/** `/spawn` never creates a run: it asks the agent that owns the `spawn` tool
 *  to delegate. Both templates are the wording the orchestrator prompt
 *  recognises, so they are fixed text, not a format string to improvise on. */
export function spawnMessage(persona: string, arg: string): string {
  const a = arg.trim();
  if (TASK_ID.test(a)) return `Spawn a ${persona} sub-agent for task ${a} using the spawn tool.`;
  return `Spawn a ${persona} sub-agent using the spawn tool with this goal: ${a}`;
}

/** Live descendants of `id` inside its own subtree rows (the row for `id`
 *  itself is in there and does not count as a child). */
export function liveKids(subtree: readonly { id: number; status: TuiStatus }[], id: number): number {
  return subtree.filter((r) => r.id !== id && isLive(r.status)).length;
}

/** One line, because cancelling a subtree kills work that is still running
 *  and the operator should see how much before the second keystroke. */
export function confirmLine(id: number, kids: number, key: string): string {
  const what = kids === 1 ? "1 live child" : `${kids} live children`;
  return `cancel #${id} and ${what}? ${key} again to confirm · esc to abort`;
}

// ── /model, /budget and `o` (T-tui-12) ─────────────────────────────────────

/** One cap, as `/budget` understood it. Dollars and turns are different
 *  columns on the run, so the parse has to pick one rather than guess later. */
export type Budget = { usd: number; turns?: undefined } | { turns: number; usd?: undefined };

const USD = /^\$?\s*(\d+(?:\.\d+)?)\s*(?:usd|\$)?$/i;
const TURNS = /^(\d+)\s*(?:t|turn|turns)?$/i;

/**
 * `/budget $5`, `/budget 5usd`, `/budget 20 turns`, `/budget 20`. A bare
 * number is turns: a dollar cap is the one an operator writes with a `$`, and
 * silently reading "5" as five dollars would cap a run 400× tighter than the
 * "5 turns" they meant.
 */
export function parseBudget(arg: string): { budget: Budget; notice: null } | { budget: null; notice: string } {
  const want = arg.trim();
  if (!want) return bad();
  const dollars = want.startsWith("$") || /(usd|\$)\s*$/i.test(want);
  const m = (dollars ? USD : TURNS).exec(want);
  if (!m) return bad();
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return bad();
  if (dollars) return { budget: { usd: n }, notice: null };
  if (!Number.isInteger(n)) return bad();
  return { budget: { turns: n }, notice: null };
}

function bad(): { budget: null; notice: string } {
  return { budget: null, notice: "/budget <usd|turns> — e.g. /budget $5 or /budget 20 turns" };
}

/** The caps a run carries, as the chat header shows them. Empty when the run
 *  inherits both — a header must not spend columns saying "nothing set". */
export function budgetLabel(run: { budgetUsd: number | null; budgetTurns: number | null }): string {
  const usd = run.budgetUsd === null ? "" : `$${trimZeros(run.budgetUsd)}`;
  const turns = run.budgetTurns === null ? "" : `${run.budgetTurns}t`;
  if (!usd && !turns) return "";
  return `${[usd, turns].filter((x) => x !== "").join("/")} cap`;
}

function trimZeros(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** What `o` opens: the PR if the run has one, otherwise the run's own page.
 *  A run with no PR is the common case (a chat run never opens one), so the
 *  fallback is the point of the key, not an error path. */
export function openUrlFor(run: { id: number; prUrl: string | null }, baseUrl: string): string {
  const pr = (run.prUrl ?? "").trim();
  if (pr) return pr;
  return `${baseUrl.replace(/\/+$/, "")}/runs/${run.id}`;
}

/** The browser launcher for a platform, as `process.platform` names it.
 *  Windows goes through `cmd /c start` with an empty title argument, because
 *  `start "https://…"` would read the url as the window title. */
export function openCommand(platform: string, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}
