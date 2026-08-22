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
