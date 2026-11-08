/**
 * Wire types shared by the server and the web app.
 *
 * Kept free of runtime imports so the browser bundle can `import type` from
 * here without pulling in Node code.
 */

export type Severity = "low" | "medium" | "high" | "critical";
export type Category = "bug" | "edge-case" | "performance" | "security" | "test-gap" | "style";

/**
 * Where a pass-1 candidate ended up.
 *
 * - inline: survived and would be posted on its line
 * - summary: survived, but its line is outside the diff (or over the cap)
 * - below-bar: survived, but under the severity/confidence bar
 * - duplicate: already posted on this PR by the Action on an earlier push
 * - refuted: knocked down by the adversarial verify pass
 */
export type Placement = "inline" | "summary" | "below-bar" | "duplicate" | "refuted";

export interface WebFinding {
  id: string;
  file: string;
  line: number;
  category: Category;
  severity: Severity;
  confidence: number;
  title: string;
  body: string;
  failureScenario: string;
  suggestion: string | null;
  placement: Placement;
  /** Pass-1 values, when the verifier corrected them. */
  original: { severity: Severity; confidence: number } | null;
  verdict: { refuted: boolean; reason: string } | null;
}

export type DiffLineKind = "add" | "del" | "context";

export interface WebDiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface WebHunk {
  header: string;
  lines: WebDiffLine[];
}

export interface WebFileDiff {
  path: string;
  status: string;
  hunks: WebHunk[];
}

export interface WebReviewResult {
  version: 1;
  pr: {
    owner: string;
    repo: string;
    number: number;
    title: string;
    author: string;
    url: string;
    headSha: string;
    isFork: boolean;
  };
  config: {
    model: string;
    verifyModel: string;
    effort: string;
    severityThreshold: Severity;
    minConfidence: number;
  };
  stats: {
    filesReviewed: number;
    candidates: number;
    survived: number;
    refuted: number;
    reported: number;
    durationMs: number;
  };
  findings: WebFinding[];
  /** Diffs for the files that have at least one finding, in any placement. */
  diffs: WebFileDiff[];
  reviewedFiles: Array<{ path: string; status: string; additions: number; deletions: number }>;
  skipped: Array<{ path: string; reason: string }>;
  failures: Array<{ paths: string[]; error: string }>;
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number; cost: number };
  models: string[];
  reviewedAt: string;
}

/** Events on the SSE stream, in the order a review emits them. */
export type ReviewEvent =
  | { type: "accepted"; cached: boolean; key: string }
  | { type: "pr"; title: string; author: string; headSha: string; url: string }
  | { type: "files"; reviewable: number; skipped: number }
  | { type: "analyzing"; groups: number }
  | {
      type: "candidates";
      count: number;
      findings: Array<{ id: string; file: string; line: number; title: string; severity: Severity; category: Category }>;
    }
  | { type: "verdict"; id: string; refuted: boolean; reason: string; done: number; total: number }
  | { type: "verified"; survived: number; refuted: number }
  | { type: "result"; result: WebReviewResult }
  | { type: "error"; code: ErrorCode; message: string };

export type ErrorCode =
  | "invalid_url"
  | "invalid_key"
  | "not_found"
  | "private_repo"
  | "too_large"
  | "rate_limited"
  | "busy"
  | "github_error"
  | "model_error"
  | "timeout"
  | "internal";

export interface ApiError {
  error: { code: ErrorCode; message: string; retryAfterSec?: number };
}

export interface SampleInfo {
  url: string;
  label: string;
  blurb: string;
  cached: boolean;
}
