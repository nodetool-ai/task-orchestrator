// lib/runner/fly-client.ts
// Thin typed client for the Fly Machines + Volumes REST API.

export interface FlyMachineConfig {
  image: string;
  env: Record<string, string>;
  mounts: { volume: string; path: string }[];
  guest: { cpu_kind: "shared" | "performance"; cpus: number; memory_mb: number };
  restart?: { policy: "on-failure" | "no" | "always"; max_retries?: number };
  metadata?: Record<string, string>;
}

export interface FlyMachine {
  id: string;
  state: string;
  region: string;
}

export interface FlyVolume {
  id: string;
  region: string;
}

export interface FlyClient {
  createVolume(input: { name: string; region: string; size_gb: number }): Promise<FlyVolume>;
  destroyVolume(id: string): Promise<void>;
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
  const appName = options.appName ?? process.env.FLY_APP_NAME;
  const apiToken = options.apiToken ?? process.env.FLY_API_TOKEN;
  if (!appName) throw new Error("FLY_APP_NAME environment variable required");
  if (!apiToken) throw new Error("FLY_API_TOKEN environment variable required");
  return { fetchImpl, baseUrl, appName, apiToken };
}

function machineFromJson(result: any): FlyMachine {
  return {
    id: String(result.id),
    state: String(result.state ?? "unknown"),
    region: String(result.region ?? ""),
  };
}

function volumeFromJson(result: any): FlyVolume {
  return { id: String(result.id), region: String(result.region ?? "") };
}

export function makeFlyClient(input?: typeof fetch | FlyClientOptions): FlyClient {
  const { fetchImpl, baseUrl, appName, apiToken } = normalizeOptions(input);

  async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T | null> {
    const response = await fetchImpl(`${baseUrl}/apps/${appName}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
        ...(body == null ? {} : { "Content-Type": "application/json" }),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new FlyApiError(response.status, await response.text());
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  }

  return {
    async createVolume(input: { name: string; region: string; size_gb: number }) {
      const result = await request<any>("POST", "/volumes", input);
      return volumeFromJson(result ?? {});
    },

    async destroyVolume(id: string) {
      await request("DELETE", `/volumes/${encodeURIComponent(id)}`);
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
