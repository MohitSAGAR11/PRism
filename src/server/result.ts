import type { GitHubClient } from "../github/client.js";
import type { ParsedFile } from "../github/diff.js";
import type { RunResult } from "../review/run.js";
import { extractFingerprints, type ReviewedFinding } from "../review/schema.js";
import type { Placement, WebFileDiff, WebFinding, WebReviewResult } from "./types.js";
import type { PullTarget } from "./validate.js";

const READ_METHODS = new Set(["GET", "HEAD"]);

export class ReadOnlyViolation extends Error {
  constructor(method: string, url: string) {
    super(`read-only client refused ${method} ${url}`);
    this.name = "ReadOnlyViolation";
  }
}

/**
 * Make a GitHub client structurally incapable of writing.
 *
 * The web path already runs with `dryRun: true`, which skips every write in
 * the pipeline. This is the second, independent guard: any non-GET request is
 * refused before it leaves the process, so a future pipeline change cannot
 * make the public demo post to someone else's pull request.
 */
export function makeReadOnly(gh: GitHubClient): GitHubClient {
  gh.hook.before("request", (options) => {
    const method = String(options.method ?? "GET").toUpperCase();
    if (!READ_METHODS.has(method)) throw new ReadOnlyViolation(method, String(options.url));
  });
  return gh;
}

function toDiff(file: ParsedFile): WebFileDiff {
  return {
    path: file.path,
    status: file.status,
    hunks: file.hunks.map((h) => ({
      header: h.header,
      lines: h.lines.map((l) => ({
        kind: l.kind,
        oldLine: l.oldLine,
        newLine: l.newLine,
        content: l.content,
      })),
    })),
  };
}

function countLines(file: ParsedFile): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") additions += 1;
      else if (l.kind === "del") deletions += 1;
    }
  }
  return { additions, deletions };
}

function byFingerprint(list: ReviewedFinding[]): Map<string, ReviewedFinding> {
  const map = new Map<string, ReviewedFinding>();
  for (const f of list) if (!map.has(f.fingerprint)) map.set(f.fingerprint, f);
  return map;
}

function placementsOf(result: RunResult): Map<string, Placement> {
  const placement = new Map<string, Placement>();
  for (const c of result.split.inline) {
    for (const fp of extractFingerprints(c.body)) placement.set(fp, "inline");
  }
  for (const f of result.split.summaryOnly) placement.set(f.fingerprint, "summary");
  for (const f of result.split.belowBar) placement.set(f.fingerprint, "below-bar");
  for (const f of result.split.duplicates) placement.set(f.fingerprint, "duplicate");
  return placement;
}

const PLACEMENT_ORDER: Record<Placement, number> = {
  inline: 0,
  summary: 1,
  "below-bar": 2,
  duplicate: 3,
  refuted: 4,
};

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/**
 * Join every pass-1 candidate with what happened to it.
 *
 * The pipeline reports survivors and refutations separately; the demo's whole
 * pitch is showing the two side by side, so each candidate is emitted once
 * with its final placement, its corrected values, and the verifier's reason.
 */
export function buildFindings(result: RunResult): WebFinding[] {
  const survivors = byFingerprint(result.survivors);
  const refuted = byFingerprint(result.refuted);
  const placement = placementsOf(result);
  const seen = new Set<string>();
  const out: WebFinding[] = [];

  for (const candidate of result.candidates) {
    if (seen.has(candidate.fingerprint)) continue;
    seen.add(candidate.fingerprint);

    const survivor = survivors.get(candidate.fingerprint);
    const knocked = survivor ? undefined : refuted.get(candidate.fingerprint);
    const final = survivor ?? knocked ?? candidate;
    const where: Placement = survivor ? placement.get(candidate.fingerprint) ?? "summary" : "refuted";

    const corrected =
      survivor !== undefined &&
      (survivor.severity !== candidate.severity || survivor.confidence !== candidate.confidence);

    out.push({
      id: candidate.fingerprint,
      file: final.file,
      line: final.line,
      category: final.category,
      severity: final.severity,
      confidence: final.confidence,
      title: final.title,
      body: final.body,
      failureScenario: final.failure_scenario,
      suggestion: final.suggested_patch,
      placement: where,
      original: corrected ? { severity: candidate.severity, confidence: candidate.confidence } : null,
      verdict: final.verdict ? { refuted: final.verdict.refuted, reason: final.verdict.reason } : null,
    });
  }

  return out.sort(
    (a, b) =>
      PLACEMENT_ORDER[a.placement] - PLACEMENT_ORDER[b.placement] ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.confidence - a.confidence ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}

export function toWebResult(
  result: RunResult,
  target: PullTarget,
  durationMs: number,
  now: Date = new Date(),
): WebReviewResult {
  const findings = buildFindings(result);
  const withFindings = new Set(findings.map((f) => f.file));
  const reported = findings.filter((f) => f.placement === "inline" || f.placement === "summary").length;

  return {
    version: 1,
    pr: {
      owner: target.owner,
      repo: target.repo,
      number: result.pr.number,
      title: result.pr.title,
      author: result.pr.author,
      url: result.pr.url,
      headSha: result.pr.headSha,
      isFork: result.pr.isFork,
    },
    config: {
      model: result.cfg.model,
      verifyModel: result.cfg.verifyModel,
      effort: result.cfg.effort,
      severityThreshold: result.cfg.severityThreshold,
      minConfidence: result.cfg.minConfidence,
    },
    stats: {
      filesReviewed: result.filesReviewed,
      candidates: findings.length,
      survived: findings.filter((f) => f.placement !== "refuted").length,
      refuted: findings.filter((f) => f.placement === "refuted").length,
      reported,
      durationMs,
    },
    findings,
    diffs: result.files.filter((f) => withFindings.has(f.path)).map(toDiff),
    reviewedFiles: result.files.map((f) => ({ path: f.path, status: f.status, ...countLines(f) })),
    skipped: result.skipped.map((s) => ({ path: s.path, reason: s.reason })),
    failures: result.failures,
    usage: { ...result.usage },
    models: result.models,
    reviewedAt: now.toISOString(),
  };
}
