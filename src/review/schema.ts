import { createHash } from "node:crypto";
import { z } from "zod";
import { CATEGORIES, SEVERITIES, type Category, type Severity } from "../config.js";
import { normalizedLineContent, type ParsedFile } from "../github/diff.js";

/**
 * Note the deliberate absence of `.optional()` and of numeric min/max: strict
 * JSON-schema mode on several providers requires every property to be present
 * and rejects range keywords, so nullability and clamping are handled here
 * rather than in the schema sent over the wire.
 */
export const FindingSchema = z
  .object({
    file: z.string(),
    line: z.number().int(),
    category: z.enum(CATEGORIES),
    severity: z.enum(SEVERITIES),
    confidence: z.number(),
    title: z.string(),
    body: z.string(),
    failure_scenario: z.string(),
    suggested_patch: z.string().nullable(),
  })
  .strict();

export type Finding = z.infer<typeof FindingSchema>;

export const FindingsResponseSchema = z.object({ findings: z.array(FindingSchema) }).strict();

export const VerdictSchema = z
  .object({
    refuted: z.boolean(),
    reason: z.string(),
    corrected_severity: z.enum(SEVERITIES).nullable(),
    corrected_confidence: z.number().nullable(),
  })
  .strict();

export type Verdict = z.infer<typeof VerdictSchema>;

export interface ReviewedFinding extends Finding {
  fingerprint: string;
  verdict?: Verdict;
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Stable identity for a finding across pushes.
 *
 * Keyed on the normalized content of the cited line rather than its number, so
 * inserting code above a defect does not resurrect a comment the bot already
 * posted, while genuinely editing that line does surface it again.
 */
export function fingerprint(finding: Finding, file: ParsedFile | undefined): string {
  const code = file ? normalizedLineContent(file, finding.line) : "";
  const material = [
    finding.file,
    code,
    finding.category,
    finding.title.trim().toLowerCase(),
  ].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export const FINGERPRINT_PREFIX = "ai-review:fp=";

export function fingerprintMarker(fp: string): string {
  return "<!-- " + FINGERPRINT_PREFIX + fp + " -->";
}

export function extractFingerprints(body: string): string[] {
  const out: string[] = [];
  const re = new RegExp(FINGERPRINT_PREFIX + "([0-9a-f]{16})", "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]!);
  return out;
}

export interface FindingFilterOptions {
  severityThreshold: Severity;
  minConfidence: number;
  focus: Category[];
}

export function meetsBar(finding: Finding, opts: FindingFilterOptions): boolean {
  const rank = SEVERITIES.indexOf(finding.severity);
  const threshold = SEVERITIES.indexOf(opts.severityThreshold);
  if (rank < threshold) return false;
  if (clampConfidence(finding.confidence) < opts.minConfidence) return false;
  return true;
}

/** Highest severity first, then most confident, then by location for stability. */
export function rankFindings<T extends Finding>(findings: T[]): T[] {
  return [...findings].sort((a, b) => {
    const sev = SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity);
    if (sev !== 0) return sev;
    const conf = clampConfidence(b.confidence) - clampConfidence(a.confidence);
    if (conf !== 0) return conf;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });
}
