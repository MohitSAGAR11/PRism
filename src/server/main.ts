#!/usr/bin/env node
/**
 * PRism web demo: one process serving the API and the built web app.
 *
 *   OPENROUTER_API_KEY  shared model key (optional; without it visitors must bring one)
 *   GITHUB_TOKEN        read-only token for public repos (optional, strongly advised)
 *   PORT                default 8787
 *
 * See README "Web demo" for the full list.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import type { Config } from "../config.js";
import { createOctokit } from "../github/client.js";
import { createClient } from "../llm/client.js";
import { run } from "../review/run.js";
import { loadEnvFile } from "../util/env.js";
import { createApp } from "./app.js";
import { resolveClientIp } from "./ip.js";
import { makeReadOnly } from "./result.js";
import { loadSampleResults, sampleRef, SAMPLES } from "./samples.js";
import { ReviewService, type ServerSettings } from "./service.js";

function log(entry: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
}

function intEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return n;
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw ? raw : fallback;
}

function effortEnv(): Config["effort"] {
  const v = strEnv("REVIEW_EFFORT", "medium");
  if (v !== "low" && v !== "medium" && v !== "high") throw new Error(`REVIEW_EFFORT must be low, medium or high`);
  return v;
}

/** Bind every request a client makes to `signal`, on top of its own. */
function boundFetch(signal: AbortSignal): typeof fetch {
  return (input, init) =>
    fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}

function clientIpResolver(trustProxy: boolean): (c: Context) => string {
  return (c) => {
    let socket: string | undefined;
    try {
      socket = getConnInfo(c).remote.address;
    } catch {
      socket = undefined;
    }
    return resolveClientIp(trustProxy, c.req.header("x-forwarded-for"), socket);
  };
}

function mountWeb(webRoot: string): (app: Hono) => void {
  return (app) => {
    const indexPath = resolve(webRoot, "index.html");
    if (!existsSync(indexPath)) {
      log({ msg: "web.missing", webRoot, hint: "run `npm run build:web`" });
      return;
    }
    const indexHtml = readFileSync(indexPath, "utf8");
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.status === 200) c.header("Cache-Control", "public, max-age=31536000, immutable");
    });
    app.use("/*", serveStatic({ root: webRoot }));
    app.get("*", (c) => {
      c.header("Cache-Control", "no-cache");
      return c.html(indexHtml);
    });
  };
}

function main(): void {
  loadEnvFile();

  const openRouterKey = process.env["OPENROUTER_API_KEY"]?.trim() || null;
  const githubToken = (process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? "").trim();
  const port = intEnv("PORT", 8787, 1);

  const settings: ServerSettings = {
    openRouterKey,
    model: strEnv("REVIEW_MODEL", "z-ai/glm-5.3-flash"),
    verifyModel: strEnv("REVIEW_VERIFY_MODEL", "deepseek/deepseek-v4-flash"),
    effort: effortEnv(),
    maxChangedFiles: intEnv("MAX_CHANGED_FILES", 30, 1),
    maxChangedLines: intEnv("MAX_CHANGED_LINES", 1500, 1),
    timeoutMs: intEnv("REVIEW_TIMEOUT_SEC", 240, 10) * 1000,
    perIpPerHour: intEnv("REVIEWS_PER_IP_PER_HOUR", 3),
    byokPerIpPerHour: intEnv("BYOK_REVIEWS_PER_IP_PER_HOUR", 20),
    globalPerDay: intEnv("REVIEWS_PER_DAY", 150),
    maxConcurrent: intEnv("MAX_CONCURRENT_REVIEWS", 3, 1),
    cacheSize: intEnv("CACHE_SIZE", 500, 1),
  };

  const github = makeReadOnly(createOctokit(githubToken, { quiet: true }));
  const service = new ReviewService({
    settings,
    github,
    createGitHub: (signal) => makeReadOnly(createOctokit(githubToken, { quiet: true, fetch: boundFetch(signal) })),
    createModelClient: (apiKey, signal) =>
      createClient(apiKey, { fetch: boundFetch(signal), maxRetries: 1, timeout: 120_000 }),
    runReview: run,
    log,
  });

  const samplesDir = resolve(strEnv("SAMPLES_DIR", "samples"));
  const seeded = loadSampleResults(samplesDir, (m) => log({ msg: "samples.warn", detail: m }));
  const seededRefs = new Set<string>();
  for (const [key, result] of seeded) {
    service.cache.set(key, result);
    seededRefs.add(key.slice(0, key.lastIndexOf("@")));
  }

  const app = createApp({
    service,
    clientIp: clientIpResolver(process.env["TRUST_PROXY"] === "1" || process.env["TRUST_PROXY"] === "true"),
    requestsPerMinute: intEnv("REQUESTS_PER_IP_PER_MINUTE", 10, 1),
    samples: () =>
      SAMPLES.map((s) => ({ ...s, cached: seededRefs.has(sampleRef(s.url) ?? "") })),
    mountStatic: mountWeb(resolve(strEnv("WEB_DIST", "web/dist"))),
  });

  const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    log({
      msg: "listening",
      port: info.port,
      sharedKey: openRouterKey !== null,
      githubToken: githubToken !== "",
      samples: seeded.size,
      model: settings.model,
      verifyModel: settings.verifyModel,
    });
  });

  if (!githubToken) {
    log({ msg: "warn", detail: "No GITHUB_TOKEN: using GitHub's anonymous limit (60 requests/hour)." });
  }
  if (!openRouterKey) {
    log({ msg: "warn", detail: "No OPENROUTER_API_KEY: visitors must bring their own key." });
  }

  const shutdown = (): void => {
    log({ msg: "shutdown" });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

try {
  main();
} catch (err) {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
