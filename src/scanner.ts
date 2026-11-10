import { Project } from "ts-morph";
import { readFileSync } from "node:fs";
import { detectMissingBackoff } from "./detectors/missing-backoff.js";
import { detectUnboundedLoop } from "./detectors/unbounded-loop.js";
import { detectTokenLeakage } from "./detectors/token-leakage.js";
import { DEFAULT_CONFIG, ValtaConfig } from "./config.js";
import { Finding, ScanResult } from "./types.js";

const HARDCODED_KEY_PATTERN = /\b(sk-[a-zA-Z0-9]{20,}|sk-ant-[a-zA-Z0-9-]{20,}|sk-proj-[a-zA-Z0-9_-]{20,})\b/;

function checkHardcodedKeys(filePath: string, findings: Finding[]): void {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n");
  lines.forEach((lineText, idx) => {
    if (HARDCODED_KEY_PATTERN.test(lineText)) {
      findings.push({
        severity: "FAIL",
        detectorId: "token-leakage",
        title: "Hardcoded API key found in source",
        file: filePath,
        line: idx + 1,
        detail: "A literal API key is committed directly in source. Move it to an environment variable before this reaches version control.",
      });
    }
  });
}

export interface ScanOptions {
  /** Applied config (see loadConfig). Defaults to no retries multiplier and no custom endpoint costs. */
  config?: ValtaConfig;
  /** Path of the config file, echoed back in the result for reporting. */
  configPath?: string | null;
}

export function scanProject(
  targetDir: string,
  glob = "**/*.{ts,tsx,js,jsx}",
  options: ScanOptions = {}
): ScanResult {
  const config = options.config ?? DEFAULT_CONFIG;
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });

  project.addSourceFilesAtPaths([
    `${targetDir}/${glob}`,
    `!${targetDir}/node_modules/**`,
    `!${targetDir}/dist/**`,
    `!${targetDir}/build/**`,
    `!${targetDir}/.next/**`,
  ]);

  const sourceFiles = project.getSourceFiles();
  const findings: Finding[] = [];

  for (const sourceFile of sourceFiles) {
    checkHardcodedKeys(sourceFile.getFilePath(), findings);
    findings.push(...detectMissingBackoff(sourceFile, config));
    findings.push(...detectUnboundedLoop(sourceFile, config));
    findings.push(...detectTokenLeakage(sourceFile, config));
  }

  return {
    filesScanned: sourceFiles.length,
    findings,
    configPath: options.configPath ?? null,
    retryMultiplier: config.sdk_default_retries,
    retryMultiplierIsDefault: !config.retries_from_config,
  };
}
