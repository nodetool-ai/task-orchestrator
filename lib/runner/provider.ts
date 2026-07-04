// lib/runner/provider.ts

import { FlyRunnerProvider } from "./fly";
import { LocalRunnerProvider } from "./local";

export type RunnerState =
  | "creating"
  | "starting"
  | "running"
  | "suspended"
  | "stopped"
  | "gone";

export interface RunnerRef {
  /** Run id this runner serves. */
  runId: number;
  /** Provider-scoped id: Docker container name, or Fly machine id. */
  handle: string;
  provider: "local" | "fly";
}

export interface CreateRunnerInput {
  runId: number;
  /** Container/machine name, e.g. `run-<id>-<nonce>` (today's workerScope). */
  scope: string;
}

export interface RunnerProvider {
  readonly kind: "local" | "fly";
  /** Create + start the runner for a claimed run. Returns null on failure. */
  create(input: CreateRunnerInput): Promise<RunnerRef | null>;
  /** Best-effort hard stop (cancel fallback). No-op if already gone. */
  stop(handle: string): Promise<void>;
  /** Reconcile DB run state against real runner state for this instance's runs. */
  sweep(): Promise<void>;
  /** Start the process-wide event/state watcher (idempotent). */
  startMonitor(): void;
}

export function runnerProviderKindFromEnv(): "local" | "fly" {
  return process.env.TASK_ORCH_RUNNER === "fly" ? "fly" : "local";
}

const PROVIDER_KEY = "__taskOrchRunnerProvider";
type ProviderCache = { kind: "local" | "fly"; provider: RunnerProvider };

/** Factory for the selected execution backend. Memoized per provider kind so
 * tests/env flips and rollbacks can switch without carrying a stale instance. */
export function getRunnerProvider(): RunnerProvider {
  const kind = runnerProviderKindFromEnv();
  const g = globalThis as Record<string, unknown>;
  const cached = g[PROVIDER_KEY] as ProviderCache | undefined;
  if (cached?.kind === kind) return cached.provider;

  const provider: RunnerProvider = kind === "fly" ? new FlyRunnerProvider() : new LocalRunnerProvider();
  g[PROVIDER_KEY] = { kind, provider } satisfies ProviderCache;
  return provider;
}

/** Test helper. */
export function __resetRunnerProviderForTests(): void {
  delete (globalThis as Record<string, unknown>)[PROVIDER_KEY];
}
