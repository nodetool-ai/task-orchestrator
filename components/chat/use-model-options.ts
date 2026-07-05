"use client";

import { useEffect, useState } from "react";
import type { ModelOption } from "@/components/chat/model-picker";

export const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-4-6";

export type BackendId = "pi" | "claude";

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
    .catch(
      (): BackendCatalog => ({
        defaultBackend: "pi",
        backendOptions: [],
        modelsByBackend: {},
      })
    );

  return catalogPromise;
}

/**
 * Model + backend selection state for the run-starting composers. The backend
 * choice narrows the model catalog (the claude backend is Anthropic-only; pi
 * spans every provider it has a credential for), and switching backends keeps
 * the current model when the other backend also offers it — otherwise it snaps
 * to the first model of the new catalog.
 */
export function useModelOptions(defaultModel = DEFAULT_CHAT_MODEL, enabled = true) {
  const [model, setModel] = useState(defaultModel);
  const [backend, setBackendState] = useState<BackendId | null>(null);
  const [catalog, setCatalog] = useState<BackendCatalog | null>(catalogCache);

  const effectiveBackend = backend ?? catalog?.defaultBackend ?? null;
  const modelOptions =
    (effectiveBackend ? catalog?.modelsByBackend[effectiveBackend] : undefined) ?? [];

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadCatalog().then((c) => {
      if (!alive) return;
      setCatalog(c);
      const options = c.modelsByBackend[c.defaultBackend] ?? [];
      const qualified = options.map((o) => `${o.provider}/${o.id}`);
      setModel((cur) => (qualified.includes(cur) ? cur : qualified[0] ?? cur));
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  function setBackend(next: BackendId) {
    setBackendState(next);
    const options = catalog?.modelsByBackend[next] ?? [];
    const qualified = options.map((o) => `${o.provider}/${o.id}`);
    setModel((cur) => (qualified.includes(cur) ? cur : qualified[0] ?? cur));
  }

  return {
    model,
    setModel,
    modelOptions,
    /** Selected backend ('pi'|'claude'), or null until the catalog loads. */
    backend: effectiveBackend,
    setBackend,
    /** Backends offered by the server, deployment default first. */
    backendOptions: catalog?.backendOptions ?? [],
  };
}
