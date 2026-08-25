#!/usr/bin/env node
/**
 * The cheapest possible proof that a model can serve this pipeline at all.
 *
 * Structured-output and reasoning support are per *endpoint* on OpenRouter, not
 * per model, so a slug that looks fine in the catalogue can still fail to route
 * once `require_parameters` is in the request. This script asks one model for a
 * two-field object and reports the request shape that was chosen, what actually
 * served it, and the spend -- fractions of a cent, and it isolates a routing
 * failure from a pipeline failure.
 *
 *   npx tsx scripts/smoke-model.ts                    # the configured defaults
 *   npx tsx scripts/smoke-model.ts stealth/ox-alpha   # one specific slug
 */
import { z } from "zod";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createClient, formatUsage } from "../src/llm/client.js";
import { completeStructured, resolveRequestShape } from "../src/llm/complete.js";
import { getModelInfo } from "../src/llm/models.js";

const Shape = z
  .object({
    greeting: z.string(),
    confidence: z.number(),
  })
  .strict();

async function smoke(apiKey: string, model: string): Promise<boolean> {
  const info = await getModelInfo(apiKey, model);
  const shape = await resolveRequestShape(apiKey, model);

  console.log(`\n${model}`);
  console.log(`  context window     ${info.contextLength.toLocaleString()}`);
  console.log(
    `  catalogue          ${info.supportedParameters.length > 0 ? "found" : "NOT FOUND (assuming capable)"}`,
  );
  console.log(`  output mode        ${shape.mode}`);
  console.log(`  reasoning effort   ${shape.sendReasoningEffort ? "sent" : "omitted"}`);

  try {
    const res = await completeStructured({
      client: createClient(apiKey),
      apiKey,
      model,
      system: "You reply only with JSON.",
      user: 'Return a friendly greeting and your confidence in it as a number between 0 and 1.',
      schema: Shape,
      schemaName: "smoke",
      maxTokens: 500,
    });
    console.log(`  served by          ${res.servedBy}`);
    console.log(`  usage              ${formatUsage(res.usage)}`);
    console.log(`  value              ${JSON.stringify(res.value)}`);
    if (res.usage.promptTokens === 0) {
      console.log("  WARNING: zero prompt tokens reported -- usage accounting may be off");
    }
    console.log("  RESULT             ok");
    return true;
  } catch (err) {
    console.log(`  RESULT             FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main(): Promise<void> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const argv = process.argv.slice(2);
  const models =
    argv.length > 0 ? argv : [DEFAULT_CONFIG.model, DEFAULT_CONFIG.verifyModel];
  const unique = [...new Set(models)];

  const results = await Promise.all(unique.map((m) => smoke(apiKey, m)));
  const failed = unique.filter((_, i) => !results[i]);

  console.log("");
  if (failed.length > 0) {
    throw new Error(`${failed.length}/${unique.length} model(s) failed: ${failed.join(", ")}`);
  }
  console.log(`all ${unique.length} model(s) returned schema-valid JSON`);
}

main().catch((err: unknown) => {
  console.error("error: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
