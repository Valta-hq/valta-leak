import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject } from "../src/scanner.js";
import { parseConfig } from "../src/config.js";
import { callsPerHour, computeExposure, MODEL_PRICING } from "../src/pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

describe("valta-leak scanner", () => {
  it("flags a self-recursive retry with no backoff as FAIL", () => {
    const result = scanProject(FIXTURES, "bad-retry.ts");
    const hit = result.findings.find((f) => f.detectorId === "missing-backoff" && f.severity === "FAIL");
    expect(hit).toBeDefined();
    expect(hit?.maxExposurePerHour).toBeGreaterThan(0);
  });

  it("flags an unbounded while(true) agent loop as FAIL", () => {
    const result = scanProject(FIXTURES, "bad-loop.ts");
    const hit = result.findings.find((f) => f.detectorId === "unbounded-loop" && f.severity === "FAIL");
    expect(hit).toBeDefined();
    expect(hit?.maxExposurePerHour).toBeGreaterThan(0);
  });

  it("flags a large static system prompt inside a loop as WARN with a real token count", () => {
    const result = scanProject(FIXTURES, "bad-prompt.ts");
    const hit = result.findings.find((f) => f.detectorId === "token-leakage");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("WARN");
    expect(hit?.title).toMatch(/\d+ tokens/);
  });

  it("flags a hardcoded API key as FAIL", () => {
    const result = scanProject(FIXTURES, "hardcoded-key.ts");
    const hit = result.findings.find((f) => f.title.includes("Hardcoded API key"));
    expect(hit).toBeDefined();
  });

  it("produces zero findings on well-guarded code", () => {
    const result = scanProject(FIXTURES, "clean.ts");
    expect(result.findings).toEqual([]);
  });

  describe("valta.config.json", () => {
    const loop = (file: string, config?: ReturnType<typeof parseConfig>) =>
      scanProject(FIXTURES, file, { config }).findings.find((f) => f.detectorId === "unbounded-loop");

    it("multiplies the token ceiling by sdk_default_retries", () => {
      const base = loop("flat-loop.ts")!.maxExposurePerHour!;
      const withRetries = loop("flat-loop.ts", parseConfig({ sdk_default_retries: 3 }))!.maxExposurePerHour!;
      expect(withRetries).toBeCloseTo(base * 3, 6);
    });

    it("adds cost_per_call for calls to a configured endpoint", () => {
      const base = loop("proxy-loop.ts")!.maxExposurePerHour!;
      const config = parseConfig({
        custom_endpoint_costs: [{ match_url: "://proxy-scraping.com", cost_per_call: 0.005 }],
      });
      const hit = loop("proxy-loop.ts", config)!;
      const M = callsPerHour(MODEL_PRICING["claude-sonnet-4-6"]);
      expect(hit.maxExposurePerHour! - base).toBeCloseTo(0.005 * M, 6);
      expect(hit.assumptionNote).toContain("proxy-scraping.com");
    });

    it("does not charge an endpoint that never appears in the loop", () => {
      const base = loop("flat-loop.ts")!.maxExposurePerHour!;
      const config = parseConfig({
        custom_endpoint_costs: [{ match_url: "://proxy-scraping.com", cost_per_call: 0.005 }],
      });
      expect(loop("flat-loop.ts", config)!.maxExposurePerHour).toBeCloseTo(base, 6);
    });
  });

  describe("quadratic history growth", () => {
    it("prices a loop that pushes onto the history it re-sends with the summation series", () => {
      const hit = scanProject(FIXTURES, "bad-loop.ts").findings.find((f) => f.detectorId === "unbounded-loop")!;
      const pricing = MODEL_PRICING["claude-sonnet-4-6"];
      const expected = computeExposure({
        inputTokens: 500,
        outputTokens: 150,
        pricing,
        history: { avgMessageTokens: 150 },
      }).maxExposurePerHour;
      expect(hit.maxExposurePerHour).toBeCloseTo(expected, 6);
      expect(hit.assumptionNote).toMatch(/History grows/);
    });

    it("keeps the flat estimate when nothing is appended to the sent history", () => {
      const hit = scanProject(FIXTURES, "flat-loop.ts").findings.find((f) => f.detectorId === "unbounded-loop")!;
      expect(hit.assumptionNote).not.toMatch(/History grows/);
    });
  });

  describe("dynamic variable fallback", () => {
    it("warns with the line number and computes a full-context worst case", () => {
      const dynamic = scanProject(FIXTURES, "dynamic-model.ts").findings.find(
        (f) => f.detectorId === "unbounded-loop"
      )!;
      expect(dynamic.warnings).toHaveLength(1);
      expect(dynamic.warnings![0]).toMatch(/^\[!\] Dynamic variable detected on Line 9\. Falling back to maximum model context window/);
      const known = scanProject(FIXTURES, "const-model.ts").findings.find((f) => f.detectorId === "unbounded-loop")!;
      expect(dynamic.maxExposurePerHour!).toBeGreaterThan(known.maxExposurePerHour!);
    });

    it("does not treat a same-file const model name as dynamic", () => {
      const hit = scanProject(FIXTURES, "const-model.ts").findings.find((f) => f.detectorId === "unbounded-loop")!;
      expect(hit.warnings).toBeUndefined();
    });
  });
});
