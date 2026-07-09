"use client";

import { useEffect, useMemo, useState } from "react";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";

export interface ProviderCatalog {
  id: string;
  models: { id: string; name: string }[];
}

interface Props {
  provider: string;
  model: string;
  onChange: (next: { provider: string; model: string }) => void;
  /** Scope the catalog to a specific agent backend (e.g. "pi" or "claude").
   *  Omit to use the deployment-default backend's catalog. */
  backend?: string;
  /** Render the two selects side-by-side (default) or stacked. */
  layout?: "row" | "column";
  className?: string;
  /** Merged over the base Select styling. */
  selectClassName?: string;
}

interface ProvidersResponse {
  providers: ProviderCatalog[];
  backends?: { id: string; providers: ProviderCatalog[] }[];
  defaultBackend?: string;
}

export interface Catalog {
  defaultBackend: string;
  byBackend: Map<string, ProviderCatalog[]>;
}

/** React hook over the shared provider catalog. Returns null until the
 *  /api/providers fetch resolves (cached module-level after the first call). */
export function useProviderCatalog(): Catalog | null {
  const [catalog, setCatalog] = useState<Catalog | null>(catalogCache);
  useEffect(() => {
    if (catalogCache) return;
    let alive = true;
    loadProviders().then((c) => {
      if (alive) setCatalog(c);
    });
    return () => {
      alive = false;
    };
  }, []);
  return catalog;
}

/** First provider/model pair offered by `backend`'s catalog, or null if the
 *  backend has no models. Used to snap a persona's provider/model when the
 *  engine changes to one that doesn't offer the current pair. */
export function firstModelForBackend(
  catalog: Catalog | null,
  backend: string
): { provider: string; model: string } | null {
  const providers = catalog?.byBackend.get(backend) ?? [];
  const first = providers[0]?.models[0];
  if (!first) return null;
  return { provider: providers[0].id, model: first.id };
}

// Module-level catalog cache — loaded once per page, shared across editors.
let catalogCache: Catalog | null = null;
let catalogPromise: Promise<Catalog> | null = null;
function loadProviders(): Promise<Catalog> {
  if (catalogCache) return Promise.resolve(catalogCache);
  if (catalogPromise) return catalogPromise;
  catalogPromise = fetch("/api/providers")
    .then((r) => r.json() as Promise<ProvidersResponse>)
    .then((b) => {
      const defaultBackend = b.defaultBackend ?? "pi";
      const byBackend = new Map<string, ProviderCatalog[]>();
      if (b.backends?.length) {
        for (const be of b.backends) byBackend.set(be.id, be.providers ?? []);
      } else {
        byBackend.set(defaultBackend, b.providers ?? []);
      }
      catalogCache = { defaultBackend, byBackend };
      return catalogCache;
    })
    .catch((): Catalog => ({ defaultBackend: "pi", byBackend: new Map() }));
  return catalogPromise;
}

/**
 * Provider + Model dropdowns wired together. Picks the first model under
 * the new provider when the provider changes. If the saved provider/model
 * isn't in pi-ai's catalog, both stay reachable as "(custom)" options so a
 * round-trip through the form doesn't silently rewrite them.
 *
 * Pass `backend` to scope the catalog to a specific agent backend (e.g. the
 * persona editor, which lets you pick the engine). Omit it to use the
 * deployment-default backend's catalog (legacy behavior).
 */
export function ProviderModelPicker({
  provider,
  model,
  onChange,
  backend,
  layout = "row",
  className = "",
  selectClassName = "w-full",
}: Props) {
  const catalog = useProviderCatalog();

  const providers =
    (backend
      ? catalog?.byBackend.get(backend)
      : catalog?.byBackend.get(catalog?.defaultBackend ?? "pi")) ?? [];

  const providerOptions = useMemo(() => {
    const ids = providers.map((p) => p.id);
    if (provider && !ids.includes(provider)) return [provider, ...ids];
    return ids;
  }, [providers, provider]);

  const modelOptions = useMemo(() => {
    const cat = providers.find((p) => p.id === provider);
    const list = cat ? [...cat.models] : [];
    if (model && !list.some((m) => m.id === model)) {
      list.unshift({ id: model, name: `${model} (custom)` });
    }
    return list;
  }, [providers, provider, model]);

  function changeProvider(nextProvider: string) {
    const cat = providers.find((p) => p.id === nextProvider);
    const nextModel =
      cat && cat.models.length > 0 ? cat.models[0].id : model;
    onChange({ provider: nextProvider, model: nextModel });
  }

  const wrap =
    layout === "column"
      ? `flex flex-col gap-2 ${className}`
      : `grid grid-cols-1 md:grid-cols-2 gap-3 ${className}`;

  return (
    <div className={wrap}>
      <Field label="Provider">
        <Select
          value={provider}
          onChange={(e) => changeProvider(e.target.value)}
          className={selectClassName}
        >
          {providerOptions.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Model">
        <Select
          mono
          value={model}
          onChange={(e) => onChange({ provider, model: e.target.value })}
          className={`${selectClassName} text-xs`}
        >
          {modelOptions.length === 0 && (
            <option value="">(no models for this provider)</option>
          )}
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} — {m.id}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
