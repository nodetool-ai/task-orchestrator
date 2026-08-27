// lib/runner/local.ts
import { config } from "../config";
import {
  defaultSpawn,
  getDocker,
  startWorkerMonitor,
  stopWorkerContainer,
  sweepWorkerContainers,
  sweepWorkerSockets,
} from "../run-dispatch";
import { dialEndpointToSocketPath, localListenEndpoint } from "../worker-channel/dispatch-env";
import type { DockerLike } from "../run-dispatch";
import type { CreateRunnerInput, RunnerObservation, RunnerProvider, RunnerRef } from "./provider";

type LocalProcess = { pid: number; spawnedAt: string };
const localProcesses = new Map<string, LocalProcess>();

export function __setLocalProcessForTests(handle: string, process: LocalProcess | undefined): void {
  if (process) localProcesses.set(handle, process);
  else localProcesses.delete(handle);
}

export class LocalRunnerProvider implements RunnerProvider {
  readonly kind = "local" as const;

  constructor(
    private readonly deps: {
      docker?: () => Promise<DockerLike>;
      kill?: (pid: number, signal: 0) => void;
    } = {},
  ) {}

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
    if (!config.deployment.workerImage && spawned.spawnedAt) {
      localProcesses.set(input.scope, { pid: spawned.pid, spawnedAt: spawned.spawnedAt });
    }
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

  async inspect(handle: string): Promise<RunnerObservation> {
    if (config.deployment.workerImage) {
      try {
        const docker = await (this.deps.docker ?? getDocker)();
        const info = await docker.getContainer(handle).inspect();
        if (info.State?.Running) {
          if (!info.Id || !info.State.StartedAt) return { status: "unknown" };
          return { status: "alive", incarnation: `${info.Id}#${info.State.StartedAt}`, pid: info.State.Pid } as RunnerObservation & { pid?: number };
        }
        return { status: "dead", detail: `exit ${info.State?.ExitCode ?? "unknown"}` };
      } catch (err) {
        const status = (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status;
        return status === 404 ? { status: "dead" } : { status: "unknown" };
      }
    }
    const recorded = localProcesses.get(handle);
    if (!recorded) return { status: "unknown" };
    try {
      (this.deps.kill ?? process.kill)(recorded.pid, 0);
      return { status: "alive", incarnation: `${recorded.pid}#${recorded.spawnedAt}`, pid: recorded.pid } as RunnerObservation & { pid?: number };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return { status: "dead" };
      return { status: "unknown" };
    }
  }

  async sweep(): Promise<void> {
    // The Docker event watcher is local-only and idempotent. Starting it here
    // makes sweep the sole lifecycle entrypoint for every provider.
    startWorkerMonitor();
    await sweepWorkerContainers();
    await sweepWorkerSockets();
  }
}
