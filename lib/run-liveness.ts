// lib/run-liveness.ts
//
// The single home for the run liveness lease (heartbeat) — its constants, its
// predicates, and the shared "a worker died, now what?" resume policy. Before
// R8 the 5-minute stale window was written THREE times (runs.ts, run-dispatch.ts,
// runner/lifecycle.ts) each with a "keep in sync" comment, the worker-liveness
// predicate lived in three near-identical copies, and the two reapers
// (reconcileOrphanedRuns, handleWorkerDeath) re-implemented the same re-dispatch
// decision with subtly different existence gates.
//
// DEPENDENCY-LIGHT ON PURPOSE. This is a leaf: it imports only run-state (the
// status vocabulary) and nothing from runs.ts / run-dispatch.ts. run-dispatch
// must not import runs.ts (the injected-RunsApi split avoids a boot cycle), and
// both import from here — so this module owes them a dependency-free surface.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentSessions, runnerInstances } from "@/db/schema";
import { createRunnerProvider, getRunnerProvider, type RunnerObservation } from "./runner/provider";

/** The provider-authoritative answer to "does this run still have its worker?" */
export type Liveness =
  | { verdict: "alive"; incarnation: string }
  | { verdict: "dead"; reason: "exited" | "replaced" | "runner-gone"; detail?: string }
  | { verdict: "unowned" }
  | { verdict: "unknown" };

/**
 * Observe a run's worker without using a clock. `unowned` means exactly "no
 * claim"; a claim whose owner cannot be observed is `unknown`, never `unowned`.
 * A process that is alive but has released its worker_scope is `unowned`: it is
 * reusable, but it is not currently entitled to consume this run's input.
 */
/** Identity of this control-plane process for the life of the process. */
export const CONTROLLER_BOOT_ID = randomUUID();

const SERVER_SCOPE_PREFIX = "server-";

/**
 * Scope for an in-process (server-runtime) turn. It carries the identity of the
 * process that took it — host, pid, boot id — so liveness can be OBSERVED, the
 * same way a runner's incarnation is: no clock, no heartbeat.
 */
export function serverClaimScope(nonce: string): string {
  return `${SERVER_SCOPE_PREFIX}${hostname()}@${process.pid}@${CONTROLLER_BOOT_ID}@${nonce}`;
}

