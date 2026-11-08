import type { Category, ErrorCode, ReviewEvent, Severity, WebReviewResult } from "../../src/server/types";

export type CandidateStatus = "pending" | "refuted" | "survived";

export interface LiveCandidate {
  id: string;
  file: string;
  line: number;
  title: string;
  severity: Severity;
  category: Category;
  status: CandidateStatus;
  reason: string | null;
}

export type StageKey = "accepted" | "pr" | "files" | "analyzing" | "candidates" | "verifying" | "done";

export interface Stage {
  key: StageKey;
  label: string;
  /** Milliseconds since the review started. */
  at: number;
}

export interface ReviewState {
  phase: "idle" | "running" | "done" | "error";
  url: string;
  startedAt: number;
  cached: boolean;
  stages: Stage[];
  pr: { title: string; author: string; headSha: string; url: string } | null;
  candidates: LiveCandidate[] | null;
  verdicts: number;
  result: WebReviewResult | null;
  error: { code: ErrorCode | "network"; message: string; retryAfterSec?: number } | null;
}

export const IDLE: ReviewState = {
  phase: "idle",
  url: "",
  startedAt: 0,
  cached: false,
  stages: [],
  pr: null,
  candidates: null,
  verdicts: 0,
  result: null,
  error: null,
};

export type Action =
  | { type: "start"; url: string; now: number }
  | { type: "event"; event: ReviewEvent; now: number }
  | { type: "fail"; code: ErrorCode | "network"; message: string; retryAfterSec?: number }
  | { type: "reset" };

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

function stage(state: ReviewState, key: StageKey, label: string, now: number): Stage[] {
  const at = Math.max(0, now - state.startedAt);
  const kept = state.stages.filter((s) => s.key !== key);
  return [...kept, { key, label, at }];
}

function candidatesFromResult(result: WebReviewResult): LiveCandidate[] {
  return result.findings.map((f) => ({
    id: f.id,
    file: f.file,
    line: f.line,
    title: f.title,
    severity: f.severity,
    category: f.category,
    status: f.placement === "refuted" ? "refuted" : "survived",
    reason: f.verdict?.reason ?? null,
  }));
}

function onEvent(state: ReviewState, e: ReviewEvent, now: number): ReviewState {
  switch (e.type) {
    case "accepted":
      return {
        ...state,
        cached: e.cached,
        stages: stage(state, "accepted", e.cached ? "Served from cache" : "Accepted", now),
      };
    case "pr":
      return {
        ...state,
        pr: { title: e.title, author: e.author, headSha: e.headSha, url: e.url },
        stages: stage(state, "pr", `Fetched PR at ${e.headSha.slice(0, 7)}`, now),
      };
    case "files":
      return {
        ...state,
        stages: stage(
          state,
          "files",
          `${plural(e.reviewable, "file")} to review${e.skipped ? `, ${e.skipped} skipped` : ""}`,
          now,
        ),
      };
    case "analyzing":
      return { ...state, stages: stage(state, "analyzing", `Pass 1: finding (${plural(e.groups, "request")})`, now) };
    case "candidates":
      return {
        ...state,
        candidates: e.findings.map((f) => ({ ...f, status: "pending", reason: null })),
        stages: stage(state, "candidates", `Pass 1 raised ${plural(e.count, "candidate")}`, now),
      };
    case "verdict": {
      const candidates = (state.candidates ?? []).map((c) =>
        c.id === e.id ? { ...c, status: e.refuted ? ("refuted" as const) : ("survived" as const), reason: e.reason } : c,
      );
      return {
        ...state,
        candidates,
        verdicts: e.done,
        stages: stage(state, "verifying", `Pass 2: refuting (${e.done}/${e.total})`, now),
      };
    }
    case "verified":
      return {
        ...state,
        stages: stage(state, "verifying", `Pass 2: ${e.refuted} refuted, ${e.survived} survived`, now),
      };
    case "result":
      return {
        ...state,
        phase: "done",
        result: e.result,
        pr: {
          title: e.result.pr.title,
          author: e.result.pr.author,
          headSha: e.result.pr.headSha,
          url: e.result.pr.url,
        },
        candidates: candidatesFromResult(e.result),
        stages: stage(state, "done", "Done", now),
      };
    case "error":
      return { ...state, phase: "error", error: { code: e.code, message: e.message } };
  }
}

export function reduce(state: ReviewState, action: Action): ReviewState {
  switch (action.type) {
    case "start":
      return { ...IDLE, phase: "running", url: action.url, startedAt: action.now };
    case "event":
      return onEvent(state, action.event, action.now);
    case "fail":
      return {
        ...state,
        phase: "error",
        error: { code: action.code, message: action.message, retryAfterSec: action.retryAfterSec },
      };
    case "reset":
      return IDLE;
  }
}

/**
 * Letters for findings, assigned left to right along the spectrum the way
 * Fraunhofer lettered his lines: by file path, then line. Stable between the
 * live stream and the final result, because both sort the same way.
 */
export function letterMap(items: Array<{ id: string; file: string; line: number }>): Map<string, string> {
  const sorted = [...items].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
  const out = new Map<string, string>();
  sorted.forEach((item, i) => out.set(item.id, letterFor(i)));
  return out;
}

export function letterFor(index: number): string {
  const A = 65;
  if (index < 26) return String.fromCharCode(A + index);
  return letterFor(Math.floor(index / 26) - 1) + String.fromCharCode(A + (index % 26));
}
