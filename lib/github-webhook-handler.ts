// GitHub webhook dispatch: route a normalized event to the runs it affects,
// persist it to the session event log (so the UI/SSE and agents can see CI &
// review feedback), and — for merges, CI failures and change requests — take
// the configured action.
//
// Pure parsing/verification/matching lives in lib/github-webhook.ts; this
// module owns the DB + agent SDK side effects.

import { and, desc, eq, isNotNull, or } from "drizzle-orm";

import { db } from "@/db";
import { agentEvents, agentSessions } from "@/db/schema";
import * as repo from "./repo";
import * as runs from "./runs";
import { ownerRepoFromRemote } from "./gh-url";
import {
  autofixEnabledFor,
  selectMatchingRunIds,
  type CandidateRun,
  type NormalizedWebhookEvent,
} from "./github-webhook";

// Auto-fix: when CI fails (or a reviewer requests changes) on a task's PR,
// resume the agent on the same branch to fix it. On by default — the
// orchestrator watches every PR's CI and fixes failures in place. Set
// TASK_ORCH_CI_AUTOFIX=0 (or false/no/off) to disable.
const AUTOFIX_ENABLED = autofixEnabledFor(process.env.TASK_ORCH_CI_AUTOFIX);
// Cap auto-fix attempts per run so a persistently-red PR can't loop forever.
const AUTOFIX_MAX = Math.max(0, Number(process.env.TASK_ORCH_CI_AUTOFIX_MAX ?? 3));
// Debounce: ignore repeat triggers within this window (a single push fans out
// into many check_run/workflow_run/check_suite deliveries).
const AUTOFIX_DEBOUNCE_MS = Math.max(
  0,
  Number(process.env.TASK_ORCH_CI_AUTOFIX_DEBOUNCE_MS ?? 120_000)
);

export interface DispatchResult {
  matched: number;
  actions: string[];
}

export async function handleWebhookEvent(
  event: NormalizedWebhookEvent,
  deliveryId: string | null
): Promise<DispatchResult> {
  const actions: string[] = [];

  // Candidates: any run carrying a PR url or a branch. Small in practice; the
  // pure matcher narrows by PR url / branch + repo.
  const candidateRows = db
    .select({
      id: agentSessions.id,
      prUrl: agentSessions.prUrl,
      branch: agentSessions.branch,
      repoId: agentSessions.repoId,
    })
    .from(agentSessions)
    .where(or(isNotNull(agentSessions.prUrl), isNotNull(agentSessions.branch)))
    .all() as CandidateRun[];

  const repoMap = buildRepoOwnerMap(candidateRows);
  const matchedIds = selectMatchingRunIds(event, candidateRows, repoMap);
  if (matchedIds.length === 0) return { matched: 0, actions };

  // Record the event on every matched run (durable log + best-effort live push).
  for (const id of matchedIds) recordEvent(id, event, deliveryId);

  // Side effects operate on full run rows; fetch them newest-first so "the
  // latest run for a task" is easy to pick.
  const matchedRuns = matchedIds
    .map((id) => runs.get(id))
    .filter((r): r is NonNullable<typeof r> => r != null)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  if (event.merged) {
    actions.push(...applyMerge(matchedRuns, event));
    return { matched: matchedIds.length, actions };
  }

  const isCiFailure = event.kind === "ci" && event.ciState === "failure";
  const isChangesRequested =
    event.kind === "review" && (event.conclusion ?? "") === "changes_requested";

  if (isCiFailure || isChangesRequested) {
    actions.push(
      ...handleNeedsFix(matchedRuns, event, isCiFailure ? "ci" : "review")
    );
  }

  return { matched: matchedIds.length, actions };
}

// ──────────────────────────────────────────────────────────
// Side effects
// ──────────────────────────────────────────────────────────

function applyMerge(
  matchedRuns: runs.RunRow[],
  event: NormalizedWebhookEvent
): string[] {
  const actions: string[] = [];
  const seenTasks = new Set<string>();
  for (const run of matchedRuns) {
    if (!run.taskId || seenTasks.has(run.taskId)) continue;
    seenTasks.add(run.taskId);
    const task = repo.getTask(run.taskId);
    if (!task) continue;
    if (task.state !== "in_progress" && task.state !== "review") continue;
    try {
      repo.transitionTask(run.taskId, {
        state: "done",
        note: `PR merged: ${event.prUrls[0] ?? run.prUrl ?? "(unknown)"}`,
        // A merged PR is authoritative — close it even if criteria were never
        // ticked, matching the merge poller's behavior.
        bypassCriteria: true,
      });
      db.insert(agentEvents)
        .values({
          sessionId: run.id,
          type: "pr_merged",
          payload: JSON.stringify({ url: event.prUrls[0] ?? run.prUrl }),
          createdAt: new Date(),
        })
        .run();
      actions.push(`task ${run.taskId} → done (merged)`);
    } catch (err) {
      try {
        repo.addNote(
          run.taskId,
          "github-webhook",
          `PR merged but could not transition to done: ${describe(err)}`
        );
      } catch {
        // ignore
      }
    }
  }
  return actions;
}

