import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import {
  autofixEnabledFor,
  canonicalizePrUrl,
  parseWebhookEvent,
  selectMatchingRunIds,
  verifySignature,
  type CandidateRun,
  type NormalizedWebhookEvent,
} from "../lib/github-webhook";

// Stub runs.followUp so a *targeted* autofix never spawns a real agent turn.
// Everything else in lib/runs (isResumableWorktreeRun, get, isLive,
// emitRunEvent) stays real, so the handler's actual gating is exercised.
const { mockFollowUp } = vi.hoisted(() => ({
  mockFollowUp: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock("../lib/runs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runs")>();
  return { ...actual, followUp: mockFollowUp };
});

// Spy on the delivery-pump hint. The handler must not wake a matched run
// before it has decided whether autofix owns it: the wake dispatches an idle
// run, and a dispatched run reads as live, which used to make autofix skip the
// follow-up — or find no resumable run and escalate the task to `blocked` —
// depending on which side of the race won. Kept real (the tests below assert
// when it fires, not that it does nothing).
const { mockHintDelivery } = vi.hoisted(() => ({
  mockHintDelivery: vi.fn(() => {}),
}));
vi.mock("../lib/run-event-delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/run-event-delivery")>();
  return { ...actual, hintRunEventDelivery: mockHintDelivery };
});

import { db } from "../db";
import {
  agentEvents,
  agentSessions,
  inboxEvents,
  runEventSubscriptions,
  runSourceEvents,
  plans,
  repositories,
  taskNotes,
  tasks,
} from "../db/schema";
import { handleWebhookEvent } from "../lib/github-webhook-handler";
import * as repo from "../lib/repo";
import type { PrGithubState } from "../lib/pr-task-state";

// A fetcher that always returns the given GitHub state, ignoring the url — so
// task-state driving never spawns a real `gh` subprocess in tests.
const fakeFetch = (s: PrGithubState) => async () => s;
const gh = (over: Partial<PrGithubState> = {}): PrGithubState => ({
  merged: false,
  closed: false,
  ciConclusion: "none",
  ...over,
});

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("verifySignature", () => {
  const secret = "s3cr3t";
  const body = JSON.stringify({ hello: "world" });

  it("accepts a correct signature", () => {
    expect(verifySignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifySignature(body + "x", sign(body, secret), secret)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifySignature(body, sign(body, "other"), secret)).toBe(false);
  });

  it("rejects missing signature or secret", () => {
    expect(verifySignature(body, null, secret)).toBe(false);
    expect(verifySignature(body, sign(body, secret), "")).toBe(false);
  });

  it("rejects a malformed (wrong-length) signature without throwing", () => {
    expect(verifySignature(body, "sha256=deadbeef", secret)).toBe(false);
  });
});

describe("canonicalizePrUrl", () => {
  it("normalizes https and short forms to a lowercased key", () => {
    const a = canonicalizePrUrl("https://github.com/Owner/Repo/pull/42");
    const b = canonicalizePrUrl("https://github.com/owner/repo/pull/42#discussion");
    expect(a).toBe("https://github.com/owner/repo/pull/42");
    expect(a).toBe(b);
  });
  it("returns null for non-PR urls", () => {
    expect(canonicalizePrUrl("https://github.com/owner/repo/issues/42")).toBeNull();
    expect(canonicalizePrUrl(null)).toBeNull();
  });
});

