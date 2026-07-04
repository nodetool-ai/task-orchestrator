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

/**
 * True when this process is a worker (a Fly Machine / Docker worker container),
 * where TASK_ORCH_INSIDE_WORKER is set by buildFlyWorkerEnv (Fly) and the worker
 * container config (Docker). Used to branch nested-dispatch behavior: a worker
 * holds no Fly credentials and none of the admission/pump/sweep machinery, so it
 * must not dispatch child runs itself. Mirrors the "TASK_ORCH_DETACHED_RUNS"
 * truthiness convention ("0"/"false" ⇒ off).
 */
export function insideWorker(): boolean {
  const v = process.env.TASK_ORCH_INSIDE_WORKER;
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}

export type NestedDispatchMode = "isolate" | "inline";

/**
 * Nested-dispatch policy: how a run created INSIDE a worker (start_session /
 * start_review / execute → runs.create's launch branches) gets its worker.
 * See docs/nested-machine-dispatch.md, Decision 5.
 *
 *  - "isolate": the worker does NOT call dispatchRun for the child. It parks the
 *    child at status 'pending' (its initialStatus) so the SERVER's pending pump
 *    claims it and gives it its own Fly Machine — the whole point of the design
 *    (worker-spawned children become independent Machines, admission-gated,
 *    per-child volume/logs, independently swept).
 *  - "inline": today's behavior — the worker dispatches the child in-process /
 *    in-container (dispatchRun). Correct off Fly (local dev, Docker workers).
 *
 * Resolution:
 *  1. Explicit env TASK_ORCH_NESTED_DISPATCH ("isolate"/"inline",
 *     case-insensitive) wins; any other value falls through to the default.
 *  2. Default: "isolate" when the runner provider is Fly, else "inline".
 *
 * On the SERVER the Fly default (runnerProviderKindFromEnv() === "fly") is what
 * makes worker-spawned children isolate onto their own Machines. INSIDE a WORKER
 * the value arrives already RESOLVED via buildFlyWorkerEnv: workers never set
 * TASK_ORCH_RUNNER (they hold no Fly token), so the Fly default would resolve to
 * "inline" there — it is the env passthrough of the server's effective policy,
 * not the default, that turns isolation on inside the worker (and its children).
 * Rollback: set TASK_ORCH_NESTED_DISPATCH=inline on the web app + restart.
 */
export function nestedDispatchMode(): NestedDispatchMode {
  const raw = process.env.TASK_ORCH_NESTED_DISPATCH;
  if (raw) {
    const v = raw.toLowerCase();
    if (v === "isolate") return "isolate";
    if (v === "inline") return "inline";
    // any other value → fall through to the provider default
  }
  return runnerProviderKindFromEnv() === "fly" ? "isolate" : "inline";
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
