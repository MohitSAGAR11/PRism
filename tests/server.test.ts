import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createOctokit, type GitHubClient } from "../src/github/client.js";
import { parseFile } from "../src/github/diff.js";
import { ZERO_USAGE } from "../src/llm/client.js";
import { splitFindings } from "../src/review/render.js";
import type { RunOptions, RunResult } from "../src/review/run.js";
import { fingerprint, type Finding, type ReviewedFinding } from "../src/review/schema.js";
import { createApp } from "../src/server/app.js";
import { LruCache, SlidingWindowLimiter } from "../src/server/limits.js";
import { buildFindings, makeReadOnly, ReadOnlyViolation } from "../src/server/result.js";
import { ReviewService, type ServerSettings } from "../src/server/service.js";
import type { ReviewEvent, WebReviewResult } from "../src/server/types.js";
import { parseOpenRouterKey, parsePullUrl, redactSecrets } from "../src/server/validate.js";

// ---------------------------------------------------------------------------
// URL and key validation
// ---------------------------------------------------------------------------

describe("parsePullUrl", () => {
  it.each([
    ["https://github.com/expressjs/express/pull/7589", "expressjs", "express", 7589],
    ["github.com/sindresorhus/ky/pull/868", "sindresorhus", "ky", 868],
    ["https://www.github.com/a/b.js/pull/1/", "a", "b.js", 1],
    ["https://github.com/a-b/c_d/pull/12/files", "a-b", "c_d", 12],
    ["https://github.com/o/r/pull/3/commits?x=1#diff", "o", "r", 3],
    ["  http://github.com/o/r/pull/3  ", "o", "r", 3],
  ])("accepts %s", (input, owner, repo, pull) => {
    expect(parsePullUrl(input)).toEqual({ ok: true, value: { owner, repo, pull } });
  });

  it.each([
    ["", "empty"],
    ["not a url", "free text"],
    ["https://gitlab.com/o/r/pull/1", "another host"],
    ["https://github.com.evil.com/o/r/pull/1", "lookalike host"],
    ["https://evil.com/github.com/o/r/pull/1", "host in path"],
    ["https://user:pw@github.com/o/r/pull/1", "credentials"],
    ["https://github.com:8443/o/r/pull/1", "port"],
    ["ftp://github.com/o/r/pull/1", "scheme"],
    ["https://github.com/o/r/issues/1", "issue, not PR"],
    ["https://github.com/o/r/pull/abc", "non-numeric number"],
    ["https://github.com/o/r/pull/0", "zero"],
    ["https://github.com/o/r/pull/99999999999", "out of range"],
    ["https://github.com/-o/r/pull/1", "leading hyphen owner"],
    ["https://github.com/o/../pull/1", "dot-dot repo"],
    ["https://github.com/o/r/pull/1/../../x", "trailing junk"],
    ["https://github.com/o/r/pull/1/files/extra", "unknown suffix"],
    ["https://github.com/o/r%2Fx/pull/1", "encoded slash"],
    ["https://github.com/" + "a".repeat(300) + "/r/pull/1", "too long"],
  ])("rejects %s (%s)", (input) => {
    expect(parsePullUrl(input).ok).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(parsePullUrl(42).ok).toBe(false);
    expect(parsePullUrl({ url: "x" }).ok).toBe(false);
    expect(parsePullUrl(undefined).ok).toBe(false);
  });
});

