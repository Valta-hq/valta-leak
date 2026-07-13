import path from "node:path";
import { Finding, ScanResult } from "./types.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function color(sev: Finding["severity"]): string {
  if (sev === "PASS") return GREEN;
  if (sev === "WARN") return YELLOW;
  return RED;
}

function relPath(p: string, cwd: string): string {
  return path.relative(cwd, p) || p;
}

export function printReport(result: ScanResult, cwd: string): void {
  const { findings, filesScanned } = result;

  if (findings.length === 0) {
    console.log(`${GREEN}[PASS]${RESET} No hardcoded keys found.`);
    console.log(`${GREEN}[PASS]${RESET} No structural cost-exposure patterns detected across ${filesScanned} file(s).`);
    console.log("");
    console.log(`[valta-leak] Analysis complete. 0 structural cost vulnerabilities found.`);
    return;
  }

  const failCount = findings.filter((f) => f.severity === "FAIL").length;
  const warnCount = findings.filter((f) => f.severity === "WARN").length;

  for (const finding of findings) {
    const c = color(finding.severity);
    console.log(`${c}[${finding.severity}]${RESET} ${finding.title}`);
    console.log(`       ${DIM}-> File:${RESET} ${relPath(finding.file, cwd)}:${finding.line}`);
    console.log(`       ${DIM}-> Risk:${RESET} ${finding.detail}`);
    if (finding.maxExposurePerHour !== undefined) {
      console.log(
        `       ${DIM}-> Maximum Exposure:${RESET} ~$${finding.maxExposurePerHour.toFixed(2)} / hour`
      );
    }
    if (finding.assumptionNote) {
      console.log(`       ${DIM}-> Basis:${RESET} ${finding.assumptionNote}`);
    }
    console.log("");
  }

  const total = failCount + warnCount;
  console.log(
    `[valta-leak] Analysis complete. ${total} structural cost vulnerabilit${total === 1 ? "y" : "ies"} found ` +
      `(${failCount} unbounded, ${warnCount} advisory).`
  );
  console.log(`Documentation on mitigating automated loop exposure: https://valta.co`);
}
