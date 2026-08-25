import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRequestShape, schemaInstruction } from "../src/llm/complete.js";
import {
  getModelInfo,
  needsExplicitCacheControl,
  outputModeFor,
  resetCatalogue,
  supportsReasoningEffort,
  type ModelInfo,
} from "../src/llm/models.js";
import { addUsage, formatUsage, readUsage, ZERO_USAGE } from "../src/llm/client.js";
import { estimateTokens, inputBudget } from "../src/util/tokens.js";

/**
 * The exact `supported_parameters` OpenRouter reports for the two configured
 * models. Read from GET /api/v1/models, not invented -- the whole point of this
 * file is that a capability guess is what breaks routing.
 */
const OX_ALPHA_PARAMS = [
  "include_reasoning",
  "max_tokens",
  "reasoning",
  "reasoning_effort",
  "response_format",
  "temperature",
  "tool_choice",
  "tools",
  "top_k",
  "top_p",
];
const LAGUNA_PARAMS = [
  "include_reasoning",
  "max_tokens",
  "reasoning",
  "temperature",
  "tool_choice",
  "tools",
];

interface RawModel {
  id: string;
  context_length?: number;
  supported_parameters?: string[];
}

function seedCatalogue(models: RawModel[]): void {
  resetCatalogue();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ data: models }) })),
  );
}

function info(supportedParameters: string[]): ModelInfo {
  return {
    id: "x",
    contextLength: 128_000,
    supportsStructuredOutputs: supportedParameters.includes("structured_outputs"),
    supportedParameters,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCatalogue();
});

describe("outputModeFor", () => {
  it("uses json_schema when the endpoint advertises structured outputs", () => {
    expect(outputModeFor(info(["response_format", "structured_outputs"]))).toBe("json_schema");
  });

  it("falls back to json_object when only response_format is supported", () => {
    // stealth/ox-alpha: has response_format, does NOT have structured_outputs.
    expect(outputModeFor(info(OX_ALPHA_PARAMS))).toBe("json_object");
  });

  it("asks for nothing when the endpoint has no response_format at all", () => {
    // poolside/laguna-s-2.1:free. Requesting response_format here alongside
    // require_parameters would leave the request with nowhere to route.
    expect(outputModeFor(info(LAGUNA_PARAMS))).toBe("prompt_only");
  });

  it("assumes the strongest mode for a model missing from the catalogue", () => {
    // An empty list means the lookup failed, not that the model supports
    // nothing -- degrading an unknown model would be the wrong default.
    expect(outputModeFor(info([]))).toBe("json_schema");
  });
});

describe("supportsReasoningEffort", () => {
  it("is true when reasoning_effort is listed", () => {
    expect(supportsReasoningEffort(info(OX_ALPHA_PARAMS))).toBe(true);
  });

  it("is false for a model exposing reasoning but not reasoning_effort", () => {
    expect(LAGUNA_PARAMS).toContain("reasoning");
    expect(supportsReasoningEffort(info(LAGUNA_PARAMS))).toBe(false);
  });

  it("is true for an unknown model", () => {
    expect(supportsReasoningEffort(info([]))).toBe(true);
  });
});

