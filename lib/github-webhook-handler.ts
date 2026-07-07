// GitHub webhook dispatch: route a normalized event to the runs it affects,
// persist it to the session event log (so the UI/SSE and agents can see CI &
// review feedback), and — for merges, CI failures and change requests — take
// the configured action.
//
// Pure parsing/verification/matching lives in lib/github-webhook.ts; this
// module owns the DB + agent SDK side effects.

import { isNotNull, or } from "drizzle-orm";

import { db } from "@/db";
import { agentEvents, agentSessions } from "@/db/schema";
import * as repo from "./repo";
import * as runs from "./runs";
import { ownerRepoFromRemote } from "./gh-url";
import { emitInboxEvent } from "./inbox";
import {
  mapWebhookToInboxType,
  selectMatchingRunIds,
  type CandidateRun,
  type NormalizedWebhookEvent,
} from "./github-webhook";
import { maybeTriggerAutofix } from "./ci-autofix";
import {
  applyTaskStateFromPr,
  fetchPrGithubState,
  type PrGithubStateFetcher,
} from "./pr-task-state";
import type { TaskFull } from "./types";

// A task an event applies to, plus a matched run (if any) to hang durable
// agent events (pr_merged) off of. Tasks are matched authoritatively by the
// explicit `tasks.pr_url` link, falling back to the run-based heuristic for
// legacy rows that predate `set_task_pr`.
interface MatchedTask {
  task: TaskFull;
  run: runs.RunRow | null;
}

export interface DispatchResult {
  matched: number;
  actions: string[];
}

export async function handleWebhookEvent(
  event: NormalizedWebhookEvent,
  deliveryId: string | null,
  // Injectable so tests can drive task state without touching the `gh`
  // subprocess. Production uses the real fetcher, which re-reads the PR's
  // rolled-up GitHub state — authoritative, unlike a single check's conclusion.
  fetchPrState: PrGithubStateFetcher = fetchPrGithubState
): Promise<DispatchResult> {
  const actions: string[] = [];

  // Candidates: any run carrying a PR url or a branch. Small in practice; the
  // pure matcher narrows by PR url / branch + repo.
  const candidateRows = (await db
    .select({
      id: agentSessions.id,
      prUrl: agentSessions.prUrl,
      branch: agentSessions.branch,
      repoId: agentSessions.repoId,
    })
    .from(agentSessions)
    .where(
      or(isNotNull(agentSessions.prUrl), isNotNull(agentSessions.branch))
    )) as CandidateRun[];

  const repoMap = await buildRepoOwnerMap(candidateRows);
  const matchedIds = selectMatchingRunIds(event, candidateRows, repoMap);

  // Record the event on every matched run (durable log + best-effort live push).
  for (const id of matchedIds) await recordEvent(id, event, deliveryId);

  // Inbox events (§3.2): one owner event per matched run (+ automatic
  // supervisor copy to its parent, handled inside emitInboxEvent). Best-effort
  // — inbox emission must never break the autofix/merge side effects below.
  const mapped = mapWebhookToInboxType(event);
  if (mapped) {
    for (const id of matchedIds) {
      void emitInboxEvent({
        targetRunId: id,
        type: mapped.type,
        payload: mapped.payload,
        sourceKind: "github",
        sourceId: deliveryId,
        dedupeKey: deliveryId ? `gh:${deliveryId}:${id}` : undefined,
      }).catch(() => {});
    }
  }

  // Side effects operate on full run rows; fetch them newest-first so "the
  // latest run for a task" is easy to pick.
  const matchedRuns = (await Promise.all(matchedIds.map((id) => runs.get(id))))
    .filter((r): r is NonNullable<typeof r> => r != null)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  // Task state is driven from GitHub via the same prToTaskState mapping the
  // poller uses, matched by the authoritative tasks.pr_url link (run-based
  // matching is only a fallback for legacy rows). This can find a task even
  // when no run matched — hence the early-return also considers matchedTasks.
  const matchedTasks = await resolveMatchedTasks(event, matchedRuns);

  if (matchedIds.length === 0 && matchedTasks.length === 0) {
    return { matched: 0, actions };
  }

  if (event.merged) {
    actions.push(...(await applyMerge(matchedTasks, event)));
    return { matched: matchedIds.length, actions };
  }

  // A CI/check completion drives the matched tasks to passing/failing/testing
  // from the PR's *rolled-up* GitHub state (re-read, not this one check's
  // conclusion). Runs before handleNeedsFix so the task is already `failing`
  // when the implementor is resumed to fix it.
  if (event.kind === "ci") {
    actions.push(...(await applyCiState(matchedTasks, event, fetchPrState)));
  }

  const isCiFailure = event.kind === "ci" && event.ciState === "failure";
  const isChangesRequested =
    event.kind === "review" && (event.conclusion ?? "") === "changes_requested";

  if (isCiFailure || isChangesRequested) {
    actions.push(
      ...(await handleNeedsFix(matchedRuns, event, isCiFailure ? "ci" : "review"))
    );
  }

  return { matched: matchedIds.length, actions };
}

/**
 * Resolve the tasks an event drives. Prefers the authoritative `tasks.pr_url`
 * link (one lookup per PR url on the event); falls back to the task owned by a
 * matched run for legacy rows that predate `set_task_pr`. Deduped by task id,
 * associating a matched run (newest first) for durable agent events.
 */
