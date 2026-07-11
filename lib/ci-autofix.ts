// Shared CI/review auto-fix trigger.
//
// When CI fails (or a reviewer requests changes) on a task's PR, resume the
// implementor agent on the same branch to fix it in place. This logic is
// reached from TWO entry points that must behave identically and dedupe
// against each other:
//   • the GitHub webhook handler (lib/github-webhook-handler.ts) — the fast
//     path, fired the moment a delivery arrives;
//   • the PR-state poller (lib/pr-task-state.ts) — the guarantee, so a dropped
//     webhook can't strand the fix loop.
//
// Both call {@link maybeTriggerAutofix}, which owns the target-run selection,
// the AUTOFIX_ENABLED gate, the in-flight guard, the attempt cap, the debounce,
// the durable `github_autofix` event, and the `runs.followUp` kick. The cap and
// debounce both read the shared `github_autofix` agentEvents rows keyed to the
// target run — so whichever path fires first records the event, and the other
// path picks the SAME target run and is deduped by that row (no double-fire).
//
// When the loop can't make progress it escalates instead of going silent: on a
// red-CI event whose attempts have hit AUTOFIX_MAX, or where there is no
// resumable run to fix in place, the task is moved to `blocked` for a human. A
// one-shot `github_autofix_exhausted` event (keyed to the anchor run) guards
// that escalation so the ~20s poller can't re-block/re-note a stuck task.
//
// Kept free of imports from either entry point so there is no import cycle
// (the poller must not pull in the webhook route handler).

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { agentEvents } from "@/db/schema";
import { CODE_REVIEW_RECEPTION_GUIDANCE } from "./code-review-guidance";
import * as repo from "./repo";
import * as runs from "./runs";
import { autofixEnabledFor } from "./github-webhook";
import { TASK_TRANSITIONS, type TaskState } from "./types";

// Auto-fix is on by default — the orchestrator watches every PR's CI and fixes
// failures in place. Set TASK_ORCH_CI_AUTOFIX=0 (or false/no/off) to disable.
// Read at call time (not import) so a toggle takes effect without a restart and
// so the whole loop — including its escalation stop condition — is gated by it.
export function autofixEnabled(): boolean {
  return autofixEnabledFor(process.env.TASK_ORCH_CI_AUTOFIX);
}
// Kept as a convenience snapshot for callers/tests that only need the boot-time
// value; the gates below use autofixEnabled() so a runtime toggle is honored.
export const AUTOFIX_ENABLED = autofixEnabled();

// Task states we escalate FROM when the autofix loop can't make progress. These
// are the "actively working a PR through CI" states where pulling in a human
// (→ blocked) is the right terminal stop. Excludes `todo` (no PR yet) and the
// terminal/blocked states themselves. `blocked` is a legal target from each of
// these (see TASK_TRANSITIONS in lib/types.ts).
const ESCALATABLE_STATES: TaskState[] = ["in_progress", "testing", "failing", "passing"];
// Parse a non-negative-integer env var, falling back to `dflt` when the value
// is unset, empty, or non-numeric. Plain `Number("")` is 0 and `Number("x")` is
// NaN — both of which would silently break the cap/debounce below (0 disables
// autofix; NaN makes `>= NaN` / `<= 0` never trip), so guard against them.
function intFromEnv(value: string | undefined, dflt: number): number {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return dflt;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : dflt;
}
// Cap auto-fix attempts per run so a persistently-red PR can't loop forever.
export const AUTOFIX_MAX = intFromEnv(process.env.TASK_ORCH_CI_AUTOFIX_MAX, 3);
// Debounce: ignore repeat triggers within this window (a single push fans out
// into many check_run/workflow_run/check_suite deliveries, and the poller can
// also fire close behind a webhook).
export const AUTOFIX_DEBOUNCE_MS = intFromEnv(
  process.env.TASK_ORCH_CI_AUTOFIX_DEBOUNCE_MS,
  120_000
);

/** The run fields the trigger needs; RunRow is structurally compatible. */
export interface AutofixCandidate {
  id: number;
  taskId: string | null;
  branch: string | null;
  worktreePath: string | null;
  cwdStrategy: string;
  status: string;
  prUrl: string | null;
}

