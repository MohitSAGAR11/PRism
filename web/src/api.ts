import type { ApiError, ErrorCode, ReviewEvent, SampleInfo } from "../../src/server/types";

export interface DemoConfig {
  quota: { remaining: number; limit: number; serverKey: boolean };
  limits: { maxFiles: number; maxLines: number; timeoutSec: number };
  model: string;
  verifyModel: string;
  samples: SampleInfo[];
}

export class ClientError extends Error {
  constructor(
    readonly code: ErrorCode | "network",
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export async function fetchConfig(signal?: AbortSignal): Promise<DemoConfig> {
  const res = await fetch("/api/config", { signal });
  if (!res.ok) throw new ClientError("network", "Could not reach the demo server.");
  return (await res.json()) as DemoConfig;
}

/** Split an SSE byte stream into parsed `data:` payloads. */
export function parseSseChunk(buffer: string): { events: ReviewEvent[]; rest: string } {
  const events: ReviewEvent[] = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as ReviewEvent);
    } catch {
      // A malformed frame is skipped rather than ending the stream.
    }
  }
  return { events, rest };
}

/**
 * Start a review and stream its events. EventSource cannot POST, so this
 * reads the SSE body off a plain fetch. Pre-stream failures arrive as JSON.
 */
export async function streamReview(
  url: string,
  apiKey: string | null,
  onEvent: (e: ReviewEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(apiKey ? { url, apiKey } : { url }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) return;
    throw new ClientError("network", "Could not reach the demo server. Check your connection and try again.");
  }

  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("text/event-stream")) {
    let body: ApiError | null = null;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      body = null;
    }
    const retry = body?.error.retryAfterSec ?? (Number(res.headers.get("retry-after")) || undefined);
    throw new ClientError(
      body?.error.code ?? "internal",
      body?.error.message ?? `The server answered ${res.status}.`,
      retry,
    );
  }

  const reader = res.body?.getReader();
  if (!reader) throw new ClientError("network", "The browser could not read the response stream.");
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;

  while (!ended) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch {
      if (signal.aborted) return;
      throw new ClientError("network", "The connection dropped mid-review. Run it again: a finished review is cached.");
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parsed = parseSseChunk(buffer);
    buffer = parsed.rest;
    for (const e of parsed.events) {
      onEvent(e);
      if (e.type === "result" || e.type === "error") ended = true;
    }
  }

  if (!ended && !signal.aborted) {
    throw new ClientError("network", "The connection closed before the review finished. Run it again: a finished review is cached.");
  }
}
