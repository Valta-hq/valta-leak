import { Node, SourceFile, SyntaxKind, WhileStatement, ForStatement } from "ts-morph";
import { findLlmCalls } from "../llm-call.js";
import { appendsToSentHistory } from "../history.js";
import { estimateExposure } from "../estimate.js";
import { DEFAULT_CONFIG, ValtaConfig } from "../config.js";
import { Finding } from "../types.js";

const BOUND_PATTERN = /\b(max\w*(steps|iterations|retries|attempts)|steps?\s*(>=?|>)\s*\d|iteration\w*\s*(>=?|>)\s*\d)\b/i;
const ABORT_PATTERN = /AbortController|AbortSignal\.timeout|signal\s*:/;

function isAlwaysTrueTest(node: Node | undefined): boolean {
  if (!node) return true; // for(;;) has no test at all
  if (Node.isTrueLiteral(node)) return true;
  if (Node.isNumericLiteral(node) && node.getLiteralValue() !== 0) return true;
  return false;
}

function isBounded(bodyText: string): boolean {
  return BOUND_PATTERN.test(bodyText) || ABORT_PATTERN.test(bodyText);
}

function computeFinding(
  file: string,
  line: number,
  title: string,
  detail: string,
  body: Node,
  approxTokensPerCall: number,
  config: ValtaConfig
): Finding {
  const llmCalls = findLlmCalls(body);
  const estimate = estimateExposure({
    call: llmCalls[0] ?? null,
    scope: body,
    config,
    approxTokensPerCall,
    growingHistory: appendsToSentHistory(body, llmCalls),
  });

  return {
    severity: "FAIL",
    detectorId: "unbounded-loop",
    title,
    file,
    line,
    detail,
    maxExposurePerHour: estimate.maxExposurePerHour,
    assumptionNote: estimate.assumptionNote,
    ...(estimate.warnings.length > 0 ? { warnings: estimate.warnings } : {}),
  };
}

export function detectUnboundedLoop(
  sourceFile: SourceFile,
  config: ValtaConfig = DEFAULT_CONFIG,
  approxTokensPerCall = 500
): Finding[] {
  const findings: Finding[] = [];
  const file = sourceFile.getFilePath();

  for (const stmt of sourceFile.getDescendantsOfKind(SyntaxKind.WhileStatement) as WhileStatement[]) {
    if (!isAlwaysTrueTest(stmt.getExpression())) continue;
    const body = stmt.getStatement();
    const llmCalls = findLlmCalls(body);
    if (llmCalls.length === 0) continue;
    const bodyText = body.getText();
    if (isBounded(bodyText)) continue;
    findings.push(
      computeFinding(
        file,
        stmt.getStartLineNumber(),
        "Unbounded while(true) agent loop calling an LLM SDK method",
        `This loop has no visible step/iteration limit, timeout, or AbortController — if the agent doesn't terminate the loop itself, it will call the API indefinitely.`,
        body,
        approxTokensPerCall,
        config
      )
    );
  }

  for (const stmt of sourceFile.getDescendantsOfKind(SyntaxKind.ForStatement) as ForStatement[]) {
    if (stmt.getCondition()) continue; // has a real bound expression, e.g. for (;i<10;)
    const body = stmt.getStatement();
    const llmCalls = findLlmCalls(body);
    if (llmCalls.length === 0) continue;
    const bodyText = body.getText();
    if (isBounded(bodyText)) continue;
    findings.push(
      computeFinding(
        file,
        stmt.getStartLineNumber(),
        "Unbounded for(;;) agent loop calling an LLM SDK method",
        `This loop has no condition and no visible step/iteration limit, timeout, or AbortController — if the agent doesn't terminate the loop itself, it will call the API indefinitely.`,
        body,
        approxTokensPerCall,
        config
      )
    );
  }

  return findings;
}
