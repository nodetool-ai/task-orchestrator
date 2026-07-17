// The Box template-build feedback contract (spec:
// docs/superpowers/specs/2026-07-17-box-template-build-feedback-design.md).
// Shared by the server emitter (ensureTemplate, via emitTemplateBuildLifecycle)
// and the run view (reducer + view model), so it must stay pure: no db, no
// server-only imports.

export const TEMPLATE_BUILD_STEPS = [
  "cloning-worker",
  "installing-deps",
  "building-worker",
  "writing-manifest",
  "archiving",
] as const;

export type TemplateBuildReason = "no-template" | "sha-drift";

export const TEMPLATE_EVENT = {
  building: "runner_box_template_building",
  step: "runner_box_template_step",
  ready: "runner_box_template_ready",
  failed: "runner_box_template_failed",
} as const;

export const TEMPLATE_BUILD_DEFAULT_ESTIMATE_SECONDS = 900;

export interface TemplateBuildState {
  phase: "building" | "ready" | "failed";
  steps: string[];
  /** -1 before the first step event. */
  stepIndex: number;
  /** Client receipt time (ms) of the building event. */
  startedAt: number;
  /** Client receipt time (ms) of the latest step advance. */
  stepStartedAt: number;
  estimatedSeconds: number;
  durationMs?: number;
  error?: string;
  failedStep?: string;
}

/**
 * Fold one SSE event (the flat `{ type, ...payload }` shape produced by
 * lib/run-stream.ts) into the build state. Tolerates replays and out-of-order
 * delivery: stepIndex is monotonic, terminal phases win over stale steps, and
 * a step with no preceding building event is ignored.
 */
export function reduceTemplateBuildEvent(
  state: TemplateBuildState | null,
  event: Record<string, unknown> & { type: string },
  nowMs: number
): TemplateBuildState | null {
  switch (event.type) {
    case TEMPLATE_EVENT.building: {
      const steps = Array.isArray(event.steps) && event.steps.length > 0
        ? (event.steps as string[])
        : [...TEMPLATE_BUILD_STEPS];
      const estimatedSeconds =
        typeof event.estimatedSeconds === "number" && event.estimatedSeconds > 0
          ? event.estimatedSeconds
          : TEMPLATE_BUILD_DEFAULT_ESTIMATE_SECONDS;
      return {
        phase: "building",
        steps,
        stepIndex: -1,
        startedAt: nowMs,
        stepStartedAt: nowMs,
        estimatedSeconds,
      };
    }
    case TEMPLATE_EVENT.step: {
      if (!state || state.phase !== "building") return state;
      const index = typeof event.index === "number" ? event.index : state.stepIndex;
      if (index <= state.stepIndex) return state; // stale replay
      return { ...state, stepIndex: index, stepStartedAt: nowMs };
    }
    case TEMPLATE_EVENT.ready: {
      const base = state ?? initialTerminalState(nowMs);
      return {
        ...base,
        phase: "ready",
        stepIndex: base.steps.length - 1,
        durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
      };
    }
    case TEMPLATE_EVENT.failed: {
      const base = state ?? initialTerminalState(nowMs);
      return {
        ...base,
        phase: "failed",
        failedStep: typeof event.step === "string" ? event.step : undefined,
        error: typeof event.error === "string" ? event.error : "Template build failed",
      };
    }
    default:
      return state;
  }
}

/** A reconnect can replay only the terminal event; synthesize a base state. */
function initialTerminalState(nowMs: number): TemplateBuildState {
  return {
    phase: "building",
    steps: [...TEMPLATE_BUILD_STEPS],
    stepIndex: -1,
    startedAt: nowMs,
    stepStartedAt: nowMs,
    estimatedSeconds: TEMPLATE_BUILD_DEFAULT_ESTIMATE_SECONDS,
  };
}

/**
 * Drive a template build while emitting the lifecycle contract. The future
 * ensureTemplate() wraps its build in this with
 * `emit = (type, payload) => emitBoxEvent(runId, type, payload)`; the contract
 * (building → step(index/total)… → ready | failed) is enforced here so every
 * caller emits the exact sequence the run view's reducer expects.
 *
 * Emission is awaited but the emitter itself must be non-throwing (emitBoxEvent
 * already swallows persistence errors); a build failure is emitted as `failed`
 * and then rethrown so the caller's error handling still runs.
 */
