import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { asyncHandler } from "./lib/asyncHandler";
import { createOriginPolicy, errorHandler } from "./lib/httpPolicy";
import { closeImageGenQueue } from "./lib/imageQueue";
import cron from "node-cron";

import { runRetentionCleanup } from "./jobs/retentionCleanup";
import authRoutes from "./routes/auth";
import characterRoutes from "./routes/characters";
import avatarRoutes from "./routes/avatar";
import chatRoutes from "./routes/chat";
import healthRoutes from "./routes/health";
import billingRoutes, { handleWebhook } from "./routes/billing";
import imagesRoutes from "./routes/images";
import moderationRoutes from "./routes/moderation";

function validateEnv() {
  const required = ["SESSION_SECRET", "DATABASE_URL"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const FRONTEND_URL = process.env.FRONTEND_URL;
  if (!FRONTEND_URL && process.env.NODE_ENV === "production") {
    console.warn("WARNING: FRONTEND_URL is not set. CORS may block frontend requests in production.");
  }

  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  if (!GOOGLE_CLIENT_ID) {
    console.warn("WARNING: GOOGLE_CLIENT_ID is not set. Google Sign-In will not work.");
  }

  const PORT = Number(process.env.PORT || 4000);
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`Invalid PORT: ${process.env.PORT}. Must be a number between 1 and 65535.`);
    process.exit(1);
  }
}

validateEnv();

const app = express();

// The frontend (Netlify) is a different origin from this API (Render), so
// CORS must explicitly allow it and echo credentials for the cross-site
// session cookie (see lib/auth.ts) to be sent/received by the browser.
// FRONTEND_URL supports a comma-separated list (e.g. your Netlify prod URL
// plus deploy-preview URLs) if you need more than one allowed origin.
const allowOrigin = createOriginPolicy(process.env.FRONTEND_URL || "http://localhost:3000", process.env.NETLIFY_SITE_NAME);
const proxyHops = Number(process.env.TRUST_PROXY_HOPS ?? (process.env.RENDER ? "1" : "0"));
if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 8) throw new Error("Invalid TRUST_PROXY_HOPS.");
app.set("trust proxy", proxyHops);
app.disable("x-powered-by");
app.use(cors({
  origin(origin, callback) {
    if (allowOrigin(origin)) return callback(null, true);
    callback(Object.assign(new Error("Origin not allowed."), { status: 403, expose: true }));
  },
  credentials: true,
}));
app.use((_req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); next(); });

app.use(cookieParser());

// Razorpay webhook signature verification needs the exact raw request
// bytes, so this one route is registered with express.raw() ahead of the
// global express.json() below — parsing it as JSON first would leave
// nothing for the signature check to hash. See routes/billing.ts for the
// verification logic (a no-op response until PAYMENTS_ENABLED is set).
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), asyncHandler(async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const result = await handleWebhook(
    req.body as Buffer,
    typeof signature === "string" ? signature : undefined
  );
  res.sendStatus(result.status);
}));

app.use(express.json({ limit: "2mb" }));

// Avatar images (uploaded or AI-generated) are hosted on Backblaze B2 — see
// src/lib/b2.ts — so there's no local-disk uploads folder to serve
// and no persistent disk needed on Render.

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/characters", characterRoutes);
app.use("/api/characters", avatarRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/images", imagesRoutes);
app.use("/api", moderationRoutes);

app.use(errorHandler);

const PORT = Number(process.env.PORT || 4000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}. Must be a number between 1 and 65535.`);
  process.exit(1);
}

const server = app.listen(PORT, () => {
  console.log(`[rolichat-backend] listening on :${PORT}`);
});

// OPTIMIZATION: Enable HTTP Keep-Alive timeout tuning
// Render's load balancer has a 60s keep-alive timeout. By setting our server's
// keepAliveTimeout slightly higher (70s), we ensure the server doesn't close
// connections before the load balancer does, which would cause 502 errors.
server.keepAliveTimeout = 70_000; // 70 seconds
server.headersTimeout = 75_000; // headersTimeout must be > keepAliveTimeout

server.on("error", (err: any) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});

// Graceful shutdown — Render sends SIGTERM before killing the dyno on
// deploy/restart. Close the server so in-flight requests are allowed to
// complete rather than being cut off mid-stream.
process.on("SIGTERM", () => {
  console.log("[rolichat-backend] SIGTERM received — shutting down gracefully");
  void closeImageGenQueue();
  server.close(() => {
    console.log("[rolichat-backend] server closed");
    process.exit(0);
  });
  // Hard-stop after 10 seconds in case close() hangs.
  setTimeout(() => {
    console.error("[rolichat-backend] forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
});

// Daily sweep: warns users ~11 months inactive, anonymizes accounts inactive
// a full year. Runs at 03:00 UTC (~8:30 AM IST) — low-traffic window.
// See src/jobs/retentionCleanup.ts for the actual policy.
if (process.env.DISABLE_RETENTION_CRON !== "true") {
  cron.schedule("0 3 * * *", () => {
    return runRetentionCleanup().catch((err) => {
      console.error("[retention] cleanup run failed", err);
    });
  }, { timezone: "UTC", noOverlap: true });
}
