import type OpenAI from "openai";
import type { Config } from "../config.js";
import type { FileGroup } from "../context/collect.js";
import type { ParsedFile } from "../github/diff.js";
import type { PullRequestInfo } from "../github/pr.js";
import { addUsage, ZERO_USAGE, type Usage } from "../llm/client.js";
import { completeStructured } from "../llm/complete.js";
import { mapPool } from "../util/pool.js";
import { buildReviewSystemPrompt, buildReviewUserPrompt } from "./prompt.js";
import {
  clampConfidence,
  fingerprint,
  FindingsResponseSchema,
  type Finding,
  type ReviewedFinding,
} from "./schema.js";

const GROUP_CONCURRENCY = 3;

export interface AnalyzeOptions {
  client: OpenAI;
  cfg: Config;
  pr: PullRequestInfo;
  groups: FileGroup[];
  conventions: string;
  filesByPath: Map<string, ParsedFile>;
  onProgress?: (message: string) => void;
}

export interface AnalyzeResult {
  findings: ReviewedFinding[];
  usage: Usage;
  servedBy: Set<string>;
  /** Groups whose review failed outright, reported in the summary. */
  failures: Array<{ paths: string[]; error: string }>;
}

export async function analyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const system = buildReviewSystemPrompt(opts.cfg, opts.conventions);
  const findings: ReviewedFinding[] = [];
  const failures: AnalyzeResult["failures"] = [];
  const servedBy = new Set<string>();
  let usage = ZERO_USAGE;

  const results = await mapPool(opts.groups, GROUP_CONCURRENCY, async (group, i) => {
    const paths = group.contexts.map((c) => c.file.path);
    opts.onProgress?.(
      `reviewing group ${i + 1}/${opts.groups.length} (${paths.length} file(s), ~${group.tokens} tokens)`,
    );
    try {
      const res = await completeStructured({
        client: opts.client,
        model: opts.cfg.model,
        fallbackModels: opts.cfg.fallbackModels,
        system,
        user: buildReviewUserPrompt(opts.pr, group),
        schema: FindingsResponseSchema,
        schemaName: "review_findings",
        effort: opts.cfg.effort,
      });
      return { paths, res };
    } catch (err) {
      return { paths, error: err instanceof Error ? err.message : String(err) };
    }
  });

  for (const result of results) {
    if ("error" in result && result.error) {
      failures.push({ paths: result.paths, error: result.error });
      continue;
    }
    if (!("res" in result) || !result.res) continue;

    usage = addUsage(usage, result.res.usage);
    servedBy.add(result.res.servedBy);

    const allowed = new Set(result.paths);
    for (const raw of result.res.value.findings) {
      // Models occasionally cite a file that was not in the request; those
      // findings cannot be anchored and are not trustworthy either.
      if (!allowed.has(raw.file)) continue;
      const finding: Finding = { ...raw, confidence: clampConfidence(raw.confidence) };
      findings.push({
        ...finding,
        fingerprint: fingerprint(finding, opts.filesByPath.get(finding.file)),
      });
    }
  }

  return { findings, usage, servedBy, failures };
}