describe("resolveRequestShape", () => {
  it("shapes the request from what the configured model actually accepts", async () => {
    seedCatalogue([
      { id: "stealth/ox-alpha", context_length: 1_048_576, supported_parameters: OX_ALPHA_PARAMS },
    ]);
    expect(await resolveRequestShape("k", "stealth/ox-alpha")).toEqual({
      mode: "json_object",
      sendReasoningEffort: true,
    });
  });

  it("drops the effort knob for a model that cannot take it", async () => {
    seedCatalogue([
      {
        id: "poolside/laguna-s-2.1:free",
        context_length: 262_144,
        supported_parameters: LAGUNA_PARAMS,
      },
    ]);
    expect(await resolveRequestShape("k", "poolside/laguna-s-2.1:free")).toEqual({
      mode: "prompt_only",
      sendReasoningEffort: false,
    });
  });

  it("takes the weakest mode across the fallback array, not just the primary", async () => {
    // require_parameters restricts routing to endpoints supporting every
    // requested parameter, so asking for more than the fallback can honour does
    // not degrade the fallback -- it removes it, and the failover is lost.
    seedCatalogue([
      {
        id: "good/strict",
        supported_parameters: ["response_format", "structured_outputs", "reasoning_effort"],
      },
      { id: "poolside/laguna-s-2.1:free", supported_parameters: LAGUNA_PARAMS },
    ]);
    expect(await resolveRequestShape("k", "good/strict", ["poolside/laguna-s-2.1:free"])).toEqual({
      mode: "prompt_only",
      sendReasoningEffort: false,
    });
  });

  it("keeps json_schema when every candidate supports it", async () => {
    seedCatalogue([
      { id: "a/one", supported_parameters: ["structured_outputs", "reasoning_effort"] },
      { id: "b/two", supported_parameters: ["structured_outputs", "reasoning_effort"] },
    ]);
    expect(await resolveRequestShape("k", "a/one", ["b/two"])).toEqual({
      mode: "json_schema",
      sendReasoningEffort: true,
    });
  });
});

describe("getModelInfo", () => {
  it("reads the real context length so the budget follows the model", async () => {
    seedCatalogue([{ id: "stealth/ox-alpha", context_length: 1_048_576 }]);
    const found = await getModelInfo("k", "stealth/ox-alpha");
    expect(found.contextLength).toBe(1_048_576);
  });

  it("survives a catalogue fetch failure instead of taking the review down", async () => {
    resetCatalogue();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const found = await getModelInfo("k", "anything/at-all");
    expect(found.contextLength).toBe(128_000);
    expect(found.supportedParameters).toEqual([]);
  });
});

describe("schemaInstruction", () => {
  it("carries the schema and forbids prose", () => {
    const text = schemaInstruction("verdict", {
      type: "object",
      properties: { refuted: { type: "boolean" } },
    });
    expect(text).toContain("verdict");
    expect(text).toContain("refuted");
    expect(text).toContain("No prose");
  });
});

describe("needsExplicitCacheControl", () => {
  it("is true for providers that only cache marked prefixes", () => {
    expect(needsExplicitCacheControl("anthropic/claude-sonnet-4.5")).toBe(true);
    expect(needsExplicitCacheControl("qwen/qwen3-max")).toBe(true);
  });

  it("is false for implicit-caching and unrelated providers", () => {
    expect(needsExplicitCacheControl("google/gemini-2.5-pro")).toBe(false);
    expect(needsExplicitCacheControl("stealth/ox-alpha")).toBe(false);
    expect(needsExplicitCacheControl("poolside/laguna-s-2.1:free")).toBe(false);
  });
});

describe("usage accounting", () => {
  it("reads all-zero usage from an empty response", () => {
    expect(readUsage({})).toEqual(ZERO_USAGE);
  });

  it("picks up cached prompt tokens", () => {
    const u = readUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      cost: 0.0123,
      prompt_tokens_details: { cached_tokens: 900 },
    });
    expect(u.cachedTokens).toBe(900);
    expect(u.cost).toBeCloseTo(0.0123);
    expect(formatUsage(u)).toContain("900 cached");
  });

  it("sums field-wise", () => {
    const a = readUsage({ prompt_tokens: 10, completion_tokens: 1, cost: 0.5 });
    expect(addUsage(a, a).promptTokens).toBe(20);
    expect(addUsage(a, a).cost).toBeCloseTo(1);
  });
});

describe("token budget", () => {
  it("estimates a short string in a plausible range", () => {
    expect(estimateTokens("hello world")).toBeGreaterThanOrEqual(2);
    expect(estimateTokens("hello world")).toBeLessThanOrEqual(4);
  });

  it("keeps headroom under the context window", () => {
    expect(inputBudget(100_000)).toBe(51_000);
    expect(inputBudget(1_048_576)).toBeLessThan(1_048_576);
  });
});
