"use client";

import { useEffect, useMemo, useState } from "react";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";

interface ProviderCatalog {
  id: string;
  models: { id: string; name: string }[];
}

interface Props {
  provider: string;
  model: string;
  onChange: (next: { provider: string; model: string }) => void;
  /** Render the two selects side-by-side (default) or stacked. */
  layout?: "row" | "column";
  className?: string;
  /** Merged over the base Select styling. */
  selectClassName?: string;
}

// Module-level catalog cache — loaded once per page, shared across editors.
let providersCache: ProviderCatalog[] | null = null;
let providersPromise: Promise<ProviderCatalog[]> | null = null;
function loadProviders(): Promise<ProviderCatalog[]> {
  if (providersCache) return Promise.resolve(providersCache);
  if (providersPromise) return providersPromise;
  providersPromise = fetch("/api/providers")
    .then((r) => r.json() as Promise<{ providers: ProviderCatalog[] }>)
    .then((b) => {
      providersCache = b.providers;
      return providersCache;
    })
    .catch(() => []);
  return providersPromise;
}

/**
 * Provider + Model dropdowns wired together. Picks the first model under
 * the new provider when the provider changes. If the saved provider/model
 * isn't in pi-ai's catalog, both stay reachable as "(custom)" options so a
 * round-trip through the form doesn't silently rewrite them.
 */
export function ProviderModelPicker({
  provider,
  model,
  onChange,
  layout = "row",
  className = "",
  selectClassName = "w-full",
}: Props) {
  const [providers, setProviders] = useState<ProviderCatalog[]>(
    providersCache ?? []
  );

  useEffect(() => {
    if (providersCache) return;
    let alive = true;
    loadProviders().then((p) => {
      if (alive) setProviders(p);
    });
    return () => {
      alive = false;
    };
  }, []);

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
