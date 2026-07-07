// GitHub PR + CI → task-state sync.
//
// A single pure mapper (`prToTaskState`) drives task state from the *real*
// GitHub PR + CI state, and is shared by both entry points:
//   • the poller (`syncPrBackedTasks`, wired on an interval in lib/agent.ts),
//   • the webhook handler (a later task calls `prToTaskState` /
//     `applyTaskStateFromPr` from lib/github-webhook-handler.ts).
//
// The agent never hand-sets testing/passing/failing/merged — GitHub state owns
// those transitions, funnelled through `applyTaskStateFromPr` so both paths
// stay consistent.

import { spawn } from "node:child_process";
import { and, desc, eq, isNotNull, notInArray } from "drizzle-orm";

import { db } from "@/db";
import { agentSessions, tasks } from "@/db/schema";
import * as repo from "./repo";
import { maybeTriggerAutofix, type AutofixCandidate } from "./ci-autofix";
import { TASK_TRANSITIONS, type TaskState } from "./types";

// ──────────────────────────────────────────────────────────
// Pure mapper
// ──────────────────────────────────────────────────────────

export interface PrGithubState {
  /** PR merged. */
  merged: boolean;
  /** PR closed without merging. */
  closed: boolean;
  /** Rolled-up state of the PR's checks (required + otherwise). */
  ciConclusion: "success" | "failure" | "pending" | "none";
}

/**
 * Map a PR's real GitHub state to the task state it implies. Pure — no I/O.
 *   • merged            → "merged"
 *   • closed (unmerged) → "blocked"   (PR abandoned; needs attention)
 *   • CI failure        → "failing"
 *   • CI success        → "passing"
 *   • otherwise         → "testing"   (pending/none, PR still open)
 */
export function prToTaskState(s: PrGithubState): TaskState {
  if (s.merged) return "merged";
  if (s.closed) return "blocked";
  if (s.ciConclusion === "failure") return "failing";
  if (s.ciConclusion === "success") return "passing";
  return "testing";
}

// ──────────────────────────────────────────────────────────
// GitHub fetch
// ──────────────────────────────────────────────────────────

/** A single entry of `gh pr view --json statusCheckRollup`. */
interface RollupCheck {
  status?: string; // check-run status (queued|in_progress|completed)
  conclusion?: string; // check-run conclusion (success|failure|neutral|…)
  state?: string; // legacy commit-status state (SUCCESS|FAILURE|PENDING|…)
}

/**
 * Collapse `statusCheckRollup` into a single ciConclusion:
 *   • any failure/timed_out/cancelled/error/action_required → "failure"
 *   • any pending/in_progress/queued                        → "pending"
 *   • non-empty and everything else success/neutral/skipped → "success"
 *   • empty                                                 → "none"
 * (failure > pending > success precedence.)
 */
export function rollupToCiConclusion(
  checks: RollupCheck[]
): PrGithubState["ciConclusion"] {
  if (checks.length === 0) return "none";
  let failure = 0;
  let pending = 0;
  for (const c of checks) {
    const status = c.status?.toUpperCase();
    if (status && status !== "COMPLETED") {
      pending += 1;
      continue;
    }
    const verdict = (c.conclusion ?? c.state ?? "").toUpperCase();
    switch (verdict) {
      case "FAILURE":
      case "ERROR":
      case "TIMED_OUT":
      case "CANCELLED":
      case "CANCELED":
      case "ACTION_REQUIRED":
      case "STARTUP_FAILURE":
      case "STALE":
        failure += 1;
        break;
      case "PENDING":
      case "IN_PROGRESS":
      case "QUEUED":
      case "REQUESTED":
      case "WAITING":
        pending += 1;
        break;
      // success / neutral / skipped / unknown → treated as a passing context
      default:
        break;
    }
  }
  if (failure > 0) return "failure";
  if (pending > 0) return "pending";
  return "success";
}

interface PrViewJson {
  state?: string;
  mergedAt?: string | null;
  statusCheckRollup?: RollupCheck[];
}

/**
 * Fetch a PR's real GitHub state via `gh pr view <url> --json …`, mapped to a
 * {@link PrGithubState}. Returns null on any failure (spawn error, non-zero
 * exit, unparsable output) so callers can skip that PR without aborting.
 *
 * Uses the same `gh` spawn pattern as lib/extensions/gh-pr.ts (`gh_pr__pr_view`
 * requests the same `state,mergedAt,statusCheckRollup` fields).
 */
