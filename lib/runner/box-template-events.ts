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
