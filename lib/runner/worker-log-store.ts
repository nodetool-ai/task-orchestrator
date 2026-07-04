// lib/runner/worker-log-store.ts
//
// Durable capture of a run's worker output into agent_sessions.worker_log.
//
// For LOCAL docker runs the worker monitor (lib/run-dispatch) captures `docker
// logs` into worker_log when the container dies. A Fly run has no docker
// container: its only worker-output artifact is `logs/runner.log` on the
// per-run Fly volume (the entrypoint tee's the worker's stdout/stderr there),
// and that volume is destroyed with the Machine — so the debugging history is
// lost unless we ship it into Postgres. This module flushes that file into
// worker_log INCREMENTALLY during the run and once more at terminal, from
// inside the worker process (scripts/run-worker.ts), where the file exists.

import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { db } from "@/db";
import { agentSessions } from "@/db/schema";

// Stored log tail cap (chars) so the run row stays bounded. Matches
// run-dispatch's cap; defined locally (no import) so the two log-capture paths
// stay decoupled — a worker importing lib/run-dispatch would pull in the docker
// monitor it has no business loading.
export const WORKER_LOG_MAX_CHARS = 64_000;

// Default flush cadence: often enough that a crash loses little, rare enough
// that a chatty worker doesn't hammer Postgres with 64KB writes.
const DEFAULT_FLUSH_MS = 15_000;

/**
 * The last WORKER_LOG_MAX_CHARS chars of `text`, safe to store in Postgres.
 * Pure + unit-testable. Mirrors run-dispatch's fetchContainerLog: the tail cut
 * can land mid-surrogate-pair (an emoji in the log), and a leading lone low
 * surrogate (0xDC00–0xDFFF) is invalid UTF-8 that Postgres rejects — strip it.
 */
export function tailForStorage(text: string): string {
  if (text.length <= WORKER_LOG_MAX_CHARS) return text;
  let tail = text.slice(-WORKER_LOG_MAX_CHARS);
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  return tail;
}

/**
 * Read `filePath` and write its tail into agent_sessions.worker_log for `runId`.
 * Returns true on a successful write, false on any failure (missing/unreadable
 * file, DB error). A log-flush failure must NEVER break the run — every error
 * is swallowed (logged via console.error) so the caller can keep driving.
 */
export async function flushWorkerLogFromFile(runId: number, filePath: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    // File not created yet, or unreadable — nothing to flush this tick.
    return false;
  }
  try {
    await db
      .update(agentSessions)
      .set({ workerLog: tailForStorage(text) })
      .where(eq(agentSessions.id, runId));
    return true;
  } catch (err) {
    console.error(`[worker-log-store] flush failed for run ${runId}:`, err);
    return false;
  }
}

/**
 * Start a periodic flusher for `filePath` and return a `stop()` that clears the
 * timer AND performs one final (terminal) flush. Call the returned stop() in a
 * finally so both the success and error paths land the last bytes of the log.
 *
 * intervalMs<=0 disables the timer entirely (the returned stop() still does the
 * one final flush). The timer is unref'd so it never keeps the worker alive.
 */
export function startWorkerLogFlusher(
  runId: number,
  filePath: string,
  intervalMs: number = DEFAULT_FLUSH_MS
): () => Promise<void> {
  // Guard against overlapping flushes: a slow read/write must not stack up
  // behind the interval (each flush reads the whole file + writes up to 64KB).
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await flushWorkerLogFromFile(runId, filePath);
    } finally {
      inFlight = false;
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  if (intervalMs > 0) {
    timer = setInterval(() => void tick(), intervalMs);
    (timer as { unref?: () => void }).unref?.();
  }

  return async function stop(): Promise<void> {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Terminal flush: capture whatever was written since the last tick. Wait
    // out any in-flight periodic flush so this final one wins the last write.
    while (inFlight) await new Promise((r) => setTimeout(r, 50));
    await flushWorkerLogFromFile(runId, filePath);
  };
}
