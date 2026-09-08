"use client";

import { useEffect, useState } from "react";
import type { ModelOption } from "@/components/chat/model-picker";

export const DEFAULT_CHAT_MODEL = "openai/gpt-5.6-sol";

export type BackendId = "pi" | "claude" | "codex";

interface ProviderCatalog {
  id: string;
  models: { id: string; name: string }[];
}

interface ProvidersResponse {
  providers?: ProviderCatalog[];
  backends?: { id: BackendId; providers: ProviderCatalog[] }[];
  defaultBackend?: BackendId;
}

export interface BackendCatalog {
  defaultBackend: BackendId;
  /** Selectable backends, deployment default first. */
  backendOptions: BackendId[];
  modelsByBackend: Partial<Record<BackendId, ModelOption[]>>;
}

let catalogCache: BackendCatalog | null = null;
let catalogPromise: Promise<BackendCatalog> | null = null;
const LAST_MODEL_KEY_PREFIX = "task-orchestrator:last-model:";
const LAST_BACKEND_KEY = "task-orchestrator:last-model-backend";

function storedBackend(options: BackendId[]): BackendId | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(LAST_BACKEND_KEY) as BackendId | null;
    return value && options.includes(value) ? value : null;
  } catch {
    return null;
  }
}

function storedModel(backend: BackendId): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(`${LAST_MODEL_KEY_PREFIX}${backend}`);
  } catch {
    return null;
  }
}

function rememberModel(backend: BackendId | null, model: string) {
  if (!backend || !model || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${LAST_MODEL_KEY_PREFIX}${backend}`, model);
  } catch {
    // Storage can be disabled (private browsing / browser policy). Selection
    // remains usable for the current component lifetime.
  }
}

function flatten(providers: ProviderCatalog[]): ModelOption[] {
  const flat: ModelOption[] = [];
  for (const provider of providers) {
    for (const m of provider.models ?? []) {
      flat.push({ id: m.id, name: m.name, provider: provider.id });
    }
  }
  return flat;
}

function loadCatalog(): Promise<BackendCatalog> {
  if (catalogCache) return Promise.resolve(catalogCache);
  if (catalogPromise) return catalogPromise;

  catalogPromise = fetch("/api/providers")
    .then((res) => res.json() as Promise<ProvidersResponse>)
    .then((data) => {
      const defaultBackend: BackendId = data.defaultBackend ?? "pi";
      const modelsByBackend: Partial<Record<BackendId, ModelOption[]>> = {};
      for (const b of data.backends ?? []) {
        modelsByBackend[b.id] = flatten(b.providers ?? []);
      }
      // Old single-catalog response shape → one implicit backend.
      if (!data.backends?.length) {
        modelsByBackend[defaultBackend] = flatten(data.providers ?? []);
      }
      const ids = Object.keys(modelsByBackend) as BackendId[];
      const backendOptions = [
        ...ids.filter((id) => id === defaultBackend),
        ...ids.filter((id) => id !== defaultBackend),
      ];
      catalogCache = { defaultBackend, backendOptions, modelsByBackend };
      return catalogCache;
    })
    .catch((): BackendCatalog => {
      // Clear the in-flight promise so the next call retries — caching the
      // failure would leave every composer with an empty catalog until a hard
      // reload. (catalogCache stays unset: only successes are cached.)
      catalogPromise = null;
      return {
        defaultBackend: "pi",
        backendOptions: [],
        modelsByBackend: {},
      };
    });

  return catalogPromise;
}

/**
 * Model + backend selection state for the run-starting composers. The backend
 * choice narrows the model catalog (the claude backend is Anthropic-only; pi
 * spans every provider it has a credential for), and switching backends keeps
 * the current model when the other backend also offers it — otherwise it snaps
 * to the first model of the new catalog.
 *
 * Pass `lockBackend` to pin a composer to a single backend. The picker then
 * surfaces just that backend's models and `backendOptions` is empty so no
 * engine selector renders; `setBackend` becomes a no-op.
 */
export function useModelOptions(
  defaultModel = DEFAULT_CHAT_MODEL,
  enabled = true,
  lockBackend?: BackendId
) {
  const [model, setModel] = useState(defaultModel);
  const [backend, setBackendState] = useState<BackendId | null>(lockBackend ?? null);
  const [catalog, setCatalog] = useState<BackendCatalog | null>(catalogCache);

  const effectiveBackend = lockBackend ?? backend ?? catalog?.defaultBackend ?? null;
  const modelOptions =
    (effectiveBackend ? catalog?.modelsByBackend[effectiveBackend] : undefined) ??
    [];

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadCatalog().then((c) => {
      if (!alive) return;
      setCatalog(c);
      const target = lockBackend ?? storedBackend(c.backendOptions) ?? c.defaultBackend;
      if (!lockBackend) setBackendState(target);
      const options = c.modelsByBackend[target] ?? [];
      const qualified = options.map((o) => `${o.provider}/${o.id}`);
      const remembered = storedModel(target);
      setModel((cur) =>
        remembered && qualified.includes(remembered)
          ? remembered
          : qualified.includes(cur)
            ? cur
            : qualified[0] ?? cur
      );
    });
    return () => {
      alive = false;
    };
  }, [enabled, lockBackend]);

  function setBackend(next: BackendId) {
    if (lockBackend) return; // pinned — no-op
    setBackendState(next);
    try {
      window.localStorage.setItem(LAST_BACKEND_KEY, next);
    } catch {
      // Keep the in-memory selection when browser storage is unavailable.
    }
    const options = catalog?.modelsByBackend[next] ?? [];
    const qualified = options.map((o) => `${o.provider}/${o.id}`);
    const remembered = storedModel(next);
    setModel((cur) =>
      remembered && qualified.includes(remembered)
        ? remembered
        : qualified.includes(cur)
          ? cur
          : qualified[0] ?? cur
    );
  }

  function selectModel(next: string) {
    setModel(next);
    rememberModel(effectiveBackend, next);
  }

  return {
    model,
    setModel: selectModel,
    modelOptions,
    /** Selected backend ('pi'|'claude'), or null until the catalog loads. */
    backend: effectiveBackend,
    setBackend,
    /** Backends offered by the server, deployment default first. Empty when
     *  `lockBackend` is set — the engine picker should not render. */
    backendOptions: lockBackend ? [] : catalog?.backendOptions ?? [],
  };
}