describe("parseWebhookEvent", () => {
  it("parses a merged pull_request", () => {
    const e = parseWebhookEvent("pull_request", {
      action: "closed",
      repository: { full_name: "acme/widgets" },
      sender: { login: "alice" },
      pull_request: {
        html_url: "https://github.com/acme/widgets/pull/7",
        merged: true,
        state: "closed",
        head: { ref: "feature-x", sha: "abc123" },
      },
    });
    expect(e).not.toBeNull();
    expect(e!.kind).toBe("pr");
    expect(e!.merged).toBe(true);
    expect(e!.prUrls).toEqual(["https://github.com/acme/widgets/pull/7"]);
    expect(e!.branch).toBe("feature-x");
  });

  it("parses a failed check_suite and rolls up CI state", () => {
    const e = parseWebhookEvent("check_suite", {
      action: "completed",
      repository: { full_name: "acme/widgets" },
      check_suite: {
        status: "completed",
        conclusion: "failure",
        head_branch: "claude/t-1-9",
        head_sha: "deadbeef",
        pull_requests: [{ number: 7 }],
        app: { name: "GitHub Actions" },
      },
    });
    expect(e!.kind).toBe("ci");
    expect(e!.ciState).toBe("failure");
    expect(e!.branch).toBe("claude/t-1-9");
    expect(e!.prUrls).toEqual(["https://github.com/acme/widgets/pull/7"]);
  });

  it("treats an in-progress workflow_run as pending", () => {
    const e = parseWebhookEvent("workflow_run", {
      action: "requested",
      repository: { full_name: "acme/widgets" },
      workflow_run: {
        name: "CI",
        status: "in_progress",
        conclusion: null,
        head_branch: "main",
        head_sha: "f00",
        pull_requests: [],
      },
    });
    expect(e!.kind).toBe("ci");
    expect(e!.ciState).toBe("pending");
  });

  it("parses a changes_requested review", () => {
    const e = parseWebhookEvent("pull_request_review", {
      action: "submitted",
      repository: { full_name: "acme/widgets" },
      review: {
        state: "changes_requested",
        body: "please fix the types",
        user: { login: "bob" },
        html_url: "https://github.com/acme/widgets/pull/7#r1",
      },
      pull_request: {
        html_url: "https://github.com/acme/widgets/pull/7",
        head: { ref: "feature-x", sha: "abc" },
      },
    });
    expect(e!.kind).toBe("review");
    expect(e!.conclusion).toBe("changes_requested");
    expect(e!.actor).toBe("bob");
    expect(e!.body).toBe("please fix the types");
  });

  it("parses an issue_comment only when it is on a PR", () => {
    const onPr = parseWebhookEvent("issue_comment", {
      action: "created",
      repository: { full_name: "acme/widgets" },
      issue: { number: 7, pull_request: { url: "..." } },
      comment: { body: "hi", user: { login: "carol" } },
    });
    expect(onPr!.kind).toBe("comment");
    expect(onPr!.prUrls).toEqual(["https://github.com/acme/widgets/pull/7"]);

    const onIssue = parseWebhookEvent("issue_comment", {
      action: "created",
      repository: { full_name: "acme/widgets" },
      issue: { number: 7 },
      comment: { body: "hi" },
    });
    expect(onIssue).toBeNull();
  });

  it("returns null for unhandled events", () => {
    expect(parseWebhookEvent("push", { ref: "refs/heads/main" })).toBeNull();
    expect(parseWebhookEvent("pull_request", {})).toBeNull();
  });
});

describe("selectMatchingRunIds", () => {
  const repoMap = new Map<string, string>([["R1", "acme/widgets"]]);

  const candidates: CandidateRun[] = [
    { id: 1, prUrl: "https://github.com/acme/widgets/pull/7", branch: "feature-x", repoId: "R1" },
    { id: 2, prUrl: null, branch: "claude/t-1-9", repoId: "R1" },
    { id: 3, prUrl: null, branch: "claude/t-1-9", repoId: "R2" }, // different repo, same branch name
  ];

  it("matches by PR url regardless of case/fragment", () => {
    const ids = selectMatchingRunIds(
      {
        kind: "ci",
        event: "check_suite",
        action: "completed",
        repoFullName: "ACME/Widgets",
        prUrls: ["https://github.com/acme/widgets/pull/7"],
        branch: null,
        headSha: null,
        ciState: "failure",
        conclusion: "failure",
        merged: false,
        prState: null,
        workflowName: null,
        actor: null,
        body: null,
        url: null,
        summary: "",
      },
      candidates,
      repoMap
    );
    expect(ids).toEqual([1]);
  });

  it("matches by branch only when the repo also matches", () => {
    const ids = selectMatchingRunIds(
      {
        kind: "ci",
        event: "check_suite",
        action: "completed",
        repoFullName: "acme/widgets",
        prUrls: [],
        branch: "claude/t-1-9",
        headSha: null,
        ciState: "failure",
        conclusion: "failure",
        merged: false,
        prState: null,
        workflowName: null,
        actor: null,
        body: null,
        url: null,
        summary: "",
      },
      candidates,
      repoMap
    );
    // run 2 (R1) matches; run 3 (R2, unknown remote) does not.
    expect(ids).toEqual([2]);
  });
});

