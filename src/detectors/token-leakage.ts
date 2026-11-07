import { Node, SourceFile, SyntaxKind } from "ts-morph";
import { findLlmCalls, extractSystemPromptText } from "../llm-call.js";
import { countTokens } from "../tokenize.js";
import { estimateExposure } from "../estimate.js";
import { DEFAULT_CONFIG, ValtaConfig } from "../config.js";
import { Finding } from "../types.js";

const TOKEN_THRESHOLD = 300;

const LOOP_KINDS = new Set([
  SyntaxKind.WhileStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ForInStatement,
]);

const LOOP_CALLBACK_METHODS = new Set(["map", "forEach", "filter", "reduce", "flatMap"]);

function enclosingLoop(node: Node): Node | undefined {
  return node.getFirstAncestor((a) => LOOP_KINDS.has(a.getKind()));
}

function isInsideLoop(node: Node): boolean {
  if (enclosingLoop(node)) return true;

  const callbackAncestor = node.getFirstAncestor((a) => {
    if (!Node.isArrowFunction(a) && !Node.isFunctionExpression(a)) return false;
    const call = a.getParentIfKind(SyntaxKind.CallExpression);
    if (!call) return false;
    const expr = call.getExpression();
    return Node.isPropertyAccessExpression(expr) && LOOP_CALLBACK_METHODS.has(expr.getName());
  });
  return callbackAncestor !== undefined;
}

export function detectTokenLeakage(sourceFile: SourceFile, config: ValtaConfig = DEFAULT_CONFIG): Finding[] {
  const findings: Finding[] = [];
  const file = sourceFile.getFilePath();

  for (const call of findLlmCalls(sourceFile)) {
    const systemText = extractSystemPromptText(call);
    if (!systemText) continue;

    const tokenCount = countTokens(systemText);
    if (tokenCount < TOKEN_THRESHOLD) continue;
    if (!isInsideLoop(call)) continue;

    // Only the input side is driven by the leaked prompt itself here —
    // this finding is about redundant input tokens sent every iteration,
    // not about generation cost, so output is left at a small fixed
    // estimate rather than compounding two different assumptions.
    const estimate = estimateExposure({
      call,
      scope: enclosingLoop(call) ?? call,
      config,
      approxTokensPerCall: tokenCount,
      measuredInputTokens: tokenCount,
      outputTokens: 100,
      measuredNote: `Token count is a real, exact measurement of the literal prompt text (cl100k-based; approximate for non-OpenAI models)`,
    });

    findings.push({
      severity: "WARN",
      detectorId: "token-leakage",
      title: `Large static system prompt (${tokenCount} tokens) resent on every loop iteration`,
      file,
      line: call.getStartLineNumber(),
      detail: `This system prompt is a static string but is declared inside a loop, so its ${tokenCount} tokens are billed again on every iteration instead of being computed once. Hoisting it to a module-level constant (or using prompt caching, if the provider supports it) removes this cost entirely.`,
      maxExposurePerHour: estimate.maxExposurePerHour,
      assumptionNote: estimate.assumptionNote,
      ...(estimate.warnings.length > 0 ? { warnings: estimate.warnings } : {}),
    });
  }

  return findings;
}
