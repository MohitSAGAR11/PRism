#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { SEVERITIES, type Config, type Severity } from "./config.js";
import { createOctokit, parsePullRef } from "./github/client.js";
import { createClient, formatUsage } from "./llm/client.js";
import { renderForTerminal } from "./review/render.js";
import { run } from "./review/run.js";

const USAGE = `ai-pr-reviewer - review a GitHub pull request

  review <owner/repo#123> [options]

Options
  --post                 Actually post to the PR. Without it, nothing is written.
  --model <slug>         OpenRouter model for the find pass.
  --verify-model <slug>  OpenRouter model for the verify pass.
  --severity <level>     low | medium | high | critical (default medium)
  --max-inline <n>       Cap on inline comments.
  --quiet                Suppress progress output.
  -h, --help

Environment
  OPENROUTER_API_KEY  required
  GITHUB_TOKEN        optional; falls back to "gh auth token"
`;

interface Args {
  ref: string;
  post: boolean;
  quiet: boolean;
  inputs: Partial<Config>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ref: "", post: false, quiet: false, inputs: {} };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };

    switch (arg) {
      case "--post":
        args.post = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "--model":
        args.inputs.model = next();
        break;
      case "--verify-model":
        args.inputs.verifyModel = next();
        break;
      case "--severity": {
        const value = next();
        if (!(SEVERITIES as readonly string[]).includes(value)) {
          throw new Error(`--severity must be one of ${SEVERITIES.join(", ")}`);
        }
        args.inputs.severityThreshold = value as Severity;
        break;
      }
      case "--max-inline":
        args.inputs.maxInlineComments = Number(next());
        break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        args.ref = arg;
    }
  }

  if (!args.ref) throw new Error('missing pull request reference, e.g. "owner/repo#123"');
  return args;
}

/** Reuse the gh CLI session so a local run needs no extra token setup. */
function githubToken(): string {
  const fromEnv = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("No GITHUB_TOKEN set and `gh auth token` failed. Run `gh auth login`.");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const openRouterKey = process.env["OPENROUTER_API_KEY"];
  if (!openRouterKey) throw new Error("OPENROUTER_API_KEY is not set");

  const { owner, repo, pull } = parsePullRef(args.ref);
  const log = args.quiet
    ? undefined
    : (m: string) => process.stderr.write(`  ${m}\n`);

  const result = await run({
    gh: createOctokit(githubToken()),
    client: createClient(openRouterKey),
    openRouterKey,
    ref: { owner, repo },
    pull,
    inputs: args.inputs,
    // Local runs never write unless asked: the CLI exists for prompt
    // iteration, and iterating against a real PR should not spam it.
    dryRun: !args.post,
    log,
  });

  process.stdout.write(renderForTerminal(result.split, result.summary) + "\n");
  process.stderr.write(
    `\n${result.posted ? "posted" : "dry run"} | ${formatUsage(result.usage)} | ` +
      `${result.models.join(", ") || "no model calls"}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
