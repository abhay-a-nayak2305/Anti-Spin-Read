/**
 * Minimal in-memory sliding-window rate limiter.
 * Per-isolate state — fine for a single Worker instance; Cloudflare
 * Rate Limiting rules are the right tool if multi-isolate precision is
 * ever needed.
 */
export interface AllowResult {
  allowed: boolean;
  /** Tokens remaining in the current window (0 when blocked). */
  remaining: number;
  /** Millis until the window slides past the oldest hit (approx). */
  retryAfterMs: number;
}

export function createSlidingWindowLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();

  return {
    /**
     * Consume one token for `key`. Returns the decision plus the
     * remaining budget — callers surface these as standard
     * X-RateLimit-* / Retry-After headers.
     */
    allow(key: string, now = Date.now()): AllowResult {
      const cutoff = now - windowMs;
      const prev = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (prev.length >= max) {
        hits.set(key, prev);
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.max(1, prev[0] + windowMs - now),
        };
      }
      prev.push(now);
      hits.set(key, prev);
      return {
        allowed: true,
        remaining: max - prev.length,
        retryAfterMs: 0,
      };
    },
    /** Test-only helper. */
    _size(): number {
      return hits.size;
    },
  };
}