#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { scanProject } from "./scanner.js";
import { printReport } from "./report.js";

const program = new Command();

program
  .name("valta-leak")
  .description(
    "Static analysis for deterministic LLM-agent cost-exposure bugs: unbounded retry " +
      "loops, unbounded while(true) agents, and leaked system prompts. Every dollar " +
      "figure is a worst-case ceiling computed from real, dated model pricing plus " +
      "labeled assumptions — never a claimed historical loss."
  )
  .argument("[dir]", "Directory to scan", ".")
  .option("--json", "Output findings as JSON instead of a formatted report")
  .action((dir: string, opts: { json?: boolean }) => {
    const targetDir = path.resolve(process.cwd(), dir);
    const result = scanProject(targetDir);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    printReport(result, process.cwd());

    const hasFail = result.findings.some((f) => f.severity === "FAIL");
    process.exitCode = hasFail ? 1 : 0;
  });

program.parse();
