import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import type { Request, Response } from "express";

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

export async function createSessionToken(userId: string) {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (typeof payload.userId === "string") {
      return { userId: payload.userId };
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
export function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
  });
}

export async function getCurrentUserId(req: Request): Promise<string | null> {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  const session = await verifySessionToken(token);
  return session?.userId ?? null;
}
