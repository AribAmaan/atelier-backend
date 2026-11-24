import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { touchActivity } from "./activity";
import { prisma } from "./db";

export const COOKIE_NAME = "session";
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getSecretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set. Copy .env.example to .env and fill it in.");
  }
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

function credentialVersion(passwordHash: string): string {
  return createHmac("sha256", getSecretKey()).update(passwordHash).digest("hex");
}

export async function createSessionToken(userId: string, passwordHash?: string) {
  const hash = passwordHash ?? (await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }))?.passwordHash;
  if (!hash) throw new Error("Account not found.");
  return new SignJWT({ userId, credentialVersion: credentialVersion(hash) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<{ userId: string; credentialVersion: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: ["HS256"] });
    if (typeof payload.userId === "string" && typeof payload.credentialVersion === "string") {
      return { userId: payload.userId, credentialVersion: payload.credentialVersion };
    }
    return null;
  } catch {
    return null;
  }
}

// The frontend (Netlify) and backend (Render) live on different origins, so
// the session cookie must be sent cross-site. That requires SameSite=None
// (which in turn requires Secure) — browsers reject SameSite=None without
// Secure. Every deploy target here (Netlify + Render) is HTTPS, so this is
// safe. CORS on the Express app must also set credentials:true and echo back
// the exact frontend origin (see server.ts) for the cookie to actually be
// stored/sent by the browser.
const isProduction = process.env.NODE_ENV === "production";

export function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
  });
}

export async function getCurrentUserId(req: Request): Promise<string | null> {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  const session = await verifySessionToken(token);
  if (!session?.userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { deletedAt: true, passwordHash: true, membershipTier: true, membershipRenewsAt: true },
  });
  if (!user || user.deletedAt || session.credentialVersion !== credentialVersion(user.passwordHash)) return null;

  if (user.membershipTier !== "free" && user.membershipRenewsAt && user.membershipRenewsAt <= new Date()) {
    await prisma.user.updateMany({
      where: { id: session.userId, membershipRenewsAt: { lte: new Date() } },
      data: { membershipTier: "free", membershipRenewsAt: null },
    });
  }
  touchActivity(session.userId);
  return session.userId;
}

function getTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && /^Bearer /i.test(authHeader)) {
    return authHeader.slice(7).trim() || null;
  }
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (typeof cookieToken === "string" && cookieToken) return cookieToken;
  return null;
}
