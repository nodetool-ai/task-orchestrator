// Proactive scheduler: auto-launch agent sessions on eligible tasks.
//
// When enabled, this periodically scans for `todo` tasks that are ready to be
// worked (assignee matches, dependencies satisfied, no run already in flight)
// and starts an agent session on each — up to a hard concurrency ceiling — so
// the orchestrator can drive the act → CI-gate → merge/block loop without a
// human kicking off every run.
//
// OFF BY DEFAULT. Like TASK_ORCH_CI_AUTOFIX and detached runs, this whole
// feature is inert unless TASK_ORCH_AUTO_LAUNCH is explicitly turned on. The
// interval in lib/agent.ts is only armed when the flag is set, so there is zero
// overhead when disabled, and `autoLaunchEligibleTasks` is itself a no-op when
// the flag is off (belt-and-suspenders — a manual/test call also does nothing).
//
// Runaway safety is the primary design constraint:
//   • never launch a task that already has a non-terminal agent run
//     (double-checked: the eligibility predicate here AND the advisory-locked
//      active-session guard inside agent.startSession);
//   • never exceed TASK_ORCH_AUTO_LAUNCH_MAX_CONCURRENT active auto-launched
//     runs — the budget is recomputed from the DB every tick;
//   • only ever touch `todo` tasks whose assignee matches the configured one;
//   • best-effort per task — one failed launch never aborts the tick.
//
// Auto-launched runs are tagged with an `auto_launch` agentEvents row (mirroring
// how the CI-autofix path records `github_autofix` events). That tag is how the
// active-count — and thus the concurrency ceiling — is computed, and it makes
// auto-launched runs observable/distinguishable from manual starts.

import { and, asc, eq, inArray, notInArray } from "drizzle-orm";

import { db } from "@/db";
import { agentEvents, agentSessions, taskDependencies, tasks } from "@/db/schema";
import { SESSION_STATUSES, isTerminalStatus, type SessionStatus, type TaskState } from "./types";

/** agentEvents.type marker recorded on every auto-launched run. */
export const AUTO_LAUNCH_EVENT = "auto_launch";

// Session statuses that count as "still active" (i.e. NOT terminal). A task with
// any run in one of these has work in flight and must not be launched again; an
// auto-launched run in one of these counts against the concurrency ceiling.
const TERMINAL_STATUS_LIST: SessionStatus[] = SESSION_STATUSES.filter(isTerminalStatus);

// A dependency is considered satisfied only once its work has SHIPPED. Task
// `merged` is the shipped terminal for a task (there is no task `done` — `done`
// is a plan state), matching the executor persona's rule ("dependencies are ALL
// merged"). We deliberately do NOT treat `cancelled` as satisfying: that keeps
// the scheduler conservative (fewer launches) at the cost of a cancelled
// dependency blocking its dependents until a human intervenes.
const DEP_SATISFIED_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["merged"]);

// ──────────────────────────────────────────────────────────
// Env knobs (all read at call time so a toggle takes effect without a restart).
// The feature is OFF unless TASK_ORCH_AUTO_LAUNCH is explicitly truthy.
// ──────────────────────────────────────────────────────────

/**
 * Master switch. OFF by default: unset / `0` / `false` / `no` / `off` disable
 * it; `1` / `true` / `yes` / `on` enable it. (Inverse default of
 * TASK_ORCH_CI_AUTOFIX, which is on unless disabled — auto-launch is the more
 * aggressive, product-shaping behavior, so it must be opt-in.)
 */
export function autoLaunchEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.TASK_ORCH_AUTO_LAUNCH ?? "").trim());
}

/** Poll cadence in ms (default 60s). ≤0 disables the interval. */
export function autoLaunchIntervalMs(): number {
  const raw = Number(process.env.TASK_ORCH_AUTO_LAUNCH_INTERVAL_MS ?? 60_000);
  return Number.isFinite(raw) ? Math.max(0, raw) : 60_000;
}

