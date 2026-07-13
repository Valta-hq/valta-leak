import { encode } from "gpt-tokenizer";

/**
 * Real token count for a literal string, via the cl100k_base tokenizer.
 * This is exact for OpenAI models that use cl100k_base. Anthropic hasn't
 * published an open tokenizer, so for Claude models this is a close
 * approximation, not an exact count — callers should label it as such
 * in any output shown to a user, per this tool's rule against presenting
 * assumptions as measured fact.
 */
export function countTokens(text: string): number {
  return encode(text).length;
}
