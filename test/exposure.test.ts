import { describe, it, expect } from "vitest";
import { computeExposure, callsPerHour, MODEL_PRICING } from "../src/pricing.js";
import { parseConfig, ConfigError } from "../src/config.js";

const pricing = MODEL_PRICING["claude-sonnet-4-6"];

describe("computeExposure", () => {
  it("matches the linear formula when there is no history growth", () => {
    const M = callsPerHour(pricing);
    const perCall = (500 / 1e6) * pricing.inputPerMillion + (150 / 1e6) * pricing.outputPerMillion;
    const { maxExposurePerHour } = computeExposure({ inputTokens: 500, outputTokens: 150, pricing });
    expect(maxExposurePerHour).toBeCloseTo(perCall * M, 6);
  });

  it("matches the summation series for a growing history", () => {
    const M = callsPerHour(pricing);
    const base = 500;
    const avg = 20; // small enough that the context cap is never hit in an hour
    let expected = 0;
    for (let i = 1; i <= M; i++) {
      expected += ((base + i * avg) / 1e6) * pricing.inputPerMillion + (150 / 1e6) * pricing.outputPerMillion;
    }
    const { maxExposurePerHour } = computeExposure({
      inputTokens: base,
      outputTokens: 150,
      pricing,
      history: { avgMessageTokens: avg },
    });
    expect(maxExposurePerHour).toBeCloseTo(expected, 6);
  });

  it("grows faster than the flat estimate and never exceeds a full context window per call", () => {
    const flat = computeExposure({ inputTokens: 500, outputTokens: 150, pricing }).maxExposurePerHour;
    const growing = computeExposure({
      inputTokens: 500,
      outputTokens: 150,
      pricing,
      history: { avgMessageTokens: 150 },
    }).maxExposurePerHour;
    expect(growing).toBeGreaterThan(flat);

    const M = callsPerHour(pricing);
    const ceiling = M * ((pricing.contextWindowTokens / 1e6) * pricing.inputPerMillion + (150 / 1e6) * pricing.outputPerMillion);
    expect(growing).toBeLessThanOrEqual(ceiling + 1e-9);
  });

  it("multiplies token cost by retries, then adds the flat per-call cost", () => {
    const M = callsPerHour(pricing);
    const base = computeExposure({ inputTokens: 500, outputTokens: 150, pricing }).maxExposurePerHour;
    const result = computeExposure({
      inputTokens: 500,
      outputTokens: 150,
      pricing,
      retries: 3,
      staticCostPerCall: 0.005,
    }).maxExposurePerHour;
    expect(result).toBeCloseTo(base * 3 + 0.005 * M, 6);
  });
});

describe("parseConfig", () => {
  it("accepts the documented shape", () => {
    const cfg = parseConfig({
      sdk_default_retries: 3,
      custom_endpoint_costs: [{ match_url: "://proxy-scraping.com", cost_per_call: 0.005 }],
    });
    expect(cfg.sdk_default_retries).toBe(3);
    expect(cfg.custom_endpoint_costs).toHaveLength(1);
  });

  it("defaults to no multiplier and no extra costs", () => {
    const cfg = parseConfig({});
    expect(cfg.sdk_default_retries).toBe(1);
    expect(cfg.custom_endpoint_costs).toEqual([]);
  });

  it("rejects bad values with a message naming the field", () => {
    expect(() => parseConfig({ sdk_default_retries: 0 })).toThrow(/sdk_default_retries/);
    expect(() => parseConfig({ custom_endpoint_costs: [{ match_url: "", cost_per_call: 1 }] })).toThrow(/match_url/);
    expect(() => parseConfig({ custom_endpoint_costs: [{ match_url: "x", cost_per_call: -1 }] })).toThrow(ConfigError);
    expect(() => parseConfig([])).toThrow(/JSON object/);
  });
});
