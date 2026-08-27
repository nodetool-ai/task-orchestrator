// __tests__/run-liveness.test.ts
//
// The single liveness module: the provider verdict (no clocks) and the shared
// reaper policy that decides re-dispatch / idle / failed.
import { beforeEach, describe, expect, it } from "vitest";
import { decideDeadRunPolicy, isResumableDeadRun, resolveLiveness } from "../lib/run-liveness";
import { create } from "../lib/runs";
import { installFakeRunnerProvider, setFakeRunLiveness } from "./helpers/fake-runner-provider";

describe("resolveLiveness", () => {
  beforeEach(() => installFakeRunnerProvider());

  it("distinguishes alive, replaced, unknown, and unowned without clocks", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    expect(await resolveLiveness(run.id)).toEqual({ verdict: "unowned" });

    await setFakeRunLiveness(run.id, { status: "alive", incarnation: "same" }, "same");
    expect(await resolveLiveness(run.id)).toEqual({ verdict: "alive", incarnation: "same" });

    await setFakeRunLiveness(run.id, { status: "alive", incarnation: "new" }, "same");
    expect(await resolveLiveness(run.id)).toMatchObject({ verdict: "dead", reason: "replaced" });

    await setFakeRunLiveness(run.id, { status: "unknown" }, "same");
    expect(await resolveLiveness(run.id)).toEqual({ verdict: "unknown" });
  });
});

describe("isResumableDeadRun — reconciled existence gate", () => {
  const base = {
    detached: true,
    isImplementWorktree: true,
    hasSdkSession: true,
    hasBranch: true,
    worktreeOnDisk: true,
  };
  it("requires detached + implement-worktree + sdk session", () => {
    expect(isResumableDeadRun({ ...base, remote: true })).toBe(true);
    expect(isResumableDeadRun({ ...base, remote: true, detached: false })).toBe(false);
    expect(isResumableDeadRun({ ...base, remote: true, isImplementWorktree: false })).toBe(false);
    expect(isResumableDeadRun({ ...base, remote: true, hasSdkSession: false })).toBe(false);
  });
  it("remote runners check the branch (not the never-present server worktree)", () => {
    expect(isResumableDeadRun({ ...base, remote: true, hasBranch: true, worktreeOnDisk: false })).toBe(true);
    expect(isResumableDeadRun({ ...base, remote: true, hasBranch: false, worktreeOnDisk: true })).toBe(false);
  });
  it("host/dev runs check the on-disk worktree", () => {
    expect(isResumableDeadRun({ ...base, remote: false, worktreeOnDisk: true, hasBranch: false })).toBe(true);
    expect(isResumableDeadRun({ ...base, remote: false, worktreeOnDisk: false, hasBranch: true })).toBe(false);
  });
});

describe("decideDeadRunPolicy — the shared resume policy", () => {
  it("resumable implement run, not OOM → re-dispatch", () => {
    expect(decideDeadRunPolicy({ goal: "implement X", resumable: true, oom: false })).toBe("redispatch");
  });
  it("resumable but OOM-killed → failed (a retry re-kills at the same cap)", () => {
    expect(decideDeadRunPolicy({ goal: "implement X", resumable: true, oom: true })).toBe("failed");
  });
  it("chat run → idle (resumable on the next message)", () => {
    expect(decideDeadRunPolicy({ goal: "<chat>", resumable: false, oom: false })).toBe("idle");
    // OOM chat still idles (the carve-out only blocks a re-dispatch).
    expect(decideDeadRunPolicy({ goal: "<chat>", resumable: false, oom: true })).toBe("idle");
  });
  it("everything else → failed", () => {
    expect(decideDeadRunPolicy({ goal: "<execute>", resumable: false, oom: false })).toBe("failed");
    expect(decideDeadRunPolicy({ goal: "review", resumable: false, oom: false })).toBe("failed");
  });
  it("sweep semantics: oom=false means a resumable orphan always re-dispatches", () => {
    // reconcileOrphanedRuns passes oom=false — its resumable orphans re-dispatch
    // regardless (it has no OOM signal), exactly as before R8.
    expect(decideDeadRunPolicy({ goal: "implement X", resumable: true, oom: false })).toBe("redispatch");
  });
});
