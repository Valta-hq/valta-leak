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
}

export const PRICING_SNAPSHOT_DATE = "2026-07-12";

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8": { inputPerMillion: 5.0, outputPerMillion: 25.0, assumedLatencySeconds: 2.5 },
  "claude-sonnet-4-6": { inputPerMillion: 3.0, outputPerMillion: 15.0, assumedLatencySeconds: 1.5 },
  "claude-sonnet-5": { inputPerMillion: 2.0, outputPerMillion: 10.0, assumedLatencySeconds: 1.5 },
  "claude-haiku-4-5": { inputPerMillion: 1.0, outputPerMillion: 5.0, assumedLatencySeconds: 0.8 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0, assumedLatencySeconds: 1.5 },
  "gpt-5": { inputPerMillion: 1.25, outputPerMillion: 10.0, assumedLatencySeconds: 2.0 },
};

/** A conservative fallback used only when a model string can't be matched
 *  to the table above — deliberately mid-range, never the cheapest option,
 *  so an unmatched model doesn't produce a falsely reassuring low number. */
export const FALLBACK_PRICING: ModelPricing = {
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
  assumedLatencySeconds: 1.5,
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
 * Worst-case dollar-per-hour exposure ceiling for a loop that fires
 * back-to-back at the assumed latency, using real per-token pricing.
 * Accounts for both input AND output tokens — a call that only prices
 * input tokens understates real exposure, since a runaway loop also
 * generates a full completion every iteration.
 */
export function computeHourlyExposure(params: {
  inputTokens: number;
  outputTokens: number;
  pricing: ModelPricing;
}): number {
  const { inputTokens, outputTokens, pricing } = params;
  const costPerCall =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const callsPerHour = 3600 / pricing.assumedLatencySeconds;
  return costPerCall * callsPerHour;
}
