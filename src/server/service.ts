import type OpenAI from "openai";
import type { Config } from "../config.js";
import type { GitHubClient } from "../github/client.js";
import type { RunEvent, RunOptions, RunResult } from "../review/run.js";
import { LruCache, SlidingWindowLimiter, type Clock } from "./limits.js";
import { toWebResult } from "./result.js";
import type { ErrorCode, ReviewEvent, WebReviewResult } from "./types.js";
import { cacheKey, redactSecrets, type PullTarget } from "./validate.js";

export interface ServerSettings {
  /** The server's own OpenRouter key. Optional: without it, visitors must bring one. */
  openRouterKey: string | null;
  model: string;
  verifyModel: string;
  effort: Config["effort"];
  maxChangedFiles: number;
  maxChangedLines: number;
  timeoutMs: number;
  /** Reviews per IP per hour on the server's key. */
  perIpPerHour: number;
  /** Reviews per IP per hour with a visitor's own key (protects the GitHub token). */
  byokPerIpPerHour: number;
  /** Reviews per day on the server's key, across all visitors. */
  globalPerDay: number;
  maxConcurrent: number;
  cacheSize: number;
}

export interface ServiceDeps {
  settings: ServerSettings;
  /** Client used for cheap preflight reads (PR metadata). */
  github: GitHubClient;
  /** Fresh read-only GitHub client bound to a job's abort signal. */
  createGitHub: (signal: AbortSignal) => GitHubClient;
  createModelClient: (apiKey: string, signal: AbortSignal) => OpenAI;
  runReview: (opts: RunOptions) => Promise<RunResult>;
  now?: Clock;
  log?: (entry: Record<string, unknown>) => void;
}

export class ReviewError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

export interface Preflight {
  target: PullTarget;
  headSha: string;
  key: string;
}

type Listener = (event: ReviewEvent) => void;

const MAX_HISTORY = 500;

/** One running review. Late subscribers get the full event history replayed. */
export class Job {
  readonly history: ReviewEvent[] = [];
  private readonly listeners = new Set<Listener>();
  done = false;

  constructor(readonly key: string) {}

  emit(event: ReviewEvent): void {
    // Verdicts are per candidate and model-driven; keep replay memory bounded.
    if (this.history.length < MAX_HISTORY || event.type !== "verdict") this.history.push(event);
    if (event.type === "result" || event.type === "error") this.done = true;
    for (const l of [...this.listeners]) l(event);
  }

