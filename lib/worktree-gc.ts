// Worktree garbage collection.
//
// Idle runs accumulate worktrees on disk: each implement-style run carves a
// fresh worktree under .worktrees/<id> and we keep it around after the run
// lands at `idle` so resuming is instant (no clone, no checkout). For runs
// whose work has been merged (or the branch otherwise reset), the worktree
// is dead weight — this module sweeps those out.
//
// Removal predicate (all must hold):
//   1. status === 'idle'
//   2. worktree_path is set AND the directory exists on disk
//   3. last activity (newest agent_messages.created_at, or startedAt) is
//      older than TASK_ORCH_WORKTREE_GC_DAYS (default 7)
//   4. `git -C <worktree> rev-list --count origin/<base>..<branch>` === 0
//      (no commits ahead of base — branch is fully merged or reset)
//
// If TASK_ORCH_KEEP_WORKTREES is set we skip the removal step entirely (the
// predicate is still computed, useful for tests). The hourly sweep is gated
// behind TASK_ORCH_WORKTREE_GC truthy so local dev isn't surprised by disk
// state changing under it.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { desc, eq, isNotNull, max } from "drizzle-orm";

import { db } from "@/db";
import { agentMessages, agentSessions, repositories } from "@/db/schema";

const DEFAULT_GC_DAYS = 7;
const HOUR_MS = 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────

export interface GcCandidate {
  runId: number;
  status: string;
  branch: string | null;
  worktreePath: string | null;
  repoId: string | null;
  baseBranch: string;
  lastActivityAt: Date;
}

export interface ShouldRemoveArgs {
  candidate: GcCandidate;
  now: Date;
  thresholdDays: number;
  /** Returns true iff the worktree directory currently exists on disk. */
  worktreeExists: (path: string) => boolean;
  /**
   * Returns commit count of `<branch>` ahead of `origin/<base>`. Caller is
   * responsible for shelling out to git in production; tests inject a stub.
   */
  revListCount: (worktree: string, base: string, branch: string) => Promise<number>;
}

export type ShouldRemoveResult =
  | { remove: true; idleDays: number }
  | { remove: false; reason: string };

// ──────────────────────────────────────────────────────────
// Pure predicate (the unit-tested core)
// ──────────────────────────────────────────────────────────

export async function shouldRemoveWorktree(args: ShouldRemoveArgs): Promise<ShouldRemoveResult> {
  const { candidate, now, thresholdDays, worktreeExists, revListCount } = args;
  if (candidate.status !== "idle") {
    return { remove: false, reason: `status=${candidate.status} (need idle)` };
  }
  if (!candidate.worktreePath) {
    return { remove: false, reason: "no worktree_path" };
  }
  if (!candidate.branch) {
    return { remove: false, reason: "no branch" };
  }
  if (!worktreeExists(candidate.worktreePath)) {
    return { remove: false, reason: "worktree missing on disk" };
  }
  const idleMs = now.getTime() - candidate.lastActivityAt.getTime();
  const idleDays = idleMs / (24 * 60 * 60 * 1000);
  if (idleDays < thresholdDays) {
    return {
      remove: false,
      reason: `idle ${idleDays.toFixed(2)}d < threshold ${thresholdDays}d`,
    };
  }
  let ahead: number;
  try {
    ahead = await revListCount(candidate.worktreePath, candidate.baseBranch, candidate.branch);
  } catch (err) {
    return {
      remove: false,
      reason: `rev-list failed: ${describe(err)}`,
    };
  }
  if (ahead > 0) {
    return { remove: false, reason: `${ahead} commits ahead of origin/${candidate.baseBranch}` };
  }
  return { remove: true, idleDays };
}

// ──────────────────────────────────────────────────────────
// Production sweep
// ──────────────────────────────────────────────────────────

export interface RunGcOnceOptions {
  /** Override the threshold (defaults to env / 7). */
  thresholdDays?: number;
  /** Injection point for tests: list candidate rows. */
  listCandidates?: () => GcCandidate[];
  /** Injection point for tests: rev-list count. */
  revListCount?: (worktree: string, base: string, branch: string) => Promise<number>;
  /** Injection point for tests: existence check. */
  worktreeExists?: (path: string) => boolean;
  /** Injection point for tests: `git worktree remove --force <path>`. */
  removeWorktree?: (worktree: string, repoRoot: string) => Promise<void>;
  /** Injection point for tests: `git -C <root> worktree prune`. */
  pruneAdmin?: (repoRoot: string) => Promise<void>;
  /** Resolve repo root for a candidate (defaults to lookup via repositories). */
  resolveRepoRoot?: (candidate: GcCandidate) => string | null;
  /** Append a system message; defaults to writing to agent_messages. */
  appendSystemMessage?: (runId: number, text: string) => void;
  /** Clock injection. */
  now?: () => Date;
  /** When true, do not run `git worktree remove` even if predicate passes. */
  keepWorktrees?: boolean;
}

