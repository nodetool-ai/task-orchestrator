import { describe, expect, it } from "vitest";
import { mapWebhookToInboxType } from "../lib/github-webhook";
import type { NormalizedWebhookEvent } from "../lib/github-webhook";

// Base fixture: fill in only what each case cares about.
function ev(overrides: Partial<NormalizedWebhookEvent>): NormalizedWebhookEvent {
  return {
    kind: "pr",
    event: "pull_request",
    action: null,
    repoFullName: "acme/widgets",
    prUrls: ["https://github.com/acme/widgets/pull/7"],
    branch: "feature-x",
    headSha: "abc123",
    ciState: null,
    conclusion: null,
    merged: false,
    prState: null,
    workflowName: null,
    actor: "alice",
    body: null,
    url: null,
    summary: "",
    ...overrides,
  };
}

describe("mapWebhookToInboxType", () => {
  it("maps a merged PR to gh.pr.merged", () => {
    const m = mapWebhookToInboxType(
      ev({ kind: "pr", action: "closed", merged: true, actor: "alice", headSha: "sha1" })
    );
    expect(m).toEqual({
      type: "gh.pr.merged",
      payload: {
        pr_url: "https://github.com/acme/widgets/pull/7",
        branch: "feature-x",
        merged_by: "alice",
        sha: "sha1",
      },
    });
  });

  it("maps a CI completion to gh.ci.completed with conclusion from ciState", () => {
    const m = mapWebhookToInboxType(
      ev({
        kind: "ci",
        ciState: "failure",
        conclusion: "failure",
        workflowName: "CI",
        headSha: "sha2",
        url: "https://github.com/acme/widgets/actions/runs/1",
      })
    );
    expect(m).toEqual({
      type: "gh.ci.completed",
      payload: {
        pr_url: "https://github.com/acme/widgets/pull/7",
        branch: "feature-x",
        conclusion: "failure",
        check: "CI",
        sha: "sha2",
        url: "https://github.com/acme/widgets/actions/runs/1",
      },
    });
  });

  it("maps a submitted review to gh.pr.review_submitted", () => {
    const longBody = "x".repeat(2500);
    const m = mapWebhookToInboxType(
      ev({ kind: "review", conclusion: "approved", actor: "bob", body: longBody })
    );
    expect(m?.type).toBe("gh.pr.review_submitted");
    expect(m?.payload.state).toBe("approved");
    expect(m?.payload.reviewer).toBe("bob");
    expect((m?.payload.body as string).length).toBe(2000);
  });

  it("maps changes_requested review the same way (state carries the verdict)", () => {
    const m = mapWebhookToInboxType(
      ev({ kind: "review", conclusion: "changes_requested", actor: "carol", body: "fix it" })
    );
    expect(m).toEqual({
      type: "gh.pr.review_submitted",
      payload: {
        pr_url: "https://github.com/acme/widgets/pull/7",
        branch: "feature-x",
        state: "changes_requested",
        reviewer: "carol",
        body: "fix it",
      },
    });
  });

  it("maps a PR comment to gh.pr.comment with body truncated to 2000 chars", () => {
    const longBody = "y".repeat(3000);
    const m = mapWebhookToInboxType(ev({ kind: "comment", actor: "dave", body: longBody }));
    expect(m?.type).toBe("gh.pr.comment");
    expect(m?.payload.author).toBe("dave");
    expect((m?.payload.body as string).length).toBe(2000);
  });

  it("maps a pull_request synchronize action to gh.pr.pushed", () => {
    const m = mapWebhookToInboxType(
      ev({ kind: "pr", action: "synchronize", merged: false, headSha: "sha3" })
    );
    expect(m).toEqual({
      type: "gh.pr.pushed",
      payload: { pr_url: "https://github.com/acme/widgets/pull/7", branch: "feature-x", sha: "sha3" },
    });
  });

  it("maps a closed-without-merge PR to gh.pr.closed", () => {
    const m = mapWebhookToInboxType(ev({ kind: "pr", action: "closed", merged: false }));
    expect(m).toEqual({
      type: "gh.pr.closed",
      payload: { pr_url: "https://github.com/acme/widgets/pull/7", branch: "feature-x" },
    });
  });

  it("returns null for events with no inbox mapping (e.g. a plain PR edit)", () => {
    const m = mapWebhookToInboxType(ev({ kind: "pr", action: "edited", merged: false }));
    expect(m).toBeNull();
  });

  it("prioritizes merged over kind (a merged event is always gh.pr.merged even if kind were ci)", () => {
    const m = mapWebhookToInboxType(ev({ kind: "ci", merged: true, action: "closed" }));
    expect(m?.type).toBe("gh.pr.merged");
  });
});
