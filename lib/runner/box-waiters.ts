// Abortable Box lifecycle polling. Kept separate from BoxRunnerProvider so the
// provider can be tested against a deterministic fake without real timers.

import type { BoxClient, BoxInfo, BoxSnapshot } from "./box-client";
import type { RunnerState } from "./provider";

export type BoxWaitOptions = {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 5_000;

export function boxStateToRunnerState(state: string): RunnerState {
  switch (state) {
    case "init":
    case "provisioning":
    case "provisioned":
    case "cloning":
    case "archiving":
      return "starting";
    case "ready":
    case "idle":
    case "running":
      return "running";
    case "archived":
      return "stopped";
    // Box's error state is recoverable: reconciliation records it and attempts
    // bounded recovery before declaring filesystem loss. Never collapse it to
    // `gone`, which would allow terminal cleanup of a still-restorable box.
    case "error":
      return "starting";
    case "deleted":
    case "missing":
      return "gone";
    default:
      return "starting";
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Box wait aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Box wait aborted"));
      },
      { once: true }
    );
  });
}

function waitContext(options: BoxWaitOptions) {
  return {
    deadline: (options.now ?? Date.now)() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    now: options.now ?? Date.now,
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    signal: options.signal,
    sleep: options.sleep ?? defaultSleep,
  };
}

function assertWaiting(context: ReturnType<typeof waitContext>, boxId: string): void {
  if (context.signal?.aborted) throw context.signal.reason ?? new Error(`Box ${boxId} wait aborted`);
  if (context.now() > context.deadline) throw new Error(`Timed out waiting for Box ${boxId}`);
}

/** Wait until Box can accept a command; provisioning/archiving are not ready. */
export async function waitForBoxReady(client: BoxClient, boxId: string, options: BoxWaitOptions = {}): Promise<BoxInfo> {
  const context = waitContext(options);
  for (;;) {
    assertWaiting(context, boxId);
    const box = await client.get(boxId);
    if (box.state === "ready" || box.state === "idle") return box;
    if (box.state === "error") throw new Error(`Box ${boxId} entered error state while waiting for readiness`);
    await context.sleep(context.pollMs, context.signal);
  }
}

export type BoxCheckpoint = { box: BoxInfo; snapshot: BoxSnapshot };

/**
 * Stop is durable only once Box reports an archived state and a completed
 * snapshot that post-dates this checkpoint attempt. A stale old snapshot must
 * never be accepted as proof that the just-released worker was preserved.
 */
export async function waitForBoxCheckpoint(
  client: BoxClient,
  boxId: string,
  requestedAt: Date | number,
  options: BoxWaitOptions = {}
): Promise<BoxCheckpoint> {
  const context = waitContext(options);
  const requestedMs = requestedAt instanceof Date ? requestedAt.getTime() : requestedAt;
  if (!Number.isFinite(requestedMs)) throw new Error("Box checkpoint request time must be valid");
  for (;;) {
    assertWaiting(context, boxId);
    const box = await client.get(boxId);
    if (box.state === "error") throw new Error(`Box ${boxId} entered error state while waiting for checkpoint`);
    const completedAt = box.snapshotCompletedAt?.getTime();
    if (box.state === "archived" && (box.lastSnapshotStatus === "failed" || box.lastSnapshotStatus === "cancelled")) {
      throw new Error(`Box ${boxId} failed its final checkpoint snapshot`);
    }
    if (box.state === "archived" && box.lastSnapshotStatus === "completed" && completedAt != null && completedAt >= requestedMs) {
      const snapshot = await client.getLatestBoxSnapshot(boxId);
      if (snapshot && snapshot.status === "completed") return { box, snapshot };
      // The box record and snapshot index are eventually consistent. Keep
      // polling rather than treating a lagging latest-snapshot read as a
      // checkpoint failure; timeout remains bounded by the caller's deadline.
    }
    await context.sleep(context.pollMs, context.signal);
  }
}
