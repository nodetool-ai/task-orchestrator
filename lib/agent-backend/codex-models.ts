// lib/agent-backend/codex-models.ts
//
// The Codex model catalog behind GET /api/providers — the list the composers'
// model picker and the persona editor offer for a `codex` run. Three sources,
// tried in order:
//
//   1. The deployment's own OpenAI account. When an API key is configured
//      (CODEX_API_KEY, else OPENAI_API_KEY — the same precedence
//      codex-auth.ts applies) the catalog is read from the OpenAI models
//      endpoint and filtered to the ids the `codex` CLI can actually drive.
//      This is the only source that knows about a model this account has early
//      access to, or that shipped after the last dependency bump.
//   2. pi-ai's generated `openai-codex` catalog — exactly the models pi's own
//      openai-codex provider serves, shipped inside a non-optional dependency
//      that gets upgraded regularly. No credential and no network needed, so
//      this is where a ChatGPT-subscription deployment lands: OpenAI publishes
//      no catalog endpoint for that credential, and a ChatGPT bearer is not
//      accepted by the API-key one.
//   3. FALLBACK_CODEX_MODELS, for a bundle trimmed so far that pi-ai's catalog
//      resolves empty.
//
// This replaces a literal list maintained by hand inside codex-backend.ts,
// which had already drifted (it never gained gpt-5.3-codex-spark) with nothing
// failing to show it had.
//
// Caching. The picker hits this on every page load, so a resolved catalog is
// cached per (endpoint, credential) for CATALOG_TTL_MS; a failed or unusable
// response is cached for the much shorter FAILURE_TTL_MS, so one bad deploy of
// the models endpoint can't turn every request into a fresh timeout while a
// recovered one is picked up quickly. Discovery never throws and never blocks
// past FETCH_TIMEOUT_MS: a catalog is always returned.

import { createHash } from "node:crypto";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { config } from "../config";

/** One entry of the catalog, in the shape AgentBackend.listProviders returns. */
export interface CodexModel {
  id: string;
  name: string;
}

type EnvLike = Record<string, string | undefined>;

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const FETCH_TIMEOUT_MS = 5_000;
const CATALOG_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;

/** Last-resort catalog: only reached when pi-ai's generated list is unavailable
 *  (a bundle built without it) and no API key is configured. Deliberately the
 *  shortest list that keeps the picker usable. */
export const FALLBACK_CODEX_MODELS: readonly CodexModel[] = [
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
];

/** Display names for ids pi-ai knows, so a fetched catalog is labelled the way
 *  the rest of the app labels the same model. */
const PI_CODEX_NAMES = new Map<string, string>(
  Object.values(OPENAI_CODEX_MODELS).map((m) => [m.id, m.name])
);

/** Model families the `codex` CLI drives: the GPT-5-and-later reasoning models,
 *  their `codex`-branded variants, and the o-series. */
const CODEX_FAMILY_RE = /^(gpt-[5-9]|codex)(\b|[-.])|^o[3-9](\b|[-.])/i;

/** Modality- and task-specific variants the CLI cannot run a coding turn on.
 *  An account's /models listing carries plenty of them next to the real ones. */
const NOT_A_CODING_MODEL_RE =
  /(audio|realtime|transcribe|tts|image|embedding|moderation|search|chat-latest|dall-e)/i;

/** True for an id the Codex backend can plausibly run. */
export function isCodexModelId(id: string): boolean {
  return CODEX_FAMILY_RE.test(id) && !NOT_A_CODING_MODEL_RE.test(id);
}

function capitalize(part: string): string {
  return part ? part[0].toUpperCase() + part.slice(1) : part;
}

/** A human label for a model id: pi-ai's own name when it knows the id, else a
 *  prettified id ("gpt-5.7-nova" → "GPT-5.7 Nova"). */
export function codexModelName(id: string): string {
  const known = PI_CODEX_NAMES.get(id);
  if (known) return known;
  return id
    .split("-")
    .map((part) =>
      /^gpt$/i.test(part) ? "GPT" : /^[\d.]/.test(part) || /^o\d/.test(part) ? part : capitalize(part)
    )
    .join(" ")
    .replace(/^GPT (\d)/, "GPT-$1");
}

/** Newest first. A descending numeric-aware id sort puts gpt-5.6-* above
 *  gpt-5.5 and gpt-5.4-*, which is the order a picker wants (and makes the
 *  catalog order deterministic whichever source produced it). */
function byNewestId(a: CodexModel, b: CodexModel): number {
  return b.id.localeCompare(a.id, "en", { numeric: true });
}

/** Turn raw model ids into the catalog: Codex-capable only, de-duplicated,
 *  named, newest first. */
export function selectCodexModels(ids: readonly string[]): CodexModel[] {
  const seen = new Set<string>();
  const models: CodexModel[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id) || !isCodexModelId(id)) continue;
    seen.add(id);
    models.push({ id, name: codexModelName(id) });
  }
  return models.sort(byNewestId);
}

