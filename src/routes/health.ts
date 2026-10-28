import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/db";
import { listAvailableProviders } from "../lib/providers";

const router = Router();

// Cheap health check for Render's healthCheckPath and for an UptimeRobot (or
// similar) keep-warm ping. Checks the DB connection and reports whether any
// chat provider is currently configured/reachable, without triggering any
// circuit breaker state — this never calls a provider, just checks isAvailable().
let cached: { expiresAt: number; status: number; body: Record<string, unknown> } | undefined;
let pending: Promise<NonNullable<typeof cached>> | undefined;
async function checkHealth() {
  const startedAt = Date.now();
  let dbOk = true;
  try { await prisma.$queryRaw`SELECT 1`; }
  catch (err) { dbOk = false; console.error("[health] database check failed:", err); }
  const providers = await listAvailableProviders().catch(() => []);
  return { expiresAt: Date.now() + 5000, status: dbOk ? 200 : 503,
    body: { ok: dbOk, database: dbOk ? "up" : "down", chatAvailable: providers.length > 0, checkedInMs: Date.now() - startedAt } };
}
router.get("/", asyncHandler(async (_req, res) => {
  if (!cached || cached.expiresAt <= Date.now()) {
    if (!pending) pending = checkHealth().finally(() => { pending = undefined; });
    cached = await pending;
  }
  res.set("Cache-Control", "no-store");
  return res.status(cached.status).json(cached.body);
}));


export default router;
