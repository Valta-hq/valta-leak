import {
  Node,
  CallExpression,
  Identifier,
  SyntaxKind,
  VariableDeclarationKind,
} from "ts-morph";

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

/**
 * Follows an identifier to the initializer of a same-file `const` declaration,
 * so `const MODEL = "claude-sonnet-4-6"; ... model: MODEL` counts as static.
 * Returns undefined for anything that isn't a plain const with an initializer
 * (let/var, parameters, imports, env lookups), since those aren't knowable
 * without running the code.
 */
export function resolveConstInitializer(id: Identifier): Node | undefined {
  try {
    const decl = id.getSymbol()?.getValueDeclaration();
    if (!decl || !Node.isVariableDeclaration(decl)) return undefined;
    const list = decl.getParent();
    if (!Node.isVariableDeclarationList(list)) return undefined;
    if (list.getDeclarationKind() !== VariableDeclarationKind.Const) return undefined;
    return decl.getInitializer();
  } catch {
    return undefined;
  }
}

function resolveStaticModel(node: Node, depth = 0): string | null {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node)) {
    return resolveStaticModel(node.getExpression(), depth);
  }
  if (Node.isIdentifier(node) && depth < 3) {
    const init = resolveConstInitializer(node);
    return init ? resolveStaticModel(init, depth + 1) : null;
  }
  return null;
}

function resolveStaticNumber(node: Node, depth = 0): number | null {
  if (Node.isNumericLiteral(node)) return node.getLiteralValue();
  if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node)) {
    return resolveStaticNumber(node.getExpression(), depth);
  }
  if (Node.isIdentifier(node) && depth < 3) {
    const init = resolveConstInitializer(node);
    return init ? resolveStaticNumber(init, depth + 1) : null;
  }
  return null;
}

/** A value in an LLM call that can't be read from the source text. */
export interface DynamicRef {
  property: "model" | "max_tokens" | "options";
  /** 1-based line of the expression that couldn't be resolved. */
  line: number;
  text: string;
}

export interface CallParams {
  /** Resolved model name, or null when absent or dynamic. */
  model: string | null;
  /** Everything about the call that can't be resolved statically. */
  dynamic: DynamicRef[];
}

const MAX_TOKEN_KEYS = ["max_tokens", "max_completion_tokens", "maxTokens"];

/**
 * Reads the model and token-limit parameters from an LLM call's options
 * object and reports which of them are dynamic (variables, env lookups,
 * function results, spread objects, a non-literal options argument).
 * A property that is simply missing is NOT dynamic — it is just absent.
 */
export function extractCallParams(call: CallExpression): CallParams {
  const dynamic: DynamicRef[] = [];
  const arg = call.getArguments()[0];
  if (!arg) return { model: null, dynamic };

  // Unwrap `{...} as X` and parentheses so a typed literal is still read.
  let target: Node = arg;
  while (Node.isAsExpression(target) || Node.isParenthesizedExpression(target)) {
    target = target.getExpression();
  }

  if (!Node.isObjectLiteralExpression(target)) {
    dynamic.push({ property: "options", line: arg.getStartLineNumber(), text: arg.getText() });
    return { model: null, dynamic };
  }

  let model: string | null = null;

  const modelProp = target.getProperty("model");
  if (modelProp && Node.isPropertyAssignment(modelProp)) {
    const init = modelProp.getInitializer();
    if (init) {
      model = resolveStaticModel(init);
      if (model === null) {
        dynamic.push({ property: "model", line: init.getStartLineNumber(), text: init.getText() });
      }
    }
  } else if (modelProp && Node.isShorthandPropertyAssignment(modelProp)) {
    const id = modelProp.getNameNode();
    model = resolveStaticModel(id);
    if (model === null) {
      dynamic.push({ property: "model", line: id.getStartLineNumber(), text: id.getText() });
    }
  } else if (!modelProp) {
    const spread = target.getProperties().find((p) => Node.isSpreadAssignment(p));
    if (spread) {
      dynamic.push({ property: "options", line: spread.getStartLineNumber(), text: spread.getText() });
    }
  }

  for (const key of MAX_TOKEN_KEYS) {
    const prop = target.getProperty(key);
    if (!prop) continue;
    let valueNode: Node | undefined;
    if (Node.isPropertyAssignment(prop)) valueNode = prop.getInitializer();
    else if (Node.isShorthandPropertyAssignment(prop)) valueNode = prop.getNameNode();
    if (valueNode && resolveStaticNumber(valueNode) === null) {
      dynamic.push({ property: "max_tokens", line: valueNode.getStartLineNumber(), text: valueNode.getText() });
    }
  }

  return { model, dynamic };
}

/** Extracts the model string from an LLM call's options object, if it is statically known. */
export function extractModelString(call: CallExpression): string | null {
  return extractCallParams(call).model;
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
