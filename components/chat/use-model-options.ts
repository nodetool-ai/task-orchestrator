"use client";

import { useEffect, useState } from "react";
import type { ModelOption } from "@/components/chat/model-picker";

export const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-4-6";

interface ProviderCatalog {
  id: string;
  models: { id: string; name: string }[];
}

let modelOptionsCache: ModelOption[] | null = null;
let modelOptionsPromise: Promise<ModelOption[]> | null = null;

function loadModelOptions(): Promise<ModelOption[]> {
  if (modelOptionsCache) return Promise.resolve(modelOptionsCache);
  if (modelOptionsPromise) return modelOptionsPromise;

  modelOptionsPromise = fetch("/api/providers")
    .then((res) => res.json() as Promise<{ providers: ProviderCatalog[] }>)
    .then((data) => {
      const flat: ModelOption[] = [];
      for (const provider of data.providers ?? []) {
        for (const m of provider.models ?? []) {
          flat.push({ id: m.id, name: m.name, provider: provider.id });
        }
      }
      modelOptionsCache = flat;
      return flat;
    })
    .catch(() => []);

  return modelOptionsPromise;
}

export function useModelOptions(defaultModel = DEFAULT_CHAT_MODEL, enabled = true) {
  const [model, setModel] = useState(defaultModel);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(modelOptionsCache ?? []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadModelOptions().then((options) => {
      if (!alive) return;
      setModelOptions(options);
      const qualified = options.map((o) => `${o.provider}/${o.id}`);
      setModel((cur) => (qualified.includes(cur) ? cur : qualified[0] ?? cur));
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return { model, setModel, modelOptions };
}
