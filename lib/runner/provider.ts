// lib/runner/provider.ts

import {
  runnerProviderKind,
  type RunnerProviderKind,
  insideWorker as insideWorkerCfg,
  nestedDispatchMode as nestedDispatchModeCfg,
  type NestedDispatchMode,
} from "../config";
import { LocalRunnerProvider } from "./local";
import { SpritesRunnerProvider } from "./sprites";

export type { NestedDispatchMode } from "../config";

export type RunnerState =
  | "creating"
  | "starting"
  | "running"
  | "suspended"
  | "stopped"
  | "gone";

/** A provider's best-effort observation of the worker process behind a handle. */
export type RunnerObservation =
  | {
      status: "alive";
      incarnation: string;
      /** The worker's pid as the PROVIDER sees it. Comparable with the pid the
       *  worker reports only when both share a pid namespace (sprites, local
       *  detached process) — not for Docker, where the worker is PID 1. */
      pid?: number;
    }
  | { status: "dead"; reason?: "runner-gone"; detail?: string }
  | {
      status: "unknown";
      /** A typed ambiguity lets the liveness layer distinguish an authoritative
       *  404 from a provider outage. A missing service is still "unknown" to a
       *  provider sweep during a legitimate boot window; once the durable
       *  provisioning owner is observably dead, it becomes proof that startup
       *  was interrupted. */
      reason?: "not-found";
      detail?: string;
    };

export interface RunnerRef {
  /** Run id this runner serves. */
  runId: number;
  /** Provider-scoped id: Docker container name or Sprite name. */
  handle: string;
  provider: RunnerProviderKind;
  channelEndpoint?: string;
  channelInstanceId?: string;
  /** Worker process generation. A restart gets a new generation and instance. */
  workerGeneration?: number;
  /** Provider-specific process/service identity for this generation. */
  providerServiceName?: string;
}

/** A generation-qualified provider handle. Unlike a stable Sprite name this
 * identifies one supervised worker process and is safe to stop independently
 * of later generations. */
export interface WorkerGenerationRef {
  runId: number;
  generation: number;
  instanceId: string;
  providerHandle: string;
  processHandle?: string;
  providerServiceName?: string;
  channelEndpoint?: string;
  /** Durable proof that this exact generation completed provider observation
   * at least once. Providers may use it to distinguish a missing service in
   * the boot window from one that existed and subsequently disappeared. */
  storedIncarnation?: string;
}

export interface CreateRunnerInput {
  runId: number;
  /** Container/machine name, e.g. `run-<id>-<nonce>` (today's workerScope). */
  scope: string;
  channelInstanceId?: string;
  channelEndpoint?: string;
  workerGeneration?: number;
  providerServiceName?: string;
  providerOperationId?: string;
  /** Existing process identity that must be torn down before this generation. */
  previousProviderServiceName?: string;
  replacesGeneration?: number;
}

/** A provider's pre-provisioning capacity decision. */
export type RunnerAdmission =
  | { decision: "admit" }
  | { decision: "defer"; reason?: string }
  /** Legacy host-memory permanent rejection. */
  | { decision: "never-fits" }
  | { decision: "reject"; message: string };

/** Context dispatch owns while it serializes admission and the worker claim. */
export interface RunnerAdmissionInput {
  runId: number;
  /** Claims already held in this server process, including in-flight forks. */
  reservedActive: number;
}

export interface RunnerProvider {
  readonly kind: RunnerProviderKind;
  /** Optional while legacy providers retain their established dispatch gates. */
  admit?(input: RunnerAdmissionInput): Promise<RunnerAdmission>;
  /** Create + start the runner for a claimed run. Returns null on failure. */
  create(input: CreateRunnerInput): Promise<RunnerRef | null>;
  /** Best-effort hard stop (cancel fallback). No-op if already gone. */
  stop(handle: string): Promise<void>;
  /** Observe only. Implementations must convert all failures to `unknown`. */
  inspect(handle: string): Promise<RunnerObservation>;
  /** Generation-aware observation. Providers should prefer this when a row has
   * a process/service identity; the legacy inspect(handle) remains for old rows. */
  inspectGeneration?(ref: WorkerGenerationRef): Promise<RunnerObservation>;
  /** Stop one generation without deleting a run-scoped provider environment. */
  stopGeneration?(ref: WorkerGenerationRef): Promise<void>;
  /** Terminal teardown for one generation; provider environments may be
   * run-scoped (Sprites) and must be CAS-claimed before destruction. */
  destroyGeneration?(ref: WorkerGenerationRef): Promise<void>;
  /** Reconcile DB run state against real runner state for this instance's runs. */
  sweep(): Promise<void>;
}

/** @deprecated alias — reads via lib/config's runnerProviderKind(). Kept for the
 *  many call sites that import it from here; the semantics live in config. */
export function runnerProviderKindFromEnv(): RunnerProviderKind {
  return runnerProviderKind();
}

/**
 * True when this process is a worker (a Sprite / Docker worker container).
 * Branches nested-dispatch behavior: a worker holds no cloud credentials and none
 * of the admission/pump/sweep machinery, so it must not dispatch child runs
 * itself. Semantics + docs live in lib/config's insideWorker(); re-exported here
 * because run-dispatch re-exports it as part of the dispatch-policy surface.
 */
export function insideWorker(): boolean {
  return insideWorkerCfg();
}

/**
 * Nested-dispatch policy: how a run created INSIDE a worker (start_session /
 * start_review / execute → runs.create's launch branches) gets its worker.
 * See docs/nested-machine-dispatch.md, Decision 5. Semantics live in lib/config's
 * nestedDispatchMode(); re-exported here so callers reasoning about dispatch
 * policy find it next to insideWorker().
 */
export function nestedDispatchMode(): NestedDispatchMode {
  return nestedDispatchModeCfg();
}

const PROVIDER_KEY = "__taskOrchRunnerProvider";
type ProviderCache = { kind: RunnerProviderKind; provider: RunnerProvider };

/** Factory for the selected execution backend. Memoized per provider kind so
 * tests/env flips and rollbacks can switch without carrying a stale instance. */
export function getRunnerProvider(): RunnerProvider {
  const kind = runnerProviderKindFromEnv();
  const g = globalThis as Record<string, unknown>;
  const cached = g[PROVIDER_KEY] as ProviderCache | undefined;
  if (cached?.kind === kind) return cached.provider;

  const provider = createRunnerProvider(kind);
  g[PROVIDER_KEY] = { kind, provider } satisfies ProviderCache;
  return provider;
}

/** Build a provider for an already-persisted runner row (observation paths). */
export function createRunnerProvider(kind: RunnerProviderKind): RunnerProvider {
  switch (kind) {
    case "local":
      return new LocalRunnerProvider();
    case "sprites":
      return new SpritesRunnerProvider();
  }
}

/** Test helper. */
export function __resetRunnerProviderForTests(): void {
  delete (globalThis as Record<string, unknown>)[PROVIDER_KEY];
}

/** Inject a provider without changing environment configuration. */
export function __setRunnerProviderForTests(provider: RunnerProvider): void {
  (globalThis as Record<string, unknown>)[PROVIDER_KEY] = { kind: provider.kind, provider } satisfies ProviderCache;
}