/** The catalog available without a credential or a network call: pi-ai's
 *  generated openai-codex list, or FALLBACK_CODEX_MODELS if that is empty. */
export function staticCodexModels(): CodexModel[] {
  const models = selectCodexModels(Object.values(OPENAI_CODEX_MODELS).map((m) => m.id));
  return models.length ? models : [...FALLBACK_CODEX_MODELS];
}

/** The API key discovery authenticates with, or undefined when this deployment
 *  has none (ChatGPT-subscription auth, or no Codex credential at all). */
function discoveryApiKey(env: EnvLike): string | undefined {
  for (const key of [env.CODEX_API_KEY, env.OPENAI_API_KEY]) {
    if (key && key.trim()) return key.trim();
  }
  return undefined;
}

/** The models endpoint to read. An explicit TASK_ORCH_CODEX_MODELS_URL wins
 *  (any OpenAI-compatible `/models` route — a gateway, a proxy, a fake in a
 *  test); otherwise it is derived from OPENAI_BASE_URL, the variable the OpenAI
 *  SDKs already use, defaulting to the public API. */
export function codexModelsEndpoint(env: EnvLike = process.env): string {
  const override = config.agent.codexModelsUrl;
  if (override) return override;
  const base = (env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/models`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Why a catalog fetch was abandoned. Logged once per attempt (attempts are
 *  rate-limited by FAILURE_TTL_MS) and never carries the credential. */
function warn(endpoint: string, reason: string): void {
  console.error(
    `[CodexModels] model discovery from ${endpoint} failed (${reason}); serving the built-in catalog`
  );
}

/** Read the account's catalog. Returns null — never throws — when the endpoint
 *  is unreachable, unauthorized, malformed, or lists nothing Codex can drive,
 *  so the caller falls back instead of failing the request. */
async function fetchAccountModels(endpoint: string, apiKey: string): Promise<CodexModel[] | null> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    warn(endpoint, errorMessage(err));
    return null;
  }
  if (!res.ok) {
    warn(endpoint, `HTTP ${res.status}`);
    return null;
  }

  const body = (await res.json().catch(() => null)) as { data?: unknown } | unknown[] | null;
  const entries = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
  if (!entries) {
    warn(endpoint, "response was not a model list");
    return null;
  }

  const ids = entries
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : typeof (entry as { id?: unknown } | null)?.id === "string"
          ? ((entry as { id: string }).id)
          : null
    )
    .filter((id): id is string => id !== null);

  const models = selectCodexModels(ids);
  if (!models.length) {
    warn(endpoint, `no Codex-capable models among ${ids.length} listed`);
    return null;
  }
  return models;
}

interface CacheEntry {
  key: string;
  expiresAt: number;
  models: CodexModel[];
}

let cached: CacheEntry | null = null;
let inflight: { key: string; promise: Promise<CodexModel[]> } | null = null;

/** Cache identity: the endpoint plus a digest of the credential, so rotating a
 *  key (or pointing at a different gateway) invalidates the catalog without the
 *  secret itself living in module state. */
function cacheKey(endpoint: string, apiKey: string | undefined): string {
  const fingerprint = apiKey
    ? createHash("sha256").update(apiKey).digest("hex").slice(0, 12)
    : "none";
  return `${endpoint}|${fingerprint}`;
}

/**
 * The Codex model catalog, discovered and cached. Always resolves: every
 * failure path degrades to the built-in catalog (see the module header). The
 * array is the caller's own — the cached one is never handed out, so a consumer
 * that sorts or filters it in place can't corrupt the next request's catalog.
 */
export async function codexModelCatalog(env: EnvLike = process.env): Promise<CodexModel[]> {
  return [...(await resolveCatalog(env))];
}

async function resolveCatalog(env: EnvLike): Promise<readonly CodexModel[]> {
  const endpoint = codexModelsEndpoint(env);
  const apiKey = config.agent.codexModelDiscovery ? discoveryApiKey(env) : undefined;
  const key = cacheKey(endpoint, apiKey);

  if (cached && cached.key === key && cached.expiresAt > Date.now()) return cached.models;
  if (inflight && inflight.key === key) return inflight.promise;

  // No credential to discover with: the built-in catalog is the answer, and
  // caching it keeps the (cheap) work off every request all the same.
  if (!apiKey) {
    const models = staticCodexModels();
    cached = { key, expiresAt: Date.now() + CATALOG_TTL_MS, models };
    return models;
  }

  const task = (async () => {
    const fetched = await fetchAccountModels(endpoint, apiKey);
    const models = fetched ?? staticCodexModels();
    cached = { key, expiresAt: Date.now() + (fetched ? CATALOG_TTL_MS : FAILURE_TTL_MS), models };
    return models;
  })();
  inflight = { key, promise: task };
  try {
    return await task;
  } finally {
    if (inflight?.key === key) inflight = null;
  }
}

export const __test = {
  /** Drop the cached catalog so the next call re-resolves. Tests only. */
  resetCache() {
    cached = null;
    inflight = null;
  },
  discoveryApiKey,
  cacheKey,
};