  subscribe(listener: Listener): () => void {
    for (const e of this.history) listener(e);
    if (this.done) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PREFLIGHT_TIMEOUT_MS = 15_000;

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

function messageOf(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 400);
}

/** Turn a raw OpenRouter failure into something a visitor can act on. */
export function modelFailureMessage(raw: string, byok: boolean): string {
  const status = /^(\d{3})\b/.exec(raw.trim())?.[1];
  if (status === "402") {
    return byok
      ? "Your OpenRouter key is out of credits. Add credits at openrouter.ai, then try again."
      : "The demo's shared model key is out of credits. Paste your own OpenRouter key to run this review.";
  }
  if (status === "401" || status === "403") {
    return byok
      ? "OpenRouter rejected that key. Check it at openrouter.ai/keys."
      : "The demo's shared model key was rejected. Paste your own OpenRouter key to run this review.";
  }
  if (status === "429") return "The model provider is rate limiting right now. Try again in a minute.";
  return `The model call failed: ${redactSecrets(raw).slice(0, 300)}`;
}

function retrySec(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export class ReviewService {
  readonly cache: LruCache<WebReviewResult>;
  private readonly inflight = new Map<string, Job>();
  private readonly ipLimiter: SlidingWindowLimiter;
  private readonly byokLimiter: SlidingWindowLimiter;
  private readonly globalLimiter: SlidingWindowLimiter;
  private readonly now: Clock;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(private readonly deps: ServiceDeps) {
    const s = deps.settings;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.cache = new LruCache(s.cacheSize);
    this.ipLimiter = new SlidingWindowLimiter(s.perIpPerHour, HOUR, this.now);
    this.byokLimiter = new SlidingWindowLimiter(s.byokPerIpPerHour, HOUR, this.now);
    this.globalLimiter = new SlidingWindowLimiter(s.globalPerDay, DAY, this.now);
  }

  get settings(): Readonly<ServerSettings> {
    return this.deps.settings;
  }

  get running(): number {
    return this.inflight.size;
  }

  /** Remaining server-key reviews for this IP, for the UI's quota hint. */
  quota(ip: string): { remaining: number; limit: number; serverKey: boolean } {
    const s = this.deps.settings;
    if (!s.openRouterKey) return { remaining: 0, limit: 0, serverKey: false };
    const ipLeft = this.ipLimiter.check(ip).remaining;
    const globalLeft = this.globalLimiter.check("global").remaining;
    return { remaining: Math.min(ipLeft, globalLeft), limit: s.perIpPerHour, serverKey: true };
  }

  sweep(): void {
    this.ipLimiter.sweep();
    this.byokLimiter.sweep();
  }

  /**
   * One cheap read before anything is spent: the PR must exist, be public, be
   * small enough, and its head SHA keys the cache.
   */
  async preflight(target: PullTarget): Promise<Preflight> {
    let data: Awaited<ReturnType<GitHubClient["pulls"]["get"]>>["data"];
    try {
      const res = await this.deps.github.pulls.get({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.pull,
        request: { signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) },
      });
      data = res.data;
    } catch (err) {
      const status = statusOf(err);
      if (status === 404) {
        throw new ReviewError(
          "not_found",
          "That pull request does not exist, or it is in a private repository.",
          404,
        );
      }
      if (status === 403 || status === 429) {
        throw new ReviewError("github_error", "GitHub is rate limiting this demo. Try again in a few minutes.", 503, 60);
      }
      throw new ReviewError("github_error", `GitHub request failed: ${messageOf(err)}`, 502);
    }

    const visibility = data.base.repo.visibility ?? (data.base.repo.private ? "private" : "public");
    if (data.base.repo.private || visibility !== "public") {
      throw new ReviewError(
        "private_repo",
        "This demo only reviews public repositories. Install the GitHub Action to review private code.",
        403,
      );
    }

    const s = this.deps.settings;
    const lines = (data.additions ?? 0) + (data.deletions ?? 0);
    if ((data.changed_files ?? 0) > s.maxChangedFiles || lines > s.maxChangedLines) {
      throw new ReviewError(
        "too_large",
        `This pull request changes ${data.changed_files} files and ${lines} lines. ` +
          `The demo caps reviews at ${s.maxChangedFiles} files and ${s.maxChangedLines} lines; ` +
          "the GitHub Action has no such cap.",
        413,
      );
    }

    return { target, headSha: data.head.sha, key: cacheKey(target, data.head.sha) };
  }

  /**
   * Return a job to subscribe to: a cached result, a review already running
   * for the same head SHA, or a newly started one. Rate limits are only
   * charged in the last case.
   */
  start(pre: Preflight, ip: string, byokKey: string | null): Job {
    const cached = this.cache.get(pre.key);
    if (cached) {
      const job = new Job(pre.key);
      job.emit({ type: "accepted", cached: true, key: pre.key });
      job.emit({ type: "result", result: cached });
      return job;
    }

    const running = this.inflight.get(pre.key);
    if (running) return running;

    const s = this.deps.settings;
    const apiKey = byokKey ?? s.openRouterKey;
    if (!apiKey) {
      throw new ReviewError(
        "invalid_key",
        "This deployment has no shared model key. Paste your own OpenRouter key to run a review.",
        400,
      );
    }

    if (this.inflight.size >= s.maxConcurrent) {
      throw new ReviewError("busy", "The demo is running several reviews right now. Try again in a minute.", 503, 30);
    }

    if (byokKey) {
      const d = this.byokLimiter.check(ip);
      if (!d.ok) {
        throw new ReviewError("rate_limited", "Too many reviews from this address. Try again later.", 429, retrySec(d.retryAfterMs));
      }
      this.byokLimiter.consume(ip);
    } else {
      const g = this.globalLimiter.check("global");
      if (!g.ok) {
        throw new ReviewError(
          "rate_limited",
          "Today's shared demo budget is used up. Paste your own OpenRouter key to keep going.",
          429,
          retrySec(g.retryAfterMs),
        );
      }
      const d = this.ipLimiter.check(ip);
      if (!d.ok) {
        throw new ReviewError(
          "rate_limited",
          `The shared key allows ${s.perIpPerHour} reviews per hour per visitor. Paste your own OpenRouter key, or try again later.`,
          429,
          retrySec(d.retryAfterMs),
        );
      }
      this.ipLimiter.consume(ip);
      this.globalLimiter.consume("global");
    }

    const job = new Job(pre.key);
    this.inflight.set(pre.key, job);
    job.emit({ type: "accepted", cached: false, key: pre.key });
    void this.execute(job, pre, apiKey, byokKey !== null).finally(() => {
      this.inflight.delete(pre.key);
    });
    return job;
  }

  private async execute(job: Job, pre: Preflight, apiKey: string, byok: boolean): Promise<void> {
    const s = this.deps.settings;
    const started = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), s.timeoutMs);

