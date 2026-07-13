import { Node, SourceFile, SyntaxKind } from "ts-morph";
import { findLlmCalls, extractSystemPromptText, extractModelString } from "../llm-call.js";
import { countTokens } from "../tokenize.js";
import { resolveModelPricing, computeHourlyExposure, PRICING_SNAPSHOT_DATE } from "../pricing.js";
import { Finding } from "../types.js";

const TOKEN_THRESHOLD = 300;

const LOOP_KINDS = new Set([
  SyntaxKind.WhileStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ForInStatement,
]);

const LOOP_CALLBACK_METHODS = new Set(["map", "forEach", "filter", "reduce", "flatMap"]);

function isInsideLoop(node: Node): boolean {
  const loopAncestor = node.getFirstAncestor((a) => LOOP_KINDS.has(a.getKind()));
  if (loopAncestor) return true;

  const callbackAncestor = node.getFirstAncestor((a) => {
    if (!Node.isArrowFunction(a) && !Node.isFunctionExpression(a)) return false;
    const call = a.getParentIfKind(SyntaxKind.CallExpression);
    if (!call) return false;
    const expr = call.getExpression();
    return Node.isPropertyAccessExpression(expr) && LOOP_CALLBACK_METHODS.has(expr.getName());
  });
  return callbackAncestor !== undefined;
}

export function detectTokenLeakage(sourceFile: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const file = sourceFile.getFilePath();

  for (const call of findLlmCalls(sourceFile)) {
    const systemText = extractSystemPromptText(call);
    if (!systemText) continue;

    const tokenCount = countTokens(systemText);
    if (tokenCount < TOKEN_THRESHOLD) continue;
    if (!isInsideLoop(call)) continue;

    const modelString = extractModelString(call);
    const { pricing, matched } = resolveModelPricing(modelString ?? "");
    // Only the input side is driven by the leaked prompt itself here —
    // this finding is about redundant input tokens sent every iteration,
    // not about generation cost, so output is left at a small fixed
    // estimate rather than compounding two different assumptions.
    const maxExposurePerHour = computeHourlyExposure({
      inputTokens: tokenCount,
      outputTokens: 100,
      pricing,
    });

    findings.push({
      severity: "WARN",
      detectorId: "token-leakage",
      title: `Large static system prompt (${tokenCount} tokens) resent on every loop iteration`,
      file,
      line: call.getStartLineNumber(),
      detail: `This system prompt is a static string but is declared inside a loop, so its ${tokenCount} tokens are billed again on every iteration instead of being computed once. Hoisting it to a module-level constant (or using prompt caching, if the provider supports it) removes this cost entirely.`,
      maxExposurePerHour,
      assumptionNote: `Token count is a real, exact measurement of the literal prompt text (cl100k-based; approximate for non-OpenAI models). Assumes ${pricing.assumedLatencySeconds}s latency between iterations${matched ? "" : " and a mid-range fallback price since the model string wasn't recognized"}. Pricing snapshot: ${PRICING_SNAPSHOT_DATE}.`,
    });
  }

  return findings;
}