/** Ceiling on concurrently-active auto-launched runs (default 3). */
export function autoLaunchMaxConcurrent(): number {
  const raw = Number(process.env.TASK_ORCH_AUTO_LAUNCH_MAX_CONCURRENT ?? 3);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 3;
}

/** Only tasks with this assignee are eligible (default `claude`). Guards against
 *  the scheduler grabbing human-owned work. */
export function autoLaunchAssignee(): string {
  const v = (process.env.TASK_ORCH_AUTO_LAUNCH_ASSIGNEE ?? "claude").trim();
  return v || "claude";
}

/** Optional plan filter: when set, only tasks in this plan are eligible. */
export function autoLaunchPlan(): string | null {
  const v = (process.env.TASK_ORCH_AUTO_LAUNCH_PLAN ?? "").trim();
  return v || null;
}

// ──────────────────────────────────────────────────────────
// Injectable session-start (mirrors syncPrBackedTasks' injectable fetcher).
// The default reuses the CANONICAL start path — agent.startSession — the same
// function POST /api/tasks/:id/sessions and `npm run task -- agent T-...` call,
// so an auto-launched run is identical to a manual one (worktree, branch,
// transition to in_progress, dispatch). Loaded lazily to avoid a static import
// cycle with lib/agent.ts (which imports this module to arm the interval).
// ──────────────────────────────────────────────────────────

export type SessionStarter = (input: { taskId: string }) => Promise<{ id: number }>;

const defaultStarter: SessionStarter = async ({ taskId }) => {
  const agent = await import("./agent");
  return agent.startSession({ taskId, userId: null });
};

export interface AutoLaunchDeps {
  /** Override the session-start (tests inject a fake so nothing hits git/net). */
  startSession?: SessionStarter;
}

// ──────────────────────────────────────────────────────────
// DB helpers
// ──────────────────────────────────────────────────────────

/** Count auto-launched runs (tagged with an `auto_launch` event) that are still
 *  active (non-terminal). This is the number the concurrency ceiling caps. */
export async function countActiveAutoLaunched(): Promise<number> {
  const tagged = await db
    .select({ sessionId: agentEvents.sessionId })
    .from(agentEvents)
    .where(eq(agentEvents.type, AUTO_LAUNCH_EVENT));
  const ids = Array.from(new Set(tagged.map((r) => r.sessionId)));
  if (ids.length === 0) return 0;
  const active = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(inArray(agentSessions.id, ids), notInArray(agentSessions.status, TERMINAL_STATUS_LIST))
    );
  return active.length;
}

/** True iff the task already has a non-terminal agent run (any goal). Mirrors
 *  the active-session guard agent.startSession takes under its advisory lock. */
async function taskHasActiveRun(taskId: string): Promise<boolean> {
  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(eq(agentSessions.taskId, taskId), notInArray(agentSessions.status, TERMINAL_STATUS_LIST))
    );
  return rows.length > 0;
}

/** True iff every dependency task is in a satisfied (shipped) state. A task with
 *  no dependencies is trivially satisfied. A missing/deleted dependency row is
 *  treated as NOT satisfied (conservative). */
async function depsSatisfied(taskId: string): Promise<boolean> {
  const deps = await db
    .select({ dependsOnId: taskDependencies.dependsOnId })
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, taskId));
  if (deps.length === 0) return true;
  const ids = deps.map((d) => d.dependsOnId);
  const rows = await db
    .select({ id: tasks.id, state: tasks.state })
    .from(tasks)
    .where(inArray(tasks.id, ids));
  const stateById = new Map(rows.map((r) => [r.id, r.state as TaskState]));
  return ids.every((id) => {
    const state = stateById.get(id);
    return state !== undefined && DEP_SATISFIED_STATES.has(state);
  });
}

