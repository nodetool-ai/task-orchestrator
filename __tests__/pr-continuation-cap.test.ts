// The "keep going until there's a PR" continuation loop in runs.append() has a
// hard ceiling (MAX_PR_CONTINUATIONS). An implement-worktree turn that ends
// without a PR (and without report_result/raise) re-lands 'running' and the loop
// re-prompts the agent to continue. Without a bound this spins forever: the
// per-turn budgetMaxTurns is NOT cumulative across continuations, and the
// wall-clock / dollar budgets only apply when configured. On exhaustion the loop
// lands the run 'failed' with a structured result instead of looping.
//
// The loop body itself needs a real git worktree + GitHub to drive, so these
// tests pin the pure pieces: the failure payload the guard writes, and that the
// turn-end decision reads it back as a terminal 'failed' landing.

import { describe, expect, it } from "vitest";
import { MAX_PR_CONTINUATIONS, prContinuationFailureResult } from "../lib/runs";
import { decideTurnEndStatus, isFailedResult, resultPrUrl } from "../lib/run-state";

describe("MAX_PR_CONTINUATIONS", () => {
  it("defaults to a finite, positive ceiling so the loop can't spin forever", () => {
    expect(MAX_PR_CONTINUATIONS).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_PR_CONTINUATIONS)).toBe(true);
    expect(Number.isInteger(MAX_PR_CONTINUATIONS)).toBe(true);
  });
});

describe("prContinuationFailureResult", () => {
  const reportedAt = "2026-01-01T00:00:00.000Z";
  const result = prContinuationFailureResult(25, 25, reportedAt);

  it("is a failed report_result payload carrying no PR", () => {
    expect(result.kind).toBe("result");
    expect(result.status).toBe("failed");
    expect(result.pr_url).toBeNull();
    expect(result.reported_at).toBe(reportedAt);
  });

  it("names the cap in the summary so the stop is diagnosable", () => {
    expect(result.summary).toContain("without producing a PR");
    expect(result.summary).toContain("TASK_ORCH_MAX_PR_CONTINUATIONS=25");
    expect(result.summary).toContain("25 turns");
  });

  it("reads back as a failed, PR-less result via the shared interpreters", () => {
    expect(isFailedResult(result)).toBe(true);
    expect(resultPrUrl(result)).toBeNull();
  });

  it("lands a terminal 'failed' status even when a PR is still required", () => {
    // This mirrors the append() finalize: the guard sets nextStatus='failed'
    // directly, but decideTurnEndStatus must also agree the payload is terminal
    // failed rather than re-landing the 'running' self-loop.
    const status = decideTurnEndStatus({
      goal: "<implement>",
      freshStatus: "running",
      parkReason: null,
      result,
      budgetHit: false,
      defaultStatus: "completed",
      requiresPrUrl: true,
      prUrl: null,
    });
    expect(status).toBe("failed");
  });
});
