import type OpenAI from "openai";
import type { Config } from "../config.js";
import { renderFileContext, type FileContext } from "../context/collect.js";
import { addUsage, ZERO_USAGE, type Usage } from "../llm/client.js";
import { completeStructured } from "../llm/complete.js";
import { mapPool } from "../util/pool.js";
import { buildVerifySystemPrompt, buildVerifyUserPrompt } from "./prompt.js";
import { clampConfidence, VerdictSchema, type ReviewedFinding } from "./schema.js";

const VERIFY_CONCURRENCY = 4;

export interface VerifyOptions {
  client: OpenAI;
  openRouterKey: string;
  cfg: Config;
  findings: ReviewedFinding[];
  contextsByPath: Map<string, FileContext>;
  onProgress?: (message: string) => void;
}

export interface VerifyResult {
  survivors: ReviewedFinding[];
  refuted: ReviewedFinding[];
  usage: Usage;
  servedBy: Set<string>;
}

/**
 * Second pass: try to knock every finding down before it reaches the PR.
 *
 * Runs on `verifyModel`, which defaults to the find model but is a separate
 * config key precisely so a team can point it at a different model and get an
 * independent opinion instead of one model grading its own homework.
 *
 * A verification that errors keeps the finding but caps its confidence -- an
 * infrastructure failure should not silently delete a real bug, nor promote an
 * unchecked one into an inline comment.
 */
export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  const system = buildVerifySystemPrompt();
  const survivors: ReviewedFinding[] = [];
  const refuted: ReviewedFinding[] = [];
  const servedBy = new Set<string>();
  let usage = ZERO_USAGE;

  const verdicts = await mapPool(opts.findings, VERIFY_CONCURRENCY, async (finding, i) => {
    opts.onProgress?.(`verifying ${i + 1}/${opts.findings.length}: ${finding.title}`);
    const ctx = opts.contextsByPath.get(finding.file);
    const code = ctx ? renderFileContext(ctx) : "(file context unavailable)";
    try {
      return await completeStructured({
        client: opts.client,
        apiKey: opts.openRouterKey,
        model: opts.cfg.verifyModel,
        fallbackModels: opts.cfg.fallbackModels,
        system,
        user: buildVerifyUserPrompt(finding, code),
        schema: VerdictSchema,
        schemaName: "verdict",
        effort: opts.cfg.effort,
        maxTokens: 4_000,
      });
    } catch {
      return null;
    }
  });

  for (const [i, result] of verdicts.entries()) {
    const finding = opts.findings[i]!;

    if (!result) {
      survivors.push({
        ...finding,
        confidence: Math.min(finding.confidence, 0.5),
        verdict: {
          refuted: false,
          reason: "verification call failed; confidence capped",
          corrected_severity: null,
          corrected_confidence: null,
        },
      });
      continue;
    }

    usage = addUsage(usage, result.usage);
    servedBy.add(result.servedBy);
    const verdict = result.value;

    if (verdict.refuted) {
      refuted.push({ ...finding, verdict });
      continue;
    }

    survivors.push({
      ...finding,
      severity: verdict.corrected_severity ?? finding.severity,
      confidence:
        verdict.corrected_confidence === null
          ? finding.confidence
          : clampConfidence(verdict.corrected_confidence),
      verdict,
    });
  }

  return { survivors, refuted, usage, servedBy };
}