async function resolveMatchedTasks(
  event: NormalizedWebhookEvent,
  matchedRuns: runs.RunRow[]
): Promise<MatchedTask[]> {
  const byId = new Map<string, MatchedTask>();
  for (const url of event.prUrls) {
    const task = await repo.getTaskByPrUrl(url);
    if (task && !byId.has(task.id)) {
      const run = matchedRuns.find((r) => r.taskId === task.id) ?? null;
      byId.set(task.id, { task, run });
    }
  }
  for (const run of matchedRuns) {
    if (!run.taskId || byId.has(run.taskId)) continue;
    const task = await repo.getTask(run.taskId);
    if (task) byId.set(task.id, { task, run });
  }
  return [...byId.values()];
}

// ──────────────────────────────────────────────────────────
// Side effects
// ──────────────────────────────────────────────────────────

async function applyMerge(
  matchedTasks: MatchedTask[],
  event: NormalizedWebhookEvent
): Promise<string[]> {
  const actions: string[] = [];
  for (const { task, run } of matchedTasks) {
    const prev = task.state;
    try {
      // Route through the shared allowed-transition guard: prToTaskState maps a
      // merged PR → "merged", and applyTaskStateFromPr no-ops (rather than
      // throws) on an illegal edge.
      await applyTaskStateFromPr(
        { id: task.id, state: task.state },
        { merged: true, closed: false, ciConclusion: "none" }
      );
    } catch (err) {
      // A throw here is a real DB error, not an illegal edge (that's a no-op).
      try {
        await repo.addNote(
          task.id,
          "github-webhook",
          `PR merged but could not transition to merged: ${describe(err)}`
        );
      } catch {
        // ignore
      }
      continue;
    }
    const now = await repo.getTask(task.id);
    if (now?.state === "merged" && prev !== "merged") {
      // Preserve the durable pr_merged agent event (keyed to the run so the
      // UI/SSE surface it). Only recorded when a matched run exists.
      if (run) {
        await db
          .insert(agentEvents)
          .values({
            sessionId: run.id,
            type: "pr_merged",
            payload: JSON.stringify({ url: event.prUrls[0] ?? run.prUrl ?? task.prUrl }),
            createdAt: new Date(),
          });
      }
      actions.push(`task ${task.id} → merged`);
    }
  }
  return actions;
}

/**
 * Drive matched tasks from the PR's real GitHub state on a CI/check completion.
 * Re-reads the rolled-up CI state (authoritative — a single check's conclusion
 * is one of many) and funnels through applyTaskStateFromPr, the same shared
 * path the poller uses, so this naturally yields failing/passing/testing.
 */
async function applyCiState(
  matchedTasks: MatchedTask[],
  event: NormalizedWebhookEvent,
  fetchPrState: PrGithubStateFetcher
): Promise<string[]> {
  const actions: string[] = [];
  for (const { task } of matchedTasks) {
    const prUrl = task.prUrl ?? event.prUrls[0] ?? null;
    if (!prUrl) continue;
    let ghState;
    try {
      ghState = await fetchPrState(prUrl);
    } catch (err) {
      console.warn(`github-webhook: fetchPrGithubState failed for ${prUrl}:`, describe(err));
      continue;
    }
    if (!ghState) continue;
    const prev = task.state;
    // An already-blocked task with still-red CI has been escalated (or its PR
    // was closed) and is awaiting a human — a stray CI-failure webhook must not
    // drag it back to `failing`. Recovery (green/merged) is not skipped.
    const redAndOpen =
      ghState.ciConclusion === "failure" && !ghState.merged && !ghState.closed;
    if (redAndOpen && prev === "blocked") continue;
    try {
      await applyTaskStateFromPr({ id: task.id, state: task.state }, ghState);
    } catch (err) {
      console.error(`github-webhook: task ${task.id} CI sync failed:`, describe(err));
      continue;
    }
    const now = await repo.getTask(task.id);
    if (now && now.state !== prev) actions.push(`task ${task.id} → ${now.state}`);
  }
  return actions;
}

async function handleNeedsFix(
  matchedRuns: runs.RunRow[],
  event: NormalizedWebhookEvent,
  reason: "ci" | "review"
): Promise<string[]> {
  // matchedRuns are already sorted newest-first by the caller. Delegate the
  // target selection + gating + follow-up kick to the shared trigger, which the
  // poller also calls — the `github_autofix` events it records dedupe the two
  // paths against each other.
  const { actions } = await maybeTriggerAutofix(matchedRuns, {
    reason,
    prUrl: event.prUrls[0] ?? null,
    workflowName: event.workflowName,
    conclusion: event.conclusion,
    headSha: event.headSha,
    actor: event.actor,
    body: event.body,
    breadcrumb: noteFor(event, reason),
  });
  return actions;
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

async function recordEvent(
  runId: number,
  event: NormalizedWebhookEvent,
  deliveryId: string | null
): Promise<void> {
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
    await db
      .insert(agentEvents)
      .values({
        sessionId: runId,
        type: "github",
        payload: JSON.stringify(payload),
        createdAt: new Date(),
      });
  } catch (err) {
    console.error("github-webhook: failed to persist event:", err);
  }
  // Best-effort live push to any connected SSE client (only fires while a
  // runner is in flight; the durable row above is the reliable surface).
  runs.emitRunEvent(runId, "github", payload);
}

async function buildRepoOwnerMap(
  candidates: CandidateRun[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c.repoId || seen.has(c.repoId)) continue;
    seen.add(c.repoId);
    const r = await repo.getRepository(c.repoId);
    const or2 = ownerRepoFromRemote(r?.remote ?? null);
    if (or2) map.set(c.repoId, `${or2.owner}/${or2.repo}`);
  }
  return map;
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

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}