export interface AutofixContext {
  reason: "ci" | "review";
  prUrl?: string | null;
  workflowName?: string | null;
  conclusion?: string | null;
  headSha?: string | null;
  actor?: string | null;
  body?: string | null;
  /**
   * Optional breadcrumb note recorded on the target task before the gates run
   * (the webhook path leaves one so feedback is visible even with autofix off).
   * The poller passes none — applyTaskStateFromPr already notes the CI state.
   */
  breadcrumb?: string;
}

export interface AutofixResult {
  target: AutofixCandidate | null;
  triggered: boolean;
  actions: string[];
}

/**
 * Pick the newest run that owns a task and a worktree branch and is *resumable*,
 * then — subject to the enabled gate, in-flight guard, attempt cap and debounce
 * — record a `github_autofix` event and kick a follow-up turn to fix the PR.
 *
 * `candidates` MUST be pre-sorted newest-first by the caller (both callers do).
 *
 * Requiring a resumable status matters: cancel()/close() leave the branch and
 * worktree_path columns intact (only the on-disk worktree is deleted), so
 * without this guard autofix would resurrect a run the user explicitly
 * cancelled/closed. isResumableWorktreeRun excludes cancelled/closed and
 * in-flight states.
 */
export async function maybeTriggerAutofix(
  candidates: AutofixCandidate[],
  ctx: AutofixContext
): Promise<AutofixResult> {
  const actions: string[] = [];
  const { reason } = ctx;

  const target =
    candidates.find(
      (r) =>
        r.taskId &&
        r.branch &&
        r.worktreePath &&
        r.cwdStrategy === "worktree" &&
        runs.isResumableWorktreeRun(r.status, r.cwdStrategy)
    ) ?? null;

  // Always leave a breadcrumb on the task so it's visible even without autofix.
  // Scoped to a resumable target on purpose: an abandoned run (all candidates
  // closed/cancelled) records only the durable 'github' event, not a task note.
  if (target?.taskId && ctx.breadcrumb) {
    try {
      await repo.addNote(target.taskId, "github-webhook", ctx.breadcrumb);
    } catch {
      // ignore
    }
  }

  if (!autofixEnabled()) {
    // Loop disabled: keep today's note-only behavior — never escalate.
    if (target) actions.push(`noted ${reason} feedback on task ${target.taskId}`);
    return { target, triggered: false, actions };
  }
  if (!target) {
    // #4 Stranded-run policy: red CI for this task but NO resumable worktree run
    // to fix it in place (the run landed closed/cancelled). Escalate the task to
    // `blocked` so a human takes over, rather than going silent. (Alternative,
    // not chosen: spawn a fresh fixer agent — more invasive/costly; revisit if
    // desired.) Anchor the idempotency guard to the newest run we do have.
    const anchor = candidates.find((c) => c.taskId) ?? null;
    if (anchor?.taskId) {
      const escalated = await escalateExhausted(
        anchor.taskId,
        anchor.id,
        "CI is red but there is no live/resumable run to auto-fix — needs manual attention.",
        { reason, kind: "no_resumable_run", pr_url: ctx.prUrl ?? anchor.prUrl ?? null }
      );
      if (escalated)
        actions.push(`autofix escalated: task ${anchor.taskId} → blocked (no resumable run)`);
    }
    return { target: null, triggered: false, actions };
  }
  if (runs.isLive(target.id)) {
    actions.push(`autofix skipped: run #${target.id} already in flight`);
    return { target, triggered: false, actions };
  }
  if ((await countAutofixAttempts(target.id)) >= AUTOFIX_MAX) {
    actions.push(`autofix skipped: run #${target.id} hit attempt cap (${AUTOFIX_MAX})`);
    // #2 Non-convergence: the loop has retried AUTOFIX_MAX times and CI is still
    // red. Escalate to `blocked` (once) so a human is pulled in instead of
    // silently giving up.
    const escalated = await escalateExhausted(
      target.taskId!,
      target.id,
      `CI still red after ${AUTOFIX_MAX} autofix attempts — needs manual attention.`,
      {
        reason,
        kind: "attempt_cap",
        attempts: AUTOFIX_MAX,
        pr_url: ctx.prUrl ?? target.prUrl ?? null,
      }
    );
    if (escalated)
      actions.push(`autofix escalated: task ${target.taskId} → blocked (attempt cap)`);
    return { target, triggered: false, actions };
  }
  if (await recentlyAutofixed(target.id)) {
    actions.push(`autofix debounced: run #${target.id}`);
    return { target, triggered: false, actions };
  }

  // BUG 11: only record the attempt when the follow-up will ACTUALLY dispatch.
  // runs.followUp() silently no-ops if the run went live in the race (an
  // in-process turn started, or a detached worker claimed one cross-process) or
  // is no longer a resumable worktree run — but the attempt row used to be
  // inserted BEFORE firing it, so a no-op still consumed AUTOFIX_MAX budget and
  // armed the debounce. A flappy webhook burst could then exhaust the cap with
  // zero fix turns actually running and wrongly escalate the task to `blocked`.
  //
  // followUp returns void, so it gives no post-hoc dispatch signal; the safe fix
  // is to re-read the run immediately before recording and mirror followUp's own
  // gate (isLive / isLeaseLive / isWorkerLive + resumable-worktree shape). If it
  // would no-op, consume no budget and do not arm escalation. Residual (tiny)
  // race: the run could still go live between this re-check and followUp's own
  // internal re-check a couple of awaits later, in which case the attempt is
  // recorded but the turn no-ops — vastly narrower than the previous full
  // cap/debounce window, and the only remaining gap without editing runs.ts.
  const fresh = await runs.get(target.id);
  const willDispatch =
    !!fresh &&
    !runs.isLive(target.id) &&
    !runs.isLeaseLive(fresh) &&
    !runs.isWorkerLive(fresh) &&
    fresh.cwdStrategy === "worktree" &&
    !!fresh.branch &&
    !!fresh.worktreePath;
  if (!willDispatch) {
    actions.push(`autofix skipped: run #${target.id} went live before dispatch`);
    return { target, triggered: false, actions };
  }

  // The follow-up will dispatch: record the attempt (also powers the cap +
  // debounce checks) then kick the turn in the background — we don't block the
  // caller on a full agent turn.
  await db.insert(agentEvents).values({
    sessionId: target.id,
    type: "github_autofix",
    payload: JSON.stringify({
      reason,
      pr_url: ctx.prUrl ?? target.prUrl ?? null,
      conclusion: ctx.conclusion ?? null,
      workflow: ctx.workflowName ?? null,
    }),
    createdAt: new Date(),
  });

  const prompt = autofixPrompt(ctx, target.prUrl ?? ctx.prUrl ?? null);
  void runs
    .followUp(target.id, prompt, {
      author: "github-webhook",
      addProfiles: ["gh_pr", "gh_ci"],
    })
    .catch((err) => console.error("ci-autofix: follow-up failed:", err));

  actions.push(`autofix triggered: run #${target.id} (${reason})`);
  return { target, triggered: true, actions };
}

