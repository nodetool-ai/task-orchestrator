// lib/agent-backend/usage.ts
//
// One usage/cost accumulator shared by every turn driver: the pi backend, the
// Claude backend, and the postgres-mode (lightweight) loop. Before this module
// each of the three summed tokens/cost its own way — the two SDK backends read
// the totals off the final `result` envelope, while the lightweight loop summed
// per-round `AssistantMessage.usage` and returned `sawCost ? total : null`. The
// representations drifted (null-if-unseen vs envelope-derived), so this is the
// single place that decides what "no cost observed" means: totalCostUsd stays
// null until a real cost is seen, tokens stay null until a real count is seen.

/** The token/cost totals a turn reports back through TurnOutcome. */
export interface UsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  totalCostUsd: number | null;
}

export interface UsageAccumulator {
  /**
   * Sum a single model round's usage (the postgres-mode loop calls this once per
   * completeSimple response). input/output tokens and cost accumulate across the
   * turn's rounds. A round with no cost leaves totalCostUsd untouched (still null
   * until the first real cost).
   */
  addRound(usage: {
    input?: number | null;
    output?: number | null;
    costTotal?: number | null;
  }): void;
  /**
   * Take the totals a backend surfaces on a `result` envelope (the pi/Claude
   * SDKs report a running total per turn, so the latest non-null value wins
   * rather than summing).
   */
  observeResult(usage: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalCostUsd?: number | null;
  }): void;
  totals(): UsageTotals;
}

export function createUsageAccumulator(): UsageAccumulator {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let totalCostUsd: number | null = null;

  return {
    addRound({ input, output, costTotal }) {
      if (input != null) inputTokens = (inputTokens ?? 0) + input;
      if (output != null) outputTokens = (outputTokens ?? 0) + output;
      if (costTotal != null) totalCostUsd = (totalCostUsd ?? 0) + costTotal;
    },
    observeResult({ inputTokens: i, outputTokens: o, totalCostUsd: c }) {
      if (i != null) inputTokens = i;
      if (o != null) outputTokens = o;
      if (c != null) totalCostUsd = c;
    },
    totals() {
      return { inputTokens, outputTokens, totalCostUsd };
    },
  };
}
