import { OPENROUTER_BASE_URL } from "./client.js";

/**
 * Model metadata from OpenRouter's catalogue.
 *
 * `contextLength` lets the token budget adapt automatically when the configured
 * model changes, instead of hardcoding a window per model. `supportedParameters`
 * is what keeps a request off endpoints that would reject it: support for
 * structured output and for reasoning effort is per *endpoint*, not per model,
 * so the only way to know is to ask the catalogue.
 */
export interface ModelInfo {
  id: string;
  contextLength: number;
  supportsStructuredOutputs: boolean;
  /** Raw `supported_parameters` from the catalogue. Empty means "not found". */
  supportedParameters: string[];
}

const DEFAULT_CONTEXT_LENGTH = 128_000;

let catalogue: Map<string, ModelInfo> | null = null;

interface RawModel {
  id: string;
  context_length?: number;
  supported_parameters?: string[];
}

export async function loadCatalogue(apiKey: string): Promise<Map<string, ModelInfo>> {
  if (catalogue) return catalogue;

  const next = new Map<string, ModelInfo>();
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: RawModel[] };
      for (const m of body.data ?? []) {
        const params = m.supported_parameters ?? [];
        next.set(m.id, {
          id: m.id,
          contextLength: m.context_length ?? DEFAULT_CONTEXT_LENGTH,
          supportsStructuredOutputs: params.includes("structured_outputs"),
          supportedParameters: params,
        });
      }
    }
  } catch {
    // A catalogue miss is not fatal -- fall back to conservative defaults.
  }

  catalogue = next;
  return next;
}

export async function getModelInfo(apiKey: string, modelId: string): Promise<ModelInfo> {
  const all = await loadCatalogue(apiKey);
  return (
    all.get(modelId) ?? {
      id: modelId,
      contextLength: DEFAULT_CONTEXT_LENGTH,
      supportsStructuredOutputs: true,
      // Empty means the lookup failed, not that the model supports nothing.
      supportedParameters: [],
    }
  );
}

/** Test seam: drop the memoized catalogue. */
export function resetCatalogue(): void {
  catalogue = null;
}

/**
 * How to ask this endpoint for JSON.
 *
 * `json_schema` is the strongest: the schema travels in the request and the
 * provider enforces it. `json_object` only promises valid JSON, so the schema
 * has to travel in the prompt. `prompt_only` promises nothing at all.
 *
 * Going through OpenRouter means none of this can be assumed -- the same model
 * can honour `response_format` on one provider and ignore it on another, and
 * asking for a parameter the endpoint does not list (alongside
 * `require_parameters`) means the request does not route at all rather than
 * degrading gracefully. Every mode below is still re-validated with zod by the
 * caller, which is the only universal guarantee.
 */
export type OutputMode = "json_schema" | "json_object" | "prompt_only";

/**
 * An empty parameter list means the model was not in the catalogue, not that it
 * supports nothing -- assume the strongest mode rather than degrading a model we
 * merely failed to look up.
 */
function unknown(info: ModelInfo): boolean {
  return info.supportedParameters.length === 0;
}

export function outputModeFor(info: ModelInfo): OutputMode {
  if (unknown(info)) return "json_schema";
  if (info.supportedParameters.includes("structured_outputs")) return "json_schema";
  if (info.supportedParameters.includes("response_format")) return "json_object";
  return "prompt_only";
}

/**
 * Whether `reasoning: { effort }` is safe to send. Some models expose
 * `reasoning` but not `reasoning_effort`; sending the effort knob to those
 * costs the whole request.
 */
export function supportsReasoningEffort(info: ModelInfo): boolean {
  return unknown(info) || info.supportedParameters.includes("reasoning_effort");
}

/**
 * Providers that cache automatically versus those that need explicit
 * `cache_control` breakpoints. Getting this wrong is harmless in one direction
 * (a redundant breakpoint) and merely wasteful in the other (no cache hit), so
 * the check is a prefix match on the OpenRouter model slug.
 */
const EXPLICIT_CACHE_PREFIXES = ["anthropic/", "qwen/", "google/gemini-pro", "google/gemma"];

export function needsExplicitCacheControl(modelId: string): boolean {
  // Gemini 2.5 caches implicitly; older/standard Gemini does not.
  if (modelId.startsWith("google/gemini-2.5")) return false;
  return EXPLICIT_CACHE_PREFIXES.some((p) => modelId.startsWith(p));
}
