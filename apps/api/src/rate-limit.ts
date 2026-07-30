/**
 * Simple sliding-window rate limiter (Wave A · A1.4).
 * In-process only — sufficient for single-node MVP; not a distributed limiter.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Try consume one unit for key; returns whether allowed. */
  take(key: string): RateLimitResult;
  /** Test helper */
  reset(): void;
}

export function createRateLimiter(opts: {
  max: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const max = Math.max(1, Math.floor(opts.max));
  const windowMs = Math.max(1, Math.floor(opts.windowMs));
  const nowFn = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();

  return {
    take(key: string): RateLimitResult {
      const now = nowFn();
      const windowStart = now - windowMs;
      const prev = hits.get(key) ?? [];
      const recent = prev.filter((t) => t > windowStart);
      if (recent.length >= max) {
        hits.set(key, recent);
        const oldest = recent[0] ?? now;
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.max(0, oldest + windowMs - now)
        };
      }
      recent.push(now);
      hits.set(key, recent);
      return {
        allowed: true,
        remaining: Math.max(0, max - recent.length),
        retryAfterMs: 0
      };
    },
    reset() {
      hits.clear();
    }
  };
}

/** Bucket name helpers for sensitive routes. */
export function rateLimitBucket(route: string, ip: string): string {
  return `${route}|${ip || "unknown"}`;
}
