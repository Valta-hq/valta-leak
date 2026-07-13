import { Node, CallExpression, SyntaxKind } from "ts-morph";

/**
 * Matches the common LLM SDK call shapes so all three detectors share one
 * definition of "this is an LLM call" instead of drifting apart.
 *   - anthropic.messages.create(...)
 *   - openai.chat.completions.create(...)
 *   - <anything>.messages.create(...) / <anything>.chat.completions.create(...)
 * Matching on the trailing property chain rather than the receiver name
 * means it still works when the client is aliased (e.g. `client`, `anthropic`, `ai`).
 */
const LLM_CALL_SUFFIXES = [".messages.create", ".chat.completions.create", ".completions.create"];

export function isLlmSdkCall(node: Node): node is CallExpression {
  if (!Node.isCallExpression(node)) return false;
  const expr = node.getExpression();
  const text = expr.getText();
  return LLM_CALL_SUFFIXES.some((suffix) => text.endsWith(suffix));
}

export function findLlmCalls(root: Node): CallExpression[] {
  return root
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call): call is CallExpression => isLlmSdkCall(call));
}

/** Extracts the model string literal from an LLM call's options object, if present. */
export function extractModelString(call: CallExpression): string | null {
  const arg = call.getArguments()[0];
  if (!arg || !Node.isObjectLiteralExpression(arg)) return null;
  const prop = arg.getProperty("model");
  if (!prop || !Node.isPropertyAssignment(prop)) return null;
  const init = prop.getInitializer();
  if (!init || !Node.isStringLiteral(init)) return null;
  return init.getLiteralText();
}

/**
 * Resolves a static string expression to its literal text, if every part
 * of it is statically known. Handles plain literals directly, and `+`
 * concatenation chains recursively — real prompts are very often built as
 * "a" + "b" + "c" across multiple lines rather than one literal, and
 * treating only the single-literal case as "static" would miss most of them.
 * Returns null the moment any part isn't a literal (e.g. a variable or
 * template-literal interpolation), since at that point the real text isn't
 * knowable without executing the code.
 */
function resolveStaticStringText(node: Node): string | null {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  if (Node.isParenthesizedExpression(node)) {
    return resolveStaticStringText(node.getExpression());
  }
  if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    const left = resolveStaticStringText(node.getLeft());
    const right = resolveStaticStringText(node.getRight());
    if (left === null || right === null) return null;
    return left + right;
  }
  return null;
}

/** Extracts a static "system" prompt field's real text, if present and fully static. */
export function extractSystemPromptText(call: CallExpression): string | null {
  const arg = call.getArguments()[0];
  if (!arg || !Node.isObjectLiteralExpression(arg)) return null;
  const prop = arg.getProperty("system");
  if (!prop || !Node.isPropertyAssignment(prop)) return null;
  const init = prop.getInitializer();
  if (!init) return null;
  return resolveStaticStringText(init);
}
