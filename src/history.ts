import { Node, CallExpression, SyntaxKind } from "ts-morph";

/** Property names that carry the conversation history in the common SDK shapes. */
const HISTORY_KEYS = ["messages", "input", "contents"];

function historyExpressions(call: CallExpression): Set<string> {
  const names = new Set<string>();
  const arg = call.getArguments()[0];
  if (!arg || !Node.isObjectLiteralExpression(arg)) return names;

  for (const key of HISTORY_KEYS) {
    const prop = arg.getProperty(key);
    if (!prop) continue;

    let value: Node | undefined;
    if (Node.isPropertyAssignment(prop)) value = prop.getInitializer();
    else if (Node.isShorthandPropertyAssignment(prop)) value = prop.getNameNode();
    if (!value) continue;

    if (Node.isIdentifier(value) || Node.isPropertyAccessExpression(value)) {
      names.add(value.getText()); // messages: history, messages: this.history
    } else if (Node.isArrayLiteralExpression(value)) {
      // messages: [...history, extra] — the spread source is the growing array.
      for (const el of value.getElements()) {
        if (Node.isSpreadElement(el)) names.add(el.getExpression().getText());
      }
    }
  }
  return names;
}

/**
 * True when `loopBody` appends to an array that is also sent whole as the
 * message history of an LLM call inside the same loop, e.g.
 *
 *   while (true) {
 *     const res = await client.messages.create({ messages: history, ... });
 *     history.push({ role: "assistant", content: res.content });
 *   }
 *
 * In that shape iteration i re-sends everything appended in iterations
 * 1..i-1, so input tokens grow linearly per call and the total cost grows
 * quadratically. Recognizes `.push(...)` and the immutable forms
 * `h = [...h, x]` and `h = h.concat(x)`.
 */
export function appendsToSentHistory(loopBody: Node, llmCalls: CallExpression[]): boolean {
  const names = new Set<string>();
  for (const call of llmCalls) {
    for (const n of historyExpressions(call)) names.add(n);
  }
  if (names.size === 0) return false;

  for (const call of loopBody.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (
      Node.isPropertyAccessExpression(expr) &&
      expr.getName() === "push" &&
      names.has(expr.getExpression().getText())
    ) {
      return true;
    }
  }

  for (const bin of loopBody.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    const left = bin.getLeft().getText();
    if (!names.has(left)) continue;
    const right = bin.getRight().getText();
    if (right.includes(`...${left}`) || right.includes(`${left}.concat(`)) return true;
  }

  return false;
}
