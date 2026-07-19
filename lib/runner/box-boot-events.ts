// The Box boot / worker-startup feedback contract. This mirrors the template
// build feedback (lib/runner/box-template-events.ts) but covers the *per-run*
// box lifecycle: forking (or blank-provisioning) the box, waiting for it to
// come up, launching the worker, and hosting its control channel.
//
// The events are already emitted by lib/runner/box.ts via emitBoxEvent and ride
// the same SSE stream as everything else (flat `{ type, ...payload }` frames).
// This module is the shared reducer + view model, so it must stay pure: no db,
// no server-only imports.

import { formatDuration } from "./box-template-events";

export { formatDuration };

// The box-side lifecycle events box.ts emits during create()/readyAndLaunch().
export const BOX_BOOT_EVENT = {
  // fork provisioning: fork the run box off the ready template snapshot.
  forking: "runner_box_forking",
  // blank provisioning: create a fresh box and push+run the worker bundle.
  provisioning: "runner_box_provisioning",
  // box is up and its template manifest was read; about to launch the worker.
  ready: "runner_box_ready",
  // the worker bootstrap command was launched (its early log was captured).
  bootstrapLog: "runner_box_bootstrap_log",
  // the worker's control channel is exposed through the host proxy — the last
  // step before the run starts producing agent output.
  channelHosted: "runner_box_channel_hosted",
  // any provisioning error during boot.
  failed: "runner_failed",
} as const;

export type BoxBootMode = "fork" | "blank";

// The three human-visible boot steps, in order. The first step's label depends
// on the provisioning mode (fork vs blank); the rest are shared.
export const BOX_BOOT_STEPS = ["starting-box", "starting-worker", "connecting"] as const;

export interface BoxBootState {
  phase: "booting" | "ready" | "failed";
  mode: BoxBootMode;
  /** 0-based index into BOX_BOOT_STEPS of the currently active step. */
  stepIndex: number;
  /** Client receipt time (ms) of the first boot event. */
  startedAt: number;
  /** Client receipt time (ms) of the latest step advance. */
  stepStartedAt: number;
  durationMs?: number;
  error?: string;
  failedStep?: string;
}

function extractError(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Box provisioning failed";
}

/** A reconnect can replay only a mid/terminal event; synthesize a base state. */
function initialState(mode: BoxBootMode, nowMs: number): BoxBootState {
  return { phase: "booting", mode, stepIndex: 0, startedAt: nowMs, stepStartedAt: nowMs };
}

/** Advance to `index` only if it is a forward move (tolerates replays / reorders). */
function advance(state: BoxBootState, index: number, nowMs: number): BoxBootState {
  if (index <= state.stepIndex) return state;
  return { ...state, stepIndex: index, stepStartedAt: nowMs };
}

/**
 * Fold one SSE event (the flat `{ type, ...payload }` shape produced by
 * lib/run-stream.ts) into the boot state. Tolerates replays and out-of-order
 * delivery: stepIndex is monotonic, terminal phases win over stale steps, and a
 * `runner_failed` after boot has completed (a later rotation/resume failure) is
 * ignored so it can't resurrect the boot stepper.
 */
export function reduceBoxBootEvent(
  state: BoxBootState | null,
  event: Record<string, unknown> & { type: string },
  nowMs: number
): BoxBootState | null {
  switch (event.type) {
    case BOX_BOOT_EVENT.forking:
      return initialState("fork", nowMs);
    case BOX_BOOT_EVENT.provisioning:
      return initialState("blank", nowMs);
    case BOX_BOOT_EVENT.ready: {
      const base = state ?? initialState("fork", nowMs);
      if (base.phase !== "booting") return base;
      return advance(base, 1, nowMs);
    }
    case BOX_BOOT_EVENT.bootstrapLog: {
      if (!state || state.phase !== "booting") return state;
      return advance(state, 2, nowMs);
    }
    case BOX_BOOT_EVENT.channelHosted: {
      const base = state ?? initialState("fork", nowMs);
      if (base.phase === "failed") return base;
      return {
        ...base,
        phase: "ready",
        stepIndex: BOX_BOOT_STEPS.length - 1,
        durationMs: nowMs - base.startedAt,
      };
    }
    case BOX_BOOT_EVENT.failed: {
      // Only a failure *during boot* belongs on the boot stepper; a later
      // runner_failed (rotation, resume) must not revive it.
      if (!state || state.phase !== "booting") return state;
      return {
        ...state,
        phase: "failed",
        failedStep: BOX_BOOT_STEPS[state.stepIndex],
        error: extractError(event.error),
      };
    }
    default:
      return state;
  }
}

function stepLabel(step: string, mode: BoxBootMode): string {
  if (step === "starting-box") {
    return mode === "blank" ? "Provisioning the box" : "Forking the box";
  }
  if (step === "starting-worker") return "Starting the worker";
  if (step === "connecting") return "Connecting the agent channel";
  return step;
}

export interface BoxBootStepView {
  step: string;
  label: string;
  state: "done" | "active" | "todo" | "failed";
  elapsedSeconds?: number;
}

export interface BoxBootView {
  phase: BoxBootState["phase"];
  title: string;
  expectation: string;
  elapsedLabel: string;
  steps: BoxBootStepView[];
  readyLabel?: string;
  error?: string;
  failureHint: string;
}

/** Everything the boot stepper renders, computed here so it is unit-testable
 *  without a DOM (this repo's vitest runs in node, no jsdom). */
export function boxBootView(state: BoxBootState, nowMs: number): BoxBootView {
  const steps: BoxBootStepView[] = BOX_BOOT_STEPS.map((step, i) => {
    if (state.phase === "failed" && i === state.stepIndex) {
      return { step, label: stepLabel(step, state.mode), state: "failed" };
    }
    const done = state.phase === "ready" || i < state.stepIndex;
    const active = state.phase === "booting" && i === state.stepIndex;
    return {
      step,
      label: stepLabel(step, state.mode),
      state: done ? "done" : active ? "active" : "todo",
      ...(active ? { elapsedSeconds: Math.floor((nowMs - state.stepStartedAt) / 1000) } : {}),
    };
  });

  return {
    phase: state.phase,
    title: "Booting the box",
    expectation: "Spinning up an isolated box for this run and starting the worker.",
    elapsedLabel: formatDuration(nowMs - state.startedAt),
    steps,
    ...(state.phase === "ready" && state.durationMs != null
      ? { readyLabel: `Box ready (${formatDuration(state.durationMs)})` }
      : {}),
    ...(state.error ? { error: state.error } : {}),
    failureHint: "Re-sending the message retries provisioning.",
  };
}
