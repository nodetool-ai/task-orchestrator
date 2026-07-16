// lib/runner/fly-client.ts
// Thin typed client for the Fly Machines + Volumes REST API.

export interface FlyMachineConfig {
  image: string;
  env: Record<string, string>;
  mounts: { volume: string; path: string }[];
  guest: { cpu_kind: "shared" | "performance"; cpus: number; memory_mb: number };
  restart?: { policy: "on-failure" | "no" | "always"; max_retries?: number };
  metadata?: Record<string, string>;
  // init.exec overrides the image entrypoint — the seed-volume job uses it to run
  // the prewarm install instead of the worker entrypoint.
  init?: { exec?: string[] };
  // auto_destroy=true makes flyd remove the machine once its process exits (the
  // seed job's one-shot machine cleans itself up).
  auto_destroy?: boolean;
}

export interface FlyMachine {
  id: string;
  state: string;
  region: string;
  name?: string;
  /** Exit code of a stopped one-shot machine, when Fly reports it. */
  exitCode?: number;
  /** Private 6PN IPv6 address (Fly's `private_ip`), when the API response
   *  carries it. Used to derive the worker channel dial endpoint (plan
   *  section 20) — never a public address. */
  privateIp?: string;
}

export interface FlyVolume {
  id: string;
  region: string;
  // Enriched fields from list/get responses (absent on a bare create echo →
  // left undefined). `attachedMachineId` is the linchpin for orphan detection:
  // a volume with no attachment is a candidate to reap.
  name?: string;
  state?: string;
  sizeGb?: number;
  attachedMachineId?: string | null;
  /** Volume creation time, when the list/get response carries it. Lets the
   *  orphan reaper skip a just-created volume that hasn't been attached yet. */
  createdAt?: Date | null;
}

export interface FlyClient {
  // source_volume_id forks an existing volume (the prewarm seed) into the new
  // one — Fly copies its contents, so the run boots with warm deps already
  // present. Omitted → a blank volume.
  createVolume(input: {
    name: string;
    region: string;
    size_gb?: number;
    source_volume_id?: string;
  }): Promise<FlyVolume>;
  destroyVolume(id: string): Promise<void>;
  listVolumes(): Promise<FlyVolume[]>;
  createMachine(input: { name: string; region: string; config: FlyMachineConfig }): Promise<FlyMachine>;
  getMachine(id: string): Promise<FlyMachine | null>;
  startMachine(id: string): Promise<void>;
  suspendMachine(id: string): Promise<void>;
  stopMachine(id: string): Promise<void>;
  destroyMachine(id: string, opts?: { force?: boolean }): Promise<void>;
  listMachines(): Promise<FlyMachine[]>;
}

export interface FlyClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  appName?: string;
  apiToken?: string;
}

// A hung Fly API call must not stall the sweep tick (or any other caller)
// indefinitely; every request gets a hard ceiling.
const REQUEST_TIMEOUT_MS = 30_000;

export class FlyApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`Fly API error ${status}: ${body}`);
  }
}

function normalizeOptions(input?: typeof fetch | FlyClientOptions): Required<FlyClientOptions> {
  const options: FlyClientOptions = typeof input === "function" ? { fetchImpl: input } : input ?? {};
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "https://api.machines.dev/v1";
  // FLY_APP_NAME is reserved by Fly's runtime (it injects each Machine's *own*
  // app name), so it can't carry the runner-pool app name on Fly. Prefer
  // TASK_ORCH_FLY_APP; fall back to FLY_APP_NAME for local/dev and tests.
  const appName = options.appName ?? process.env.TASK_ORCH_FLY_APP ?? process.env.FLY_APP_NAME;
  const apiToken = options.apiToken ?? process.env.FLY_API_TOKEN;
  if (!appName) throw new Error("TASK_ORCH_FLY_APP (or FLY_APP_NAME) environment variable required");
  if (!apiToken) throw new Error("FLY_API_TOKEN environment variable required");
  return { fetchImpl, baseUrl, appName, apiToken };
}

