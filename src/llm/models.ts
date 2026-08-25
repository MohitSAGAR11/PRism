import { OPENROUTER_BASE_URL } from "./client.js";

/**
 * Model metadata from OpenRouter's catalogue. Only `context_length` really
 * matters here: it lets the token budget adapt automatically when the
 * configured model changes, instead of hardcoding a window per model.
 */
export interface ModelInfo {
  id: string;
  contextLength: number;
  supportsStructuredOutputs: boolean;
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
        next.set(m.id, {
          id: m.id,
          contextLength: m.context_length ?? DEFAULT_CONTEXT_LENGTH,
          supportsStructuredOutputs: (m.supported_parameters ?? []).includes(
            "structured_outputs",
          ),
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
    }
  );
}

/** Test seam: drop the memoized catalogue. */
export function resetCatalogue(): void {
  catalogue = null;
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