/** Record the `auto_launch` tag on a freshly-created run. */
async function tagAutoLaunched(runId: number, taskId: string): Promise<void> {
  await db.insert(agentEvents).values({
    sessionId: runId,
    type: AUTO_LAUNCH_EVENT,
    payload: JSON.stringify({ taskId, launchedAt: new Date().toISOString() }),
    createdAt: new Date(),
  });
}

// ──────────────────────────────────────────────────────────
// Scheduler tick
// ──────────────────────────────────────────────────────────

/**
 * One scheduler tick. No-op unless TASK_ORCH_AUTO_LAUNCH is enabled.
 *
 * Computes the remaining budget (ceiling − currently-active auto-launched runs),
 * then walks eligible `todo` tasks oldest-id-first and starts an agent session
 * on each until the budget is spent. A task is eligible iff ALL hold:
 *   • state is `todo`;
 *   • assignee matches the configured one;
 *   • all dependency tasks are satisfied (merged);
 *   • it has no active (non-terminal) agent run already;
 *   • launching it keeps active auto-launched runs ≤ the ceiling.
 *
 * Best-effort per task: one failed launch is logged and skipped, never aborting
 * the tick. Injectable `startSession` (defaults to the canonical
 * agent.startSession) so tests can run without touching git/network.
 */
export async function autoLaunchEligibleTasks(deps: AutoLaunchDeps = {}): Promise<void> {
  if (!autoLaunchEnabled()) return;

  const start = deps.startSession ?? defaultStarter;
  const assignee = autoLaunchAssignee();
  const max = autoLaunchMaxConcurrent();
  const planId = autoLaunchPlan();

  const activeAuto = await countActiveAutoLaunched();
  let budget = max - activeAuto;
  if (budget <= 0) {
    // At/over the ceiling — nothing may launch this tick.
    return;
  }

  const where = planId
    ? and(eq(tasks.state, "todo"), eq(tasks.assignee, assignee), eq(tasks.planId, planId))
    : and(eq(tasks.state, "todo"), eq(tasks.assignee, assignee));
  // Deterministic order: oldest task id first (ids are date-prefixed, so this is
  // effectively oldest-first).
  const candidates = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(where)
    .orderBy(asc(tasks.id));

  const launched: string[] = [];
  let skippedActive = 0;
  let skippedDeps = 0;

  for (const candidate of candidates) {
    if (budget <= 0) break;
    try {
      if (await taskHasActiveRun(candidate.id)) {
        skippedActive += 1;
        continue;
      }
      if (!(await depsSatisfied(candidate.id))) {
        skippedDeps += 1;
        continue;
      }
      const session = await start({ taskId: candidate.id });
      // The run is live now — count it against the budget BEFORE tagging, so a
      // failed tag insert can never leave a successfully-started run uncounted
      // (which would let countActiveAutoLaunched under-count and the concurrency
      // ceiling be exceeded on a later tick).
      budget -= 1;
      launched.push(candidate.id);
      try {
        await tagAutoLaunched(session.id, candidate.id);
      } catch (tagErr) {
        // Best-effort tag: the run started and is already counted this tick; a
        // missing tag only affects cross-tick accounting. Log, do not un-launch.
        console.warn(
          `auto-launch: task ${candidate.id} started but tagging failed:`,
          tagErr instanceof Error ? tagErr.message : tagErr
        );
      }
    } catch (err) {
      // Best-effort: a single failed launch (e.g. a lost race to a manual start,
      // or a dispatch error) must not stop the others.
      console.warn(
        `auto-launch: task ${candidate.id} launch failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  if (launched.length > 0 || skippedActive > 0 || skippedDeps > 0) {
    console.log(
      `auto-launch: launched ${launched.length}` +
        (launched.length ? ` (${launched.join(", ")})` : "") +
        `; active before=${activeAuto}, ceiling=${max}` +
        (skippedActive ? `; skipped ${skippedActive} with an active run` : "") +
        (skippedDeps ? `; skipped ${skippedDeps} with unmet deps` : "")
    );
  }
}
