import type { ErrorRequestHandler } from "express";

export function createOriginPolicy(frontendUrls: string, netlifySiteName = "") {
  const origins = new Set<string>();
  const sites = new Set<string>();
  for (const value of frontendUrls.split(",").map(s => s.trim()).filter(Boolean)) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("FRONTEND_URL must use HTTP or HTTPS.");
    origins.add(url.origin);
    const match = url.hostname.match(/^(?:[a-z0-9-]+--)?([a-z0-9-]+)\.netlify\.app$/i);
    if (match) sites.add(match[1]);
  }
  if (/^[a-z0-9-]+$/i.test(netlifySiteName)) sites.add(netlifySiteName.toLowerCase());
  return (origin: string | undefined): boolean => {
    if (!origin) return true;
    if (origins.has(origin)) return true;
    try {
      const url = new URL(origin);
      const match = url.hostname.match(/^[a-z0-9-]+--([a-z0-9-]+)\.netlify\.app$/i);
      return url.protocol === "https:" && url.origin === origin && !!match && sites.has(match[1]);
    } catch { return false; }
  };
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === "entity.too.large" || err?.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "Upload or request is too large." }); return;
  }
  if (err?.type === "entity.parse.failed" || err instanceof URIError) {
    res.status(400).json({ error: "Invalid request format." }); return;
  }
  if (err?.name === "MulterError") {
    res.status(400).json({ error: "Invalid image upload. Send one supported image file." }); return;
  }
  if (err?.code === "P2002") {
    res.status(409).json({ error: "That value is already in use." }); return;
  }
  if (err?.code === "P2025") {
    res.status(404).json({ error: "The requested item no longer exists." }); return;
  }
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: err.expose ? err.message : "Request could not be accepted." }); return;
  }
  console.error("[request]", err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
};
