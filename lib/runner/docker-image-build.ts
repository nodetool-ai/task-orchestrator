// lib/runner/docker-image-build.ts
//
// Build the worker Docker image (Dockerfile.worker) on the host via dockerode,
// recording progress and outcome on an environments row. Fire-and-forget:
// never throws.
import { config } from "../config";
import { markEnvironmentFailed, markEnvironmentReady, setEnvironmentDetail } from "./environments";

export interface DockerBuildApi {
  buildImage(context: unknown, opts: { t: string; dockerfile: string }): Promise<NodeJS.ReadableStream>;
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      onFinished: (err: Error | null, output: Array<Record<string, unknown>>) => void,
      onProgress: (evt: { stream?: string; error?: string }) => void
    ): void;
  };
}

export async function runDockerImageBuild(
  input: { environmentId: number; image?: string },
  opts: { docker?: DockerBuildApi } = {}
): Promise<void> {
  // Progress writes are serialized onto one chain (never fired-and-forgotten):
  // an out-of-order write could otherwise land AFTER markEnvironmentReady clears
  // `detail`, leaving a ready row with stale progress, and a rejected write
  // would surface as an unhandled rejection. We drain this chain before writing
  // the final ready/failed state.
  let detailChain: Promise<void> = Promise.resolve();
  const pushDetail = (step: string): void => {
    detailChain = detailChain.then(() => setEnvironmentDetail(input.environmentId, step)).catch(() => {});
  };
  try {
    const image = input.image ?? config.deployment.workerImage;
    if (!image) {
      throw new Error(
        "TASK_ORCH_WORKER_IMAGE is not configured; set it (or pass an image tag) to build the worker image."
      );
    }
    const docker = opts.docker ?? (await makeDocker());
    pushDetail("preparing build context");
    // Build context: the repo root. .dockerignore bounds what's sent (it excludes
    // node_modules, .git, .next, data.db, etc.) so the context tar stays small.
    const stream = await docker.buildImage(
      { context: process.cwd(), src: ["."] },
      { t: image, dockerfile: "Dockerfile.worker" }
    );
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err, output) => {
          if (err) return reject(err);
          const last = output[output.length - 1] as { error?: string } | undefined;
          if (last?.error) return reject(new Error(last.error));
          resolve();
        },
        (evt) => {
          if (evt.error) return; // surfaced by onFinished
          const line = evt.stream?.trim();
          if (line && /^Step \d+\/\d+/.test(line)) {
            pushDetail(line.slice(0, 140));
          }
        }
      );
    });
    await detailChain; // drain progress writes so none land after `ready`
    await markEnvironmentReady(input.environmentId, { image });
  } catch (error) {
    await detailChain; // same, before the row goes `failed`
    await markEnvironmentFailed(
      input.environmentId,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function makeDocker(): Promise<DockerBuildApi> {
  const { default: Docker } = await import("dockerode");
  return new Docker() as unknown as DockerBuildApi;
}
