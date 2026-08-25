#!/usr/bin/env node
/**
 * Exercise everything except the model calls.
 *
 * Fetches a real pull request, parses its diff, collects file context, and
 * prints exactly what would be sent -- without spending a token. Useful for
 * checking the GitHub half in isolation, and for eyeballing the prompt payload
 * when a review comes back worse than expected.
 *
 *   npm run check:plumbing -- owner/repo#123 [--show-prompt]
 */
import { execFileSync } from "node:child_process";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.js";
import { buildFileContexts, groupFiles, renderFileContext, shrinkContext } from "../src/context/collect.js";
import { collectConventions } from "../src/context/conventions.js";
import { partitionFiles } from "../src/context/filters.js";
import { createOctokit, parsePullRef } from "../src/github/client.js";
import { getPullRequest, listChangedFiles } from "../src/github/pr.js";
import { buildReviewSystemPrompt, buildReviewUserPrompt } from "../src/review/prompt.js";
import { estimateTokens, inputBudget } from "../src/util/tokens.js";
import { loadEnvFile } from "../src/util/env.js";

function githubToken(): string {
  const fromEnv = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (fromEnv) return fromEnv;
  return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = process.argv.slice(2);
  const ref = args.find((a) => !a.startsWith("-"));
  const showPrompt = args.includes("--show-prompt");
  if (!ref) throw new Error('usage: check:plumbing -- owner/repo#123 [--show-prompt]');

  const { owner, repo, pull } = parsePullRef(ref);
  const gh = createOctokit(githubToken());
  const repoRef = { owner, repo };
  const cfg = resolveConfig({}, {});

  const pr = await getPullRequest(gh, repoRef, pull);
  console.log(`PR #${pr.number}: ${pr.title}`);
  console.log(`  author=${pr.author} head=${pr.headSha.slice(0, 7)} fork=${pr.isFork}`);

  const all = await listChangedFiles(gh, repoRef, pull);
  const { review, skipped } = partitionFiles(all, cfg.pathsIgnore);
  console.log(`\n${all.length} changed file(s): ${review.length} reviewable, ${skipped.length} skipped`);
  for (const s of skipped) console.log(`  skip  ${s.path} (${s.reason})`);

  let anchorable = 0;
  for (const f of review) {
    anchorable += f.commentableLines.size;
    console.log(
      `  review ${f.path} - ${f.hunks.length} hunk(s), ` +
        `${f.addedLines.size} added, ${f.commentableLines.size} commentable line(s)`,
    );
  }
  console.log(`\nTotal anchorable lines: ${anchorable}`);
  if (review.length > 0 && anchorable === 0) {
    throw new Error("no anchorable lines across any reviewable file -- diff parsing is broken");
  }

  const conventions = await collectConventions(gh, repoRef, pr.headSha);
  console.log(
    `Conventions: ${conventions ? `${estimateTokens(conventions)} tokens` : "none found"}`,
  );

  const contexts = await buildFileContexts(gh, repoRef, pr.headSha, review);
  const withBody = contexts.filter((c) => c.numberedContent !== null).length;
  console.log(`File bodies fetched: ${withBody}/${contexts.length}`);

  const budget = inputBudget(DEFAULT_CONFIG.model.includes("claude") ? 200_000 : 128_000);
  const sized = contexts.map((c) => (c.tokens > budget ? shrinkContext(c) : c));
  const groups = groupFiles(sized, budget);
  const system = buildReviewSystemPrompt(cfg, conventions);

  console.log(`\nBudget ${budget} tokens -> ${groups.length} request group(s)`);
  console.log(`System prompt: ${estimateTokens(system)} tokens (the cacheable prefix)`);
  for (const [i, g] of groups.entries()) {
    const user = buildReviewUserPrompt(pr, g);
    console.log(
      `  group ${i + 1}: ${g.contexts.length} file(s), user payload ${estimateTokens(user)} tokens`,
    );
    if (estimateTokens(system) + estimateTokens(user) > budget) {
      throw new Error(`group ${i + 1} exceeds the input budget after assembly`);
    }
  }

  if (showPrompt && groups[0]) {
    console.log("\n" + "=".repeat(72) + "\nSYSTEM\n" + "=".repeat(72));
    console.log(system);
    console.log("\n" + "=".repeat(72) + "\nUSER (group 1)\n" + "=".repeat(72));
    console.log(buildReviewUserPrompt(pr, groups[0]));
  } else if (showPrompt) {
    console.log("\n(no groups to show)");
  }

  // Prove a rendered context actually carries citable line numbers.
  const sample = sized[0];
  if (sample) {
    const rendered = renderFileContext(sample);
    const cited = [...sample.file.commentableLines][0];
    if (cited !== undefined && !rendered.includes(String(cited))) {
      throw new Error("rendered context does not contain its own commentable line numbers");
    }
  }

  console.log("\nplumbing OK - no model calls made");
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
