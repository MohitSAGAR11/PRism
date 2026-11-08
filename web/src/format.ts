import type { Placement, Severity } from "../../src/server/types";

export function seconds(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

export function usd(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function tokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n.toLocaleString("en-US");
}

export function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function shortModel(slug: string): string {
  const i = slug.indexOf("/");
  return i === -1 ? slug : slug.slice(i + 1);
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const PLACEMENT_LABEL: Record<Placement, string> = {
  inline: "Inline comment",
  summary: "Summary comment",
  "below-bar": "Below the reporting bar",
  duplicate: "Already posted on this PR",
  refuted: "Refuted",
};

/** Client-side mirror of the server's URL check, for instant feedback. */
export function looksLikePullUrl(value: string): boolean {
  return /^(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/\d{1,7}(?:\/(?:files|commits|checks|changes))?\/?(?:[?#].*)?$/i.test(
    value.trim(),
  );
}
