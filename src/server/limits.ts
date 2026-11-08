/**
 * In-memory rate limiting and result caching for a single-instance demo.
 *
 * Both are deliberately process-local: the demo runs as one container, and a
 * restart forgetting the counters is an acceptable failure mode for a demo
 * (the global daily cap still bounds spend per process lifetime).
 */

export type Clock = () => number;

export interface LimitDecision {
  ok: boolean;
  remaining: number;
  /** Milliseconds until the next slot frees up; 0 when ok. */
  retryAfterMs: number;
}

/**
 * Sliding-window limiter: at most `limit` hits per `windowMs` per key.
 *
 * `check` and `consume` are separate on purpose. A cache hit should be free,
 * so the server checks first and only consumes once a paid review actually
 * starts.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: Clock = Date.now,
  ) {}

  private live(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept;
  }

  check(key: string): LimitDecision {
    if (this.limit <= 0) return { ok: false, remaining: 0, retryAfterMs: this.windowMs };
    const live = this.live(key);
    if (live.length < this.limit) {
      return { ok: true, remaining: this.limit - live.length, retryAfterMs: 0 };
    }
    const oldest = live[0]!;
    return { ok: false, remaining: 0, retryAfterMs: Math.max(0, oldest + this.windowMs - this.now()) };
  }

  consume(key: string): void {
    const live = this.live(key);
    this.hits.set(key, [...live, this.now()]);
  }

  /** Check and consume in one step; returns the decision made before consuming. */
  take(key: string): LimitDecision {
    const decision = this.check(key);
    if (decision.ok) this.consume(key);
    return decision;
  }

  /** Drop expired keys so memory tracks active visitors, not all-time ones. */
  sweep(): void {
    for (const key of [...this.hits.keys()]) this.live(key);
  }

  get size(): number {
    return this.hits.size;
  }
}

/** Least-recently-used cache. Reviews keyed by head SHA never go stale. */
export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(readonly capacity: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