export interface RunGcOnceResult {
  scanned: number;
  removed: number;
  errors: number;
  removals: Array<{ runId: number; worktreePath: string; idleDays: number }>;
}

export async function runWorktreeGcOnce(opts: RunGcOnceOptions = {}): Promise<RunGcOnceResult> {
  const thresholdDays =
    opts.thresholdDays ?? readThresholdDaysFromEnv() ?? DEFAULT_GC_DAYS;
  const now = (opts.now ?? (() => new Date()))();
  const listCandidates = opts.listCandidates ?? defaultListCandidates;
  const revListCount = opts.revListCount ?? defaultRevListCount;
  const worktreeExists = opts.worktreeExists ?? defaultWorktreeExists;
  const removeWorktree = opts.removeWorktree ?? defaultRemoveWorktree;
  const pruneAdmin = opts.pruneAdmin ?? defaultPruneAdmin;
  const resolveRepoRoot = opts.resolveRepoRoot ?? defaultResolveRepoRoot;
  const appendSystemMessage = opts.appendSystemMessage ?? defaultAppendSystemMessage;
  const keep = opts.keepWorktrees ?? !!process.env.TASK_ORCH_KEEP_WORKTREES;

  const candidates = listCandidates();
  const result: RunGcOnceResult = { scanned: candidates.length, removed: 0, errors: 0, removals: [] };
  const rootsTouched = new Set<string>();

  for (const c of candidates) {
    const decision = await shouldRemoveWorktree({
      candidate: c,
      now,
      thresholdDays,
      worktreeExists,
      revListCount,
    });
    if (!decision.remove) continue;
    if (keep) {
      // Still emit a note so operators can see what *would* be GC'd.
      appendSystemMessage(
        c.runId,
        `worktree garbage-collect skipped (KEEP_WORKTREES) after ${decision.idleDays.toFixed(1)} days idle.`
      );
      continue;
    }
    const root = resolveRepoRoot(c);
    if (!root) {
      result.errors++;
      continue;
    }
    try {
      await removeWorktree(c.worktreePath!, root);
      const days = Math.round(decision.idleDays);
      appendSystemMessage(
        c.runId,
        `worktree garbage-collected after ${days} days idle.`
      );
      result.removed++;
      result.removals.push({ runId: c.runId, worktreePath: c.worktreePath!, idleDays: decision.idleDays });
      rootsTouched.add(root);
    } catch (err) {
      result.errors++;
      console.warn(`[worktree-gc] failed to remove ${c.worktreePath}: ${describe(err)}`);
    }
  }

  for (const root of rootsTouched) {
    try {
      await pruneAdmin(root);
    } catch (err) {
      console.warn(`[worktree-gc] prune failed for ${root}: ${describe(err)}`);
    }
  }

  return result;
}

// ──────────────────────────────────────────────────────────
// Hourly scheduler
// ──────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __worktreeGcTimer: ReturnType<typeof setInterval> | undefined;
}

/**
 * Idempotently start the hourly GC sweep. No-op when
 * TASK_ORCH_WORKTREE_GC is not truthy. Safe to call from instrumentation.ts
 * on every cold start; the timer is held on globalThis so HMR doesn't spawn
 * a swarm.
 */
export function startWorktreeGc(): void {
  if (!isEnabled()) return;
  if (globalThis.__worktreeGcTimer) return;
  // Kick once on startup so a long-running idle box gets cleaned without
  // waiting an hour.
  void runWorktreeGcOnce().catch((err) =>
    console.warn(`[worktree-gc] initial sweep failed: ${describe(err)}`)
  );
  globalThis.__worktreeGcTimer = setInterval(() => {
    void runWorktreeGcOnce().catch((err) =>
      console.warn(`[worktree-gc] sweep failed: ${describe(err)}`)
    );
  }, HOUR_MS);
  // Don't keep the node process alive solely for the GC timer.
  globalThis.__worktreeGcTimer.unref?.();
}

export function stopWorktreeGc(): void {
  if (globalThis.__worktreeGcTimer) {
    clearInterval(globalThis.__worktreeGcTimer);
    globalThis.__worktreeGcTimer = undefined;
  }
}

export function isEnabled(): boolean {
  return isTruthy(process.env.TASK_ORCH_WORKTREE_GC);
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "off" && s !== "no";
}