describe("autofixEnabledFor", () => {
  it("defaults to enabled when unset or empty", () => {
    expect(autofixEnabledFor(undefined)).toBe(true);
    expect(autofixEnabledFor("")).toBe(true);
    expect(autofixEnabledFor("   ")).toBe(true);
  });

  it("stays enabled for truthy and unrelated values", () => {
    expect(autofixEnabledFor("1")).toBe(true);
    expect(autofixEnabledFor("true")).toBe(true);
    expect(autofixEnabledFor("on")).toBe(true);
    expect(autofixEnabledFor("yes")).toBe(true);
  });

  it("disables only for explicit off values (case/space-insensitive)", () => {
    for (const v of ["0", "false", "no", "off", "OFF", " false "]) {
      expect(autofixEnabledFor(v)).toBe(false);
    }
  });
});

describe("handleWebhookEvent CI-autofix targeting", () => {
  const PR_URL = "https://github.com/acme/widgets/pull/7";

  beforeEach(async () => {
    mockFollowUp.mockClear();
    mockHintDelivery.mockClear();
    await db.delete(agentEvents);
    await db.delete(taskNotes);
    await db.delete(inboxEvents);
    await db.delete(runEventSubscriptions);
    await db.delete(runSourceEvents);
    await db.delete(agentSessions);
    await db.delete(tasks);
    await db.delete(plans);
    await db.delete(repositories).where(ne(repositories.id, "R-default"));

    await db.insert(repositories).values({
      id: "R-acme",
      name: "widgets",
      remote: "git@github.com:acme/widgets.git",
      localPath: "/tmp/acme-widgets",
      defaultBranch: "main",
    });
    await db.insert(plans).values({ id: "P-acme", title: "Acme plan" });
    await db
      .insert(tasks)
      .values({ id: "T-acme", title: "Do the thing", planId: "P-acme", repoId: "R-acme" });
  });

  async function insertRun(status: string): Promise<number> {
    const row = (
      await db
        .insert(agentSessions)
        .values({
          taskId: "T-acme",
          status,
          goal: "<implement>",
          toolsProfile: "orchestrator,repo_write",
          cwdStrategy: "worktree",
          branch: "feature-x",
          // cancel()/close() KEEP these columns populated (only the on-disk
          // worktree is deleted) — that's exactly why a status filter is needed.
          worktreePath: "/tmp/acme-widgets/.worktrees/1",
          prUrl: PR_URL,
          repoId: "R-acme",
          startedAt: new Date(),
        })
        .returning({ id: agentSessions.id })
    )[0];
    return row!.id;
  }

  function ciFailure(): NormalizedWebhookEvent {
    return {
      kind: "ci",
      event: "workflow_run",
      action: "completed",
      repoFullName: "acme/widgets",
      prUrls: [PR_URL],
      branch: "feature-x",
      headSha: "abc123",
      ciState: "failure",
      conclusion: "failure",
      merged: false,
      prState: null,
      workflowName: "CI",
      actor: "ci-bot",
      body: null,
      url: "https://github.com/acme/widgets/actions/runs/1",
      summary: 'Workflow "CI" failure',
    };
  }

  async function eventsOfType(runId: number, type: string): Promise<number> {
    return (
      await db
        .select({ id: agentEvents.id })
        .from(agentEvents)
        .where(and(eq(agentEvents.sessionId, runId), eq(agentEvents.type, type)))
    ).length;
  }

  for (const status of ["cancelled", "closed"]) {
    it(`does NOT autofix a ${status} run (user abandoned it)`, async () => {
      const id = await insertRun(status);

      const result = await handleWebhookEvent(
        ciFailure(),
        "delivery-1",
        fakeFetch(gh({ ciConclusion: "failure" }))
      );

      // The run still MATCHED the event (so the skip is due to status, not a
      // failed match): a durable 'github' event is recorded on it.
      expect(result.matched).toBe(1);
      expect(await eventsOfType(id, "github")).toBe(1);

      // …but autofix was skipped entirely: no follow-up turn, no autofix event,
      // no status flip, no breadcrumb note.
      expect(mockFollowUp).not.toHaveBeenCalled();
      expect(await eventsOfType(id, "github_autofix")).toBe(0);
      expect(result.actions.some((a) => /autofix/.test(a))).toBe(false);
      expect(
        (await db.select().from(agentSessions).where(eq(agentSessions.id, id)))[0]?.status
      ).toBe(status);
      expect(await db.select().from(taskNotes)).toHaveLength(0);
    });
  }

  it("DOES autofix a resumable (idle) worktree run — control for the guard", async () => {
    const id = await insertRun("idle");

    const result = await handleWebhookEvent(
      ciFailure(),
      "delivery-2",
      fakeFetch(gh({ ciConclusion: "failure" }))
    );

    expect(result.matched).toBe(1);
    expect(mockFollowUp).toHaveBeenCalledTimes(1);
    expect(mockFollowUp.mock.calls[0]?.[0]).toBe(id);
    expect(await eventsOfType(id, "github_autofix")).toBe(1);
    expect(result.actions.some((a) => /autofix triggered/.test(a))).toBe(true);
    // Autofix owns the run: the handler must NOT also hint the delivery pump,
    // which would dispatch the same idle run in parallel with the follow-up.
    expect(mockHintDelivery).not.toHaveBeenCalled();
  });

  it("describes authoritative aggregate failure instead of blaming a queued check", async () => {
    const id = await insertRun("idle");
    const queuedEvent: NormalizedWebhookEvent = {
      ...ciFailure(),
      action: "created",
      ciState: "pending",
      conclusion: "queued",
      workflowName: "Quality Gate / quality",
    };

    await handleWebhookEvent(
      queuedEvent,
      "delivery-queued-observed-red",
      fakeFetch(gh({ ciConclusion: "failure", headSha: "authoritative-sha" }))
    );

    expect(mockFollowUp).toHaveBeenCalledTimes(1);
    const prompt = String(mockFollowUp.mock.calls[0]?.[1]);
    expect(prompt).toContain("Conclusion: failure.");
    expect(prompt).toContain("Head commit: authoritative-sha.");
    expect(prompt).not.toContain("Conclusion: queued.");
    expect(prompt).not.toContain("Workflow/check: Quality Gate / quality.");
    expect(await eventsOfType(id, "github_autofix")).toBe(1);
  });

  it("defers the delivery-pump wake until after the autofix decision", async () => {
    // A run autofix will not take (already running), so the matched event still
    // has to reach it — the wake fires, just after the decision rather than
    // racing it.
    const id = await insertRun("running");

    const result = await handleWebhookEvent(
      ciFailure(),
      "delivery-wake",
      fakeFetch(gh({ ciConclusion: "failure" }))
    );

    expect(result.matched).toBe(1);
    expect(mockFollowUp).not.toHaveBeenCalled();
    expect(await eventsOfType(id, "github")).toBe(1);
    expect(mockHintDelivery).toHaveBeenCalledTimes(1);
  });
});

