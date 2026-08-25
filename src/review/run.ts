import type OpenAI from "openai";
import { parseFileConfig, resolveConfig, type Config, type FileConfig } from "../config.js";
import { buildFileContexts, groupFiles, shrinkContext, type FileContext } from "../context/collect.js";
import { collectConventions } from "../context/conventions.js";
import { partitionFiles, type SkippedFile } from "../context/filters.js";
import type { GitHubClient, RepoRef } from "../github/client.js";
import { collectPostedFingerprints, postReview } from "../github/comments.js";
import type { ParsedFile } from "../github/diff.js";
import { getFileContent, getPullRequest, listChangedFiles, type PullRequestInfo } from "../github/pr.js";
import { addUsage, ZERO_USAGE, type Usage } from "../llm/client.js";
import { getModelInfo } from "../llm/models.js";
import { inputBudget } from "../util/tokens.js";
import { analyze } from "./analyze.js";
import { renderSummary, splitFindings, type SplitResult } from "./render.js";
import type { ReviewedFinding } from "./schema.js";
import { verify } from "./verify.js";

export const CONFIG_PATH = ".github/ai-review.yml";

export interface RunOptions {
  gh: GitHubClient;
  client: OpenAI;
  openRouterKey: string;
  ref: RepoRef;
  pull: number;
  /** Action inputs, layered over the repo config file. */
  inputs?: Partial<Config>;
  dryRun: boolean;
  log?: (message: string) => void;
}

export interface RunResult {
  pr: PullRequestInfo;
  cfg: Config;
  split: SplitResult;
  refuted: ReviewedFinding[];
  summary: string;
  usage: Usage;
  models: string[];
  filesReviewed: number;
  skipped: SkippedFile[];
  posted: boolean;
}

async function loadRepoConfig(
  gh: GitHubClient,
  ref: RepoRef,
  gitRef: string,
  log: (m: string) => void,
): Promise<FileConfig> {
  const raw = await getFileContent(gh, ref, CONFIG_PATH, gitRef);
  if (!raw) return {};
  try {
    return parseFileConfig(raw);
  } catch (err) {
    // A malformed config should not take the review down with it.
    log(`ignoring ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  const { gh, ref, pull } = opts;

  const pr = await getPullRequest(gh, ref, pull);
  log(`PR #${pr.number} "${pr.title}" by ${pr.author} at ${pr.headSha.slice(0, 7)}`);

  const fileConfig = await loadRepoConfig(gh, ref, pr.headSha, log);
  const cfg = resolveConfig(fileConfig, opts.inputs);
  log(`model=${cfg.model} verify=${cfg.verifyModel} effort=${cfg.effort}`);

  const allFiles = await listChangedFiles(gh, ref, pull);
  const { review: reviewable, skipped } = partitionFiles(allFiles, cfg.pathsIgnore);

  let files = reviewable;
  if (files.length > cfg.maxFiles) {
    // Say what was dropped -- a silent cap reads as "reviewed everything".
    for (const f of files.slice(cfg.maxFiles)) {
      skipped.push({ path: f.path, reason: `over the ${cfg.maxFiles}-file cap` });
    }
    files = files.slice(0, cfg.maxFiles);
  }
  log(`${files.length} file(s) to review, ${skipped.length} skipped`);

  const filesByPath = new Map<string, ParsedFile>(files.map((f) => [f.path, f]));

  if (files.length === 0) {
    const split: SplitResult = { inline: [], summaryOnly: [], belowBar: [], duplicates: [] };
    const summary = renderSummary({
      split,
      refuted: [],
      skipped,
      failures: [],
      usage: ZERO_USAGE,
      models: [],
      headSha: pr.headSha,
      filesReviewed: 0,
      knownFingerprints: [],
      dryRun: opts.dryRun,
    });
    return {
      pr, cfg, split, refuted: [], summary,
      usage: ZERO_USAGE, models: [], filesReviewed: 0, skipped, posted: false,
    };
  }

  const conventions = await collectConventions(gh, ref, pr.headSha);
  const contexts = await buildFileContexts(gh, ref, pr.headSha, files);

  const modelInfo = await getModelInfo(opts.openRouterKey, cfg.model);
  const budget = inputBudget(modelInfo.contextLength);
  log(`context window ${modelInfo.contextLength}, input budget ~${budget} tokens`);

  // A single file bigger than the whole budget loses its full-file context
  // rather than being dropped from the review.
  const sized = contexts.map((c) => (c.tokens > budget ? shrinkContext(c) : c));
  const groups = groupFiles(sized, budget);
  log(`${groups.length} request group(s)`);

  const contextsByPath = new Map<string, FileContext>(sized.map((c) => [c.file.path, c]));

  const found = await analyze({
    client: opts.client,
    openRouterKey: opts.openRouterKey,
    cfg,
    pr,
    groups,
    conventions,
    filesByPath,
    onProgress: log,
  });
  log(`${found.findings.length} candidate finding(s)`);

  const checked = await verify({
    client: opts.client,
    openRouterKey: opts.openRouterKey,
    cfg,
    findings: found.findings,
    contextsByPath,
    onProgress: log,
  });
  log(`${checked.survivors.length} survived verification, ${checked.refuted.length} refuted`);

  const alreadyPosted = await collectPostedFingerprints(gh, ref, pull);
  const split = splitFindings({
    findings: checked.survivors,
    filesByPath,
    cfg,
    alreadyPosted,
  });

  const usage = addUsage(found.usage, checked.usage);
  const models = [...new Set([...found.servedBy, ...checked.servedBy])].sort();

  // The ledger must carry forward everything already known plus everything
  // reported now, or a summary-only finding reappears on the next push.
  const knownFingerprints = [
    ...alreadyPosted,
    ...checked.survivors
      .filter((f) => !split.belowBar.includes(f))
      .map((f) => f.fingerprint),
  ];

  const summary = renderSummary({
    split,
    refuted: checked.refuted,
    skipped,
    failures: found.failures,
    usage,
    models,
    headSha: pr.headSha,
    filesReviewed: files.length,
    knownFingerprints,
    dryRun: opts.dryRun,
  });

  let posted = false;
  if (!opts.dryRun) {
    const result = await postReview({
      gh, ref, pull,
      headSha: pr.headSha,
      inline: split.inline,
      summary,
    });
    posted = true;
    log(
      result.degraded
        ? "inline placement was rejected; posted everything in the summary"
        : `posted ${result.inlinePosted} inline comment(s)`,
    );
  }

  return {
    pr, cfg, split,
    refuted: checked.refuted,
    summary, usage, models,
    filesReviewed: files.length,
    skipped, posted,
  };
}