export function isServerClaimScope(scope: string | null | undefined): boolean {
  return typeof scope === "string" && scope.startsWith(SERVER_SCOPE_PREFIX);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but is not ours — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Observe the process behind a server claim. */
function observeServerClaim(scope: string): Liveness {
  const parts = scope.slice(SERVER_SCOPE_PREFIX.length).split("@");
  if (parts.length < 4) {
    // Legacy `server-<nonce>` claims predate process identity. They were
    // taken by a control-plane process that a deploy has since replaced.
    return { verdict: "dead", reason: "exited", detail: "legacy server claim without process identity" };
  }
  const [host, pidText, bootId] = parts;
  if (bootId === CONTROLLER_BOOT_ID) return { verdict: "alive", incarnation: scope };
  if (host !== hostname()) return { verdict: "unknown" };
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return { verdict: "unknown" };
  return processAlive(pid)
    ? { verdict: "alive", incarnation: scope }
    : { verdict: "dead", reason: "exited", detail: `control-plane process ${pid} on ${host} is gone` };
}

export async function resolveLiveness(runId: number): Promise<Liveness> {
  const [row] = await db
    .select({
      workerScope: agentSessions.workerScope,
      provider: runnerInstances.provider,
      spriteName: runnerInstances.spriteName,
      workerIncarnation: runnerInstances.workerIncarnation,
    })
    .from(agentSessions)
    .leftJoin(runnerInstances, eq(runnerInstances.runId, agentSessions.id))
    .where(eq(agentSessions.id, runId));

  // No claim → unowned. (A reusable runner may still be alive, but the claim is
  // what gives it work.)
  if (!row?.workerScope) return { verdict: "unowned" };
  // An in-process turn: observe the control-plane process itself.
  if (isServerClaimScope(row.workerScope)) return observeServerClaim(row.workerScope);
  // A claim with no runner row at all: nothing to observe. This is NOT "no
  // owner" — a dispatch may be provisioning the runner right now.
  if (!row.provider) return { verdict: "unknown" };
  const handle = row.spriteName ?? row.workerScope;

  // Prefer the process-wide provider (memoised, and injectable in tests); only
  // build a one-off when the instance was created under a different provider.
  let observed: RunnerObservation;
  try {
    const active = getRunnerProvider();
    const provider = active.kind === row.provider ? active : createRunnerProvider(row.provider as "local" | "sprites");
    observed = await provider.inspect(handle);
  } catch (err) {
    // No provider (missing credentials in this process) is "cannot observe", never "dead".
    console.warn(`[liveness] cannot observe run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    return { verdict: "unknown" };
  }
  if (observed.status === "unknown") return { verdict: "unknown" };
  if (observed.status === "dead") {
    const detail = observed.detail;
    const runnerGone = /box\s+is\s+gone|sprite.*gone|not found|404|does not exist/i.test(detail ?? "");
    return { verdict: "dead", reason: runnerGone ? "runner-gone" : "exited", ...(detail ? { detail } : {}) };
  }
  // Boot window: the worker exists but has not completed channel.hello, so no
  // incarnation is stored yet. Trust the observation as-is; there is nothing to
  // compare against and "replaced" cannot be decided.
  if (!row.workerIncarnation) return { verdict: "alive", incarnation: observed.incarnation };
  if (observed.incarnation !== row.workerIncarnation) {
    return { verdict: "dead", reason: "replaced", detail: `stored=${row.workerIncarnation}, observed=${observed.incarnation}` };
  }
  return { verdict: "alive", incarnation: observed.incarnation };
}

/**
 * Whether a dead run can be resumed by handing it to a FRESH worker, rather than
 * failed. A worktree implement run is resumable — its branch/worktree persist
 * and it has an SDK session to resume from.
 *
 * The existence gate (R8 reconciliation): a REMOTE runner (Fly Machine or Docker
 * worker) re-clones from the branch pushed to GitHub, so `hasBranch` is enough —
 * and on Fly worktreePath is a runner-volume path (/mnt/session/repo) that never
 * exists on the server, so an on-disk check would wrongly fail every remote
 * orphan. A host/dev run instead needs its worktree still on this disk. Both
 * reapers now pass `remote = remoteRunnerEnabled()` for this bit; previously
 * reconcileOrphanedRuns used remoteRunnerEnabled() while handleWorkerDeath used
 * `!!TASK_ORCH_WORKER_IMAGE`. In the Docker-die context those two agree
 * (WORKER_IMAGE is set there, and remoteRunnerEnabled() reduces to its presence
 * given detached); unifying on remoteRunnerEnabled() also makes the death
 * handler correct were it ever reached on Fly.
 */
export function isResumableDeadRun(i: {
  detached: boolean;
  remote: boolean;
  isImplementWorktree: boolean;
  hasSdkSession: boolean;
  hasBranch: boolean;
  worktreeOnDisk: boolean;
}): boolean {
  return (
    i.detached &&
    i.isImplementWorktree &&
    i.hasSdkSession &&
    (i.remote ? i.hasBranch : i.worktreeOnDisk)
  );
}

export type DeadRunPolicy = "redispatch" | "idle" | "failed";

/**
 * The shared resume policy both reapers apply to a run whose worker died:
 *   - resumable implement run, NOT OOM-killed → re-dispatch to a fresh worker
 *   - chat run → back to 'idle' (resumable on the next message)
 *   - everything else → failed
 *
 * The OOM carve-out: an OOM-killed container would be re-killed at the same
 * memory cap at the same spot, so a visible failure beats a silent kill loop.
 * reconcileOrphanedRuns (the heartbeat sweep) has no OOM signal — it only knows
 * the heartbeat went stale — so it passes oom=false, and its resumable orphans
 * always re-dispatch, exactly as before. handleWorkerDeath passes the real
 * Docker-die OOM verdict. The sweep's completed-event recovery (a completion
 * event that outlived a lost terminal write) is a sweep-only PRE-check that runs
 * before this policy — it stays at the call site, not here.
 */
export function decideDeadRunPolicy(i: {
  goal: string;
  resumable: boolean;
  oom: boolean;
}): DeadRunPolicy {
  if (i.resumable && !i.oom) return "redispatch";
  if (i.goal === "<chat>") return "idle";
  return "failed";
}
