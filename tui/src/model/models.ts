// `/model` argument completion. The server owns the catalog (GET
// /api/providers); this module only reshapes it and matches what the operator
// typed. No Ink here, so the suite can call it directly (views/prompt.tsx
// paints what this returns).

import type { ProvidersResponse } from "../api/types.js";

/** One completable model. `value` is the qualified `provider/model-id` form
 *  the run row stores (lib/model-id.ts only assumes a provider for bare ids,
 *  so completing bare ids would misfile every non-Anthropic model). */
export interface ModelOption {
  value: string;
  label: string;
}

/** Flatten every backend's catalog into one deduplicated list. A run may
 *  execute on any backend (the persona or a later /model pick decides), so
 *  restricting the menu to the default backend would hide real choices. */
export function modelOptions(res: ProvidersResponse): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const backend of res.backends ?? []) {
    for (const provider of backend.providers ?? []) {
      for (const model of provider.models ?? []) {
        const value = `${provider.id}/${model.id}`;
        if (seen.has(value)) continue;
        seen.add(value);
        out.push({ value, label: model.name });
      }
    }
  }
  return out.sort((a, b) => a.value.localeCompare(b.value));
}

const CMD = "/model";

/** How many rows the composer may spend on suggestions before it clips. The
 *  screen arithmetic (views/layout.ts) yields further on a short terminal. */
export const MODEL_SUGGESTIONS = 8;

/**
 * The suggestions for the composer's current input, best first. Empty unless
 * the input is `/model` plus at least one space; empty again once the typed
 * id already names a model exactly, because at that point `tab` belongs to
 * agent addressing again rather than to completion.
 */
export function matchModels(input: string, models: ModelOption[], limit = MODEL_SUGGESTIONS): ModelOption[] {
  if (!input.startsWith(CMD)) return [];
  const rest = input.slice(CMD.length);
  if (!/^\s/.test(rest)) return []; // still typing the command word itself
  const q = rest.trim().toLowerCase();
  if (models.some((m) => m.value.toLowerCase() === q)) return [];
  const ranked: Array<{ option: ModelOption; rank: number }> = [];
  models.forEach((option, i) => {
    const r = rank(option, q);
    if (r < 4) ranked.push({ option, rank: r * 1000 + i }); // stable: catalog order breaks ties
  });
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, Math.max(0, Math.floor(limit)))
    .map((r) => r.option);
}

/** Where a query hits: prefix of the id beats prefix of the label beats a hit
 *  anywhere in either. `sonnet` lands on `anthropic/claude-sonnet-5`. */
function rank(option: ModelOption, q: string): number {
  if (q === "") return 0; // no query yet: catalog order decides
  const value = option.value.toLowerCase();
  const label = option.label.toLowerCase();
  if (value.startsWith(q)) return 0;
  if (label.startsWith(q)) return 1;
  if (value.includes(q)) return 2;
  if (label.includes(q)) return 3;
  return 4;
}

/** Swap the half-typed argument for the picked one, command token kept. */
export function applyModelCompletion(input: string, value: string): string {
  const cut = input.search(/\s/);
  if (cut < 0) return `${CMD} ${value}`;
  return `${input.slice(0, cut)} ${value}`;
}
