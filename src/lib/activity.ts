import { prisma } from "./db";

const TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const recentlyTouched = new Map<string, number>();
const MAX_MAP_ENTRIES = 10_000;

function pruneRecentlyTouched() {
  const now = Date.now();
  let pruned = 0;
  for (const [userId, last] of recentlyTouched.entries()) {
    if (now - last >= TOUCH_INTERVAL_MS) {
      recentlyTouched.delete(userId);
      pruned++;
    }
  }
  if (pruned > 0) {
    console.debug(`[activity] pruned ${pruned} stale entries, size=${recentlyTouched.size}`);
  }

  if (recentlyTouched.size > MAX_MAP_ENTRIES) {
    const entries = Array.from(recentlyTouched.entries()).sort((a, b) => a[1] - b[1]);
    const toRemove = entries.slice(0, recentlyTouched.size - MAX_MAP_ENTRIES);
    for (const [userId] of toRemove) {
      recentlyTouched.delete(userId);
    }
    console.debug(`[activity] evicted ${toRemove.length} oldest entries, size=${recentlyTouched.size}`);
  }
}

setInterval(pruneRecentlyTouched, 60 * 60 * 1000).unref();

export function touchActivity(userId: string) {
  const now = Date.now();
  const last = recentlyTouched.get(userId);
  if (last && now - last < TOUCH_INTERVAL_MS) return;
  recentlyTouched.set(userId, now);

  prisma.user
    .update({
      where: { id: userId },
      data: { lastActiveAt: new Date(), deletionWarningSentAt: null },
    })
    .catch((err: unknown) => {
      if (recentlyTouched.get(userId) === now) recentlyTouched.delete(userId);
      console.error("[activity] failed to touch lastActiveAt", err);
    });
}