export async function emitTemplateBuildLifecycle<T extends { templateId: string }>(opts: {
  emit: (type: string, payload: Record<string, unknown>) => Promise<void>;
  workerSha: string;
  reason: TemplateBuildReason;
  steps?: readonly string[];
  estimatedSeconds?: number;
  now?: () => number;
  build: (step: (name: string) => Promise<void>) => Promise<T>;
}): Promise<T> {
  const steps = opts.steps ?? TEMPLATE_BUILD_STEPS;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let currentStep: string | undefined;

  await opts.emit(TEMPLATE_EVENT.building, {
    workerSha: opts.workerSha,
    reason: opts.reason,
    steps: [...steps],
    estimatedSeconds: opts.estimatedSeconds ?? TEMPLATE_BUILD_DEFAULT_ESTIMATE_SECONDS,
  });

  const step = async (name: string): Promise<void> => {
    const index = steps.indexOf(name);
    if (index === -1) throw new Error(`Template build step "${name}" is not declared in steps.`);
    currentStep = name;
    await opts.emit(TEMPLATE_EVENT.step, { step: name, index, total: steps.length });
  };

  try {
    const result = await opts.build(step);
    await opts.emit(TEMPLATE_EVENT.ready, {
      templateId: result.templateId,
      durationMs: now() - startedAt,
    });
    return result;
  } catch (error) {
    await opts.emit(TEMPLATE_EVENT.failed, {
      step: currentStep,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

const STEP_LABELS: Record<string, string> = {
  "cloning-worker": "Cloning worker repo",
  "installing-deps": "Installing dependencies",
  "building-worker": "Building worker",
  "cloning-agent-repo": "Cloning agent repo",
  "installing-agent-deps": "Installing agent dependencies",
  "writing-manifest": "Writing manifest",
  "archiving": "Archiving snapshot",
};

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export interface TemplateBuildStepView {
  step: string;
  label: string;
  state: "done" | "active" | "todo" | "failed";
  elapsedSeconds?: number;
}

export interface TemplateBuildView {
  phase: TemplateBuildState["phase"];
  title: string;
  expectation: string;
  elapsedLabel: string;
  showReassurance: boolean;
  reassurance: string;
  steps: TemplateBuildStepView[];
  readyLabel?: string;
  error?: string;
  failureHint: string;
}

/** Everything the stepper renders, computed here so it is unit-testable
 *  without a DOM (this repo's vitest runs in node, no jsdom). */
export function templateBuildView(state: TemplateBuildState, nowMs: number): TemplateBuildView {
  const steps: TemplateBuildStepView[] = state.steps.map((step, i) => {
    if (state.phase === "failed" && step === state.failedStep) {
      return { step, label: STEP_LABELS[step] ?? step, state: "failed" };
    }
    const done = state.phase === "ready" || i < state.stepIndex;
    const active = state.phase === "building" && i === state.stepIndex;
    return {
      step,
      label: STEP_LABELS[step] ?? step,
      state: done ? "done" : active ? "active" : "todo",
      ...(active ? { elapsedSeconds: Math.floor((nowMs - state.stepStartedAt) / 1000) } : {}),
    };
  });

  return {
    phase: state.phase,
    title: "Setting up the box template",
    expectation:
      "One-time setup for this worker build — usually 10–15 minutes. Later runs skip this.",
    elapsedLabel: formatDuration(nowMs - state.startedAt),
    showReassurance:
      state.phase === "building" && nowMs - state.startedAt > state.estimatedSeconds * 1000 * 1.5,
    reassurance: "Still working — dependency installs can be slow on cold caches",
    steps,
    ...(state.phase === "ready" && state.durationMs != null
      ? { readyLabel: `Template ready (${formatDuration(state.durationMs)})` }
      : {}),
    ...(state.error ? { error: state.error } : {}),
    failureHint: "Re-dispatching the run retries the build.",
  };
}