// GitHub-driven task lifecycle (§3): the webhook drives task state through the
// SAME prToTaskState mapping the poller uses, matched via the authoritative
// tasks.pr_url link. fetchPrGithubState is injected so no real `gh` runs.
describe("handleWebhookEvent drives task state from GitHub", () => {
  const PR_URL = "https://github.com/acme/widgets/pull/7";

  beforeEach(async () => {
    mockFollowUp.mockClear();
    mockHintDelivery.mockClear();
    await db.delete(agentEvents);
    await db.delete(taskNotes);
    await db.delete(inboxEvents);
    await db.delete(runEventSubscriptions);
    await db.delete(runSourceEvents);
    await db.delete(agentSessions);
    await db.delete(tasks);
    await db.delete(plans);
    await db.delete(repositories).where(ne(repositories.id, "R-default"));

    await db.insert(repositories).values({
      id: "R-acme",
      name: "widgets",
      remote: "git@github.com:acme/widgets.git",
      localPath: "/tmp/acme-widgets",
      defaultBranch: "main",
    });
    await db.insert(plans).values({ id: "P-acme", title: "Acme plan" });
  });

  // A task in `testing` with its authoritative pr_url set — the shape after an
  // implementor opened a PR and called set_task_pr.
  async function makeTestingTask(prUrl = PR_URL): Promise<string> {
    await db
      .insert(tasks)
      .values({ id: "T-acme", title: "Do the thing", planId: "P-acme", repoId: "R-acme" });
    await repo.transitionTask("T-acme", { state: "in_progress", assignee: "alice" });
    await repo.transitionTask("T-acme", { state: "testing" });
    await repo.setTaskPr("T-acme", prUrl);
    return "T-acme";
  }

  // A resumable worktree run for the task, matched by branch/PR — so a
  // CI-failure can resume the implementor in place.
  async function insertResumableRun(): Promise<number> {
    const row = (
      await db
        .insert(agentSessions)
        .values({
          taskId: "T-acme",
          status: "idle",
          goal: "<implement>",
          toolsProfile: "orchestrator,repo_write",
          cwdStrategy: "worktree",
          branch: "feature-x",
          worktreePath: "/tmp/acme-widgets/.worktrees/1",
          prUrl: PR_URL,
          repoId: "R-acme",
          startedAt: new Date(),
        })
        .returning({ id: agentSessions.id })
    )[0];
    return row!.id;
  }

  function mergeEvent(): NormalizedWebhookEvent {
    return {
      kind: "pr",
      event: "pull_request",
      action: "closed",
      repoFullName: "acme/widgets",
      prUrls: [PR_URL],
      branch: "feature-x",
      headSha: "abc123",
      ciState: null,
      conclusion: null,
      merged: true,
      prState: "closed",
      workflowName: null,
      actor: "alice",
      body: null,
      url: PR_URL,
      summary: "PR merged",
    };
  }

  function ciEvent(ciState: "success" | "failure" | "pending"): NormalizedWebhookEvent {
    return {
      kind: "ci",
      event: "workflow_run",
      action: "completed",
      repoFullName: "acme/widgets",
      prUrls: [PR_URL],
      branch: "feature-x",
      headSha: "abc123",
      ciState,
      conclusion: ciState,
      merged: false,
      prState: null,
      workflowName: "CI",
      actor: "ci-bot",
      body: null,
      url: "https://github.com/acme/widgets/actions/runs/1",
      summary: `Workflow "CI" ${ciState}`,
    };
  }

  it("a merge webhook drives the matched task to merged (via tasks.pr_url)", async () => {
    const taskId = await makeTestingTask();
    const runId = await insertResumableRun();

    const result = await handleWebhookEvent(mergeEvent(), "d-merge");

    expect((await repo.getTask(taskId))!.state).toBe("merged");
    expect(result.actions).toContain(`task ${taskId} → merged`);
    // The durable pr_merged agent event is preserved (keyed to the run).
    const merged = await db
      .select({ id: agentEvents.id })
      .from(agentEvents)
      .where(and(eq(agentEvents.sessionId, runId), eq(agentEvents.type, "pr_merged")));
    expect(merged).toHaveLength(1);
  });

  it("matches purely by tasks.pr_url even with no matching run", async () => {
    const taskId = await makeTestingTask(); // no run inserted

    const result = await handleWebhookEvent(mergeEvent(), "d-merge-norun");

    expect((await repo.getTask(taskId))!.state).toBe("merged");
    expect(result.actions).toContain(`task ${taskId} → merged`);
  });

  it("a CI-failure webhook drives testing → failing and resumes the implementor", async () => {
    const taskId = await makeTestingTask();
    const runId = await insertResumableRun();

    const result = await handleWebhookEvent(
      ciEvent("failure"),
      "d-ci-fail",
      fakeFetch(gh({ ciConclusion: "failure" }))
    );

    // State set first…
    expect((await repo.getTask(taskId))!.state).toBe("failing");
    expect(result.actions).toContain(`task ${taskId} → failing`);
    // …then the implementor resumed to fix it.
    expect(mockFollowUp).toHaveBeenCalledTimes(1);
    expect(mockFollowUp.mock.calls[0]?.[0]).toBe(runId);
    expect(result.actions.some((a) => /autofix triggered/.test(a))).toBe(true);
  });

  it("a CI-success webhook drives testing → passing (no resume)", async () => {
    const taskId = await makeTestingTask();
    await insertResumableRun();

    const result = await handleWebhookEvent(
      ciEvent("success"),
      "d-ci-pass",
      fakeFetch(gh({ ciConclusion: "success" }))
    );

    expect((await repo.getTask(taskId))!.state).toBe("passing");
    expect(result.actions).toContain(`task ${taskId} → passing`);
    expect(mockFollowUp).not.toHaveBeenCalled();
  });

  it("keeps pending CI visible without waking a model turn", async () => {
    await makeTestingTask();
    const runId = await insertResumableRun();

    await handleWebhookEvent(
      ciEvent("pending"),
      "d-ci-pending",
      fakeFetch(gh({ ciConclusion: "pending", headSha: "abc123" }))
    );

    expect(await db.select().from(agentEvents).where(and(
      eq(agentEvents.sessionId, runId), eq(agentEvents.type, "github")
    ))).toHaveLength(1);
    expect(await db.select().from(inboxEvents).where(eq(inboxEvents.targetRunId, runId))).toHaveLength(0);
    expect(mockHintDelivery).not.toHaveBeenCalled();
    expect(mockFollowUp).not.toHaveBeenCalled();
  });

  it("re-reads authoritative rolled-up CI state, not the event's single conclusion", async () => {
    // The event says failure, but the PR's rolled-up state is green → passing.
    const taskId = await makeTestingTask();
    await insertResumableRun();

    await handleWebhookEvent(
      ciEvent("failure"),
      "d-ci-authoritative",
      fakeFetch(gh({ ciConclusion: "success" }))
    );

    expect((await repo.getTask(taskId))!.state).toBe("passing");
  });
});

