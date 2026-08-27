// lib/runner/sprites-client.ts
// Thin typed client for the Sprites REST + control-plane proxy API.
// See docs/sprites-migration-design.md §2 and https://sprites.dev/api
// Verified shapes: docs/runners/sprites-api-notes.md

import { spritesProxyUrl } from "./sprites-tunnel";

export interface Sprite {
  name: string;
  status?: string;
  region?: string;
  createdAt?: Date | null;
  url?: string;
}

export interface SpriteServiceDef {
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  dir?: string;
  needs?: string[];
  http_port?: number;
}

export interface SpriteCheckpoint {
  id: string;
  createdAt?: Date;
  comment?: string;
}

export interface NetworkPolicyRule {
  domain?: string;
  action?: "allow" | "deny";
  include?: string;
}

export interface NetworkPolicy {
  rules: NetworkPolicyRule[];
}

export interface SpritesClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  token?: string;
  /** Optional WebSocket implementation for proxy tests. */
  wsImpl?: typeof WebSocket;
}

export interface SpritesClient {
  createSprite(input: { name: string; urlSettings?: { auth?: string } }): Promise<Sprite>;
  getSprite(name: string): Promise<Sprite | null>;
  deleteSprite(name: string): Promise<void>;
  listSprites(input?: { prefix?: string; maxResults?: number; continuationToken?: string }): Promise<{ sprites: Sprite[]; continuationToken?: string }>;
  /** List ALL sprites with prefix, paginating past the 50-item page cap internally. */
  listAllSprites(prefix?: string): Promise<Sprite[]>;
  putService(spriteName: string, serviceName: string, def: SpriteServiceDef): Promise<void>;
  startService(spriteName: string, serviceName: string): Promise<void>;
  stopService(spriteName: string, serviceName: string): Promise<void>;
  restartService(spriteName: string, serviceName: string): Promise<void>;
  getServiceLogs(spriteName: string, serviceName: string): Promise<string>;
  exec(
    spriteName: string,
    input: { cmd: string; dir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  checkpoint(spriteName: string, comment?: string): Promise<SpriteCheckpoint>;
  listCheckpoints(spriteName: string): Promise<SpriteCheckpoint[]>;
  restoreCheckpoint(spriteName: string, checkpointId: string): Promise<void>;
  getNetworkPolicy(spriteName: string): Promise<NetworkPolicy | null>;
  setNetworkPolicy(spriteName: string, policy: NetworkPolicy): Promise<void>;
  getResourcesPolicy(spriteName: string): Promise<unknown>;
  setResourcesPolicy(spriteName: string, policy: unknown): Promise<void>;
  /** WSS proxy URL for dialing a port inside the sprite (handshake done by the caller). */
  proxyUrl(spriteName: string): string;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class SpritesApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Sprites API error ${status}: ${body}`);
  }
}

function normalizeOptions(input?: SpritesClientOptions): Required<Omit<SpritesClientOptions, "wsImpl">> & Pick<SpritesClientOptions, "wsImpl"> {
  const baseUrl = input?.baseUrl ?? process.env.TASK_ORCH_SPRITES_BASE_URL ?? process.env.SPRITES_BASE_URL ?? "https://api.sprites.dev/v1";
  const token = input?.token ?? process.env.SPRITES_TOKEN ?? process.env.TASK_ORCH_SPRITES_TOKEN;
  const fetchImpl = input?.fetchImpl ?? globalThis.fetch;
  if (!token) throw new Error("SPRITES_TOKEN (or TASK_ORCH_SPRITES_TOKEN) environment variable required");
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  if (!fetchImpl) throw new Error("fetch is not available");
  return { fetchImpl, baseUrl: normalizedBase, token, wsImpl: input?.wsImpl };
}

interface RawSpriteJson {
  id?: string;
  name: string;
  status?: string;
  url?: string;
  region?: string;
  organization?: string;
  org_slug?: string;
  created_at?: string | null;
  updated_at?: string | null;
  last_started_at?: string | null;
  last_active_at?: string | null;
}

interface RawCheckpointJson {
  id: string;
  create_time?: string;
  created_at?: string;
  source_id?: string;
  comment?: string | null;
  health?: string;
}

interface RawListSpritesJson {
  sprites: RawSpriteJson[];
  has_more: boolean;
  next_continuation_token?: string | null;
}

/**
 * POST /exec answers with a framed byte stream, one frame per HTTP data
 * chunk: the first byte is the stream id (1 stdout, 2 stderr, 3 exit — one
 * payload byte with the code). Frames carry no length, so chunk boundaries
 * are the framing.
 */
export function parseExecFrames(chunks: Uint8Array[]): { exitCode: number; stdout: string; stderr: string } {
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  let exitCode = 0;
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const payload = chunk.subarray(1);
    switch (chunk[0]) {
      case 1:
        out.push(payload);
        break;
      case 2:
        err.push(payload);
        break;
      case 3:
        if (payload.length > 0) exitCode = payload[0];
        break;
      default:
        // Unknown stream: keep the bytes visible rather than drop them.
        err.push(chunk);
    }
  }
  return { exitCode, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

async function readChunks(response: Response): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  if (!response.body) return chunks;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return chunks;
}

function spriteFromJson(raw: RawSpriteJson): Sprite {
  const s: Sprite = {
    name: String(raw.name),
  };
  if (raw.status != null) s.status = String(raw.status);
  if (raw.region != null) s.region = String(raw.region);
  if (raw.url != null) s.url = String(raw.url);
  if (raw.created_at != null) {
    const d = new Date(raw.created_at);
    s.createdAt = Number.isNaN(d.getTime()) ? null : d;
  } else if ((raw as unknown as { create_time?: string | null }).create_time != null) {
    const ct = (raw as unknown as { create_time?: string | null }).create_time!;
    const d = new Date(ct);
    s.createdAt = Number.isNaN(d.getTime()) ? null : d;
  } else {
    s.createdAt = null;
  }
  return s;
}

function checkpointFromJson(raw: RawCheckpointJson): SpriteCheckpoint {
  const createdAtRaw = raw.create_time ?? raw.created_at;
  return {
    id: String(raw.id),
    comment: raw.comment != null ? String(raw.comment) : undefined,
    createdAt: createdAtRaw ? new Date(createdAtRaw) : undefined,
  };
}

export function makeSpritesClient(input?: SpritesClientOptions): SpritesClient {
  const { fetchImpl, baseUrl, token } = normalizeOptions(input);

  async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body == null ? {} : { "Content-Type": "application/json" }),
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new SpritesApiError(0, `request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
      }
      throw err;
    }
    if (!response.ok) {
      throw new SpritesApiError(response.status, await response.text());
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  }