    let groups = 0;
    let candidates = 0;
    let verdicts = 0;

    const onEvent = (e: RunEvent): void => {
      switch (e.type) {
        case "pr":
          job.emit({ type: "pr", title: e.pr.title, author: e.pr.author, headSha: e.pr.headSha, url: e.pr.url });
          break;
        case "files":
          job.emit({ type: "files", reviewable: e.reviewable, skipped: e.skipped });
          break;
        case "analyzing":
          groups = e.groups;
          job.emit({ type: "analyzing", groups: e.groups });
          break;
        case "candidates":
          candidates = e.findings.length;
          job.emit({
            type: "candidates",
            count: e.findings.length,
            findings: e.findings.map((f) => ({
              id: f.fingerprint, file: f.file, line: f.line,
              title: f.title, severity: f.severity, category: f.category,
            })),
          });
          break;
        case "verdict":
          verdicts += 1;
          job.emit({
            type: "verdict",
            id: e.finding.fingerprint,
            refuted: e.refuted,
            reason: e.reason,
            done: verdicts,
            total: candidates,
          });
          break;
        case "verified":
          job.emit({ type: "verified", survived: e.survived, refuted: e.refuted });
          break;
      }
    };

    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new ReviewError(
        "timeout",
        `The review took longer than ${Math.round(s.timeoutMs / 1000)}s and was stopped.`,
        504,
      )), { once: true });
    });
    // The cleanup abort in `finally` rejects this after the race has settled;
    // without a handler that would be an unhandled rejection.
    aborted.catch(() => {});

    this.log({ msg: "review.start", key: pre.key, byok });

    try {
      const result = await Promise.race([
        this.deps.runReview({
          gh: this.deps.createGitHub(controller.signal),
          client: this.deps.createModelClient(apiKey, controller.signal),
          openRouterKey: apiKey,
          ref: { owner: pre.target.owner, repo: pre.target.repo },
          pull: pre.target.pull,
          // Server-side settings override the reviewed repo's own config, so a
          // repo cannot point the demo at an expensive model.
          inputs: {
            model: s.model,
            verifyModel: s.verifyModel,
            fallbackModels: [],
            effort: s.effort,
            maxFiles: s.maxChangedFiles,
            // Unbounded repo-supplied prompt text would inflate every request.
            customRules: [],
          },
          // The web path never writes to GitHub. The client is read-only too.
          dryRun: true,
          onEvent,
        }),
        aborted,
      ]);

      if (groups > 0 && result.failures.length >= groups) {
        const first = result.failures[0]?.error ?? "unknown error";
        throw new ReviewError("model_error", modelFailureMessage(first, byok), 502);
      }

      const safe = {
        ...result,
        failures: result.failures.map((f) => ({ paths: f.paths, error: redactSecrets(f.error).slice(0, 300) })),
      };
      const web = toWebResult(safe, pre.target, this.now() - started);
      // A push between preflight and fetch means the review covers a newer
      // head; cache it under the SHA it actually reviewed.
      this.cache.set(cacheKey(pre.target, result.pr.headSha), web);
      job.emit({ type: "result", result: web });
      this.log({
        msg: "review.done", key: pre.key, byok,
        ms: web.stats.durationMs, candidates: web.stats.candidates,
        reported: web.stats.reported, cost: web.usage.cost,
      });
    } catch (err) {
      const e = err instanceof ReviewError
        ? err
        : new ReviewError(statusOf(err) === 404 ? "not_found" : "internal", `The review failed: ${messageOf(err)}`, 500);
      job.emit({ type: "error", code: e.code, message: e.message });
      this.log({ msg: "review.error", key: pre.key, byok, code: e.code, error: e.message });
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort(new Error("finished"));
    }
  }
}
