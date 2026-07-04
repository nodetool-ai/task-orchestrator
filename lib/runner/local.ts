// lib/runner/local.ts
import {
  defaultSpawn,
  startWorkerMonitor,
  stopWorkerContainer,
  sweepWorkerContainers,
} from "../run-dispatch";
import type { CreateRunnerInput, RunnerProvider, RunnerRef } from "./provider";

export class LocalRunnerProvider implements RunnerProvider {
  readonly kind = "local" as const;

  async create(input: CreateRunnerInput): Promise<RunnerRef | null> {
    const pid = await defaultSpawn(input.runId, input.scope);
    if (pid == null) return null;
    return { runId: input.runId, handle: input.scope, provider: "local" };
  }

  async stop(handle: string): Promise<void> {
    await stopWorkerContainer(handle);
  }

  async sweep(): Promise<void> {
    await sweepWorkerContainers();
  }

  startMonitor(): void {
    startWorkerMonitor();
  }
}
