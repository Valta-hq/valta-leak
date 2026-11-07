/**
 * Model pricing snapshot — last verified 2026-07-12 against
 * platform.claude.com/docs/en/about-claude/pricing and
 * openai.com/business/pricing.
 *
 * These numbers change frequently and providers ship new model tiers
 * often — treat this table as a best-effort, dated snapshot, not a
 * live source of truth. Every exposure figure this tool prints states
 * the pricing snapshot date alongside it so a stale table is visible,
 * not silently wrong.
 */

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillion: number;
  /**
   * A labeled ASSUMPTION, not a measured value — a static scanner has no
   * way to know a call's real latency. Used only to bound "calls per
   * hour" in a worst-case ceiling, and always printed alongside the
   * assumption itself so it's never mistaken for a measured fact.
   */
  assumedLatencySeconds: number;
  /**
   * Maximum context window in tokens. Also a dated snapshot value. Used to cap
   * how large a growing message history can get, and as the worst-case input
   * size when a model can't be resolved statically.
   */
  contextWindowTokens: number;
}

export const PRICING_SNAPSHOT_DATE = "2026-07-12";

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8": { inputPerMillion: 5.0, outputPerMillion: 25.0, assumedLatencySeconds: 2.5, contextWindowTokens: 200_000 },
  "claude-sonnet-4-6": { inputPerMillion: 3.0, outputPerMillion: 15.0, assumedLatencySeconds: 1.5, contextWindowTokens: 200_000 },
  "claude-sonnet-5": { inputPerMillion: 2.0, outputPerMillion: 10.0, assumedLatencySeconds: 1.5, contextWindowTokens: 200_000 },
  "claude-haiku-4-5": { inputPerMillion: 1.0, outputPerMillion: 5.0, assumedLatencySeconds: 0.8, contextWindowTokens: 200_000 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0, assumedLatencySeconds: 1.5, contextWindowTokens: 128_000 },
  "gpt-5": { inputPerMillion: 1.25, outputPerMillion: 10.0, assumedLatencySeconds: 2.0, contextWindowTokens: 400_000 },
};

/** A conservative fallback used only when a model string can't be matched
 *  to the table above — deliberately mid-range, never the cheapest option,
 *  so an unmatched model doesn't produce a falsely reassuring low number. */
export const FALLBACK_PRICING: ModelPricing = {
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
  assumedLatencySeconds: 1.5,
  contextWindowTokens: 200_000,
};

export function resolveModelPricing(modelString: string): { pricing: ModelPricing; matched: boolean } {
  const normalized = modelString.toLowerCase();
  if (MODEL_PRICING[normalized]) {
    return { pricing: MODEL_PRICING[normalized], matched: true };
  }
  // Prefix match handles dated suffixes some SDKs use, e.g.
  // "claude-haiku-4-5-20251001" should still match "claude-haiku-4-5".
  for (const key of Object.keys(MODEL_PRICING)) {
    if (normalized.startsWith(key)) {
      return { pricing: MODEL_PRICING[key], matched: true };
    }
  }
  return { pricing: FALLBACK_PRICING, matched: false };
}

/**
 * Used when a model name or token limit can't be read from the source
 * (e.g. `model: process.env.DYNAMIC_MODEL`). Instead of returning an empty or
 * optimistic estimate, assume the most expensive prices in the table, the
 * fastest assumed latency, and a completely full context window.
 */
export const FALLBACK_CONTEXT_TOKENS = 200_000;
/** Assumed output size per call when max_tokens is unreadable. A labeled assumption. */
export const FALLBACK_MAX_OUTPUT_TOKENS = 64_000;

export function worstCasePricing(): ModelPricing {
  const all = Object.values(MODEL_PRICING);
  return {
    inputPerMillion: Math.max(...all.map((p) => p.inputPerMillion)),
    outputPerMillion: Math.max(...all.map((p) => p.outputPerMillion)),
    assumedLatencySeconds: Math.min(...all.map((p) => p.assumedLatencySeconds)),
    contextWindowTokens: FALLBACK_CONTEXT_TOKENS,
  };
}

export function callsPerHour(pricing: ModelPricing): number {
  return Math.floor(3600 / pricing.assumedLatencySeconds);
}

export interface ExposureInput {
  /** Input tokens of a single call. With `history`, this is the base prompt (before any history). */
  inputTokens: number;
  outputTokens: number;
  pricing: ModelPricing;
  /** SDK retry multiplier applied to the token cost. Default 1. */
  retries?: number;
  /** Flat USD added once per call iteration, after the retry multiplier. Default 0. */
  staticCostPerCall?: number;
  /**
   * When set, input size grows every iteration because the loop appends to a
   * message array that is re-sent whole (quadratic total cost). Iteration i
   * sends min(inputTokens + i * avgMessageTokens, contextWindowTokens).
   */
  history?: { avgMessageTokens: number } | null;
}

export interface ExposureResult {
  maxExposurePerHour: number;
  callsPerHour: number;
}

/**
 * Worst-case dollar-per-hour exposure ceiling for a loop that fires
 * back-to-back at the assumed latency, using real per-token pricing.
 * Accounts for both input AND output tokens — a call that only prices
 * input tokens understates real exposure, since a runaway loop also
 * generates a full completion every iteration.
 *
 * Linear case (no history growth):
 *   hourly = (tokenCostPerCall * retries + staticCostPerCall) * M
 *
 * Growing history (quadratic):
 *   hourly = retries * sum_{i=1..M}( inputCost(base + i*avg) + outputCost ) + staticCostPerCall * M
 * where M is the number of calls that fit in an hour and the input size is
 * capped at the model's context window.
 */
export function computeExposure(params: ExposureInput): ExposureResult {
  const { inputTokens, outputTokens, pricing } = params;
  const retries = params.retries ?? 1;
  const staticCostPerCall = params.staticCostPerCall ?? 0;
  const M = callsPerHour(pricing);
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;

  let tokenCostPerHour = 0;
  if (params.history) {
    const { avgMessageTokens } = params.history;
    for (let i = 1; i <= M; i++) {
      const sent = Math.min(inputTokens + i * avgMessageTokens, pricing.contextWindowTokens);
      tokenCostPerHour += (sent / 1_000_000) * pricing.inputPerMillion + outputCost;
    }
  } else {
    const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
    tokenCostPerHour = (inputCost + outputCost) * M;
  }

  return {
    maxExposurePerHour: tokenCostPerHour * retries + staticCostPerCall * M,
    callsPerHour: M,
  };
}

/** Linear exposure with no retries or extras. Kept for callers that don't need the new options. */
export function computeHourlyExposure(params: {
  inputTokens: number;
  outputTokens: number;
  pricing: ModelPricing;
}): number {
  return computeExposure(params).maxExposurePerHour;
}
