// lib/worker-channel/dispatch-env.ts
//
// Local-runner endpoint conventions and the WebSocket-only supervisor
// environment. This lives under lib/worker-channel/ (not lib/worker/, which
// section 18 deletes) so the HTTP-deletion milestone removes only dead code.
//
// Two endpoint forms are derived from one instance id:
//   - listen endpoint  — what the worker binds:      unix:<absolute socket path>
//   - dial endpoint     — what the control plane dials: ws+unix://<path>:/worker/channel
//
// The dial form is the `ws` package's Unix-domain URL syntax: the socket path
// precedes a literal ":" and the request path.

import { join } from "node:path";

import { mintChannelCredential } from "./credential";

const CHANNEL_PATH = "/worker/channel";

/** Absolute path of a local worker's Unix-domain socket. */
export function localSocketPath(instanceId: string, cwd: string = process.cwd()): string {
  return join(cwd, ".worker-sockets", `${instanceId}.sock`);
}

/** Endpoint the worker binds (TASK_ORCH_WORKER_CHANNEL_ENDPOINT). */
export function localListenEndpoint(socketPath: string): string {
  return `unix:${socketPath}`;
}

/** Endpoint the control plane stores and dials with the `ws` client. */
export function localDialEndpoint(socketPath: string): string {
  return `ws+unix://${socketPath}:${CHANNEL_PATH}`;
}

/** Recover the socket path from a local dial endpoint. Returns null when the
 * value is not a local `ws+unix://…:/worker/channel` URL. */
export function dialEndpointToSocketPath(dialEndpoint: string): string | null {
  const prefix = "ws+unix://";
  const suffix = `:${CHANNEL_PATH}`;
  if (!dialEndpoint.startsWith(prefix) || !dialEndpoint.endsWith(suffix)) return null;
  return dialEndpoint.slice(prefix.length, dialEndpoint.length - suffix.length);
}

// ── Docker worker endpoints (plan section 19) ───────────────────────────────
// A Docker worker binds a real TCP port (fixed at 8787 per plan section 2)
// instead of a Unix socket. The dial host is either the container name (a
// shared TASK_ORCH_DOCKER_NETWORK, resolvable by Docker DNS) or the
// container's private bridge IP (host dev without a shared network) — see
// resolveDockerDialHost in lib/run-dispatch.ts.

const DOCKER_CHANNEL_PORT = 8787;

/** Endpoint the Docker worker container binds. */
export function dockerListenEndpoint(): string {
  return `tcp:0.0.0.0:${DOCKER_CHANNEL_PORT}`;
}

/** Endpoint the control plane stores and dials for a Docker worker. */
export function dockerDialEndpoint(host: string): string {
  return `ws://${host}:${DOCKER_CHANNEL_PORT}${CHANNEL_PATH}`;
}

// ── Fly worker endpoints (plan section 20) ──────────────────────────────────
// A Fly Machine binds the same fixed TCP port (8787, plan section 2) as
// Docker, but the control plane dials it over the Machine's private 6PN
// IPv6 address rather than a container name — never a public service/IP.

/** Endpoint the Fly worker Machine binds. Same fixed-port convention as
 *  Docker; kept as its own named export so a future divergence doesn't force
 *  callers to reach for `dockerListenEndpoint`. */
export function flyListenEndpoint(): string {
  return dockerListenEndpoint();
}

/** Endpoint the control plane stores and dials for a Fly worker: the fixed
 *  channel port on the Machine's private 6PN IPv6 address, bracketed per URL
 *  convention for a literal IPv6 host. */
export function flyChannelDialEndpoint(privateIp: string): string {
  return `ws://[${privateIp}]:${DOCKER_CHANNEL_PORT}${CHANNEL_PATH}`;
}

/**
 * WebSocket-only supervisor environment. It intentionally contains no
 * control-plane URL, API token, or database credential — the worker learns
 * everything else from the pushed `run.start` snapshot.
 */
export function workerChannelDispatchEnv(
  runId: number,
  instanceId: string,
  listenEndpoint: string,
): Record<string, string> {
  return {
    TASK_ORCH_WORKER_INSTANCE_ID: instanceId,
    TASK_ORCH_WORKER_CHANNEL_CREDENTIAL: mintChannelCredential(runId, instanceId),
    TASK_ORCH_WORKER_CHANNEL_ENDPOINT: listenEndpoint,
  };
}

/** Deterministic `run.start` command id for an instance. The 32 hex characters
 * of `wi_<hex>` become a UUID, so a reconnect (or an idempotent re-send) reuses
 * the same durable command instead of building a second snapshot. */
export function runStartCommandId(instanceId: string): string {
  const hex = instanceId.replace(/^wi_/, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
