import { getEncoding } from "js-tiktoken";

/**
 * Token estimation.
 *
 * OpenRouter has no count-tokens endpoint and routes across many tokenizers,
 * so every number here is an estimate: cl100k is close for OpenAI models and
 * within roughly 10-20% for Claude and Gemini. Callers therefore budget with a
 * headroom margin rather than filling the window to the limit.
 */

type Encoder = { encode(text: string): unknown[] };

let encoder: Encoder | null | undefined;

function getEncoder(): Encoder | null {
  if (encoder !== undefined) return encoder;
  try {
    encoder = getEncoding("cl100k_base");
  } catch {
    encoder = null;
  }
  return encoder;
}

/** Fallback when the tokenizer will not load: roughly 3.5 chars per token. */
function heuristic(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function estimateTokens(text: string): number {
  const enc = getEncoder();
  if (!enc) return heuristic(text);
  try {
    return enc.encode(text).length;
  } catch {
    return heuristic(text);
  }
}

/** Held back to absorb tokenizer mismatch across providers. */
export const HEADROOM = 0.85;

/** Share of the context window we are willing to fill with input. */
export const INPUT_SHARE = 0.6;

export function inputBudget(contextLength: number): number {
  return Math.floor(contextLength * INPUT_SHARE * HEADROOM);
}
