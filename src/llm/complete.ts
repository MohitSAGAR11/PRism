import type OpenAI from "openai";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readUsage, type Usage } from "./client.js";
import { needsExplicitCacheControl } from "./models.js";

export interface CompleteOptions<T extends z.ZodTypeAny> {
  client: OpenAI;
  /** Primary OpenRouter model slug, e.g. "anthropic/claude-sonnet-4.5". */
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

/**
 * One OpenRouter call that must come back matching `schema`.
 *
 * `response_format` plus `provider.require_parameters` keeps the request on
 * endpoints that actually honour structured outputs -- support is per endpoint,
 * not per model, so without the guard a request can silently land somewhere
 * that ignores the schema and returns prose. The zod re-validation below is
 * still not redundant: OpenRouter documents `strict` as enforced by some
 * providers and treated as a hint by others.
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

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: buildSystemContent(opts.model, opts.system) },
    { role: "user", content: opts.user },
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
      response_format: {
        type: "json_schema",
        json_schema: { name: opts.schemaName, strict: true, schema: inner },
      },
      provider: { require_parameters: true },
      usage: { include: true },
    };
    if (opts.fallbackModels?.length) request["models"] = [opts.model, ...opts.fallbackModels];
    if (opts.effort) request["reasoning"] = { effort: opts.effort };

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