/**
 * Timestamp of the most recent "recovery" signal on a run: a merge, or a green
 * CI webhook (a recorded `github` event with `ci_state === "success"`). The
 * attempt cap and the exhausted-escalation guard are scoped to events AFTER
 * this so a PR that went green and then failed again gets a fresh attempt
 * budget — otherwise the all-time count plus the one-shot exhausted guard would
 * permanently wedge autofix off after a recover-then-refail. Null when the run
 * has never recovered.
 */
async function lastRecoveryAt(runId: number): Promise<Date | null> {
  const rows = await db
    .select({
      type: agentEvents.type,
      payload: agentEvents.payload,
      createdAt: agentEvents.createdAt,
    })
    .from(agentEvents)
    .where(eq(agentEvents.sessionId, runId))
    .orderBy(desc(agentEvents.id));
  for (const r of rows) {
    if (r.type === "pr_merged") return r.createdAt;
    if (r.type === "github") {
      try {
        if ((JSON.parse(r.payload) as { ci_state?: unknown }).ci_state === "success")
          return r.createdAt;
      } catch {
        // ignore malformed payloads
      }
    }
  }
  return null;
}

export async function countAutofixAttempts(runId: number): Promise<number> {
  const since = await lastRecoveryAt(runId);
  const rows = await db
    .select({ createdAt: agentEvents.createdAt })
    .from(agentEvents)
    .where(and(eq(agentEvents.sessionId, runId), eq(agentEvents.type, "github_autofix")));
  if (!since) return rows.length;
  const cutoff = since.getTime();
  return rows.filter((r) => r.createdAt.getTime() > cutoff).length;
}

