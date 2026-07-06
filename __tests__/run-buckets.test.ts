import { describe, expect, it } from "vitest";
import { bucketFor, classifyRun, dedupeLiveByTask } from "../lib/run-buckets";

describe("dedupeLiveByTask", () => {
  const item = (taskId: string | null, bucket: "review" | "blocked" | "running", startedAt: number) => ({
    taskId,
    bucket,
    startedAt,
  });

  it("collapses several runs of one task to a single card", () => {
    // The reported bug: 2 review tasks × 3 runs each = 6 cards. Should be 2.
    const items = [
      item("T-1", "review", 1),
      item("T-1", "review", 2),
      item("T-1", "review", 3),
      item("T-2", "review", 5),
      item("T-2", "review", 4),
    ];
    const out = dedupeLiveByTask(items);
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.taskId).sort()).toEqual(["T-1", "T-2"]);
  });

  it("keeps the newest run within the same bucket as the representative", () => {
    const out = dedupeLiveByTask([
      item("T-1", "review", 1),
      item("T-1", "review", 9),
      item("T-1", "review", 4),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].startedAt).toBe(9);
  });

  it("prefers the higher-priority bucket when a task has runs in two buckets", () => {
    // review (0) beats running (2) even if the running run is newer.
    const out = dedupeLiveByTask([
      item("T-1", "running", 100),
      item("T-1", "review", 1),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].bucket).toBe("review");
  });

  it("keeps distinct tasks separate", () => {
    const out = dedupeLiveByTask([
      item("T-1", "review", 1),
      item("T-2", "blocked", 2),
      item("T-3", "running", 3),
    ]);
    expect(out).toHaveLength(3);
  });

  it("passes through items without a taskId (does not merge them)", () => {
    const out = dedupeLiveByTask([item(null, "running", 1), item(null, "running", 2)]);
    expect(out).toHaveLength(2);
  });
});

const PR = "https://github.com/o/r/pull/7";

describe("classifyRun", () => {
  it("active statuses are running", () => {
    expect(classifyRun("running", null, "in_progress")).toBe("running");
    expect(classifyRun("preparing", null, "in_progress")).toBe("running");
    expect(classifyRun("pushing", null, "in_progress")).toBe("running");
  });

  it("opening_pr is review", () => {
    expect(classifyRun("opening_pr", null, "in_progress")).toBe("review");
  });

  it("failed/budget statuses are blocked", () => {
    expect(classifyRun("failed", null, "blocked")).toBe("blocked");
    expect(classifyRun("budget_exhausted", null, "blocked")).toBe("blocked");
  });

  it("completed run with an open PR is review only while the task's PR is open", () => {
    expect(classifyRun("completed", PR, "testing")).toBe("review");
    expect(classifyRun("completed", PR, "passing")).toBe("review");
    expect(classifyRun("completed", PR, "failing")).toBe("review");
  });

  it("completed run whose task is merged/cancelled is shipped, not review", () => {
    // Regression: previously any run with a prUrl was filed as review, so completed
    // (PR merged → task merged) runs lingered in the live sidebar as 'in review'.
    expect(classifyRun("completed", PR, "merged")).toBe("shipped");
    expect(classifyRun("completed", PR, "cancelled")).toBe("shipped");
  });

  it("completed run without a PR is shipped", () => {
    expect(classifyRun("completed", null, "merged")).toBe("shipped");
    expect(classifyRun("completed", null, "testing")).toBe("shipped");
  });

  it("unknown status belongs to no bucket", () => {
    expect(classifyRun("queued", null, "todo")).toBeNull();
  });
});

describe("bucketFor (live sidebar)", () => {
  it("mirrors classifyRun for live buckets", () => {
    expect(bucketFor("running", null, "in_progress")).toBe("running");
    expect(bucketFor("opening_pr", null, "in_progress")).toBe("review");
    expect(bucketFor("failed", null, "blocked")).toBe("blocked");
    expect(bucketFor("completed", PR, "testing")).toBe("review");
  });

  it("drops shipped runs — they are not live", () => {
    expect(bucketFor("completed", PR, "merged")).toBeNull();
    expect(bucketFor("completed", null, "merged")).toBeNull();
  });
});
