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
  defaultBackend?: BackendId;
}

export interface BackendCatalog {
  defaultBackend: BackendId;
  models: ModelOption[];
}

let catalogCache: BackendCatalog | null = null;
let catalogPromise: Promise<BackendCatalog> | null = null;
const LAST_MODEL_KEY_PREFIX = "task-orchestrator:last-model:";
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
      catalogCache = { defaultBackend, models: flatten(data.providers ?? []) };
      return catalogCache;
    })
    .catch((): BackendCatalog => {
      // Clear the in-flight promise so the next call retries — caching the
      // failure would leave every composer with an empty catalog until a hard
      // reload. (catalogCache stays unset: only successes are cached.)
      catalogPromise = null;
      return {
        defaultBackend: "pi",
        models: [],
      };
    });

  return catalogPromise;
}

/**
 * Model selection state for run-starting composers. The server's deployment
 * backend determines the only catalog shown; the browser remembers the last
 * valid model selected for that backend.
 */
export function useModelOptions(
  defaultModel = DEFAULT_CHAT_MODEL,
  enabled = true
) {
  const [model, setModel] = useState(defaultModel);
  const [catalog, setCatalog] = useState<BackendCatalog | null>(catalogCache);

  const effectiveBackend = catalog?.defaultBackend ?? null;
  const modelOptions = catalog?.models ?? [];

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadCatalog().then((c) => {
      if (!alive) return;
      setCatalog(c);
      const target = c.defaultBackend;
      const options = c.models;
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
  }, [enabled]);

  function selectModel(next: string) {
    setModel(next);
    rememberModel(effectiveBackend, next);
  }

  return {
    model,
    setModel: selectModel,
    modelOptions,
  };
}
