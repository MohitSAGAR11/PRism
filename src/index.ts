import * as core from "@actions/core";
import * as github from "@actions/github";
import { SEVERITIES, type Category, type Config, type Severity } from "./config.js";
import { createOctokit } from "./github/client.js";
import { createClient, formatUsage } from "./llm/client.js";
import { run } from "./review/run.js";

function optionalString(name: string): string | undefined {
  const value = core.getInput(name).trim();
  return value.length > 0 ? value : undefined;
}

function optionalList(name: string): string[] | undefined {
  const value = optionalString(name);
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function optionalNumber(name: string): number | undefined {
  const value = optionalString(name);
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${value}"`);
  return n;
}

/**
 * Action inputs are layered over the reviewed repo's own config file, so a
 * workflow can override a repo without committing to it.
 */
function readInputs(): Partial<Config> {
  const inputs: Partial<Config> = {};

  const model = optionalString("model");
  if (model) inputs.model = model;

  const verifyModel = optionalString("verify-model");
  if (verifyModel) inputs.verifyModel = verifyModel;

  const fallbacks = optionalList("fallback-models");
  if (fallbacks) inputs.fallbackModels = fallbacks;

  const effort = optionalString("effort");
  if (effort) {
    if (!["low", "medium", "high"].includes(effort)) {
      throw new Error(`effort must be low, medium or high, got "${effort}"`);
    }
    inputs.effort = effort as Config["effort"];
  }

  const severity = optionalString("severity-threshold");
  if (severity) {
    if (!(SEVERITIES as readonly string[]).includes(severity)) {
      throw new Error(`severity-threshold must be one of ${SEVERITIES.join(", ")}`);
    }
    inputs.severityThreshold = severity as Severity;
  }

  const minConfidence = optionalNumber("min-confidence");
  if (minConfidence !== undefined) inputs.minConfidence = minConfidence;

  const maxInline = optionalNumber("max-inline-comments");
  if (maxInline !== undefined) inputs.maxInlineComments = maxInline;

  const pathsIgnore = optionalList("paths-ignore");
  if (pathsIgnore) inputs.pathsIgnore = pathsIgnore;

  const focus = optionalList("focus");
  if (focus) inputs.focus = focus as Category[];

  return inputs;
}

function resolvePullNumber(): number {
  const explicit = optionalString("pull-number");
  if (explicit) return Number(explicit);

  const fromPayload =
    github.context.payload.pull_request?.number ?? github.context.payload.issue?.number;
  if (typeof fromPayload === "number") return fromPayload;

  throw new Error(
    "No pull request in the event payload. Trigger on pull_request / pull_request_target, " +
      "or pass the pull-number input.",
  );
}

async function main(): Promise<void> {
  const openRouterKey = core.getInput("openrouter-api-key", { required: true });
  const githubToken = core.getInput("github-token", { required: true });
  const dryRun = core.getBooleanInput("dry-run");

  const { owner, repo } = github.context.repo;
  const pull = resolvePullNumber();

  const result = await run({
    gh: createOctokit(githubToken),
    client: createClient(openRouterKey),
    openRouterKey,
    ref: { owner, repo },
    pull,
    inputs: readInputs(),
    dryRun,
    log: (m) => core.info(m),
  });

  core.setOutput("findings", String(result.split.inline.length + result.split.summaryOnly.length));
  core.setOutput("inline-comments", String(result.split.inline.length));
  core.setOutput("cost-usd", result.usage.cost.toFixed(4));
  core.setOutput("models", result.models.join(","));

  // Cost and model routing belong somewhere visible: a fallback silently
  // serving the review is exactly the sort of thing you want to notice.
  await core.summary
    .addHeading("AI code review", 2)
    .addRaw(result.summary.split("\n---\n")[0] ?? "")
    .addSeparator()
    .addRaw(
      [
        `Files reviewed: ${result.filesReviewed}`,
        `Inline comments: ${result.split.inline.length}`,
        `Summary-only findings: ${result.split.summaryOnly.length}`,
        `Refuted by verification: ${result.refuted.length}`,
        `Models: ${result.models.join(", ") || "none"}`,
        `Usage: ${formatUsage(result.usage)}`,
      ].join("  \n"),
    )
    .write();
}

main().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
