import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { wallClockTimeout } from "./wall-clock-timeout";

export type WorkerExitReason = "completed" | "fatal" | "controller_lost" | "idle_backstop" | "signal";

/** Infrastructure loss is recoverable by a fresh generation; it is never an
 * operator's run.cancel and must not consume the active turn as cancelled. */
export class WorkerShutdownError extends Error {
  constructor(readonly exitReason: WorkerExitReason) {
    super(`Worker shutting down: ${exitReason}`);
    this.name = "WorkerShutdownError";
  }
}

export interface WorkerExitEvidence {
  version: 1;
  runId: number;
  instanceId: string;
  workerGeneration: number;
  pid: number;
  state: "exiting";
  reason: WorkerExitReason;
  at: string;
}

/** Separate from the channel outbox: replacement workers cannot replay another
 * instance's receipts. This marker diagnoses an irrevocable local shutdown;
 * provider reconciliation still needs process-death evidence before recovery. */
export async function writeWorkerExitEvidence(
  sessionRoot: string,
  evidence: WorkerExitEvidence,
): Promise<void> {
  if (!/^wi_[a-f0-9]{32}$/.test(evidence.instanceId)) throw new Error("invalid worker instance");
  if (!Number.isSafeInteger(evidence.runId) || evidence.runId <= 0 ||
      !Number.isSafeInteger(evidence.workerGeneration) || evidence.workerGeneration <= 0) {
    throw new Error("invalid worker generation identity");
  }
  const directory = join(sessionRoot, "workers", evidence.instanceId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `exit.json.${process.pid}.tmp`);
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(evidence) + "\n", "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, join(directory, "exit.json"));
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

/** Resolve after a bounded best-effort operation, including a stuck session
 * send/outbox tail. The underlying rejection remains observed after timeout. */
export async function boundedShutdownStep(operation: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let cancelTimer: (() => void) | undefined;
  const deadline = Date.now() + timeoutMs;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(() => Date.now() <= deadline, () => false),
      new Promise<false>((resolve) => { cancelTimer = wallClockTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    cancelTimer?.();
  }
}

export async function shutdownWorker(options: {
  sessionRoot: string;
  evidence: WorkerExitEvidence;
  abort(reason: WorkerShutdownError): void;
  driver?: Promise<unknown>;
  flushLog?: () => Promise<unknown>;
  close?: () => Promise<unknown>;
  shutdownDiagnostics?: () => Promise<unknown>;
  /** Total outer bound, primarily injectable by tests. */
  timeoutMs?: number;
}): Promise<{ evidenceWritten: boolean; drained: boolean }> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  let evidenceWritten = false;
  let abortFailed = false;
  let abortAttempted = false;
  const abort = () => {
    if (abortAttempted) return;
    abortAttempted = true;
    try { options.abort(new WorkerShutdownError(options.evidence.reason)); }
    catch { abortFailed = true; }
  };
  const drained = await boundedShutdownStep(async () => {
    // Disk pressure must not prevent the abort or process-level backstop. If
    // even fsync cannot finish, process absence still proves this worker died.
    evidenceWritten = await boundedShutdownStep(
      () => writeWorkerExitEvidence(options.sessionRoot, options.evidence),
      Math.min(1_000, timeoutMs / 4),
    );
    abort();
    if (options.driver) await boundedShutdownStep(() => options.driver!, Math.min(1_000, timeoutMs / 4));
    // Preserve log/terminal outbox writes before closing the channel. None of
    // these waits may hold the process open indefinitely without a controller.
    if (options.flushLog) await boundedShutdownStep(options.flushLog, Math.min(500, timeoutMs / 4));
    if (options.close) await options.close();
    if (options.shutdownDiagnostics) await options.shutdownDiagnostics();
  }, timeoutMs);
  // Also covers a synchronous abort callback failure or a stalled evidence I/O.
  abort();
  return { evidenceWritten, drained: drained && !abortFailed };
}
