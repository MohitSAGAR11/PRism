import OpenAI from "openai";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function createClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    // OpenRouter uses these purely for app attribution on its rankings page.
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/ai-pr-reviewer",
      "X-OpenRouter-Title": "AI PR Reviewer",
    },
    maxRetries: 3,
    timeout: 180_000,
  });
}

/** Token/cost accounting as OpenRouter reports it. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** USD, straight from OpenRouter -- no local price table to keep in sync. */
  cost: number;
}

export const ZERO_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cost: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cost: a.cost + b.cost,
  };
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

export function readUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as RawUsage;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    cost: u.cost ?? 0,
  };
}

export function formatUsage(u: Usage): string {
  const cached = u.cachedTokens > 0 ? ` (${u.cachedTokens.toLocaleString()} cached)` : "";
  return (
    `${u.promptTokens.toLocaleString()} in${cached} / ` +
    `${u.completionTokens.toLocaleString()} out / $${u.cost.toFixed(4)}`
  );
}
