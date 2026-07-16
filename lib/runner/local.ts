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
    // `channelEndpoint` is the canonical dial endpoint (ws+unix://…). The worker
    // binds the matching listen endpoint (unix:<path>); the control plane dials
    // the dial endpoint we echo back in the ref.
    const socketPath = input.channelEndpoint ? dialEndpointToSocketPath(input.channelEndpoint) : null;
    const listenEndpoint = socketPath ? localListenEndpoint(socketPath) : undefined;
    const pid = await defaultSpawn(input.runId, input.scope, input.channelInstanceId, listenEndpoint);
    if (pid == null) return null;
    return {
      runId: input.runId,
      handle: input.scope,
      provider: "local",
      channelInstanceId: input.channelInstanceId,
      channelEndpoint: input.channelEndpoint,
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
