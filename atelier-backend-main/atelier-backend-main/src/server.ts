import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";

import authRoutes from "./routes/auth";
import characterRoutes from "./routes/characters";
import avatarRoutes from "./routes/avatar";
import chatRoutes from "./routes/chat";
import healthRoutes from "./routes/health";

const app = express();

// The frontend (Netlify) is a different origin from this API (Render), so
// CORS must explicitly allow it and echo credentials for the cross-site
// session cookie (see lib/auth.ts) to be sent/received by the browser.
// FRONTEND_URL supports a comma-separated list (e.g. your Netlify prod URL
// plus deploy-preview URLs) if you need more than one allowed origin.
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow no-origin requests (curl, server-to-server health checks).
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));

// Avatar image uploads written to disk by routes/avatar.ts — served back out
// here. On Render, mount a persistent disk at public/uploads (see render.yaml)
// so these survive restarts/deploys.
app.use("/uploads", express.static(path.join(process.cwd(), "public", "uploads")));

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/characters", characterRoutes);
app.use("/api/characters", avatarRoutes);
app.use("/api/chat", chatRoutes);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong." });
});

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`[atelier-backend] listening on :${PORT}`);
});
