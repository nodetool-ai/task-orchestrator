import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

import { createLogger, type LogFields } from "@/lib/worker/log";

type Outcome = "success" | "error" | "deferred" | "skipped";
type Provider = "local" | "fly" | "box" | "unknown";

type TelemetryState = {
  registry: Registry;
  initialized: boolean;
  runnerEvents: Counter<string>;
  dispatches: Counter<string>;
  metricsRefreshErrors: Counter<string>;
  statusTransitions: Counter<string>;
  illegalTransitions: Counter<string>;
  phaseDuration: Histogram<string>;
  activeRuns: Gauge<string>;
  runnerInstances: Gauge<string>;
};

declare global {
  // eslint-disable-next-line no-var
  var __taskOrchTelemetry: TelemetryState | undefined;
}

const log = createLogger("runner.telemetry");

function makeState(): TelemetryState {
  const registry = new Registry();
  registry.setDefaultLabels({ service: "task-orchestrator" });

  collectDefaultMetrics({
    register: registry,
    prefix: "task_orch_",
  });

  return {
    registry,
    initialized: true,
    runnerEvents: new Counter({
      name: "task_orch_runner_lifecycle_events_total",
      help: "Runner lifecycle events emitted by the orchestrator.",
      labelNames: ["provider", "event"] as const,
      registers: [registry],
    }),
    dispatches: new Counter({
      name: "task_orch_runner_dispatch_total",
      help: "Run dispatch attempts by provider and result.",
      labelNames: ["provider", "result"] as const,
      registers: [registry],
    }),
    metricsRefreshErrors: new Counter({
      name: "task_orch_metrics_refresh_errors_total",
      help: "Errors while refreshing DB-backed gauges for the metrics endpoint.",
      labelNames: ["source"] as const,
      registers: [registry],
    }),
    statusTransitions: new Counter({
      name: "task_orch_run_status_transitions_total",
      help: "Run status transitions written by the orchestrator.",
      labelNames: ["status"] as const,
      registers: [registry],
    }),
    illegalTransitions: new Counter({
      name: "task_orch_run_illegal_transitions_total",
      help: "Run status transitions that violated the run-state legal-transition table (allowed, not rejected).",
      labelNames: ["from", "to"] as const,
      registers: [registry],
    }),
    phaseDuration: new Histogram({
      name: "task_orch_runner_phase_duration_seconds",
      help: "Duration of runner lifecycle and agent-turn phases.",
      labelNames: ["provider", "phase", "outcome"] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300, 600],
      registers: [registry],
    }),
    activeRuns: new Gauge({
      name: "task_orch_runs_active",
      help: "Current run rows by status.",
      labelNames: ["status"] as const,
      registers: [registry],
    }),
    runnerInstances: new Gauge({
      name: "task_orch_runner_instances",
      help: "Current detached runner instances by provider and state.",
      // Keep the service label first to match the stable metric exposition
      // shape used by dashboards and the telemetry contract.
      labelNames: ["service", "provider", "state"] as const,
      registers: [registry],
    }),
  };
}

export function telemetry(): TelemetryState {
  if (!globalThis.__taskOrchTelemetry) {
    globalThis.__taskOrchTelemetry = makeState();
  }
  return globalThis.__taskOrchTelemetry;
}

export function observeRunnerPhase(
  phase: string,
  seconds: number,
  opts: { provider?: Provider; outcome?: Outcome } = {}
): void {
  telemetry().phaseDuration
    .labels(opts.provider ?? "unknown", phase, opts.outcome ?? "success")
    .observe(seconds);
}

export async function timeRunnerPhase<T>(
  phase: string,
  fn: () => Promise<T>,
  opts: { provider?: Provider; fields?: LogFields } = {}
): Promise<T> {
  const started = process.hrtime.bigint();
  try {
    const result = await fn();
    const durationMs = elapsedMs(started);
    observeRunnerPhase(phase, durationMs / 1000, {
      provider: opts.provider ?? "unknown",
      outcome: "success",
    });
    log.debug("runner phase completed", {
      phase,
      provider: opts.provider ?? "unknown",
      durationMs,
      ...(opts.fields ?? {}),
    });
    return result;
  } catch (err) {
    const durationMs = elapsedMs(started);
    observeRunnerPhase(phase, durationMs / 1000, {
      provider: opts.provider ?? "unknown",
      outcome: "error",
    });
    log.warn("runner phase failed", {
      phase,
      provider: opts.provider ?? "unknown",
      durationMs,
      err,
      ...(opts.fields ?? {}),
    });
    throw err;
  }
}

export function recordRunnerEvent(
  event: string,
  opts: { provider?: Provider; runId?: number; fields?: LogFields } = {}
): void {
  telemetry().runnerEvents.labels(opts.provider ?? "unknown", event).inc();
  log.info("runner lifecycle event", {
    event,
    provider: opts.provider ?? "unknown",
    runId: opts.runId,
    ...(opts.fields ?? {}),
  });
}

export function recordDispatch(
  result: string,
  opts: { provider?: Provider; runId?: number; fields?: LogFields } = {}
): void {
  telemetry().dispatches.labels(opts.provider ?? "unknown", result).inc();
  log.info("runner dispatch", {
    result,
    provider: opts.provider ?? "unknown",
    runId: opts.runId,
    ...(opts.fields ?? {}),
  });
}

export function recordStatusTransition(status: string): void {
  telemetry().statusTransitions.labels(status).inc();
}

/** An illegal run-status edge that applyStatusTx allowed but the transition
 *  table did not sanction (see lib/run-state.ts assertTransition). */
export function recordIllegalTransition(from: string, to: string): void {
  telemetry().illegalTransitions.labels(from, to).inc();
}

export function recordMetricsRefreshError(source: string, err: unknown): void {
  telemetry().metricsRefreshErrors.labels(source).inc();
  log.warn("metrics refresh failed", { source, err });
}

export function setActiveRuns(statusCounts: Array<{ status: string; count: number }>): void {
  telemetry().activeRuns.reset();
  for (const row of statusCounts) {
    telemetry().activeRuns.labels(row.status).set(row.count);
  }
}

export function setRunnerInstances(
  rows: Array<{ provider: string | null; state: string | null; count: number }>
): void {
  telemetry().runnerInstances.reset();
  for (const row of rows) {
    telemetry().runnerInstances
      .labels({
        service: "task-orchestrator",
        provider: row.provider ?? "unknown",
        state: row.state ?? "unknown",
      })
      .set(row.count);
  }
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}
