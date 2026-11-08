#!/usr/bin/env node
/**
 * Pre-compute the web demo's sample reviews, so the sample buttons show real
 * output instantly and cost the deployment nothing.
 *
 *   npm run seed:samples                         # every PR in SAMPLES
 *   npm run seed:samples -- <pr-url> [<pr-url>]  # specific PRs (try-outs)
 *   npm run seed:samples -- --dry <pr-url>       # print a summary, write nothing
 *
 * Runs through the exact code path the server uses (ReviewService, read-only
 * client, dry run, server-pinned models), so a sample is what a visitor would
 * have seen. Pick merged or closed PRs: their head SHA never moves, so the
 * cached result stays valid.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createOctokit } from "../src/github/client.js";
import { createClient } from "../src/llm/client.js";
import { run } from "../src/review/run.js";
import { makeReadOnly } from "../src/server/result.js";
import { SAMPLES } from "../src/server/samples.js";
import { ReviewService } from "../src/server/service.js";
import type { ReviewEvent, WebReviewResult } from "../src/server/types.js";
import { parsePullUrl } from "../src/server/validate.js";
import { loadEnvFile } from "../src/util/env.js";

loadEnvFile();

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const urls = args.filter((a) => !a.startsWith("--"));
const targets = urls.length > 0 ? urls : SAMPLES.map((s) => s.url);

const openRouterKey = process.env["OPENROUTER_API_KEY"];
if (!openRouterKey) throw new Error("OPENROUTER_API_KEY is not set");
const githubToken = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? "";

const service = new ReviewService({
  settings: {
    openRouterKey,
    model: process.env["REVIEW_MODEL"] ?? "z-ai/glm-5.3-flash",
    verifyModel: process.env["REVIEW_VERIFY_MODEL"] ?? "deepseek/deepseek-v4-flash",
    effort: (process.env["REVIEW_EFFORT"] as "low" | "medium" | "high" | undefined) ?? "medium",
    maxChangedFiles: 30,
    maxChangedLines: 1500,
    timeoutMs: 300_000,
    perIpPerHour: 1000,
    byokPerIpPerHour: 1000,
    globalPerDay: 1000,
    maxConcurrent: 4,
    cacheSize: 100,
  },
  github: makeReadOnly(createOctokit(githubToken, { quiet: true })),
  createGitHub: () => makeReadOnly(createOctokit(githubToken, { quiet: true })),
  createModelClient: (key) => createClient(key),
  runReview: run,
});

function wait(urlText: string): Promise<WebReviewResult> {
  return new Promise((resolvePromise, reject) => {
    const parsed = parsePullUrl(urlText);
    if (!parsed.ok) return reject(new Error(parsed.message));
    service
      .preflight(parsed.value)
      .then((pre) => {
        const job = service.start(pre, "seed", null);
        job.subscribe((e: ReviewEvent) => {
          if (e.type === "result") resolvePromise(e.result);
          if (e.type === "error") reject(new Error(`${e.code}: ${e.message}`));
          if (e.type === "candidates") process.stderr.write(`  pass 1: ${e.count} candidate(s)\n`);
        });
      })
      .catch(reject);
  });
}

const outDir = resolve("samples");
mkdirSync(outDir, { recursive: true });

for (const url of targets) {
  process.stderr.write(`${url}\n`);
  try {
    const result = await wait(url);
    const counts = result.findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.placement] = (acc[f.placement] ?? 0) + 1;
      return acc;
    }, {});
    process.stderr.write(
      `  ${JSON.stringify(counts)} in ${Math.round(result.stats.durationMs / 1000)}s, $${result.usage.cost.toFixed(4)}\n`,
    );
    for (const f of result.findings) {
      process.stderr.write(`    [${f.placement}] ${f.severity}/${f.category} ${f.file}:${f.line} ${f.title}\n`);
    }
    if (!dry) {
      const file = join(outDir, `${result.pr.owner}-${result.pr.repo}-${result.pr.number}.json`.toLowerCase());
      writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
      process.stderr.write(`  wrote ${file}\n`);
    }
  } catch (err) {
    process.stderr.write(`  failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
