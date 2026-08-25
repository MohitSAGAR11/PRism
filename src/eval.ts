#!/usr/bin/env node
/**
 * Precision/recall harness.
 *
 * The point of this file is to make prompt and model changes measurable. Both
 * are easy to change and impossible to judge by eye: a prompt tweak that fixes
 * one PR routinely breaks two others, and swapping models is a one-line config
 * change whose effect on quality is invisible without a scoreboard.
 *
 *   npm run eval                                  # every fixture, default model
 *   npm run eval -- --models a/b,c/d              # compare models
 *   npm run eval -- --fixture fixtures/cases.json
 *
 * Fixture format (see fixtures/cases.example.json):
 *   [{ "ref": "owner/repo#123",
 *      "expected": [{ "file": "src/a.ts", "line": 42, "category": "bug",
 *                     "note": "off-by-one in the bound" }] }]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Category } from "./config.js";
import { createOctokit, parsePullRef } from "./github/client.js";
import { createClient, formatUsage, addUsage, ZERO_USAGE, type Usage } from "./llm/client.js";
import { run } from "./review/run.js";

/** How far a reported line may sit from the labelled line and still count. */
const LINE_TOLERANCE = 3;

interface Expectation {
  file: string;
  line: number;
  category?: Category;
  note?: string;
}

interface Case {
  ref: string;
  expected: Expectation[];
}

interface Score {
  model: string | undefined;
  matched: number;
  missed: Expectation[];
  extra: number;
  usage: Usage;
}

function githubToken(): string {
  const fromEnv = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (fromEnv) return fromEnv;
  return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function pct(n: number, d: number): string {
  if (d === 0) return "n/a";
  return ((n / d) * 100).toFixed(0) + "%";
}

async function scoreModel(
  model: string | undefined,
  cases: Case[],
  openRouterKey: string,
): Promise<Score> {
  const gh = createOctokit(githubToken());
  const client = createClient(openRouterKey);

  let matched = 0;
  let extra = 0;
  const missed: Expectation[] = [];
  let usage = ZERO_USAGE;

  for (const testCase of cases) {
    const { owner, repo, pull } = parsePullRef(testCase.ref);
    const result = await run({
      gh,
      client,
      openRouterKey,
      ref: { owner, repo },
      pull,
      // No --models means "use the resolved config", so pass no override at
      // all. An empty string would survive resolveConfig's ?? chain and go
      // out as an empty model slug.
      inputs: model ? { model, verifyModel: model } : {},
      // Never posts: the same PR is reviewed repeatedly across models.
      dryRun: true,
    });

    usage = addUsage(usage, result.usage);

    // Both inline and summary-only findings count as reported: the harness
    // measures whether the defect was found, not where the comment landed.
    const reported = [
      ...result.split.inline.map((c) => ({ file: c.path, line: c.line })),
      ...result.split.summaryOnly.map((f) => ({ file: f.file, line: f.line })),
    ];
    const consumed = new Set<number>();

    for (const want of testCase.expected) {
      const hit = reported.findIndex(
        (got, i) =>
          !consumed.has(i) &&
          got.file === want.file &&
          Math.abs(got.line - want.line) <= LINE_TOLERANCE,
      );
      if (hit === -1) missed.push(want);
      else {
        consumed.add(hit);
        matched += 1;
      }
    }

    extra += reported.length - consumed.size;
    process.stderr.write(
      `  ${testCase.ref}: ${consumed.size}/${testCase.expected.length} found, ` +
        `${reported.length - consumed.size} unlabelled\n`,
    );
  }

  return { model, matched, missed, extra, usage };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const openRouterKey = process.env["OPENROUTER_API_KEY"];
  if (!openRouterKey) throw new Error("OPENROUTER_API_KEY is not set");

  const fixturePath = argValue(argv, "--fixture") ?? "fixtures/cases.json";
  const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as Case[];
  const models = (argValue(argv, "--models") ?? "").split(",").filter(Boolean);
  const total = cases.reduce((n, c) => n + c.expected.length, 0);

  const scores: Score[] = [];
  for (const model of models.length > 0 ? models : [undefined]) {
    process.stderr.write(`\n${model || "(configured default)"}\n`);
    scores.push(await scoreModel(model, cases, openRouterKey));
  }

  console.log("\n" + "=".repeat(78));
  console.log(
    "model".padEnd(34) +
      "recall".padEnd(10) +
      "precision".padEnd(12) +
      "unlabelled".padEnd(12) +
      "cost",
  );
  console.log("=".repeat(78));
  for (const s of scores) {
    const reportedTotal = s.matched + s.extra;
    console.log(
      (s.model || "default").slice(0, 33).padEnd(34) +
        pct(s.matched, total).padEnd(10) +
        pct(s.matched, reportedTotal).padEnd(12) +
        String(s.extra).padEnd(12) +
        "$" + s.usage.cost.toFixed(4),
    );
  }

  // "Unlabelled" is not the same as "wrong": a finding the fixture does not
  // mention may still be a real defect nobody labelled. Read them before
  // treating precision here as ground truth.
  for (const s of scores) {
    if (s.missed.length === 0) continue;
    console.log(`\nmissed by ${s.model || "default"}:`);
    for (const m of s.missed) {
      console.log(`  ${m.file}:${m.line}${m.note ? " - " + m.note : ""}`);
    }
  }
  console.log("\ntotal usage: " + formatUsage(scores.reduce((a, s) => addUsage(a, s.usage), ZERO_USAGE)));
}

main().catch((err: unknown) => {
  console.error("error: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
