// lib/pricing.ts
//
// Approximate per-model token pricing, used ONLY to estimate a run's dollar
// spend when the agent backend does not self-report a cost. The Claude backend
// reports `total_cost_usd` directly (authoritative); the pi backend reports
// token *usage* but no priced cost, which used to leave budgetMaxUsd unenforced
// on pi. checkBudget() (lib/runs.ts) falls back to estimateCostUsd() so the
// dollar cap is a real backstop on every backend.
//
// These are LIST prices in USD per 1,000,000 tokens (per-MTok), matching the
// public Anthropic pricing for the models this project actually runs (see
// claude-backend.ts listProviders() and DEFAULT_MODEL). The estimate is
// deliberately coarse: it prices input+output tokens only and does NOT price
// cache read/write traffic separately (pi's reported input_tokens already
// excludes cached tokens — see pi-event-mapper.ts sumAssistantUsage), so the
// estimate can UNDER-count a cache-heavy turn. It is a budget backstop, not a
// billing ledger; treat any cap it trips as "hit on an estimated basis".

/** Input/output list price in USD per 1,000,000 tokens. */
interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

// Keyed by bare model id (provider prefix stripped). Kept in sync with the
// models exposed by the backends' listProviders() / used as DEFAULT_MODEL.
const PRICING: Record<string, ModelPrice> = {
  // GPT-5.6 Sol — $5 / $30 per MTok (limited preview).
  "gpt-5.6-sol": { inputPerMTok: 5, outputPerMTok: 30 },
  "gpt-5.6-terra": { inputPerMTok: 2.5, outputPerMTok: 15 },
  "gpt-5.6-luna": { inputPerMTok: 1, outputPerMTok: 6 },
  // Opus tier — $5 / $25 per MTok.
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25 },
  // Sonnet tier — $3 / $15 per MTok.
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },
  // Haiku tier — $1 / $5 per MTok.
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

// Conservative fallback for a model we don't have an explicit price for (e.g. a
// non-Anthropic pi model, or a newer id we haven't listed). We deliberately use
// the most expensive known tier so the estimate is an UPPER bound: a budget
// backstop should trip early rather than let an unknown-priced model run
// unbounded. This is approximate by design.
const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 5, outputPerMTok: 25 };

/** Strip a provider prefix ("anthropic/claude-...") to the bare model id. */
function bareModelId(model: string): string {
  const idx = model.indexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

/**
 * Estimate the USD cost of a turn (or run) from its token usage. Returns null
 * when there is no usage to price (both counts null/zero) so the caller can
 * keep "unknown spend" semantics rather than treating it as $0 spent.
 *
 * The estimate is APPROXIMATE (see the file header): input/output list price
 * only, no separate cache pricing. Use it as a budget backstop, not an invoice.
 */
export function estimateCostUsd(
  model: string | null,
  inputTokens: number | null,
  outputTokens: number | null
): number | null {
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  if (input <= 0 && output <= 0) return null;

  const price = (model && PRICING[bareModelId(model)]) || FALLBACK_PRICE;
  return (input / 1_000_000) * price.inputPerMTok + (output / 1_000_000) * price.outputPerMTok;
}
