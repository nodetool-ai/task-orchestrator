// __tests__/run-liveness.test.ts
//
// R8: the single liveness module. Proves the extracted predicates give the SAME
// verdicts as the three ad-hoc copies they replaced, and that the shared reaper
// policy decides re-dispatch / idle / failed the way both reapers used to.
import { beforeEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_STALE_MS,
  decideDeadRunPolicy,
  isLeaseLive,
  isResumableDeadRun,
  isWorkerLive,
  resolveLiveness,
} from "../lib/run-liveness";
import { create } from "../lib/runs";
import { installFakeRunnerProvider, setFakeRunLiveness } from "./helpers/fake-runner-provider";

const NOW = 1_000_000_000_000;
const fresh = new Date(NOW - 5_000);
const stale = new Date(NOW - HEARTBEAT_STALE_MS - 1);
const justLive = new Date(NOW - HEARTBEAT_STALE_MS + 1);

// The three original bodies, transcribed, so equivalence is checked against the
// bytes the module replaced — not a paraphrase.
const oldIsLeaseLive = (run: { status: string; heartbeatAt: Date | null }, now: number) => {
  if (!["running", "preparing"].includes(run.status)) return false;
  return run.heartbeatAt != null && now - run.heartbeatAt.getTime() < HEARTBEAT_STALE_MS;
};
const oldWorkerLive = (i: { workerScope?: string | null; heartbeatAt?: Date | null }, now: number) =>
  i.workerScope != null && i.heartbeatAt != null && now - i.heartbeatAt.getTime() < HEARTBEAT_STALE_MS;

describe("isLeaseLive equivalence", () => {
  const cases = [
    { status: "running", heartbeatAt: fresh },
    { status: "preparing", heartbeatAt: justLive },
    { status: "running", heartbeatAt: stale },
    { status: "idle", heartbeatAt: fresh }, // not a lease status
    { status: "completed", heartbeatAt: fresh },
    { status: "running", heartbeatAt: null },
  ];
  it("matches the old runs.ts body on every case", () => {
    for (const c of cases) {
      expect(isLeaseLive(c, NOW)).toBe(oldIsLeaseLive(c, NOW));
    }
  });
  it("idle holds no lease even with a fresh heartbeat", () => {
    expect(isLeaseLive({ status: "idle", heartbeatAt: fresh }, NOW)).toBe(false);
  });
});

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

describe("isWorkerLive equivalence (the three merged copies)", () => {
  const cases = [
    { workerScope: "run-1", heartbeatAt: fresh },
    { workerScope: "run-1", heartbeatAt: stale },
    { workerScope: "run-1", heartbeatAt: null },
    { workerScope: null, heartbeatAt: fresh },
    { workerScope: undefined, heartbeatAt: undefined }, // lifecycle's optional shape
  ];
  it("matches the old hasLiveWorkerClaim / isWorkerClaimLive body", () => {
    for (const c of cases) {
      expect(isWorkerLive(c, NOW)).toBe(oldWorkerLive(c, NOW));
    }
  });
  it("stays live for a chat worker parked at idle (status-independent)", () => {
    // A chat worker holds worker_scope + fresh heartbeat while idle → live,
    // even though isLeaseLive on the same idle row is false.
    const row = { status: "idle", workerScope: "run-9", heartbeatAt: fresh };
    expect(isWorkerLive(row, NOW)).toBe(true);
    expect(isLeaseLive(row, NOW)).toBe(false);
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
