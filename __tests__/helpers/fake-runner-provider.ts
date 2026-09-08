import { eq } from "drizzle-orm";
import { db } from "../../db";
import { agentSessions, runnerInstances } from "../../db/schema";
import { __setRunnerProviderForTests, type RunnerObservation, type RunnerProvider } from "../../lib/runner/provider";

const observations = new Map<string, RunnerObservation>();
let beforeInspect: ((handle: string) => Promise<void> | void) | undefined;

const provider: RunnerProvider = {
  kind: "local",
  async create() { return null; },
  async stop() {},
  async sweep() {},
  async inspect(handle) {
    await beforeInspect?.(handle);
    return observations.get(handle) ?? { status: "unknown" };
  },
};

/** Idempotent: re-installing keeps observations already recorded in this file. */
export function installFakeRunnerProvider(): void {
  __setRunnerProviderForTests(provider);
}

export function clearFakeRunLiveness(): void {
  observations.clear();
  beforeInspect = undefined;
}

/** Deterministic race seam for reconciliation tests. */
export function setFakeLivenessInspectionHook(hook: ((handle: string) => Promise<void> | void) | undefined): void {
  beforeInspect = hook;
}

export async function setFakeRunLiveness(
  runId: number,
  observation: RunnerObservation,
  storedIncarnation = "fake-incarnation"
): Promise<void> {
  const scope = `fake-runner-${runId}`;
  observations.set(scope, observation);
  await db.update(agentSessions).set({ workerScope: scope }).where(eq(agentSessions.id, runId));
  await db.insert(runnerInstances).values({
    runId,
    provider: "local",
    state: "running",
    workerIncarnation: storedIncarnation,
  }).onConflictDoUpdate({
    target: runnerInstances.runId,
    set: { provider: "local", workerIncarnation: storedIncarnation },
  });
}