function readThresholdDaysFromEnv(): number | null {
  const raw = process.env.TASK_ORCH_WORKTREE_GC_DAYS;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// ──────────────────────────────────────────────────────────
// Default implementations (DB + shell)
// ──────────────────────────────────────────────────────────

function defaultListCandidates(): GcCandidate[] {
  // Pull every idle run with a worktree_path. Compute lastActivityAt as
  // max(agent_messages.created_at) per run, falling back to the run's
  // startedAt when the run has no messages yet (rare for idle runs).
  const lastMsg = db
    .select({
      runId: agentMessages.runId,
      last: max(agentMessages.createdAt).as("last"),
    })
    .from(agentMessages)
    .groupBy(agentMessages.runId)
    .as("last_msg");

  const rows = db
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
      branch: agentSessions.branch,
      worktreePath: agentSessions.worktreePath,
      repoId: agentSessions.repoId,
      startedAt: agentSessions.startedAt,
      lastMessageAt: lastMsg.last,
      defaultBranch: repositories.defaultBranch,
    })
    .from(agentSessions)
    .leftJoin(lastMsg, eq(lastMsg.runId, agentSessions.id))
    .leftJoin(repositories, eq(repositories.id, agentSessions.repoId))
    .where(eq(agentSessions.status, "idle"))
    .orderBy(desc(agentSessions.id))
    .all();

  return rows
    .filter((r) => r.worktreePath && r.branch)
    .map((r) => ({
      runId: r.id,
      status: r.status,
      branch: r.branch,
      worktreePath: r.worktreePath,
      repoId: r.repoId,
      baseBranch: r.defaultBranch ?? "main",
      lastActivityAt: coerceDate(r.lastMessageAt) ?? r.startedAt,
    }));
}

function coerceDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return new Date(n);
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function defaultWorktreeExists(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function defaultRevListCount(
  worktree: string,
  base: string,
  branch: string
): Promise<number> {
  return new Promise((resolveP) => {
    const child = spawn(
      "git",
      ["-C", worktree, "rev-list", "--count", `origin/${base}..${branch}`],
      { env: process.env }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      // Treat as "unknown" — surface via rejection so caller bails on remove.
      reject(e);
    });
    let rejected = false;
    function reject(e: unknown) {
      if (rejected) return;
      rejected = true;
      resolveP(Promise.reject(e));
    }
    child.on("close", (code) => {
      if (rejected) return;
      if (code !== 0) {
        reject(new Error(`git rev-list exited ${code}: ${err.trim() || out.trim()}`));
        return;
      }
      const n = parseInt(out.trim(), 10);
      if (!Number.isFinite(n)) {
        reject(new Error(`git rev-list returned non-numeric output: ${out}`));
        return;
      }
      resolveP(n);
    });
  });
}

function defaultRemoveWorktree(worktree: string, repoRoot: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("git", ["worktree", "remove", "--force", worktree], {
      cwd: repoRoot,
      env: process.env,
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", rejectP);
    child.on("close", (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`git worktree remove exited ${code}: ${err.trim()}`));
    });
  });
}

function defaultPruneAdmin(repoRoot: string): Promise<void> {
  return new Promise((resolveP) => {
    const child = spawn("git", ["-C", repoRoot, "worktree", "prune"], { env: process.env });
    child.on("error", () => resolveP());
    child.on("close", () => resolveP());
  });
}

function defaultResolveRepoRoot(c: GcCandidate): string | null {
  if (c.repoId) {
    const row = db
      .select({ localPath: repositories.localPath })
      .from(repositories)
      .where(eq(repositories.id, c.repoId))
      .get();
    if (row?.localPath) return resolve(row.localPath);
  }
  // Fall back to the parent of the worktree (.worktrees/<id> → repo root).
  if (c.worktreePath) {
    const wtParent = dirname(c.worktreePath);
    // .worktrees lives directly under the repo root.
    const parent = dirname(wtParent);
    if (parent && existsSync(parent)) return resolve(parent);
  }
  return null;
}

function defaultAppendSystemMessage(runId: number, text: string): void {
  try {
    db.insert(agentMessages)
      .values({
        runId,
        role: "system",
        content: JSON.stringify([{ type: "text", text }]),
        createdAt: new Date(),
      })
      .run();
  } catch (err) {
    console.warn(`[worktree-gc] failed to append system message for run ${runId}: ${describe(err)}`);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

// `isNotNull` is imported above but only kept for downstream queries that may
// want to add nullability constraints. Silence unused if the lint flips.
void isNotNull;
