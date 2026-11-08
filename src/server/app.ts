import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { SlidingWindowLimiter } from "./limits.js";
import { ReviewError, type Job, type ReviewService } from "./service.js";
import type { ApiError, ErrorCode, ReviewEvent, SampleInfo } from "./types.js";
import { parseOpenRouterKey, parsePullUrl } from "./validate.js";

export interface AppOptions {
  service: ReviewService;
  samples: () => SampleInfo[];
  /** How to identify a visitor for rate limiting. */
  clientIp: (c: Context) => string;
  /** POSTs per IP per minute, cache hits included. Bounds GitHub API use. */
  requestsPerMinute?: number;
  heartbeatMs?: number;
  /** Mounted after the API routes, e.g. static file serving. */
  mountStatic?: (app: Hono) => void;
}

const MAX_BODY_BYTES = 4 * 1024;
/** Open SSE streams per IP; each can live as long as a review. */
const MAX_STREAMS_PER_IP = 3;

function errorBody(code: ErrorCode, message: string, retryAfterSec?: number): ApiError {
  return { error: { code, message, ...(retryAfterSec ? { retryAfterSec } : {}) } };
}

function fail(c: Context, err: ReviewError): Response {
  if (err.retryAfterSec) c.header("Retry-After", String(err.retryAfterSec));
  return c.json(errorBody(err.code, err.message, err.retryAfterSec), err.status as 400);
}

function streamJob(c: Context, job: Job, heartbeatMs: number, onClose: () => void): Response {
  c.header("Cache-Control", "no-cache, no-transform");
  // Proxies (nginx-style, including some PaaS edges) buffer otherwise.
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    let chain = Promise.resolve();
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const write = (event: ReviewEvent): void => {
      chain = chain
        .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
        .catch(() => {});
      if (event.type === "result" || event.type === "error") void chain.then(finish);
    };

    const unsubscribe = job.subscribe(write);
    const heartbeat = setInterval(() => {
      chain = chain.then(() => stream.write(": ping\n\n")).then(() => {}).catch(() => {});
    }, heartbeatMs);

    // A closed tab stops the stream, not the review: it finishes and is
    // cached, so a refresh picks the result up for free.
    stream.onAbort(() => finish());

    try {
      await finished;
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
      await chain;
      onClose();
    }
  });
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  const service = opts.service;
  const requestLimiter = new SlidingWindowLimiter(opts.requestsPerMinute ?? 10, 60_000);
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const openStreams = new Map<string, number>();

  setInterval(() => {
    requestLimiter.sweep();
    service.sweep();
  }, 10 * 60_000).unref();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://avatars.githubusercontent.com"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  );

  app.get("/api/health", (c) => c.json({ ok: true, running: service.running, cached: service.cache.size }));

  app.get("/api/config", (c) => {
    const s = service.settings;
    return c.json({
      quota: service.quota(opts.clientIp(c)),
      limits: { maxFiles: s.maxChangedFiles, maxLines: s.maxChangedLines, timeoutSec: Math.round(s.timeoutMs / 1000) },
      model: s.model,
      verifyModel: s.verifyModel,
      samples: opts.samples(),
    });
  });

  app.post(
    "/api/review",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody("invalid_url", "Request body too large."), 413),
    }),
    async (c) => {
      const ip = opts.clientIp(c);
      if ((openStreams.get(ip) ?? 0) >= MAX_STREAMS_PER_IP) {
        return fail(c, new ReviewError("rate_limited", "Too many reviews open from this address. Close one and try again.", 429, 10));
      }
      const gate = requestLimiter.take(ip);
      if (!gate.ok) {
        const sec = Math.max(1, Math.ceil(gate.retryAfterMs / 1000));
        return fail(c, new ReviewError("rate_limited", "Slow down a little -- too many requests.", 429, sec));
      }

      let body: Record<string, unknown>;
      try {
        const parsed: unknown = await c.req.json();
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        body = parsed as Record<string, unknown>;
      } catch {
        return fail(c, new ReviewError("invalid_url", "Send JSON like {\"url\": \"https://github.com/o/r/pull/1\"}.", 400));
      }

      const target = parsePullUrl(body["url"]);
      if (!target.ok) return fail(c, new ReviewError("invalid_url", target.message, 400));

      // The visitor's key lives only in this request's scope: never logged,
      // never stored, never put in a cache key or an event.
      const key = parseOpenRouterKey(body["apiKey"]);
      if (!key.ok) return fail(c, new ReviewError("invalid_key", key.message, 400));

      try {
        const pre = await service.preflight(target.value);
        const job = service.start(pre, ip, key.value);
        openStreams.set(ip, (openStreams.get(ip) ?? 0) + 1);
        return streamJob(c, job, heartbeatMs, () => {
          const n = (openStreams.get(ip) ?? 1) - 1;
          if (n <= 0) openStreams.delete(ip);
          else openStreams.set(ip, n);
        });
      } catch (err) {
        if (err instanceof ReviewError) return fail(c, err);
        return fail(c, new ReviewError("internal", "Something went wrong starting the review.", 500));
      }
    },
  );

  app.all("/api/*", (c) => c.json(errorBody("not_found", "No such endpoint."), 404));

  opts.mountStatic?.(app);
  return app;
}
