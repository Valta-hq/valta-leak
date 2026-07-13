import { Node, SourceFile, SyntaxKind, Block } from "ts-morph";
import { findLlmCalls, extractModelString } from "../llm-call.js";
import { resolveModelPricing, computeHourlyExposure, PRICING_SNAPSHOT_DATE } from "../pricing.js";
import { Finding } from "../types.js";

const BACKOFF_PATTERN = /setTimeout|sleep\s*\(|delay\s*\(|backoff/i;

/**
 * Strips comments before matching BACKOFF_PATTERN against them — a comment
 * that merely *mentions* "backoff" (e.g. documenting that a case is
 * missing it) would otherwise register as a false negative, since a plain
 * substring match can't tell "the word backoff appears" from "backoff
 * logic is actually here." Good enough for a heuristic; doesn't need to
 * handle every string-literal edge case perfectly.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The nearest enclosing function-like node, whatever shape it takes. */
function findEnclosingFunction(node: Node): Node | null {
  return (
    node.getFirstAncestor(
      (a) =>
        Node.isFunctionDeclaration(a) ||
        Node.isMethodDeclaration(a) ||
        (Node.isVariableDeclaration(a) &&
          (Node.isArrowFunction(a.getInitializer()) || Node.isFunctionExpression(a.getInitializer())))
    ) ?? null
  );
}

function enclosingFunctionName(fn: Node | null): string | null {
  if (!fn) return null;
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getName() ?? null;
  if (Node.isVariableDeclaration(fn)) return fn.getName();
  return null;
}

/** The actual body to scan for an LLM call — the function body for a
 *  VariableDeclaration wrapping an arrow/function expression, or the node
 *  itself otherwise. */
function functionBodyNode(fn: Node): Node {
  if (Node.isVariableDeclaration(fn)) {
    const init = fn.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init.getBody();
    }
  }
  return fn;
}

function pushFinding(
  findings: Finding[],
  file: string,
  line: number,
  severity: "FAIL" | "WARN",
  title: string,
  detail: string,
  llmCall: ReturnType<typeof findLlmCalls>[number] | null,
  approxTokensPerCall: number
): void {
  if (severity === "WARN") {
    findings.push({ severity, detectorId: "missing-backoff", title, file, line, detail });
    return;
  }
  const modelString = llmCall ? extractModelString(llmCall) : null;
  const { pricing, matched } = resolveModelPricing(modelString ?? "");
  const inputTokens = approxTokensPerCall;
  const outputTokens = Math.round(approxTokensPerCall * 0.3);
  const maxExposurePerHour = computeHourlyExposure({ inputTokens, outputTokens, pricing });
  findings.push({
    severity,
    detectorId: "missing-backoff",
    title,
    file,
    line,
    detail,
    maxExposurePerHour,
    assumptionNote: `Assumes ~${inputTokens} input / ${outputTokens} output tokens per call and ${pricing.assumedLatencySeconds}s latency${matched ? "" : " (model string not recognized — using a mid-range fallback price, verify manually)"}. Pricing snapshot: ${PRICING_SNAPSHOT_DATE}.`,
  });
}

function checkCatchBody(body: Node, file: string, findings: Finding[], approxTokensPerCall: number): void {
  const bodyText = stripComments(body.getText());
  if (BACKOFF_PATTERN.test(bodyText)) return;

  const enclosingFn = findEnclosingFunction(body);
  const enclosingName = enclosingFunctionName(enclosingFn);

  // True self-recursive retry: the catch calls the enclosing function by
  // name again, and that function (somewhere in its body, not necessarily
  // inside this catch) makes the LLM call being retried.
  const isSelfRecursive = enclosingName !== null && bodyText.includes(`${enclosingName}(`);
  if (isSelfRecursive && enclosingFn) {
    const llmCallsInFn = findLlmCalls(functionBodyNode(enclosingFn));
    if (llmCallsInFn.length > 0) {
      pushFinding(
        findings,
        file,
        body.getStartLineNumber(),
        "FAIL",
        "Unbounded recursive retry loop calling an LLM SDK method",
        `If the API call fails, "${enclosingName}" retries itself immediately with no exponential backoff or sleep interval, and no attempt limit — this will fire continuously on any transient error.`,
        llmCallsInFn[0],
        approxTokensPerCall
      );
      return;
    }
  }

  // Inline immediate retry: the catch itself makes another LLM call
  // directly, with no backoff, but doesn't recurse into the enclosing
  // function — still worth flagging, just less severe since it can't
  // spiral past a single extra attempt on its own.
  const llmCallsInCatch = findLlmCalls(body);
  if (llmCallsInCatch.length > 0) {
    pushFinding(
      findings,
      file,
      body.getStartLineNumber(),
      "WARN",
      "Retry on LLM API failure with no backoff",
      `This catch block retries the API call with no exponential backoff or sleep — safe for a single retry, but risky if this is ever called in a loop or from a caller that retries too.`,
      null,
      approxTokensPerCall
    );
  }
}

export function detectMissingBackoff(sourceFile: SourceFile, approxTokensPerCall = 500): Finding[] {
  const findings: Finding[] = [];
  const file = sourceFile.getFilePath();

  for (const catchClause of sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause)) {
    checkCatchBody(catchClause.getBlock(), file, findings, approxTokensPerCall);
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== "catch") continue;
    const handler = call.getArguments()[0];
    if (!handler) continue;
    if (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler)) {
      const body = handler.getBody();
      checkCatchBody(body, file, findings, approxTokensPerCall);
    }
  }

  return findings;
}
