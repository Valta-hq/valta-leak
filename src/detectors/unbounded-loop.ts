import { Node, SourceFile, SyntaxKind, WhileStatement, ForStatement } from "ts-morph";
import { findLlmCalls, extractModelString } from "../llm-call.js";
import { resolveModelPricing, computeHourlyExposure, PRICING_SNAPSHOT_DATE } from "../pricing.js";
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
  llmCallText: string,
  approxTokensPerCall: number
): Finding {
  // Reuse the first matched call's model string if we can find one in a
  // fresh parse isn't available here, so this stays a labeled estimate
  // when a model string can't be pulled from the loop body directly.
  const modelMatch = /model\s*:\s*["'`]([\w.-]+)["'`]/.exec(llmCallText);
  const { pricing, matched } = resolveModelPricing(modelMatch?.[1] ?? "");
  const inputTokens = approxTokensPerCall;
  const outputTokens = Math.round(approxTokensPerCall * 0.3);
  const maxExposurePerHour = computeHourlyExposure({ inputTokens, outputTokens, pricing });

  return {
    severity: "FAIL",
    detectorId: "unbounded-loop",
    title,
    file,
    line,
    detail,
    maxExposurePerHour,
    assumptionNote: `Assumes ~${inputTokens} input / ${outputTokens} output tokens per call and ${pricing.assumedLatencySeconds}s latency${matched ? "" : " (model string not found in loop body — using a mid-range fallback price, verify manually)"}. Pricing snapshot: ${PRICING_SNAPSHOT_DATE}.`,
  };
}

export function detectUnboundedLoop(sourceFile: SourceFile, approxTokensPerCall = 500): Finding[] {
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
        bodyText,
        approxTokensPerCall
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
        bodyText,
        approxTokensPerCall
      )
    );
  }

  return findings;
}
