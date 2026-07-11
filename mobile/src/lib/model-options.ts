// Model catalog — the mobile counterpart of the web's
// components/chat/use-model-options.ts. Reads the `/api/providers` catalog and
// flattens it into per-backend model lists. A "model" value is the qualified
// `provider/modelId` string the run-start endpoints expect.

import { api } from "./api";
import type { BackendId, ProvidersResponse } from "./types";

export const DEFAULT_CHAT_MODEL = "openai/gpt-5.6-sol";

export interface ModelOption {
  id: string; // e.g. "gpt-5.6-sol"
  name: string; // e.g. "Claude Sonnet 4.6"
  provider: string; // e.g. "anthropic"
}

export interface ModelCatalog {
  defaultBackend: BackendId;
  backendOptions: BackendId[];
  modelsByBackend: Partial<Record<BackendId, ModelOption[]>>;
}

export function qualify(o: ModelOption): string {
  return `${o.provider}/${o.id}`;
}

function flatten(providers: ProvidersResponse["backends"][number]["providers"]): ModelOption[] {
  const out: ModelOption[] = [];
  for (const p of providers as { id?: string; models?: { id?: string; name?: string }[] }[]) {
    const provider = p?.id ?? "";
    for (const m of p?.models ?? []) {
      if (m?.id) out.push({ id: m.id, name: m.name || m.id, provider });
    }
  }
  return out;
}

/** Fetch + flatten the provider/backend catalog (cached in api.providers). */
export async function loadModelCatalog(): Promise<ModelCatalog> {
  const data = await api.providers();
  const def = data.defaultBackend;
  const ids = (data.backends ?? []).map((b) => b.id);
  const backendOptions = [def, ...ids.filter((b) => b !== def)];
  const modelsByBackend: Partial<Record<BackendId, ModelOption[]>> = {};
  for (const b of data.backends ?? []) modelsByBackend[b.id] = flatten(b.providers);
  return { defaultBackend: def, backendOptions, modelsByBackend };
}
