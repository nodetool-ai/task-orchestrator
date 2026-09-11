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

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { resolveLiveness } from "@/lib/run-liveness";
import { agentEvents, agentSessions, runTurns } from "@/db/schema";
import { CODE_REVIEW_RECEPTION_GUIDANCE } from "./code-review-guidance";
import { emitInboxEvent } from "./inbox";
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
  startedAt?: Date;
  attempt?: number;
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

  const resumable =
    candidates.find(
      (r) =>
        r.taskId &&
        r.branch &&
        r.worktreePath &&
        r.cwdStrategy === "worktree" &&
        runs.isResumableWorktreeRun(r.status, r.cwdStrategy)
    ) ?? null;
  // A newer generation owns the task even while it is queued or starting. Do
  // not revive an older settled generation underneath it (runs 243/244/245).
  const newest = candidates[0] ?? null;
  const target =
    resumable && newest && newest.id !== resumable.id &&
    ["pending", "preparing", "running"].includes(newest.status)
      ? null
      : resumable;

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
    if (newest && ["pending", "preparing", "running"].includes(newest.status)) {
      actions.push(`autofix skipped: newer run #${newest.id} owns the task (${newest.status})`);
      return { target: null, triggered: false, actions };
    }
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
  if ((await countTaskAutofixAttempts(target.taskId!)) >= AUTOFIX_MAX) {
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
  if (await recentlyAutofixedForTask(target.taskId!, failureKey(ctx))) {
    actions.push(`autofix debounced: run #${target.id}`);
    return { target, triggered: false, actions };
  }

  // Avoid provisional claims for an already-live/non-resumable target. The
  // task-locked followUp admission below is the final authority and reports a
  // rejection so its exact provisional event can be retracted.
  const fresh = await runs.get(target.id);
  const willDispatch =
    !!fresh &&
    !runs.isLive(target.id) &&
    (await resolveLiveness(target.id)).verdict !== "alive" &&
    fresh.cwdStrategy === "worktree" &&
    !!fresh.branch &&
    !!fresh.worktreePath;
  if (!willDispatch) {
    actions.push(`autofix skipped: run #${target.id} went live before dispatch`);
    return { target, triggered: false, actions };
  }
  const claimedRunAttempt = fresh.deliveryVersion !== 2
    ? null
    : ["completed", "failed"].includes(fresh.status)
      ? fresh.attempt + 1
      : fresh.attempt;

  // Claim one repair owner atomically across webhook processes and the poller.
  // The advisory lock shares the task admission namespace used by runs.create.
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${target.taskId!}))`);
    const siblings = await tx.select({ id: agentSessions.id, status: agentSessions.status })
      .from(agentSessions).where(eq(agentSessions.taskId, target.taskId!))
      .orderBy(desc(agentSessions.startedAt), desc(agentSessions.id));
    const latest = siblings[0];
    if (latest && latest.id !== target.id && ["pending", "preparing", "running"].includes(latest.status)) return false;
    const ids = siblings.map((s) => s.id);
    if (ids.length) {
      const budgetEvents = await tx.select({ sessionId: agentEvents.sessionId, type: agentEvents.type,
        payload: agentEvents.payload, createdAt: agentEvents.createdAt })
        .from(agentEvents).where(and(inArray(agentEvents.sessionId, ids), inArray(agentEvents.type,
          ["github_autofix", "github_ci_aggregate", "pr_merged"])))
        .orderBy(desc(agentEvents.id));
      const begun = await tx.select({ runId: runTurns.runId, attempt: runTurns.attempt })
        .from(runTurns).where(inArray(runTurns.runId, ids));
      if (effectiveAttemptCount(budgetEvents, new Set(begun.map((t) => `${t.runId}:${t.attempt}`))) >= AUTOFIX_MAX) return false;
      const prior = budgetEvents.filter((e) => e.type === "github_autofix");
      if (prior.some((e) => e.createdAt.getTime() >= Date.now() - AUTOFIX_DEBOUNCE_MS)) return false;
    }
    const inserted = await tx.insert(agentEvents).values({
      sessionId: target.id,
      type: "github_autofix",
      payload: JSON.stringify({ reason, pr_url: ctx.prUrl ?? target.prUrl ?? null,
        conclusion: ctx.conclusion ?? null, workflow: ctx.workflowName ?? null,
        head_sha: ctx.headSha ?? null, failure_key: failureKey(ctx),
        ...(claimedRunAttempt == null ? {} : { run_attempt: claimedRunAttempt }) }),
      createdAt: new Date(),
    }).returning({ id: agentEvents.id });
    return inserted[0]?.id ?? null;
  });
  if (!claimed) {
    actions.push(`autofix deduped: task ${target.taskId} already has a repair owner`);
    return { target, triggered: false, actions };
  }

  const prompt = autofixPrompt(ctx, target.prUrl ?? ctx.prUrl ?? null);
  void runs.followUp(target.id, prompt, {
      author: "github-webhook",
      addProfiles: ["gh_pr", "gh_ci"],
    })
    .then(async (accepted) => {
      if (accepted !== false) return;
      // The final task/run admission gate won a race. Retract only this exact
      // provisional claim so a turn that never started consumes no budget.
      await db.delete(agentEvents).where(eq(agentEvents.id, claimed));
    })
    .catch((err) => console.error("ci-autofix: follow-up failed:", err));

  actions.push(`autofix triggered: run #${target.id} (${reason})`);
  return { target, triggered: true, actions };
}

