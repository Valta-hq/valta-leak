import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject } from "../src/scanner.js";

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
});