function handleNeedsFix(
  matchedRuns: runs.RunRow[],
  event: NormalizedWebhookEvent,
  reason: "ci" | "review"
): string[] {
  const actions: string[] = [];

  // Pick the newest run that owns a task and a worktree branch — that's the
  // one whose PR this feedback is about and that we can resume in place.
  const target = matchedRuns.find(
    (r) =>
      r.taskId &&
      r.branch &&
      r.worktreePath &&
      r.cwdStrategy === "worktree"
  );

  // Always leave a breadcrumb on the task so it's visible even without autofix.
  if (target?.taskId) {
    try {
      repo.addNote(target.taskId, "github-webhook", noteFor(event, reason));
    } catch {
      // ignore
    }
  }

  if (!AUTOFIX_ENABLED) {
    if (target) actions.push(`noted ${reason} feedback on task ${target.taskId}`);
    return actions;
  }
  if (!target) return actions;
  if (runs.isLive(target.id)) {
    actions.push(`autofix skipped: run #${target.id} already in flight`);
    return actions;
  }
  if (countAutofixAttempts(target.id) >= AUTOFIX_MAX) {
    actions.push(`autofix skipped: run #${target.id} hit attempt cap (${AUTOFIX_MAX})`);
    return actions;
  }
  if (recentlyAutofixed(target.id)) {
    actions.push(`autofix debounced: run #${target.id}`);
    return actions;
  }

  // Record the attempt up front (also powers the cap + debounce checks) then
  // kick the follow-up turn in the background — we don't block the webhook
  // response on a full agent turn.
  db.insert(agentEvents)
    .values({
      sessionId: target.id,
      type: "github_autofix",
      payload: JSON.stringify({
        reason,
        pr_url: event.prUrls[0] ?? target.prUrl ?? null,
        conclusion: event.conclusion,
        workflow: event.workflowName,
      }),
      createdAt: new Date(),
    })
    .run();

  const prompt = autofixPrompt(event, reason, target.prUrl ?? event.prUrls[0] ?? null);
  void runs
    .followUp(target.id, prompt, {
      author: "github-webhook",
      addProfiles: ["gh_pr", "gh_ci"],
    })
    .catch((err) => console.error("github-webhook: autofix follow-up failed:", err));

  actions.push(`autofix triggered: run #${target.id} (${reason})`);
  return actions;
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function recordEvent(
  runId: number,
  event: NormalizedWebhookEvent,
  deliveryId: string | null
): void {
  const payload = {
    kind: event.kind,
    event: event.event,
    action: event.action,
    ci_state: event.ciState,
    conclusion: event.conclusion,
    pr_url: event.prUrls[0] ?? null,
    branch: event.branch,
    head_sha: event.headSha,
    workflow: event.workflowName,
    actor: event.actor,
    merged: event.merged,
    url: event.url,
    summary: event.summary,
    delivery_id: deliveryId,
  };
  try {
    db.insert(agentEvents)
      .values({
        sessionId: runId,
        type: "github",
        payload: JSON.stringify(payload),
        createdAt: new Date(),
      })
      .run();
  } catch (err) {
    console.error("github-webhook: failed to persist event:", err);
  }
  // Best-effort live push to any connected SSE client (only fires while a
  // runner is in flight; the durable row above is the reliable surface).
  runs.emitRunEvent(runId, "github", payload);
}

function buildRepoOwnerMap(candidates: CandidateRun[]): Map<string, string> {
  const map = new Map<string, string>();
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c.repoId || seen.has(c.repoId)) continue;
    seen.add(c.repoId);
    const r = repo.getRepository(c.repoId);
    const or2 = ownerRepoFromRemote(r?.remote ?? null);
    if (or2) map.set(c.repoId, `${or2.owner}/${or2.repo}`);
  }
  return map;
}

function countAutofixAttempts(runId: number): number {
  return db
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .where(
      and(eq(agentEvents.sessionId, runId), eq(agentEvents.type, "github_autofix"))
    )
    .all().length;
}

function recentlyAutofixed(runId: number): boolean {
  if (AUTOFIX_DEBOUNCE_MS <= 0) return false;
  const cutoff = Date.now() - AUTOFIX_DEBOUNCE_MS;
  const last = db
    .select({ type: agentEvents.type, createdAt: agentEvents.createdAt })
    .from(agentEvents)
    .where(eq(agentEvents.sessionId, runId))
    .orderBy(desc(agentEvents.id))
    .all()
    .find((r) => r.type === "github_autofix");
  return !!last && last.createdAt.getTime() >= cutoff;
}

function noteFor(event: NormalizedWebhookEvent, reason: "ci" | "review"): string {
  if (reason === "ci") {
    return (
      `CI failed on the PR — ${event.summary}` +
      (event.url ? ` (${event.url})` : "") +
      (event.headSha ? ` @ ${event.headSha.slice(0, 8)}` : "")
    );
  }
  const body = event.body ? `\n\n> ${event.body.replace(/\n/g, "\n> ")}` : "";
  return `Reviewer requested changes${event.actor ? ` (${event.actor})` : ""}.${body}`;
}

function autofixPrompt(
  event: NormalizedWebhookEvent,
  reason: "ci" | "review",
  prUrl: string | null
): string {
  const pr = prUrl ?? event.prUrls[0] ?? "(this task's PR)";
  if (reason === "ci") {
    return [
      `GitHub CI reported a FAILURE on the pull request for this task: ${pr}.`,
      event.workflowName ? `Workflow/check: ${event.workflowName}.` : "",
      event.conclusion ? `Conclusion: ${event.conclusion}.` : "",
      event.headSha ? `Head commit: ${event.headSha}.` : "",
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
    event.actor ? `Reviewer: ${event.actor}.` : "",
    event.body ? `\nReview comment:\n${event.body}\n` : "",
    `You are back in the task's worktree on the PR branch. Address the feedback,`,
    `then commit — your changes will be pushed to update the PR. Use gh_pr__pr_view`,
    `/ gh_pr__pr_diff if you need more context on the current PR state.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}
