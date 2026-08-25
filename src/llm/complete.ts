import type OpenAI from "openai";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readUsage, type Usage } from "./client.js";
import {
  getModelInfo,
  needsExplicitCacheControl,
  outputModeFor,
  supportsReasoningEffort,
  type OutputMode,
} from "./models.js";

export interface CompleteOptions<T extends z.ZodTypeAny> {
  client: OpenAI;
  /** Needed to read endpoint capabilities from the model catalogue. */
  apiKey: string;
  /** Primary OpenRouter model slug, e.g. "stealth/ox-alpha". */
  model: string;
  /** Tried in order if the primary is down or rate-limited. */
  fallbackModels?: string[];
  /** Stable prefix: review instructions + repo conventions. Cache-friendly. */
  system: string;
  /** Volatile payload: the diff and file bodies for this request. */
  user: string;
  schema: T;
  schemaName: string;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}

export interface CompleteResult<T> {
  value: T;
  usage: Usage;
  /** Which model actually served the request -- may be a fallback. */
  servedBy: string;
}

export class SchemaViolationError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "SchemaViolationError";
  }
}

/**
 * Some providers wrap JSON in a markdown fence even when asked for
 * `json_schema` output. Cheaper to tolerate than to fight.
 */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

type SystemContent = string | Array<Record<string, unknown>>;

function buildSystemContent(model: string, system: string): SystemContent {
  if (!needsExplicitCacheControl(model)) return system;
  // Anthropic/Qwen/standard-Gemini only cache what is explicitly marked.
  return [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }];
}

const MODE_RANK: Record<OutputMode, number> = {
  prompt_only: 0,
  json_object: 1,
  json_schema: 2,
};

export interface RequestShape {
  mode: OutputMode;
  sendReasoningEffort: boolean;
}

/**
 * Decide how to ask, across every model that could serve this request.
 *
 * `provider.require_parameters` restricts routing to endpoints supporting
 * *every* parameter in the request, so a parameter the fallback cannot honour
 * does not degrade the fallback -- it removes it. Taking the weakest mode across
 * the whole candidate list keeps the fallback array actually usable, which is
 * the entire reason it exists.
 */
export async function resolveRequestShape(
  apiKey: string,
  model: string,
  fallbackModels: string[] = [],
): Promise<RequestShape> {
  const candidates = [model, ...fallbackModels];
  const infos = await Promise.all(candidates.map((m) => getModelInfo(apiKey, m)));

  let mode: OutputMode = "json_schema";
  let sendReasoningEffort = true;
  for (const info of infos) {
    const candidateMode = outputModeFor(info);
    if (MODE_RANK[candidateMode] < MODE_RANK[mode]) mode = candidateMode;
    if (!supportsReasoningEffort(info)) sendReasoningEffort = false;
  }

  return { mode, sendReasoningEffort };
}

/**
 * The schema, for endpoints that cannot take it in the request.
 *
 * This goes in the *user* message, never the system prompt: the system prompt is
 * the cacheable prefix and has to stay byte-identical across every request in a
 * run, and the find and verify passes use different schemas.
 */
export function schemaInstruction(schemaName: string, inner: unknown): string {
  return [
    "",
    "---",
    "",
    `Reply with a single JSON object matching this JSON Schema (named "${schemaName}"):`,
    "",
    JSON.stringify(inner, null, 2),
    "",
    "Output only that JSON object. No prose before or after it, no markdown fence.",
  ].join("\n");
}

/**
 * One OpenRouter call that must come back matching `schema`.
 *
 * Structured-output support is per endpoint, not per model, so the request is
 * built from what the catalogue says the candidate endpoints actually accept:
 * the schema travels in the request where it can, and in the prompt where it
 * cannot. Either way the response is re-validated with zod here, which is the
 * only guarantee that holds across every provider -- OpenRouter documents
 * `strict` as enforced by some and treated as a hint by others.
 */
export async function completeStructured<T extends z.ZodTypeAny>(
  opts: CompleteOptions<T>,
): Promise<CompleteResult<z.infer<T>>> {
  const jsonSchema = zodToJsonSchema(opts.schema, {
    name: opts.schemaName,
    target: "jsonSchema7",
    $refStrategy: "none",
  });
  // zodToJsonSchema nests the schema under definitions when given a name.
  const definitions = (jsonSchema as Record<string, any>).definitions ?? {};
  const inner = definitions[opts.schemaName] ?? jsonSchema;

  const shape = await resolveRequestShape(opts.apiKey, opts.model, opts.fallbackModels);

  const user =
    shape.mode === "json_schema"
      ? opts.user
      : opts.user + schemaInstruction(opts.schemaName, inner);

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: buildSystemContent(opts.model, opts.system) },
    { role: "user", content: user },
  ];

  let lastRaw = "";
  let lastError: unknown;

  // Two attempts: the retry feeds the validation error back so the model can
  // correct its own shape rather than reproducing the same malformed output.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request: Record<string, unknown> = {
      model: opts.model,
      messages,
      max_tokens: opts.maxTokens ?? 16_000,
      temperature: 0,
      usage: { include: true },
    };

    if (shape.mode === "json_schema") {
      request["response_format"] = {
        type: "json_schema",
        json_schema: { name: opts.schemaName, strict: true, schema: inner },
      };
    } else if (shape.mode === "json_object") {
      request["response_format"] = { type: "json_object" };
    }

    // Only meaningful when the request actually asks for something optional --
    // with nothing to require, it would only narrow routing for no gain.
    if (shape.mode !== "prompt_only") request["provider"] = { require_parameters: true };

    if (opts.fallbackModels?.length) request["models"] = [opts.model, ...opts.fallbackModels];
    if (opts.effort && shape.sendReasoningEffort) request["reasoning"] = { effort: opts.effort };

    const res = (await opts.client.chat.completions.create(
      request as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
    )) as OpenAI.ChatCompletion;

    const usage = readUsage((res as unknown as { usage?: unknown }).usage);
    const servedBy = res.model ?? opts.model;
    lastRaw = res.choices?.[0]?.message?.content ?? "";

    if (!lastRaw.trim()) {
      lastError = new Error("empty response body");
    } else {
      try {
        const parsed = opts.schema.parse(JSON.parse(stripFence(lastRaw)));
        return { value: parsed, usage, servedBy };
      } catch (err) {
        lastError = err;
      }
    }

    if (attempt === 0) {
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({
        role: "user",
        content:
          `That response did not match the required schema (${String(lastError)}). ` +
          `Reply again with only the JSON object, matching the schema exactly. No prose, no markdown fence.`,
      });
    }
  }

  throw new SchemaViolationError(
    `Model did not return schema-valid JSON after 2 attempts: ${String(lastError)}`,
    lastRaw.slice(0, 2000),
  );
}
