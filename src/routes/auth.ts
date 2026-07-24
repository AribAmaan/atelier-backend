import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/db";
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  setSessionCookie,
  clearSessionCookie,
  getCurrentUserId,
} from "../lib/auth";
import { checkRateLimit, getClientIp } from "../lib/rateLimit";

const router = Router();

router.post("/register", asyncHandler(async (req, res) => {
  const ip = getClientIp(req);
  const limit = checkRateLimit(`register:${ip}`, 5, 60 * 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many signups from this network. Please try again later." });
  }

  const body = req.body ?? {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";

  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Enter a valid email." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  if (!displayName) {
    return res.status(400).json({ error: "Enter a display name." });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await prisma.user.create({ data: { email, passwordHash, displayName } });
  } catch (err: any) {
    // Race with the findUnique check above — the DB's unique constraint is
    // the real guard; P2002 means someone else's signup won the race.
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    throw err;
  }

  const token = await createSessionToken(user.id);
  setSessionCookie(res, token);

  return res.json({ id: user.id, email: user.email, displayName: user.displayName });
}));

router.post("/login", asyncHandler(async (req, res) => {
  const ip = getClientIp(req);
  const limit = checkRateLimit(`login:${ip}`, 10, 15 * 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many login attempts. Please wait a few minutes and try again." });
  }

  const body = req.body ?? {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return res.status(400).json({ error: "Enter your email and password." });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  const token = await createSessionToken(user.id);
  setSessionCookie(res, token);

  return res.json({ id: user.id, email: user.email, displayName: user.displayName });
}));

router.post("/logout", asyncHandler(async (_req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
}));

router.get("/me", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.json({ user: null });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true },
  });
  return res.json({ user });
}));

export default router;
