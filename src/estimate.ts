import { Node, CallExpression, SyntaxKind } from "ts-morph";
import { ValtaConfig } from "./config.js";
import { extractCallParams, resolveConstInitializer } from "./llm-call.js";
import {
  PRICING_SNAPSHOT_DATE,
  FALLBACK_CONTEXT_TOKENS,
  FALLBACK_MAX_OUTPUT_TOKENS,
  ModelPricing,
  computeExposure,
  resolveModelPricing,
  worstCasePricing,
} from "./pricing.js";

/** Deterministic terminal warning for a value that can't be resolved at rest. */
export function dynamicWarning(line: number): string {
  return (
    `[!] Dynamic variable detected on Line ${line}. Falling back to maximum model context window ` +
    `constraints (e.g., Claude 3.5 Sonnet / 200k tokens) to compute absolute worst-case financial ceiling.`
  );
}

export interface CustomEndpointHit {
  match_url: string;
  count: number;
  cost_per_call: number;
}

/**
 * Finds calls inside `scope` whose first argument contains one of the
 * configured `match_url` substrings (directly, or through a same-file const)
 * and totals their flat cost for one pass through the scope. Each call counts
 * once, so a loop body containing one matching fetch adds one cost_per_call
 * per iteration.
 */
export function customEndpointCosts(
  scope: Node,
  config: ValtaConfig
): { costPerIteration: number; hits: CustomEndpointHit[] } {
  const hits = new Map<string, CustomEndpointHit>();
  if (config.custom_endpoint_costs.length === 0) return { costPerIteration: 0, hits: [] };

  const calls: CallExpression[] = scope.getDescendantsOfKind(SyntaxKind.CallExpression);
  if (Node.isCallExpression(scope)) calls.push(scope);

  for (const call of calls) {
    const first = call.getArguments()[0];
    if (!first) continue;
    let text = first.getText();
    if (Node.isIdentifier(first)) {
      const init = resolveConstInitializer(first);
      if (init) text = init.getText();
    }
    const entry = config.custom_endpoint_costs.find((e) => text.includes(e.match_url));
    if (!entry) continue;
    const existing = hits.get(entry.match_url);
    if (existing) existing.count += 1;
    else hits.set(entry.match_url, { match_url: entry.match_url, count: 1, cost_per_call: entry.cost_per_call });
  }

  const list = [...hits.values()];
  return {
    costPerIteration: list.reduce((sum, h) => sum + h.count * h.cost_per_call, 0),
    hits: list,
  };
}

export interface EstimateParams {
  /** The LLM call being priced, or null when the finding has no single call (e.g. an inline-retry WARN). */
  call: CallExpression | null;
  /** The code that runs once per iteration/attempt; searched for configured custom endpoints. */
  scope: Node;
  config: ValtaConfig;
  /** Assumed input tokens per call when nothing better is known. */
  approxTokensPerCall: number;
  /** A measured input size (e.g. an exact system-prompt token count) that replaces the assumption. */
  measuredInputTokens?: number;
  /** Output tokens per call; defaults to 30% of the input assumption. */
  outputTokens?: number;
  /** True when the loop appends to the history it re-sends (quadratic growth). */
  growingHistory?: boolean;
  /** Sentence describing how input tokens were obtained, when measured. */
  measuredNote?: string;
}

export interface Estimate {
  maxExposurePerHour: number;
  assumptionNote: string;
  warnings: string[];
}

export function estimateExposure(p: EstimateParams): Estimate {
  const params = p.call ? extractCallParams(p.call) : { model: null, dynamic: [] };
  const warnings = params.dynamic.map((d) => dynamicWarning(d.line));
  const isDynamic = params.dynamic.length > 0;
  const modelUnknown = params.dynamic.some((d) => d.property === "model" || d.property === "options");

  let pricing: ModelPricing;
  let matched: boolean;
  if (modelUnknown) {
    pricing = worstCasePricing();
    matched = true;
  } else {
    const resolved = resolveModelPricing(params.model ?? "");
    pricing = resolved.pricing;
    matched = resolved.matched;
  }

  let inputTokens: number;
  let outputTokens: number;
  if (isDynamic) {
    // Absolute worst case: a full context window in, a large completion out.
    inputTokens = modelUnknown ? FALLBACK_CONTEXT_TOKENS : pricing.contextWindowTokens;
    outputTokens = FALLBACK_MAX_OUTPUT_TOKENS;
  } else {
    inputTokens = p.measuredInputTokens ?? p.approxTokensPerCall;
    outputTokens = p.outputTokens ?? Math.round(p.approxTokensPerCall * 0.3);
  }

  const growing = !!p.growingHistory && !isDynamic; // a full context window can't grow further
  const avgMessageTokens = p.config.average_message_tokens ?? Math.max(outputTokens, 1);
  const { costPerIteration, hits } = customEndpointCosts(p.scope, p.config);

  const { maxExposurePerHour, callsPerHour } = computeExposure({
    inputTokens,
    outputTokens,
    pricing,
    retries: p.config.sdk_default_retries,
    staticCostPerCall: costPerIteration,
    history: growing ? { avgMessageTokens } : null,
  });

  const parts: string[] = [];
  if (isDynamic) {
    parts.push(
      `Model or token limit could not be read from source, so this assumes the most expensive listed prices, ` +
        `a full ${inputTokens.toLocaleString("en-US")}-token context in and ${outputTokens.toLocaleString("en-US")} tokens out per call ` +
        `at ${pricing.assumedLatencySeconds}s latency.`
    );
  } else {
    const tokenPart = p.measuredNote
      ? p.measuredNote
      : `Assumes ~${inputTokens} input / ${outputTokens} output tokens per call`;
    parts.push(
      `${tokenPart} and ${pricing.assumedLatencySeconds}s latency${
        matched ? "" : " (model string not recognized — using a mid-range fallback price, verify manually)"
      }.`
    );
  }
  if (growing) {
    parts.push(
      `History grows by ~${Math.round(avgMessageTokens)} tokens per iteration, so input per call rises each ` +
        `iteration (capped at the ${pricing.contextWindowTokens.toLocaleString("en-US")}-token context window): ` +
        `${callsPerHour} calls/hour summed as base + i x message size, not a flat per-call cost.`
    );
  }
  if (p.config.retries_from_config) {
    parts.push(`Token cost multiplied by sdk_default_retries = ${p.config.sdk_default_retries} (valta.config.json).`);
  } else {
    parts.push(`Token cost multiplied by an assumed default of ${p.config.sdk_default_retries}x for SDK retries.`);
  }
  for (const h of hits) {
    parts.push(
      `Adds $${h.cost_per_call} x ${h.count} per iteration for calls matching "${h.match_url}" (valta.config.json).`
    );
  }
  parts.push(`Pricing snapshot: ${PRICING_SNAPSHOT_DATE}.`);

  return { maxExposurePerHour, assumptionNote: parts.join(" "), warnings };
}
