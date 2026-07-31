// lib/run-runtime.ts
//
// THE predicate for "does this run's turn execute inside the orchestrator
// process?" — the one place `runtime === 'server'` is allowed to be interpreted.
//
// Why a predicate and not a column read (the M2 review's BLOCKER): the
// server-runtime guardrail in runs.create() (design §3/§6) is CREATE-time only.
// Rows written before the lightweight tier was retired (pre-d3025b5) already
// carry runtime='server' together with the column-default tools profile
// 'orchestrator,repo_write' (db/schema.ts) — a profile that mounts
// lib/extensions/repo-read.ts (spawns `git`, readFile/readdir under ctx.cwd) and
// unlocks the backend's built-in fs/bash tools. Reading the column directly
// would hand those legacy rows the in-process, no-sandbox, no-env-scrub
// postgres-turn path, pointed at the ORCHESTRATOR's own checkout with the
// server's unscrubbed process.env — strictly worse than what they got before M2
// (remote dispatch to a container, or a locally sandboxed sdk-session turn).
//
// So: a row is server-runtime only if its placement AND its tool surface agree.
// A server row with an unsafe profile is DEMOTED here and behaves exactly like a
// worker row everywhere — dispatch, the pending pump, the sweeps, the context
// mode. Demotion is logged once per run so operators can find and migrate the
// legacy rows.
//
// DEPENDENCY-LIGHT ON PURPOSE (same contract as run-liveness.ts): runs.ts and
// run-dispatch.ts must both be able to import this, and run-dispatch must not
// statically import runs.ts. lib/profiles.ts is safe to import — its only
// top-level imports are types, and every extension factory is loaded lazily.

import { serverUnsafeProfiles } from "./profiles";

/** The columns the placement decision reads. Structural so it accepts a RunRow,
 *  a partial `db.select()` projection, and a dispatch-side snapshot alike. */
export interface RunPlacementRow {
  id: number;
  runtime: string;
  toolsProfile?: string | null;
}

/** Runs already warned about, so a demoted legacy row logs once per process
 *  rather than once per wake/turn/sweep tick. */
const warnedDemotions = new Set<number>();

/**
 * True when this run's turns may execute IN the orchestrator process: placement
 * says 'server' AND every profile it mounts is server-safe (lib/profiles.ts
 * `serverSafe` — tool-mediated only, no shell, no filesystem, no repo write).
 *
 * False for every worker row and for a legacy server row whose profile is
 * unsafe; the latter is logged once (see the module note). Callers must use
 * this for EVERY turn-time placement decision — dispatch routing, the
 * sendMessageToRun branch, the postgres/sdk-session context mode, the pending
 * pump's queue, and the reaper policies — so a demoted row consistently gets the
 * worker belts back (pump, reconcile, container sweep) instead of falling
 * between the two tiers.
 */
export function isServerRuntimeRun(run: RunPlacementRow): boolean {
  if (run.runtime !== "server") return false;
  const unsafe = serverUnsafeProfiles(run.toolsProfile ?? "");
  if (unsafe.length === 0) return true;
  if (!warnedDemotions.has(run.id)) {
    warnedDemotions.add(run.id);
    console.warn(
      `[run-runtime] run ${run.id} has runtime='server' but a non-server-safe tools profile ` +
        `('${run.toolsProfile ?? ""}': ${unsafe.join(", ")}). Treating it as a WORKER run — an ` +
        `in-process turn would run those tools against the orchestrator's own checkout and ` +
        `environment. This is a legacy row from the retired lightweight tier; migrate it to ` +
        `runtime='worker' (or a server-safe profile) to silence this.`
    );
  }
  return false;
}

/** Test seam: forget which runs have already logged a demotion warning. */
export function __resetDemotionWarnings(): void {
  warnedDemotions.clear();
}
