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

import { db } from "../db";
import {
  agentEvents,
  agentSessions,
  plans,
  repositories,
  taskNotes,
  tasks,
} from "../db/schema";
import { handleWebhookEvent } from "../lib/github-webhook-handler";

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
    await db.delete(agentEvents);
    await db.delete(taskNotes);
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

      const result = await handleWebhookEvent(ciFailure(), "delivery-1");

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

    const result = await handleWebhookEvent(ciFailure(), "delivery-2");

    expect(result.matched).toBe(1);
    expect(mockFollowUp).toHaveBeenCalledTimes(1);
    expect(mockFollowUp.mock.calls[0]?.[0]).toBe(id);
    expect(await eventsOfType(id, "github_autofix")).toBe(1);
    expect(result.actions.some((a) => /autofix triggered/.test(a))).toBe(true);
  });
});