/**
 * Timestamp of the most recent authoritative aggregate recovery on a run.
 * Raw per-check success events are deliberately ignored: one passing check
 * cannot reset a repair budget while another required check remains red. The
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
    if (r.type === "github_ci_aggregate") return r.createdAt;
  }
  return null;
}

async function taskRunIds(taskId: string): Promise<number[]> {
  return (await db.select({ id: agentSessions.id }).from(agentSessions)
    .where(eq(agentSessions.taskId, taskId))).map((r) => r.id);
}

/** Task-wide budget survives replacement runs. Infrastructure-only worker
 * starts are refunded by the durable signal emitted by dispatch recovery. */
export async function countTaskAutofixAttempts(taskId: string): Promise<number> {
  const ids = await taskRunIds(taskId);
  if (!ids.length) return 0;
  const events = await db.select({ sessionId: agentEvents.sessionId, type: agentEvents.type,
    payload: agentEvents.payload, createdAt: agentEvents.createdAt })
    .from(agentEvents).where(and(inArray(agentEvents.sessionId, ids),
      inArray(agentEvents.type, ["github_autofix", "github_ci_aggregate", "pr_merged"])))
    .orderBy(desc(agentEvents.id));
  const begun = await db.select({ runId: runTurns.runId, attempt: runTurns.attempt })
    .from(runTurns).where(inArray(runTurns.runId, ids));
  return effectiveAttemptCount(events, new Set(begun.map((t) => `${t.runId}:${t.attempt}`)));
}

function effectiveAttemptCount(
  events: Array<{ sessionId: number; type: string; payload?: string; createdAt: Date }>,
  begunAttempts: ReadonlySet<string>
): number {
  const recovery = events.find((e) => e.type === "github_ci_aggregate" || e.type === "pr_merged")?.createdAt.getTime() ?? -Infinity;
  let attempts = 0;
  for (const event of [...events].reverse()) {
    if (event.createdAt.getTime() <= recovery) continue;
    if (event.type === "github_autofix") {
      const runAttempt = payloadAttempt(event.payload);
      // New-format claims become budget attempts only when a logical turn has
      // actually begun. Legacy claims lack run_attempt and retain old counting.
      if (runAttempt != null && !begunAttempts.has(`${event.sessionId}:${runAttempt}`)) continue;
      attempts += 1;
    }
  }
  return attempts;
}

function payloadAttempt(payload?: string): number | null {
  try { const n = (JSON.parse(payload ?? "{}") as { run_attempt?: unknown }).run_attempt; return typeof n === "number" ? n : null; }
  catch { return null; }
}

function failureKey(ctx: AutofixContext): string {
  // CI admission is based on the authoritative aggregate re-read, so the
  // individual workflow delivery that happened to trigger that read is not a
  // distinct failure. Review feedback retains its actor/body identity.
  return ctx.reason === "ci"
    ? ["ci", ctx.headSha ?? "unknown-head", ctx.conclusion ?? "failure"].join(":")
    : ["review", ctx.headSha ?? "unknown-head", ctx.actor ?? "unknown", ctx.body ?? "changes_requested"].join(":");
}
function eventFailureKey(payload: string): string | null {
  try { return (JSON.parse(payload) as { failure_key?: string }).failure_key ?? null; } catch { return null; }
}

