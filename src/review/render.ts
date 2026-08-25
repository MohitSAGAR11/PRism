import type { Config } from "../config.js";
import type { SkippedFile } from "../context/filters.js";
import type { ParsedFile } from "../github/diff.js";
import { formatUsage, type Usage } from "../llm/client.js";
import { fingerprintMarker, meetsBar, rankFindings, type ReviewedFinding } from "./schema.js";

export const SUMMARY_MARKER = "<!-- ai-review:summary -->";
export const SHA_PREFIX = "ai-review:sha=";

export interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

const SEVERITY_LABEL: Record<string, string> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

function findingBody(f: ReviewedFinding, includeFingerprint: boolean): string {
  const parts = [
    "**" + SEVERITY_LABEL[f.severity] + " / " + f.category + "** - " + f.title,
    "",
    f.body.trim(),
    "",
    "**Fails when:** " + f.failure_scenario.trim(),
  ];

  if (f.suggested_patch !== null && f.suggested_patch.trim().length > 0) {
    parts.push("", "```suggestion", f.suggested_patch.replace(/\n+$/, ""), "```");
  }

  if (includeFingerprint) parts.push("", fingerprintMarker(f.fingerprint));
  return parts.join("\n");
}

export interface SplitOptions {
  findings: ReviewedFinding[];
  filesByPath: Map<string, ParsedFile>;
  cfg: Config;
  /** Fingerprints this bot has already posted on the PR. */
  alreadyPosted: Set<string>;
}

export interface SplitResult {
  inline: InlineComment[];
  /** Passed the bar but could not be anchored, or exceeded the inline cap. */
  summaryOnly: ReviewedFinding[];
  /** Real but below the configured reporting bar. */
  belowBar: ReviewedFinding[];
  duplicates: ReviewedFinding[];
}

/**
 * Decide where each finding goes.
 *
 * The anchoring rule is the important one: GitHub rejects the entire review if
 * any comment names a line outside the diff, so a finding that cannot be
 * anchored is demoted to the summary rather than risking the whole post.
 */
export function splitFindings(opts: SplitOptions): SplitResult {
  const ranked = rankFindings(opts.findings);
  const inline: InlineComment[] = [];
  const summaryOnly: ReviewedFinding[] = [];
  const belowBar: ReviewedFinding[] = [];
  const duplicates: ReviewedFinding[] = [];
  const seen = new Set<string>();

  for (const f of ranked) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);

    if (opts.alreadyPosted.has(f.fingerprint)) {
      duplicates.push(f);
      continue;
    }
    if (!meetsBar(f, opts.cfg)) {
      belowBar.push(f);
      continue;
    }

    const file = opts.filesByPath.get(f.file);
    const anchorable = file?.commentableLines.has(f.line) ?? false;

    if (anchorable && inline.length < opts.cfg.maxInlineComments) {
      inline.push({
        path: f.file,
        line: f.line,
        side: "RIGHT",
        body: findingBody(f, true),
      });
    } else {
      summaryOnly.push(f);
    }
  }

  return { inline, summaryOnly, belowBar, duplicates };
}

export interface SummaryOptions {
  split: SplitResult;
  refuted: ReviewedFinding[];
  skipped: SkippedFile[];
  failures: Array<{ paths: string[]; error: string }>;
  usage: Usage;
  models: string[];
  headSha: string;
  filesReviewed: number;
  /**
   * Every fingerprint reported on this PR so far, this run included. Written
   * back into the summary as a hidden ledger so that a finding demoted to the
   * summary on one push is still recognised as a duplicate on the next -- the
   * summary body is rewritten each run, so without the ledger those
   * fingerprints would vanish and the finding would be reported again.
   */
  knownFingerprints: string[];
  dryRun?: boolean;
}

function detailsBlock(title: string, body: string): string {
  return ["<details>", "<summary>" + title + "</summary>", "", body, "", "</details>"].join("\n");
}

function findingLine(f: ReviewedFinding): string {
  const conf = Math.round(f.confidence * 100);
  return (
    "- `" +
    f.file +
    ":" +
    String(f.line) +
    "` **" +
    f.severity +
    "/" +
    f.category +
    "** (" +
    String(conf) +
    "%) - " +
    f.title +
    "\n  " +
    f.failure_scenario.trim()
  );
}

export function renderSummary(opts: SummaryOptions): string {
  const { split } = opts;
  const posted = split.inline.length;
  const sections: string[] = [];

  const headline =
    posted === 0 && split.summaryOnly.length === 0
      ? "No blocking issues found in " + String(opts.filesReviewed) + " reviewed file(s)."
      : "Left " +
        String(posted) +
        " inline comment(s) across " +
        String(opts.filesReviewed) +
        " reviewed file(s).";

  sections.push("## AI code review\n\n" + headline);

  if (split.summaryOnly.length > 0) {
    sections.push(
      "### Findings not anchored inline\n\n" +
        "These are on lines outside the diff, or beyond the inline comment cap.\n\n" +
        split.summaryOnly.map(findingLine).join("\n"),
    );
  }

  if (split.duplicates.length > 0) {
    sections.push(
      detailsBlock(
        "Already reported on an earlier push (" + String(split.duplicates.length) + ")",
        split.duplicates.map(findingLine).join("\n"),
      ),
    );
  }

  if (split.belowBar.length > 0) {
    sections.push(
      detailsBlock(
        "Below the reporting bar (" + String(split.belowBar.length) + ")",
        split.belowBar.map(findingLine).join("\n"),
      ),
    );
  }

  if (opts.refuted.length > 0) {
    sections.push(
      detailsBlock(
        "Dropped by verification (" + String(opts.refuted.length) + ")",
        opts.refuted
          .map((f) => findingLine(f) + "\n  _refuted: " + (f.verdict?.reason ?? "") + "_")
          .join("\n"),
      ),
    );
  }

  if (opts.skipped.length > 0) {
    sections.push(
      detailsBlock(
        "Files not reviewed (" + String(opts.skipped.length) + ")",
        opts.skipped.map((s) => "- `" + s.path + "` - " + s.reason).join("\n"),
      ),
    );
  }

  if (opts.failures.length > 0) {
    sections.push(
      "### Review errors\n\n" +
        opts.failures
          .map((f) => "- `" + f.paths.join("`, `") + "` - " + f.error)
          .join("\n"),
    );
  }

  const footer = [
    "---",
    "",
    "Models: " + (opts.models.length > 0 ? opts.models.join(", ") : "n/a") + "  ",
    "Usage: " + formatUsage(opts.usage) + "  ",
    "Reviewed through `" + opts.headSha.slice(0, 7) + "`",
  ];
  if (opts.dryRun) footer.push("", "_(dry run - nothing was posted)_");
  footer.push("", SUMMARY_MARKER, "<!-- " + SHA_PREFIX + opts.headSha + " -->");
  for (const fp of [...new Set(opts.knownFingerprints)].sort()) {
    footer.push(fingerprintMarker(fp));
  }

  sections.push(footer.join("\n"));
  return sections.join("\n\n");
}

/** Render the whole review as plain text for the local CLI. */
export function renderForTerminal(split: SplitResult, summary: string): string {
  const lines: string[] = [];
  for (const c of split.inline) {
    lines.push("=".repeat(72));
    lines.push(c.path + ":" + String(c.line));
    lines.push("-".repeat(72));
    lines.push(c.body.replace(/\n*<!-- ai-review:fp=[0-9a-f]+ -->/, ""));
    lines.push("");
  }
  lines.push("=".repeat(72));
  lines.push(summary);
  return lines.join("\n");
}