function machineFromJson(result: any): FlyMachine {
  const machine: FlyMachine = {
    id: String(result.id),
    state: String(result.state ?? "unknown"),
    region: String(result.region ?? ""),
  };
  if (result.name != null) machine.name = String(result.name);
  if (result.private_ip != null) machine.privateIp = String(result.private_ip);
  // Best-effort exit code for a stopped one-shot machine (seed job). Fly reports
  // it on the most recent "exit" event; absent on running machines.
  const exit = Array.isArray(result.events)
    ? result.events.find((e: any) => e?.type === "exit")?.request?.exit_event?.exit_code
    : undefined;
  if (typeof exit === "number") machine.exitCode = exit;
  return machine;
}

function volumeFromJson(result: any): FlyVolume {
  const vol: FlyVolume = { id: String(result.id), region: String(result.region ?? "") };
  if (result.name != null) vol.name = String(result.name);
  if (result.state != null) vol.state = String(result.state);
  if (result.size_gb != null) vol.sizeGb = Number(result.size_gb);
  // Fly reports the attachment under either key depending on API version; a
  // volume with neither set is unattached (reap candidate).
  const attached = result.attached_machine_id ?? result.attached_machine ?? null;
  vol.attachedMachineId = attached == null ? null : String(attached);
  if (result.created_at != null) {
    const d = new Date(result.created_at);
    vol.createdAt = Number.isNaN(d.getTime()) ? null : d;
  }
  return vol;
}

export function makeFlyClient(input?: typeof fetch | FlyClientOptions): FlyClient {
  const { fetchImpl, baseUrl, appName, apiToken } = normalizeOptions(input);

  async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/apps/${appName}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: "application/json",
          ...(body == null ? {} : { "Content-Type": "application/json" }),
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new FlyApiError(0, `request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
      }
      throw err;
    }
    if (!response.ok) {
      throw new FlyApiError(response.status, await response.text());
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  }

  return {
    async createVolume(input: {
      name: string;
      region: string;
      size_gb?: number;
      source_volume_id?: string;
    }) {
      const result = await request<any>("POST", "/volumes", input);
      return volumeFromJson(result ?? {});
    },

    async destroyVolume(id: string) {
      await request("DELETE", `/volumes/${encodeURIComponent(id)}`);
    },

    async listVolumes(): Promise<FlyVolume[]> {
      const result = await request<any>("GET", "/volumes");
      const rows = Array.isArray(result) ? result : Array.isArray(result?.volumes) ? result.volumes : [];
      return rows.map(volumeFromJson);
    },

    async createMachine(input: { name: string; region: string; config: FlyMachineConfig }) {
      const result = await request<any>("POST", "/machines", input);
      return machineFromJson(result ?? {});
    },

    async getMachine(id: string): Promise<FlyMachine | null> {
      try {
        const result = await request<any>("GET", `/machines/${encodeURIComponent(id)}`);
        return result ? machineFromJson(result) : null;
      } catch (err) {
        if (err instanceof FlyApiError && err.status === 404) return null;
        throw err;
      }
    },

    async startMachine(id: string) {
      await request("POST", `/machines/${encodeURIComponent(id)}/start`);
    },

    async suspendMachine(id: string) {
      await request("POST", `/machines/${encodeURIComponent(id)}/suspend`);
    },

    async stopMachine(id: string) {
      await request("POST", `/machines/${encodeURIComponent(id)}/stop`);
    },

    async destroyMachine(id: string, opts?: { force?: boolean }) {
      await request(
        "DELETE",
        `/machines/${encodeURIComponent(id)}${opts?.force ? "?force=true" : ""}`
      );
    },

    async listMachines(): Promise<FlyMachine[]> {
      const result = await request<any>("GET", "/machines");
      const rows = Array.isArray(result) ? result : Array.isArray(result?.machines) ? result.machines : [];
      return rows.map(machineFromJson);
    },
  };
}