  async function requestNdjson(method: string, path: string, body?: unknown): Promise<Array<Record<string, unknown>>> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/x-ndjson, application/json",
          ...(body == null ? {} : { "Content-Type": "application/json" }),
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new SpritesApiError(0, `request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
      }
      throw err;
    }
    if (!response.ok) {
      throw new SpritesApiError(response.status, await response.text());
    }
    if (response.status === 204) return [];
    const text = await response.text();
    if (!text.trim()) return [];
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const out: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Non-JSON line (e.g. plain text log) — wrap as data
        out.push({ type: "info", data: line } as Record<string, unknown>);
      }
    }
    return out;
  }

  const client: SpritesClient = {
    async createSprite(input: { name: string; urlSettings?: { auth?: string } }) {
      const result = await request<RawSpriteJson>("POST", "/sprites", {
        name: input.name,
        url_settings: input.urlSettings ? { auth: input.urlSettings.auth } : undefined,
      });
      if (!result) throw new SpritesApiError(500, "empty response from createSprite");
      return spriteFromJson(result);
    },

    async getSprite(name: string) {
      try {
        const result = await request<RawSpriteJson>("GET", `/sprites/${encodeURIComponent(name)}`);
        return result ? spriteFromJson(result) : null;
      } catch (err) {
        if (err instanceof SpritesApiError && err.status === 404) return null;
        throw err;
      }
    },

    async deleteSprite(name: string) {
      try {
        await request("DELETE", `/sprites/${encodeURIComponent(name)}`);
      } catch (err) {
        if (err instanceof SpritesApiError && err.status === 404) return;
        throw err;
      }
    },

    async listSprites(input = {}) {
      const params = new URLSearchParams();
      if (input.prefix) params.set("prefix", input.prefix);
      if (input.maxResults) params.set("max_results", String(input.maxResults));
      if (input.continuationToken) params.set("continuation_token", input.continuationToken);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const result = await request<RawListSpritesJson>("GET", `/sprites${qs}`);
      if (!result) return { sprites: [], continuationToken: undefined };
      const rows = Array.isArray(result.sprites) ? result.sprites : [];
      const token = result.has_more ? result.next_continuation_token ?? undefined : undefined;
      return { sprites: rows.map(spriteFromJson), continuationToken: token ? String(token) : undefined };
    },

    async listAllSprites(prefix?: string) {
      const all: Sprite[] = [];
      let token: string | undefined;
      do {
        const page = await client.listSprites({ prefix, maxResults: 50, continuationToken: token });
        all.push(...page.sprites);
        token = page.continuationToken;
      } while (token);
      return all;
    },

    async putService(spriteName: string, serviceName: string, def: SpriteServiceDef) {
      // Answers an NDJSON event stream (started/complete) and starts the service.
      await requestNdjson("PUT", `/sprites/${encodeURIComponent(spriteName)}/services/${encodeURIComponent(serviceName)}`, def);
    },

    async startService(spriteName: string, serviceName: string) {
      await requestNdjson("POST", `/sprites/${encodeURIComponent(spriteName)}/services/${encodeURIComponent(serviceName)}/start`);
    },

    async stopService(spriteName: string, serviceName: string) {
      await requestNdjson("POST", `/sprites/${encodeURIComponent(spriteName)}/services/${encodeURIComponent(serviceName)}/stop`);
    },

    async restartService(spriteName: string, serviceName: string) {
      await requestNdjson("POST", `/sprites/${encodeURIComponent(spriteName)}/services/${encodeURIComponent(serviceName)}/restart`);
    },

    async getServiceLogs(spriteName: string, serviceName: string) {
      const events = await requestNdjson("GET", `/sprites/${encodeURIComponent(spriteName)}/services/${encodeURIComponent(serviceName)}/logs`);
      if (events.length === 0) return "";
      // NDJSON events have { type, data, timestamp } — concat stdout/stderr data
      const parts: string[] = [];
      for (const ev of events) {
        if ((ev.type === "stdout" || ev.type === "stderr") && typeof ev.data === "string") parts.push(ev.data);
        else if (typeof ev.data === "string" && ev.type === "info") parts.push(ev.data);
      }
      return parts.join("");
    },

    async exec(
      spriteName: string,
      input: { cmd: string; dir?: string; env?: Record<string, string>; timeoutMs?: number },
    ) {
      // `cmd` is argv on the wire (repeated param), so a shell line goes
      // through `sh -c`; the caller's string is one argument, never split.
      const params = new URLSearchParams();
      for (const a of ["sh", "-c", input.cmd]) params.append("cmd", a);
      if (input.dir) params.set("dir", input.dir);
      if (input.env) {
        for (const [k, v] of Object.entries(input.env)) params.append("env", `${k}=${v}`);
      }
      const path = `/sprites/${encodeURIComponent(spriteName)}/exec?${params.toString()}`;
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(input.timeoutMs ?? REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new SpritesApiError(0, `request timed out: POST ${path}`);
        }
        throw err;
      }
      if (!response.ok) {
        throw new SpritesApiError(response.status, await response.text());
      }
      return parseExecFrames(await readChunks(response));
    },

    async checkpoint(spriteName: string, comment?: string) {
      const events = await requestNdjson("POST", `/sprites/${encodeURIComponent(spriteName)}/checkpoint`, comment ? { comment } : {});
      // Keep regex as hint only; primary is listCheckpoints (documented JSON shape)
      let hintId: string | undefined;
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i] as Record<string, unknown> & { data?: unknown };
        const data = typeof ev.data === "string" ? ev.data : "";
        const m = data.match(/Checkpoint\s+(\S+)\s+created/i);
        if (m) {
          hintId = m[1];
          break;
        }
      }
      // Primary: documented JSON shape via listCheckpoints
      const list = await request<RawCheckpointJson[]>("GET", `/sprites/${encodeURIComponent(spriteName)}/checkpoints`);
      const checkpoints = Array.isArray(list) ? list.map(checkpointFromJson) : [];
      if (checkpoints.length > 0) {
        if (comment != null) {
          const matches = checkpoints.filter((cp) => cp.comment === comment);
          if (matches.length > 0) {
            matches.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
            return matches[0];
          }
          if (hintId) {
            const hintMatch = checkpoints.find((cp) => cp.id === hintId);
            if (hintMatch) return hintMatch;
          }
        } else {
          // No comment filter: return newest checkpoint
          const sorted = [...checkpoints].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
          return sorted[0];
        }
        // Fallback: newest overall
        const sorted = [...checkpoints].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
        return sorted[0];
      }
      // Fallback to hint if list is empty (e.g. test mock with single NDJSON complete)
      if (hintId) return { id: hintId, comment, createdAt: undefined };
      const fallback = events[0] as unknown as RawCheckpointJson | undefined;
      if (fallback && typeof fallback.id === "string") return checkpointFromJson(fallback);
      throw new SpritesApiError(500, "could not determine checkpoint id from NDJSON");
    },

    async listCheckpoints(spriteName: string) {
      const result = await request<RawCheckpointJson[]>("GET", `/sprites/${encodeURIComponent(spriteName)}/checkpoints`);
      const rows = Array.isArray(result) ? result : [];
      return rows.map(checkpointFromJson);
    },

    async restoreCheckpoint(spriteName: string, checkpointId: string) {
      await requestNdjson("POST", `/sprites/${encodeURIComponent(spriteName)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`);
    },

    async getNetworkPolicy(spriteName: string) {
      try {
        const result = await request<NetworkPolicy>("GET", `/sprites/${encodeURIComponent(spriteName)}/policy/network`);
        return result ?? null;
      } catch (err) {
        if (err instanceof SpritesApiError && err.status === 404) return null;
        throw err;
      }
    },

    async setNetworkPolicy(spriteName: string, policy: NetworkPolicy) {
      await request("POST", `/sprites/${encodeURIComponent(spriteName)}/policy/network`, policy);
    },

    async getResourcesPolicy(spriteName: string) {
      try {
        const result = await request<unknown>("GET", `/sprites/${encodeURIComponent(spriteName)}/policy/resources`);
        return result;
      } catch (err) {
        if (err instanceof SpritesApiError && err.status === 404) return null;
        throw err;
      }
    },

    async setResourcesPolicy(spriteName: string, policy: unknown) {
      await request("POST", `/sprites/${encodeURIComponent(spriteName)}/policy/resources`, policy as Record<string, unknown>);
    },

    proxyUrl(spriteName: string) {
      return spritesProxyUrl(spriteName, baseUrl);
    },
  };

  return client;
}
