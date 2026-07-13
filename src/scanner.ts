import { Project } from "ts-morph";
import { readFileSync } from "node:fs";
import { detectMissingBackoff } from "./detectors/missing-backoff.js";
import { detectUnboundedLoop } from "./detectors/unbounded-loop.js";
import { detectTokenLeakage } from "./detectors/token-leakage.js";
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

export function scanProject(targetDir: string, glob = "**/*.{ts,tsx,js,jsx}"): ScanResult {
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
    findings.push(...detectMissingBackoff(sourceFile));
    findings.push(...detectUnboundedLoop(sourceFile));
    findings.push(...detectTokenLeakage(sourceFile));
  }

  return { filesScanned: sourceFiles.length, findings };
}
