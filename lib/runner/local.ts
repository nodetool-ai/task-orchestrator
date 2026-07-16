// lib/runner/local.ts
import {
  defaultSpawn,
  startWorkerMonitor,
  stopWorkerContainer,
  sweepWorkerContainers,
  sweepWorkerSockets,
} from "../run-dispatch";
import { dialEndpointToSocketPath, localListenEndpoint } from "../worker-channel/dispatch-env";
import type { CreateRunnerInput, RunnerProvider, RunnerRef } from "./provider";

export class LocalRunnerProvider implements RunnerProvider {
  readonly kind = "local" as const;

  async create(input: CreateRunnerInput): Promise<RunnerRef | null> {
    // `channelEndpoint` (as computed by provisionLocalChannel) is always the
    // Unix-socket dial form (ws+unix://…) — it's built before dispatch knows
    // whether this run's worker is a plain detached process or a Docker
    // container (plan section 19). defaultSpawn resolves that: for Docker it
    // ignores the Unix endpoint entirely and returns its own tcp `ws://…`
    // dial endpoint instead, which the caller (dispatchRun) persists over the
    // placeholder Unix one.
    const socketPath = input.channelEndpoint ? dialEndpointToSocketPath(input.channelEndpoint) : null;
    const listenEndpoint = socketPath ? localListenEndpoint(socketPath) : undefined;
    const spawned = await defaultSpawn(input.runId, input.scope, input.channelInstanceId, listenEndpoint);
    if (spawned == null) return null;
    return {
      runId: input.runId,
      handle: input.scope,
      provider: "local",
      channelInstanceId: input.channelInstanceId,
      channelEndpoint: spawned.channelEndpoint,
    };
  }

  async stop(handle: string): Promise<void> {
    await stopWorkerContainer(handle);
  }

  async sweep(): Promise<void> {
    await sweepWorkerContainers();
    await sweepWorkerSockets();
  }

  startMonitor(): void {
    startWorkerMonitor();
  }
}