export function fetchPrGithubState(prUrl: string): Promise<PrGithubState | null> {
  return new Promise((resolveP) => {
    const child = spawn(
      "gh",
      ["pr", "view", prUrl, "--json", "state,mergedAt,statusCheckRollup"],
      { env: process.env }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => resolveP(null));
    child.on("close", (code) => {
      if (code !== 0) {
        if (stderr) console.warn("gh pr view failed:", stderr.trim());
        resolveP(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as PrViewJson;
        const state = (parsed.state ?? "").toUpperCase();
        const checks = Array.isArray(parsed.statusCheckRollup)
          ? parsed.statusCheckRollup
          : [];
        resolveP({
          merged: state === "MERGED",
          closed: state === "CLOSED",
          ciConclusion: rollupToCiConclusion(checks),
        });
      } catch {
        resolveP(null);
      }
    });
  });
}

// ──────────────────────────────────────────────────────────
// Apply
// ──────────────────────────────────────────────────────────

function noteFor(target: TaskState): string {
  switch (target) {
    case "merged":
      return "PR merged";
    case "blocked":
      return "PR closed without merging";
    case "failing":
      return "CI failed";
    case "passing":
      return "CI passed";
    case "testing":
      return "PR open, CI in progress";
    default:
      return `→ ${target}`;
  }
}

/**
 * Drive a task's state from its PR's real GitHub state. Computes the target via
 * {@link prToTaskState}; transitions only if the target differs from the
 * current state AND the edge is allowed by TASK_TRANSITIONS. Any other case
 * (target === current, illegal edge, terminal task) is a silent no-op — never
 * throws for a disallowed transition.
 *
 * Shared by the poller and (later) the webhook handler so both paths apply the
 * same rule.
 */
export async function applyTaskStateFromPr(
  task: { id: string; state: TaskState },
  ghState: PrGithubState
): Promise<void> {
  const target = prToTaskState(ghState);
  if (target === task.state) return;
  const allowed = TASK_TRANSITIONS[task.state] ?? [];
  if (!allowed.includes(target)) return;
  await repo.transitionTask(task.id, {
    state: target,
    note: noteFor(target),
    // A merged PR is authoritative that the work shipped — close the task even
    // if acceptance criteria were never checked off, rather than stranding it.
    bypassCriteria: target === "merged",
  });
}

// ──────────────────────────────────────────────────────────
// Poller
// ──────────────────────────────────────────────────────────

export type PrGithubStateFetcher = (prUrl: string) => Promise<PrGithubState | null>;

const TERMINAL_STATES: TaskState[] = ["merged", "cancelled"];

/**
 * Poll every non-terminal, PR-backed task and drive its state from GitHub.
 * Generalizes the old merged-PR poller: for each task with a non-null pr_url
 * whose state is not terminal, fetch its {@link PrGithubState} and apply
 * {@link applyTaskStateFromPr}. Best-effort per task — one failing fetch or
 * transition must not abort the loop.
 *
 * `fetchState` is injectable so tests can supply a fake without touching the
 * `gh` subprocess or the network.
 */
export async function syncPrBackedTasks(
  fetchState: PrGithubStateFetcher = fetchPrGithubState
): Promise<void> {
  const rows = await db
    .select({ id: tasks.id, state: tasks.state, prUrl: tasks.prUrl })
    .from(tasks)
    .where(and(isNotNull(tasks.prUrl), notInArray(tasks.state, TERMINAL_STATES)));

  for (const row of rows) {
    if (!row.prUrl) continue;
    try {
      const ghState = await fetchState(row.prUrl);
      if (!ghState) continue;
      const redAndOpen =
        ghState.ciConclusion === "failure" && !ghState.merged && !ghState.closed;
      // A task already in `blocked` with still-red CI has been escalated (or its
      // PR was closed) and is awaiting a human — don't let the CI-failure sync
      // drag it back to `failing` every tick, which would visually undo the
      // escalation. Recovery (green → passing, merged) still applies because
      // those states aren't skipped here.
      if (!(redAndOpen && row.state === "blocked")) {
        await applyTaskStateFromPr({ id: row.id, state: row.state as TaskState }, ghState);
      }
      // Belt for a dropped CI-failure webhook: when the PR's rolled-up CI is
      // red (and the PR is neither merged nor closed), drive the SAME capped
      // autofix the webhook would. The shared cap/debounce/in-flight guards
      // read the `github_autofix` events keyed to the target run, so this
      // dedupes against a recent webhook rather than double-firing. When the
      // loop can't progress (cap hit, or no resumable run) it escalates the task
      // to `blocked` — guarded by a one-shot `github_autofix_exhausted` event so
      // the ~20s poll can't re-escalate. Never fires on a green/merged/closed
      // PR. Best-effort — a failure here must not abort the loop for other tasks.
      if (redAndOpen) {
        await maybeTriggerAutofixForTask(row.id, row.prUrl);
      }
    } catch (err) {
      console.warn(
        `syncPrBackedTasks: task ${row.id} (${row.prUrl}) sync failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

/**
 * Load a task's runs newest-first and hand them to the shared autofix trigger.
 * Kept separate so a throw is contained to the one task in the poller loop.
 */
async function maybeTriggerAutofixForTask(taskId: string, prUrl: string): Promise<void> {
  const candidates = (await db
    .select({
      id: agentSessions.id,
      taskId: agentSessions.taskId,
      branch: agentSessions.branch,
      worktreePath: agentSessions.worktreePath,
      cwdStrategy: agentSessions.cwdStrategy,
      status: agentSessions.status,
      prUrl: agentSessions.prUrl,
    })
    .from(agentSessions)
    .where(eq(agentSessions.taskId, taskId))
    .orderBy(desc(agentSessions.startedAt))) as AutofixCandidate[];

  await maybeTriggerAutofix(candidates, { reason: "ci", prUrl });
}