// Non-convergence escalation via the webhook path: when the loop can't progress
// (attempt cap hit, or no resumable run) the task is moved to `blocked` with a
// note, guarded by a one-shot `github_autofix_exhausted` event.
describe("handleWebhookEvent CI-autofix escalation", () => {
  const PR_URL = "https://github.com/acme/widgets/pull/7";

  beforeEach(async () => {
    mockFollowUp.mockClear();
    mockHintDelivery.mockClear();
    await db.delete(agentEvents);
    await db.delete(taskNotes);
    await db.delete(inboxEvents);
    await db.delete(runEventSubscriptions);
    await db.delete(runSourceEvents);
    await db.delete(agentSessions);
    await db.delete(tasks);
    await db.delete(plans);
    await db.delete(repositories).where(ne(repositories.id, "R-default"));

    await db.insert(repositories).values({
      id: "R-acme",
      name: "widgets",
      remote: "git@github.com:acme/widgets.git",
      localPath: "/tmp/acme-widgets",
      defaultBranch: "main",
    });
    await db.insert(plans).values({ id: "P-acme", title: "Acme plan" });
  });

  // A task already in `failing` (implementor opened a PR, CI went red) with its
  // authoritative pr_url set.
  async function makeFailingTask(): Promise<string> {
    await db
      .insert(tasks)
      .values({ id: "T-acme", title: "Do the thing", planId: "P-acme", repoId: "R-acme" });
    await repo.transitionTask("T-acme", { state: "in_progress", assignee: "alice" });
    await repo.transitionTask("T-acme", { state: "testing" });
    await repo.transitionTask("T-acme", { state: "failing" });
    await repo.setTaskPr("T-acme", PR_URL);
    return "T-acme";
  }

  async function insertRun(status: string): Promise<number> {
    const row = (
      await db
        .insert(agentSessions)
        .values({
          taskId: "T-acme",
          status,
          goal: "<implement>",
          cwdStrategy: "worktree",
          branch: "feature-x",
          worktreePath: "/tmp/acme-widgets/.worktrees/1",
          prUrl: PR_URL,
          repoId: "R-acme",
          startedAt: new Date(),
        })
        .returning({ id: agentSessions.id })
    )[0];
    return row!.id;
  }

  function ciFailure(): NormalizedWebhookEvent {
    return {
      kind: "ci",
      event: "workflow_run",
      action: "completed",
      repoFullName: "acme/widgets",
      prUrls: [PR_URL],
      branch: "feature-x",
      headSha: "abc123",
      ciState: "failure",
      conclusion: "failure",
      merged: false,
      prState: null,
      workflowName: "CI",
      actor: "ci-bot",
      body: null,
      url: "https://github.com/acme/widgets/actions/runs/1",
      summary: 'Workflow "CI" failure',
    };
  }

  async function eventsOfType(runId: number, type: string): Promise<number> {
    return (
      await db
        .select({ id: agentEvents.id })
        .from(agentEvents)
        .where(and(eq(agentEvents.sessionId, runId), eq(agentEvents.type, type)))
    ).length;
  }

  it("escalates to blocked once when the attempt cap is hit", async () => {
    const { AUTOFIX_MAX } = await import("../lib/ci-autofix");
    const taskId = await makeFailingTask();
    const [parent] = await db.insert(agentSessions).values({
      goal: "<execute>",
      status: "idle",
      cwdStrategy: "repo",
      repoId: "R-acme",
    }).returning({ id: agentSessions.id });
    const runId = await insertRun("idle");
    await db.update(agentSessions).set({ parentRunId: parent.id }).where(eq(agentSessions.id, runId));
    for (let i = 0; i < AUTOFIX_MAX; i++) {
      await db.insert(agentEvents).values({
        sessionId: runId,
        type: "github_autofix",
        payload: "{}",
        createdAt: new Date(Date.now() - 10 * 60_000),
      });
    }

    await handleWebhookEvent(ciFailure(), "d-cap-1", fakeFetch(gh({ ciConclusion: "failure" })));
    expect((await repo.getTask(taskId))!.state).toBe("blocked");
    expect(mockFollowUp).not.toHaveBeenCalled();
    expect(await eventsOfType(runId, "github_autofix_exhausted")).toBe(1);
    const parentNotices = await db.select().from(inboxEvents).where(and(
      eq(inboxEvents.targetRunId, parent.id),
      eq(inboxEvents.type, "ci.autofix_exhausted")
    ));
    expect(parentNotices).toHaveLength(1);
    expect(parentNotices[0].payload).toMatchObject({
      task_id: taskId,
      child_run_id: runId,
      state: "blocked",
      kind: "attempt_cap",
    });

    // A second delivery does not re-escalate (guard) and does not undo the block.
    await handleWebhookEvent(ciFailure(), "d-cap-2", fakeFetch(gh({ ciConclusion: "failure" })));
    expect((await repo.getTask(taskId))!.state).toBe("blocked");
    expect(await eventsOfType(runId, "github_autofix_exhausted")).toBe(1);
    expect(await db.select().from(inboxEvents).where(and(
      eq(inboxEvents.targetRunId, parent.id),
      eq(inboxEvents.type, "ci.autofix_exhausted")
    ))).toHaveLength(1);
  });

  it("escalates to blocked when there is no resumable run", async () => {
    const taskId = await makeFailingTask();
    const runId = await insertRun("closed"); // not resumable

    await handleWebhookEvent(ciFailure(), "d-strand", fakeFetch(gh({ ciConclusion: "failure" })));
    expect((await repo.getTask(taskId))!.state).toBe("blocked");
    expect(mockFollowUp).not.toHaveBeenCalled();
    expect(await eventsOfType(runId, "github_autofix_exhausted")).toBe(1);
  });

  it("does NOT escalate when autofix is disabled", async () => {
    vi.stubEnv("TASK_ORCH_CI_AUTOFIX", "0");
    try {
      const taskId = await makeFailingTask();
      const runId = await insertRun("closed");
      await handleWebhookEvent(ciFailure(), "d-off", fakeFetch(gh({ ciConclusion: "failure" })));
      expect((await repo.getTask(taskId))!.state).toBe("failing");
      expect(await eventsOfType(runId, "github_autofix_exhausted")).toBe(0);
      expect(mockFollowUp).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does NOT escalate on the happy path (attempts < cap, resumable run)", async () => {
    const taskId = await makeFailingTask();
    const runId = await insertRun("idle");

    await handleWebhookEvent(ciFailure(), "d-happy", fakeFetch(gh({ ciConclusion: "failure" })));
    expect((await repo.getTask(taskId))!.state).toBe("failing");
    expect(mockFollowUp).toHaveBeenCalledTimes(1);
    expect(await eventsOfType(runId, "github_autofix_exhausted")).toBe(0);
  });
});
