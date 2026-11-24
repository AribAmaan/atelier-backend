/**
 * Minimal in-memory rate limiter, keyed by IP + a bucket name (e.g.
 * "login", "register"). Good enough for a single-instance deployment
 * (which is what Render's free plan gives you) — state doesn't need to be
 * shared across instances because there's only one. If this app ever moves
 * to a multi-instance/autoscaled plan, swap this for a Redis-backed limiter
 * instead, since in-memory state won't be shared across instances there.
 *
 * Fixed window, not sliding — simpler, and fine for "stop obvious brute
 * force" rather than precise rate shaping.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

// Periodic cleanup so this Map doesn't grow unbounded over a long-running
// process — old buckets are harmless but there's no reason to keep them.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let lastCleanup = Date.now();

// Separate interval-based cleanup that runs regardless of traffic, so stale
// buckets don't accumulate during low-traffic periods.
const CLEANUP_TIMER = setInterval(() => {
  const now = Date.now();
  lastCleanup = now;
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}, CLEANUP_INTERVAL_MS);

// Prevent the timer from keeping the Node process alive by itself if no
// other work is pending (e.g. during tests).
if (CLEANUP_TIMER.unref) CLEANUP_TIMER.unref();

function cleanupIfDue() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

export type RateLimitResult = { limited: false } | { limited: true; retryAfterSeconds: number };

/**
 * Checks and increments the counter for `key` (e.g. "login:1.2.3.4").
 * Returns whether the request should be blocked, and if so, how long to
 * wait. `windowSeconds` / `maxRequests` define the fixed window.
 */
export function checkRateLimit(key: string, maxRequests: number, windowSeconds: number): RateLimitResult {
  cleanupIfDue();
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now >= existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { limited: false };
  }

  existing.count += 1;
  if (existing.count > maxRequests) {
    return { limited: true, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
  }
  return { limited: false };
}

/** Trust only Express's configured proxy chain, never raw client headers. */
export function getClientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}