async function recentlyAutofixedForTask(taskId: string, key: string): Promise<boolean> {
  if (AUTOFIX_DEBOUNCE_MS <= 0) return false;
  const ids = await taskRunIds(taskId);
  if (!ids.length) return false;
  const cutoff = Date.now() - AUTOFIX_DEBOUNCE_MS;
  const rows = await db.select({ payload: agentEvents.payload, createdAt: agentEvents.createdAt })
    .from(agentEvents).where(and(inArray(agentEvents.sessionId, ids), eq(agentEvents.type, "github_autofix")))
    .orderBy(desc(agentEvents.id));
  return rows.some((r) => r.createdAt.getTime() >= cutoff && eventFailureKey(r.payload) === key);
}

/** Record only an authoritative rolled-up green result. A single successful
 * check webhook never calls this and therefore cannot reset repair budget. */
export async function recordAggregateCiGreen(taskId: string, headSha: string | null): Promise<void> {
  const rows = await db.select({ id: agentSessions.id }).from(agentSessions)
    .where(eq(agentSessions.taskId, taskId)).orderBy(desc(agentSessions.startedAt), desc(agentSessions.id)).limit(1);
  if (!rows[0]) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${taskId}))`);
    const ids = await tx.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.taskId, taskId));
    const recent = await tx.select({ type: agentEvents.type, payload: agentEvents.payload }).from(agentEvents)
      .where(and(inArray(agentEvents.sessionId, ids.map((r) => r.id)),
        inArray(agentEvents.type, ["github_ci_aggregate", "github_autofix"])))
      .orderBy(desc(agentEvents.id)).limit(1);
    try { if (recent[0]?.type === "github_ci_aggregate" &&
      (JSON.parse(recent[0].payload) as { head_sha?: string | null }).head_sha === headSha) return; } catch {}
    await tx.insert(agentEvents).values({ sessionId: rows[0].id, type: "github_ci_aggregate",
      payload: JSON.stringify({ ci_state: "success", head_sha: headSha }), createdAt: new Date() });
  });
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
    const runIds = await taskRunIds(taskId);
    const recoveries = runIds.length ? await db.select({ createdAt: agentEvents.createdAt })
      .from(agentEvents).where(and(inArray(agentEvents.sessionId, runIds),
        inArray(agentEvents.type, ["github_ci_aggregate", "pr_merged"])))
      .orderBy(desc(agentEvents.id)).limit(1) : [];
    const since = recoveries[0]?.createdAt ?? null;
    const already = await db
      .select({ createdAt: agentEvents.createdAt })
      .from(agentEvents)
      .where(
        and(
          inArray(agentEvents.sessionId, runIds.length ? runIds : [anchorRunId]),
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

    const [exhaustedEvent] = await db.insert(agentEvents).values({
      sessionId: anchorRunId,
      type: "github_autofix_exhausted",
      payload: JSON.stringify(payload),
      createdAt: new Date(),
    }).returning({ id: agentEvents.id });

    // Wake the supervising executor with a terminal coordination fact. This is
    // deliberately NOT another CI repair request: the task is already blocked,
    // and the executor's spawn tools reject attempts to bypass that state. The
    // parent can now report the blocker promptly without polling CI itself.
    const anchorRun = await runs.get(anchorRunId);
    if (anchorRun?.parentRunId != null && exhaustedEvent) {
      await emitInboxEvent({
        targetRunId: anchorRun.parentRunId,
        type: "ci.autofix_exhausted",
        sourceKind: "system",
        sourceId: String(anchorRunId),
        dedupeKey: `ci-autofix-exhausted:${exhaustedEvent.id}`,
        payload: {
          task_id: taskId,
          child_run_id: anchorRunId,
          state: "blocked",
          note,
          ...payload,
        },
      }).catch((err) =>
        console.error("ci-autofix: failed to notify supervising executor:", err)
      );
    }
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
      `failure, and fix it. Commit your changes, fetch origin and reconcile any`,
      `newer task-branch commits, then push the branch yourself to update the PR`,
      `and re-trigger CI. Verify the push succeeds before reporting success.`,
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
    `then commit, fetch origin and reconcile newer task-branch commits, and push`,
    `the branch yourself. Verify the push succeeds before reporting success. Use gh_pr__pr_view`,
    `/ gh_pr__pr_diff if you need more context on the current PR state.`,
    ``,
    CODE_REVIEW_RECEPTION_GUIDANCE,
  ]
    .filter(Boolean)
    .join("\n");
}
