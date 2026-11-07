#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { scanProject } from "./scanner.js";
import { printReport } from "./report.js";
import { ConfigError, loadConfig } from "./config.js";

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
  .option("--config <path>", "Path to a valta.config.json (default: looked up in the scan dir, then the current dir)")
  .action((dir: string, opts: { json?: boolean; config?: string }) => {
    const targetDir = path.resolve(process.cwd(), dir);

    let loaded;
    try {
      loaded = loadConfig([targetDir, process.cwd()], opts.config);
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`[valta-leak] ${err.message}`);
        process.exitCode = 2;
        return;
      }
      throw err;
    }

    const result = scanProject(targetDir, undefined, { config: loaded.config, configPath: loaded.path });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    printReport(result, process.cwd());

    const hasFail = result.findings.some((f) => f.severity === "FAIL");
    process.exitCode = hasFail ? 1 : 0;
  });

program.parse();