describe("parseOpenRouterKey", () => {
  it("treats absent or blank as no key", () => {
    expect(parseOpenRouterKey(undefined)).toEqual({ ok: true, value: null });
    expect(parseOpenRouterKey("   ")).toEqual({ ok: true, value: null });
  });

  it("accepts the OpenRouter shape", () => {
    const key = "sk-or-v1-" + "a1".repeat(32);
    expect(parseOpenRouterKey(key)).toEqual({ ok: true, value: key });
  });

  it("rejects other shapes, and never echoes the input", () => {
    const bad = parseOpenRouterKey("sk-proj-secretsecretsecret");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).not.toContain("secretsecret");
    expect(parseOpenRouterKey(123).ok).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("strips keys and tokens from messages", () => {
    const msg = redactSecrets(
      "401 for sk-or-v1-abcdef0123456789 with ghp_" + "x".repeat(36) + " and Bearer abc.def.ghi123",
    );
    expect(msg).not.toMatch(/abcdef0123456789|xxxxxxxx|abc\.def/);
    expect(msg).toContain("[redacted]");
  });
});

// ---------------------------------------------------------------------------
// Rate limiting and cache
// ---------------------------------------------------------------------------

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit, then reports when the next slot frees", () => {
    let now = 1_000_000;
    const lim = new SlidingWindowLimiter(3, 60_000, () => now);
    expect(lim.take("ip").ok).toBe(true);
    now += 10_000;
    expect(lim.take("ip").ok).toBe(true);
    expect(lim.take("ip").ok).toBe(true);

    const denied = lim.take("ip");
    expect(denied.ok).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBe(50_000);

    now += 50_001;
    expect(lim.take("ip").ok).toBe(true);
  });

  it("keeps keys independent", () => {
    const lim = new SlidingWindowLimiter(1, 60_000, () => 0);
    expect(lim.take("a").ok).toBe(true);
    expect(lim.take("a").ok).toBe(false);
    expect(lim.take("b").ok).toBe(true);
  });

  it("check does not consume", () => {
    const lim = new SlidingWindowLimiter(1, 60_000, () => 0);
    expect(lim.check("a").ok).toBe(true);
    expect(lim.check("a").ok).toBe(true);
    lim.consume("a");
    expect(lim.check("a").ok).toBe(false);
  });

  it("a zero limit denies everything", () => {
    expect(new SlidingWindowLimiter(0, 1000).check("a").ok).toBe(false);
  });

  it("sweep drops expired keys", () => {
    let now = 0;
    const lim = new SlidingWindowLimiter(5, 1000, () => now);
    lim.take("a");
    lim.take("b");
    expect(lim.size).toBe(2);
    now = 5000;
    lim.sweep();
    expect(lim.size).toBe(0);
  });
});

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const c = new LruCache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.set("c", 3);
    expect(c.has("a")).toBe(true);
    expect(c.has("b")).toBe(false);
    expect(c.has("c")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Read-only guarantee
// ---------------------------------------------------------------------------

describe("makeReadOnly", () => {
  it("refuses every write before it reaches the network", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    const gh = makeReadOnly(createOctokit("t", { quiet: true, fetch: fetchSpy as unknown as typeof fetch }));

    await expect(
      gh.issues.createComment({ owner: "o", repo: "r", issue_number: 1, body: "hi" }),
    ).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(
      gh.pulls.createReview({ owner: "o", repo: "r", pull_number: 1, event: "COMMENT" }),
    ).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(
      gh.issues.updateComment({ owner: "o", repo: "r", comment_id: 1, body: "x" }),
    ).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still allows reads", async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const gh = makeReadOnly(createOctokit("t", { quiet: true, fetch: fetchSpy as unknown as typeof fetch }));
    const res = await gh.repos.get({ owner: "o", repo: "r" });
    expect(res.data).toEqual({ id: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Pipeline result -> web result
// ---------------------------------------------------------------------------

const PATCH = ["@@ -1,3 +1,5 @@", " const a = 1;", "+const b = 2;", "+const c = 3;", " use(a);"].join("\n");
const FILE = parseFile({ filename: "src/app.ts", status: "modified", patch: PATCH });

function finding(over: Partial<Finding> = {}): ReviewedFinding {
  const f: Finding = {
    file: "src/app.ts",
    line: 2,
    category: "bug",
    severity: "high",
    confidence: 0.9,
    title: "Off-by-one",
    body: "Reads past the end.",
    failure_scenario: "items=[1] reads items[1].",
    suggested_patch: null,
    ...over,
  };
  return { ...f, fingerprint: fingerprint(f, FILE) };
}

function fakeRunResult(): RunResult {
  const real = finding();
  const outside = finding({ line: 40, title: "Outside the diff" });
  const weak = finding({ line: 3, title: "Weak", severity: "low", confidence: 0.4 });
  const wrong = finding({ line: 3, title: "Not a bug" });

  const survivors: ReviewedFinding[] = [
    { ...real, confidence: 0.95, verdict: { refuted: false, reason: "confirmed", corrected_severity: null, corrected_confidence: 0.95 } },
    { ...outside, verdict: { refuted: false, reason: "real", corrected_severity: null, corrected_confidence: null } },
    { ...weak, verdict: { refuted: false, reason: "minor", corrected_severity: null, corrected_confidence: null } },
  ];
  const refuted: ReviewedFinding[] = [
    { ...wrong, verdict: { refuted: true, reason: "guarded on line 1", corrected_severity: null, corrected_confidence: null } },
  ];
  const cfg = { ...DEFAULT_CONFIG };
  const split = splitFindings({
    findings: survivors,
    filesByPath: new Map([[FILE.path, FILE]]),
    cfg,
    alreadyPosted: new Set(),
  });

  return {
    pr: {
      number: 7, title: "Fix things", body: "", baseSha: "b".repeat(40), headSha: "a".repeat(40),
      author: "dev", url: "https://github.com/o/r/pull/7", isFork: false,
    },
    cfg,
    split,
    refuted,
    summary: "",
    usage: { ...ZERO_USAGE, promptTokens: 100, cost: 0.001 },
    models: ["m1", "m2"],
    filesReviewed: 1,
    skipped: [{ path: "package-lock.json", reason: "generated" }],
    posted: false,
    candidates: [real, outside, weak, wrong],
    survivors,
    failures: [],
    files: [FILE],
  };
}

describe("buildFindings", () => {
  it("places every candidate exactly once, survivors first", () => {
    const out = buildFindings(fakeRunResult());
    expect(out.map((f) => [f.title, f.placement])).toEqual([
      ["Off-by-one", "inline"],
      ["Outside the diff", "summary"],
      ["Weak", "below-bar"],
      ["Not a bug", "refuted"],
    ]);
  });

  it("keeps the refutation reason and the pass-1 values the verifier corrected", () => {
    const out = buildFindings(fakeRunResult());
    expect(out.find((f) => f.placement === "refuted")?.verdict).toEqual({ refuted: true, reason: "guarded on line 1" });
    expect(out[0]!.original).toEqual({ severity: "high", confidence: 0.9 });
    expect(out[0]!.confidence).toBe(0.95);
    expect(out[1]!.original).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP + SSE
// ---------------------------------------------------------------------------

const SETTINGS: ServerSettings = {
  openRouterKey: "sk-or-v1-server",
  model: "m1",
  verifyModel: "m2",
  effort: "medium",
  maxChangedFiles: 30,
  maxChangedLines: 1500,
  timeoutMs: 5_000,
  perIpPerHour: 2,
  byokPerIpPerHour: 5,
  globalPerDay: 100,
  maxConcurrent: 3,
  cacheSize: 10,
};

interface PullData {
  private?: boolean;
  visibility?: string;
  changed_files?: number;
  additions?: number;
  deletions?: number;
  status?: number;
}

function fakeGithub(pull: PullData = {}): GitHubClient {
  return {
    pulls: {
      get: vi.fn(async () => {
        if (pull.status) throw Object.assign(new Error("Not Found"), { status: pull.status });
        return {
          data: {
            head: { sha: "a".repeat(40) },
            base: { repo: { private: pull.private ?? false, visibility: pull.visibility ?? "public" } },
            changed_files: pull.changed_files ?? 1,
            additions: pull.additions ?? 2,
            deletions: pull.deletions ?? 0,
          },
        };
      }),
    },
  } as unknown as GitHubClient;
}

async function fakeRun(opts: RunOptions): Promise<RunResult> {
  const result = fakeRunResult();
  opts.onEvent?.({ type: "pr", pr: result.pr });
  opts.onEvent?.({ type: "files", reviewable: 1, skipped: 1 });
  opts.onEvent?.({ type: "analyzing", groups: 1 });
  opts.onEvent?.({ type: "candidates", findings: result.candidates });
  for (const f of result.candidates) {
    const r = result.refuted.find((x) => x.fingerprint === f.fingerprint);
    opts.onEvent?.({ type: "verdict", finding: f, refuted: !!r, reason: r?.verdict?.reason ?? "ok" });
  }
  opts.onEvent?.({ type: "verified", survived: 3, refuted: 1 });
  return result;
}

function setup(over: { pull?: PullData; settings?: Partial<ServerSettings>; runReview?: typeof fakeRun } = {}) {
  const runReview = vi.fn(over.runReview ?? fakeRun);
  const service = new ReviewService({
    settings: { ...SETTINGS, ...over.settings },
    github: fakeGithub(over.pull),
    createGitHub: () => fakeGithub(over.pull),
    createModelClient: () => ({}) as OpenAI,
    runReview,
  });
  const app = createApp({ service, samples: () => [], clientIp: () => "1.2.3.4", heartbeatMs: 60_000 });
  const post = (body: unknown) =>
    app.request("/api/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, service, runReview, post };
}

function parseSse(text: string): ReviewEvent[] {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)) as ReviewEvent);
}

const URL_OK = "https://github.com/o/r/pull/7";

describe("POST /api/review", () => {
  it("streams stages in order and ends with a structured result", async () => {
    const { post, runReview } = setup();
    const res = await post({ url: URL_OK });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await res.text());
    expect(events.map((e) => e.type)).toEqual([
      "accepted", "pr", "files", "analyzing", "candidates",
      "verdict", "verdict", "verdict", "verdict", "verified", "result",
    ]);

    const verdicts = events.filter((e) => e.type === "verdict");
    expect(verdicts.at(-1)).toMatchObject({ done: 4, total: 4 });

    const last = events.at(-1) as { type: "result"; result: WebReviewResult };
    expect(last.result.version).toBe(1);
    expect(last.result.stats).toMatchObject({ filesReviewed: 1, candidates: 4, survived: 3, refuted: 1, reported: 2 });
    expect(last.result.findings[0]).toMatchObject({
      file: "src/app.ts", line: 2, severity: "high", category: "bug",
      title: "Off-by-one", failureScenario: "items=[1] reads items[1].", placement: "inline",
    });
    expect(last.result.diffs.map((d) => d.path)).toEqual(["src/app.ts"]);
    expect(last.result.diffs[0]!.hunks[0]!.lines[1]).toEqual({ kind: "add", oldLine: null, newLine: 2, content: "const b = 2;" });

    // Read-only: the pipeline is always asked for a dry run, with server-pinned models.
    const opts = runReview.mock.calls[0]![0];
    expect(opts.dryRun).toBe(true);
    expect(opts.inputs).toMatchObject({ model: "m1", verifyModel: "m2", fallbackModels: [] });
  });

  it("serves a repeat request from cache without running or charging", async () => {
    const { post, runReview, service } = setup();
    await (await post({ url: URL_OK })).text();
    const before = service.quota("1.2.3.4").remaining;

    const events = parseSse(await (await post({ url: URL_OK })).text());
    expect(events[0]).toEqual({ type: "accepted", cached: true, key: "o/r#7@" + "a".repeat(40) });
    expect(events.map((e) => e.type)).toEqual(["accepted", "result"]);
    expect(runReview).toHaveBeenCalledTimes(1);
    expect(service.quota("1.2.3.4").remaining).toBe(before);
  });

  it("rejects an invalid URL with 400 before touching GitHub", async () => {
    const { post, service } = setup();
    const res = await post({ url: "https://example.com/o/r/pull/1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_url" } });
    expect(service.running).toBe(0);
  });

  it("rejects malformed JSON", async () => {
    const { post } = setup();
    const res = await post("{nope");
    expect(res.status).toBe(400);
  });

  it("rejects a malformed BYOK key", async () => {
    const { post } = setup();
    const res = await post({ url: URL_OK, apiKey: "not-a-key" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_key" } });
  });

  it("maps a missing or inaccessible PR to 404", async () => {
    const { post } = setup({ pull: { status: 404 } });
    const res = await post({ url: URL_OK });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("refuses private repositories even when the token can read them", async () => {
    const { post, runReview } = setup({ pull: { private: true, visibility: "private" } });
    const res = await post({ url: URL_OK });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "private_repo" } });
    expect(runReview).not.toHaveBeenCalled();
  });

  it("refuses internal-visibility repositories", async () => {
    const { post } = setup({ pull: { visibility: "internal" } });
    expect((await post({ url: URL_OK })).status).toBe(403);
  });

  it("caps diff size", async () => {
    const { post, runReview } = setup({ pull: { additions: 5000 } });
    const res = await post({ url: URL_OK });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "too_large" } });
    expect(runReview).not.toHaveBeenCalled();
  });

  it("rate limits the shared key per IP, with Retry-After", async () => {
    let n = 0;
    const github = (): GitHubClient =>
      ({
        pulls: {
          get: vi.fn(async () => ({
            data: {
              head: { sha: String(++n).padStart(40, "0") },
              base: { repo: { private: false, visibility: "public" } },
              changed_files: 1, additions: 1, deletions: 0,
            },
          })),
        },
      }) as unknown as GitHubClient;
    const service = new ReviewService({
      settings: SETTINGS,
      github: github(),
      createGitHub: github,
      createModelClient: () => ({}) as OpenAI,
      runReview: fakeRun,
    });
    const app = createApp({ service, samples: () => [], clientIp: () => "9.9.9.9", heartbeatMs: 60_000 });
    const post = (body: unknown) =>
      app.request("/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    // Each call sees a new head SHA, so none is a cache hit.
    expect((await post({ url: URL_OK })).status).toBe(200);
    expect((await post({ url: URL_OK })).status).toBe(200);
    const limited = await post({ url: URL_OK });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });

    // A visitor's own key is not charged against the shared allowance.
    const byok = await post({ url: URL_OK, apiKey: "sk-or-v1-" + "b".repeat(40) });
    expect(byok.status).toBe(200);
  });

  it("requires a BYOK key when the server has none", async () => {
    const { post } = setup({ settings: { openRouterKey: null } });
    const res = await post({ url: URL_OK });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_key" } });
  });

  it("passes a BYOK key to the model client and never into events", async () => {
    const key = "sk-or-v1-" + "c".repeat(40);
    const createModelClient = vi.fn((_key: string, _signal: AbortSignal) => ({}) as OpenAI);
    const service = new ReviewService({
      settings: SETTINGS,
      github: fakeGithub(),
      createGitHub: () => fakeGithub(),
      createModelClient,
      runReview: fakeRun,
    });
    const app = createApp({ service, samples: () => [], clientIp: () => "1.1.1.1", heartbeatMs: 60_000 });
    const res = await app.request("/api/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: URL_OK, apiKey: key }),
    });
    const text = await res.text();
    expect(createModelClient.mock.calls[0]![0]).toBe(key);
    expect(text).not.toContain(key);
  });

  it("emits a model_error event when every request group failed", async () => {
    const { post, service } = setup({
      runReview: async (opts) => {
        const r = fakeRunResult();
        opts.onEvent?.({ type: "analyzing", groups: 1 });
        return { ...r, candidates: [], survivors: [], refuted: [], failures: [{ paths: ["a"], error: "401 bad key sk-or-v1-leakleakleakleak" }] };
      },
    });
    const events = parseSse(await (await post({ url: URL_OK })).text());
    const err = events.at(-1)!;
    expect(err).toMatchObject({ type: "error", code: "model_error" });
    expect(JSON.stringify(err)).not.toContain("leakleak");
    expect(service.cache.size).toBe(0);
  });

  it("times out a slow review with a timeout event", async () => {
    const { post } = setup({
      settings: { timeoutMs: 50 },
      runReview: () => new Promise(() => {}),
    });
    const events = parseSse(await (await post({ url: URL_OK })).text());
    expect(events.at(-1)).toMatchObject({ type: "error", code: "timeout" });
  });

  it("shares one running review between concurrent requests for the same SHA", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { post, runReview } = setup({
      runReview: async (opts) => {
        await gate;
        return fakeRun(opts);
      },
    });
    const a = post({ url: URL_OK });
    const b = post({ url: URL_OK });
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [ea, eb] = await Promise.all([a, b].map(async (p) => parseSse(await (await p).text())));
    expect(runReview).toHaveBeenCalledTimes(1);
    expect(ea!.at(-1)!.type).toBe("result");
    expect(eb!.at(-1)!.type).toBe("result");
  });
});

describe("GET endpoints", () => {
  it("reports health and config without secrets", async () => {
    const { app } = setup();
    expect(await (await app.request("/api/health")).json()).toMatchObject({ ok: true });
    const cfg = await (await app.request("/api/config")).text();
    expect(cfg).toContain('"model":"m1"');
    expect(cfg).not.toContain("sk-or-v1-server");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const { app } = setup();
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
  });

  it("sets security headers", async () => {
    const { app } = setup();
    const res = await app.request("/api/health");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

// ---------------------------------------------------------------------------
// Hardening from the security review
// ---------------------------------------------------------------------------

describe("resolveClientIp", () => {
  it("trusts only the last X-Forwarded-For hop behind a proxy", async () => {
    const { resolveClientIp } = await import("../src/server/ip.js");
    expect(resolveClientIp(true, "6.6.6.6, 10.0.0.1, 203.0.113.9", "10.1.1.1")).toBe("203.0.113.9");
    expect(resolveClientIp(true, "not-an-ip", "10.1.1.1")).toBe("10.1.1.1");
    expect(resolveClientIp(false, "203.0.113.9", "10.1.1.1")).toBe("10.1.1.1");
    expect(resolveClientIp(true, undefined, undefined)).toBe("unknown");
  });
});

describe("service hardening", () => {
  it("redacts failure text in results and pins custom rules", async () => {
    const { post, runReview } = setup({
      runReview: async (opts) => {
        const r = await fakeRun(opts);
        return { ...r, failures: [{ paths: ["x.ts"], error: "500 upstream echoed sk-or-v1-secretsecretsecret" }] };
      },
    });
    const text = await (await post({ url: URL_OK })).text();
    expect(text).not.toContain("secretsecret");
    expect(runReview.mock.calls[0]![0].inputs).toMatchObject({ customRules: [] });
  });

  it("caches under the head SHA that was actually reviewed", async () => {
    const { post, service } = setup({
      runReview: async (opts) => {
        const r = await fakeRun(opts);
        return { ...r, pr: { ...r.pr, headSha: "c".repeat(40) } };
      },
    });
    await (await post({ url: URL_OK })).text();
    expect(service.cache.has("o/r#7@" + "c".repeat(40))).toBe(true);
    expect(service.cache.has("o/r#7@" + "a".repeat(40))).toBe(false);
  });
});

describe("model catalogue", () => {
  it("does not memoize a failed lookup", async () => {
    const { loadCatalogue, resetCatalogue } = await import("../src/llm/models.js");
    resetCatalogue();
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response("no", { status: 401 })
        : new Response(JSON.stringify({ data: [{ id: "m", context_length: 9 }] }), { status: 200 });
    }) as typeof fetch;
    try {
      expect((await loadCatalogue("bad")).size).toBe(0);
      expect((await loadCatalogue("good")).get("m")?.contextLength).toBe(9);
      expect((await loadCatalogue("again")).size).toBe(1);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
      resetCatalogue();
    }
  });
});
