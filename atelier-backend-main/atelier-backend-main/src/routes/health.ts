import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/db";
import { listAvailableProviders } from "../lib/providers";

const router = Router();

// Cheap health check for Render's healthCheckPath and for an UptimeRobot (or
// similar) keep-warm ping. Checks the DB connection and reports whether any
// chat provider is currently configured/reachable, without triggering any
// circuit breaker state — this never calls a provider, just checks isAvailable().
router.get("/", asyncHandler(async (_req, res) => {
  const startedAt = Date.now();

  let dbOk = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    dbOk = false;
    console.error("[health] database check failed:", err);
  }

  const providers = await listAvailableProviders();
  const ok = dbOk;

  // This endpoint is public and unauthenticated, so it must never name which
  // backend(s) power chat — only whether chat can currently be served at all.
  return res.status(ok ? 200 : 503).json({
    ok,
    database: dbOk ? "up" : "down",
    chatAvailable: providers.length > 0,
    checkedInMs: Date.now() - startedAt,
  });
}));

export default router;
