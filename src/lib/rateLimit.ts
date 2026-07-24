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

/**
 * Best-effort client IP from standard proxy headers (Render, like most
 * hosts, sits behind a proxy that sets x-forwarded-for). Falls back to a
 * constant if nothing is present — meaning everyone with no header shares
 * one bucket, which is still strictly safer than no rate limiting at all.
 *
 * Trust caveat: this takes the leftmost x-forwarded-for entry at face value,
 * which is only safe because Render's edge proxy sets/overwrites this header
 * itself rather than appending to whatever the client sent. If this app is
 * ever deployed behind a different/additional proxy, confirm that proxy
 * sanitizes (not appends to) an inbound X-Forwarded-For before trusting it
 * here — otherwise a client could spoof the header and land in a
 * different rate-limit bucket than they're actually in.
 */
export function getClientIp(req: { headers: Record<string, unknown> }): string {
  const forwardedRaw = req.headers["x-forwarded-for"];
  const forwarded = Array.isArray(forwardedRaw) ? forwardedRaw[0] : forwardedRaw;
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  const realIpRaw = req.headers["x-real-ip"];
  const realIp = Array.isArray(realIpRaw) ? realIpRaw[0] : realIpRaw;
  if (typeof realIp === "string" && realIp) return realIp.trim();
  return "unknown";
}