export async function recentlyAutofixed(runId: number): Promise<boolean> {
  if (AUTOFIX_DEBOUNCE_MS <= 0) return false;
  const cutoff = Date.now() - AUTOFIX_DEBOUNCE_MS;
  const last = (
    await db
      .select({ type: agentEvents.type, createdAt: agentEvents.createdAt })
      .from(agentEvents)
      .where(eq(agentEvents.sessionId, runId))
      .orderBy(desc(agentEvents.id))
  ).find((r) => r.type === "github_autofix");
  return !!last && last.createdAt.getTime() >= cutoff;
}

/**
 * Terminal escalation for the autofix loop: transition the task to `blocked`
 * with a human-readable note and record ONE durable `github_autofix_exhausted`
 * event keyed to the anchor run.
 *
 * The event is the idempotency guard: the poller re-scans blocked tasks every
 * ~20s (blocked is not terminal), so without it the escalation would re-block
 * and re-note on every tick. We check for the guard first and only record it
 * AFTER a successful transition, so a task we couldn't actually escalate (wrong
 * state, illegal edge) never gets a phantom guard row that would suppress a
 * later, legitimate escalation.
 *
 * Best-effort: never throws — a failure to escalate one task must not abort the
 * poller loop over the others. Returns true iff it escalated on THIS call.
 */
async function escalateExhausted(
  taskId: string,
  anchorRunId: number,
  note: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  try {
    // Scope the one-shot guard to events since the last recovery: an exhausted
    // marker recorded BEFORE the PR recovered must not suppress a fresh
    // escalation after it fails again.
    const since = await lastRecoveryAt(anchorRunId);
    const already = await db
      .select({ createdAt: agentEvents.createdAt })
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.sessionId, anchorRunId),
          eq(agentEvents.type, "github_autofix_exhausted")
        )
      );
    const cutoff = since?.getTime() ?? -Infinity;
    if (already.some((r) => r.createdAt.getTime() > cutoff)) return false;

    const task = await repo.getTask(taskId);
    if (!task) return false;
    // Only escalate from a state where `blocked` is meaningful AND a legal edge.
    if (!ESCALATABLE_STATES.includes(task.state)) return false;
    if (!(TASK_TRANSITIONS[task.state] ?? []).includes("blocked")) return false;

    await repo.transitionTask(taskId, { state: "blocked", note });

    await db.insert(agentEvents).values({
      sessionId: anchorRunId,
      type: "github_autofix_exhausted",
      payload: JSON.stringify(payload),
      createdAt: new Date(),
    });
    return true;
  } catch (err) {
    console.error("ci-autofix: escalation failed:", err);
    return false;
  }
}

function autofixPrompt(ctx: AutofixContext, prUrl: string | null): string {
  const pr = prUrl ?? ctx.prUrl ?? "(this task's PR)";
  if (ctx.reason === "ci") {
    return [
      `GitHub CI reported a FAILURE on the pull request for this task: ${pr}.`,
      ctx.workflowName ? `Workflow/check: ${ctx.workflowName}.` : "",
      ctx.conclusion ? `Conclusion: ${ctx.conclusion}.` : "",
      ctx.headSha ? `Head commit: ${ctx.headSha}.` : "",
      ``,
      `You are back in the task's worktree on the PR branch. Use the gh_ci tools`,
      `(ci_runs then ci_logs) to fetch the failing logs for this PR, diagnose the`,
      `failure, and fix it. Commit your changes — they will be pushed to the same`,
      `branch to update the PR and re-trigger CI.`,
      ``,
      `If the failure is flaky/unrelated to this change or not actionable from the`,
      `code, do NOT make speculative edits: explain why and stop.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `A reviewer requested changes on the pull request for this task: ${pr}.`,
    ctx.actor ? `Reviewer: ${ctx.actor}.` : "",
    ctx.body ? `\nReview comment:\n${ctx.body}\n` : "",
    `You are back in the task's worktree on the PR branch. Address the feedback,`,
    `then commit — your changes will be pushed to update the PR. Use gh_pr__pr_view`,
    `/ gh_pr__pr_diff if you need more context on the current PR state.`,
    ``,
    CODE_REVIEW_RECEPTION_GUIDANCE,
  ]
    .filter(Boolean)
    .join("\n");
}
