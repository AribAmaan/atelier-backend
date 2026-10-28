import { requireUser } from "../lib/requireUser";
import crypto from "crypto";
import { validateAccount, validEmail, passwordError } from "../lib/accountValidation";
import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import multer from "multer";
import sharp from "sharp";
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
import { sendMail } from "../lib/mailer";
import { uploadAvatarBuffer } from "../lib/b2";
import { processImageGen } from "./avatar";

const router = Router();
router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

const ALLOWED_AVATAR_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 10, parts: 12 } });

const MINIMUM_AGE_YEARS = 18;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// "Sign in with Google" (Google Identity Services). Client ID is not secret
// (it's shipped in the frontend bundle too) — no client secret is needed
// for this flow, since we only ever verify an ID token's signature against
// Google's public keys, we never exchange an auth code ourselves.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function verifyGoogleCredential(credential: string) {
  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload) throw new Error("Empty Google token payload");
  return payload;
}

// Shared by /register and /google/complete — both need the same 18+ /
// display-name / ToS checks before a User row can be created.
const validateNewAccountFields = validateAccount;

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function issueRawToken() {
  return crypto.randomBytes(32).toString("hex");
}


async function issueEmailVerification(userId: string, email: string, frontendUrl: string) {
  await prisma.emailVerificationToken.deleteMany({
    where: { userId, expiresAt: { gt: new Date() } },
  });
  const raw = issueRawToken();
  await prisma.emailVerificationToken.create({
    data: { userId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS) },
  });
  const link = `${frontendUrl}/verify-email?token=${raw}`;
  await sendMail(
    email,
    "Verify your Rolichat email",
    `<p>Confirm this is your email address to finish setting up your Rolichat account.</p><p><a href="${link}">${link}</a></p><p>This link expires in 24 hours.</p>`,
    `Verify your email: ${link} (expires in 24 hours)`
  );
}

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
  const birthdateRaw = typeof body.birthdate === "string" ? body.birthdate : "";
  const tosAccepted = body.tosAccepted === true;

  if (!validEmail(email)) {
    return res.status(400).json({ error: "Enter a valid email." });
  }
  const invalidPassword = passwordError(password);
  if (invalidPassword) return res.status(400).json({ error: invalidPassword });
  const validation = validateNewAccountFields(displayName, birthdateRaw, tosAccepted);
  if ("error" in validation) return res.status(400).json({ error: validation.error });
  const birthdate = validation.birthdate;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await prisma.user.create({
      data: { email, passwordHash, displayName, birthdate, tosAcceptedAt: new Date() },
    });
  } catch (err: any) {
    // Race with the findUnique check above — the DB's unique constraint is
    // the real guard; P2002 means someone else's signup won the race.
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    throw err;
  }

  if (user.deletedAt) return res.status(401).json({ error: "Unable to sign in to this account." });
  const token = await createSessionToken(user.id, user.passwordHash);
  setSessionCookie(res, token);

  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();
  issueEmailVerification(user.id, user.email, frontendUrl).catch((err) =>
    console.error("Failed to send verification email:", err)
  );

  return res.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    token,
  });
}));

// POST /api/auth/google — "Continue with Google" for an existing account
// (found by a previously-linked googleId, or by matching email — Google has
// already verified that email, so it's safe to link it to a password
// account with the same address). If no account exists yet, we deliberately
// do NOT create one here: Rolichat requires a self-reported date of birth
// and ToS acceptance at signup (18+ content gate), neither of which Google
// gives us. Instead this responds with isNewUser so the frontend can show a
// short "finish your profile" step that posts to /google/complete.
router.post("/google", asyncHandler(async (req, res) => {
  const ip = getClientIp(req);
  const limit = checkRateLimit(`google-auth:${ip}`, 20, 60 * 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many attempts. Please try again later." });
  }

  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: "Google Sign-In isn't configured on this server yet." });
  }

  const credential = typeof req.body?.credential === "string" ? req.body.credential : "";
  if (!credential) return res.status(400).json({ error: "Missing Google credential." });

  let payload;
  try {
    payload = await verifyGoogleCredential(credential);
  } catch (err) {
    console.error("[auth] Google credential verification failed:", err);
    return res.status(401).json({ error: "Invalid Google sign-in token." });
  }
  if (!payload.email_verified) {
    return res.status(401).json({
      error: "Your Google account's email isn't verified. Please verify it with Google first.",
    });
  }

  const googleId = payload.sub;
  const email = (payload.email || "").toLowerCase();
  if (!googleId || !validEmail(email)) return res.status(401).json({ error: "Invalid Google account details." });

  let user = await prisma.user.findUnique({ where: { googleId } });
  if (!user) {
    const existingByEmail = await prisma.user.findUnique({ where: { email } });
    if (existingByEmail) {
      if (existingByEmail.deletedAt || (existingByEmail.googleId && existingByEmail.googleId !== googleId)) {
        return res.status(401).json({ error: "Unable to sign in to this account." });
      }
      user = await prisma.user.update({
        where: { id: existingByEmail.id },
        data: { googleId, emailVerified: true },
      });
    }
  }

  if (!user) {
    return res.json({
      isNewUser: true,
      email,
      suggestedDisplayName: typeof payload.name === "string" ? payload.name : "",
    });
  }

  if (user.deletedAt) return res.status(401).json({ error: "Unable to sign in to this account." });
  const token = await createSessionToken(user.id, user.passwordHash);
  setSessionCookie(res, token);
  return res.json({
    isNewUser: false,
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    token,
  });
}));

// POST /api/auth/google/complete — finishes account creation for a Google
// sign-in that came back isNewUser from /google above. Re-verifies the same
// credential (it's still valid for a few minutes and re-verification is
// cheap/stateless) rather than trusting the email the frontend sends back,
// so the account is created from Google's claims, not client input.
router.post("/google/complete", asyncHandler(async (req, res) => {
  const ip = getClientIp(req);
  const limit = checkRateLimit(`google-complete:${ip}`, 10, 60 * 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many attempts. Please try again later." });
  }

  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: "Google Sign-In isn't configured on this server yet." });
  }

  const credential = typeof req.body?.credential === "string" ? req.body.credential : "";
  if (!credential) return res.status(400).json({ error: "Missing Google credential." });

  let payload;
  try {
    payload = await verifyGoogleCredential(credential);
  } catch (err) {
    console.error("[auth] Google credential verification failed:", err);
    return res.status(401).json({ error: "Invalid Google sign-in token." });
  }
  if (!payload.email_verified) {
    return res.status(401).json({
      error: "Your Google account's email isn't verified. Please verify it with Google first.",
    });
  }

  const body = req.body ?? {};
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const birthdateRaw = typeof body.birthdate === "string" ? body.birthdate : "";
  const tosAccepted = body.tosAccepted === true;

  const validation = validateNewAccountFields(displayName, birthdateRaw, tosAccepted);
  if ("error" in validation) return res.status(400).json({ error: validation.error });

  const googleId = payload.sub;
  const email = (payload.email || "").toLowerCase();
  if (!googleId || !validEmail(email)) return res.status(401).json({ error: "Invalid Google account details." });

  // Race guard: this Google account (or its email) may have been linked by
  // a concurrent /google or /google/complete call since the frontend first
  // asked. Reuse that account instead of creating a duplicate.
  let user = await prisma.user.findUnique({ where: { googleId } });
  if (!user) {
    const existingByEmail = await prisma.user.findUnique({ where: { email } });
    if (existingByEmail) {
      if (existingByEmail.deletedAt || (existingByEmail.googleId && existingByEmail.googleId !== googleId)) {
        return res.status(401).json({ error: "Unable to sign in to this account." });
      }
      user = await prisma.user.update({
        where: { id: existingByEmail.id },
        data: { googleId, emailVerified: true },
      });
    }
  }

  if (!user) {
    try {
      user = await prisma.user.create({
        data: {
          email,
          // Random secret, never revealed — satisfies passwordHash's NOT
          // NULL constraint and keeps the password-login form from ever
          // working against this account (it's Google-only until/unless
          // they later set a password via "forgot password").
          passwordHash: await hashPassword(crypto.randomBytes(32).toString("hex")),
          displayName,
          birthdate: validation.birthdate,
          tosAcceptedAt: new Date(),
          googleId,
          // Google has already verified this address, so there's no need
          // to send our own verification email for it.
          emailVerified: true,
        },
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        return res.status(409).json({ error: "An account with that email already exists." });
      }
      throw err;
    }
  }

  if (user.deletedAt) return res.status(401).json({ error: "Unable to sign in to this account." });
  const token = await createSessionToken(user.id, user.passwordHash);
  setSessionCookie(res, token);
  return res.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    token,
  });
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
  if (!user || user.deletedAt) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  if (user.deletedAt) return res.status(401).json({ error: "Unable to sign in to this account." });
  const token = await createSessionToken(user.id, user.passwordHash);
  setSessionCookie(res, token);

  return res.json({ id: user.id, email: user.email, displayName: user.displayName, token });
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
    select: {
      id: true,
      email: true,
      displayName: true,
      emailVerified: true,
      username: true,
      highlights: true,
      avatarUrl: true,
      explicitMode: true,
      blurExplicitImages: true,
      defaultModel: true,
      preferredLanguage: true,
    },
  });
  return res.json({ user });
}));

// PUT /api/auth/me — update the signed-in user's profile fields.
router.put("/me", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const body = req.body ?? {};
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : undefined;
  const username = typeof body.username === "string" ? (body.username.trim() || null) : undefined;
  const highlights = typeof body.highlights === "string" ? body.highlights.trim() : undefined;
  const explicitMode = typeof body.explicitMode === "boolean" ? body.explicitMode : undefined;
  const blurExplicitImages = typeof body.blurExplicitImages === "boolean" ? body.blurExplicitImages : undefined;
  const defaultModel = typeof body.defaultModel === "string" ? body.defaultModel.trim() : undefined;
  const preferredLanguage = typeof body.preferredLanguage === "string" ? body.preferredLanguage.trim() : undefined;

  if (displayName !== undefined && (!displayName || displayName.length > 100)) return res.status(400).json({ error: "Display name must be 1–100 characters." });
  if (username && !/^[a-zA-Z0-9_]{3,30}$/.test(username)) return res.status(400).json({ error: "Username must be 3–30 letters, numbers, or underscores." });
  if (highlights && highlights.length > 2000) return res.status(400).json({ error: "Profile description is too long." });
  if ((defaultModel && defaultModel.length > 100) || (preferredLanguage && preferredLanguage.length > 35)) return res.status(400).json({ error: "Invalid profile preference." });
  if (username) {
    const existing = await prisma.user.findFirst({
      where: { username: username, NOT: { id: userId } },
    });
    if (existing) {
      return res.status(409).json({ error: "That username is already taken." });
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(username !== undefined ? { username } : {}),
      ...(highlights !== undefined ? { highlights } : {}),
      ...(explicitMode !== undefined ? { explicitMode } : {}),
      ...(blurExplicitImages !== undefined ? { blurExplicitImages } : {}),
      ...(defaultModel !== undefined ? { defaultModel } : {}),
      ...(preferredLanguage !== undefined ? { preferredLanguage } : {}),
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      emailVerified: true,
      username: true,
      highlights: true,
      avatarUrl: true,
      explicitMode: true,
      blurExplicitImages: true,
      defaultModel: true,
      preferredLanguage: true,
    },
  });

  return res.json({ user: updated });
}));

// DELETE /api/auth/me — permanently delete the signed-in user's account.
// Relies on cascading deletes (see schema.prisma) to clean up owned
// characters, chats, messages, and reports.
router.delete("/me", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  await prisma.user.delete({ where: { id: userId } });

  clearSessionCookie(res);
  return res.json({ ok: true });
}));

// POST /api/auth/avatar — upload a profile avatar image for the signed-in user.
router.post("/avatar", requireUser, avatarUpload.single("avatar"), asyncHandler(async (req, res) => {
  const userId = res.locals.uploadUserId as string;
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "No image file was sent." });
  }
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.mimetype)) {
    return res.status(400).json({ error: "Use a PNG, JPEG, WebP, or GIF image." });
  }

  const publicId = `user-${userId}-${Date.now()}`;
  const avatarUrl = await uploadAvatarBuffer(file.buffer, publicId);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatarUrl },
    select: {
      id: true,
      email: true,
      displayName: true,
      emailVerified: true,
      username: true,
      highlights: true,
      avatarUrl: true,
    },
  });

  return res.json({ user: updated });
}));

// POST /api/auth/avatar/generate — AI-generate a profile avatar for the
// signed-in user, using their display name + highlights as the prompt (the
// same pipeline characters use for avatar generation — see routes/avatar.ts).
router.post("/avatar/generate", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const limit = checkRateLimit(`avatar-generate:${userId}`, 10, 60 * 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many avatar generations. Please wait a bit and try again." });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: "Account not found." });

  const customPrompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim().slice(0, 2000) : "";
  const prompt =
    customPrompt ||
    `A highly polished digital portrait avatar of a person named ${user.displayName || "this user"}.` +
      (user.highlights?.trim() ? ` Appearance: ${user.highlights.trim().slice(0, 500)}.` : "");

  try {
    const result = await processImageGen({ prompt, isExplicit: !!user.explicitMode, kind: "avatar" });
    const cleanBytes = await sharp(result.bytes).sharpen().toBuffer().catch(() => result.bytes);
    const publicId = `user-${userId}-${Date.now()}-generated`;
    const avatarUrl = await uploadAvatarBuffer(cleanBytes, publicId);
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
      select: {
        id: true,
        email: true,
        displayName: true,
        emailVerified: true,
        username: true,
        highlights: true,
        avatarUrl: true,
      },
    });
    console.log(`[avatar] user avatar generated via ${result.provider}`);
    return res.json({ user: updated, imageGeneration: { provider: result.provider, isFallback: result.provider === "dicebear-fallback" } });
  } catch (err) {
    console.error("User avatar generation failed", err);
    if ((err as any)?.status === 503 && (err as any)?.expose) {
      res.set("Retry-After", "5");
      return res.status(503).json({ error: (err as Error).message });
    }
    return res.status(502).json({ error: "Avatar generation failed. Try again, or upload an image instead." });
  }
}));

// POST /api/auth/forgot-password — always responds 200 with the same message
// whether or not the email exists, so this endpoint can't be used to
// enumerate registered accounts. If the account exists, emails a one-time
// reset link.
router.post("/forgot-password", asyncHandler(async (req, res) => {
  const ip = getClientIp(req);
  const limit = checkRateLimit(`forgot-password:${ip}`, 5, 60 * 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }

  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const genericResponse = { ok: true, message: "If that email has an account, a reset link is on its way." };
  if (!email) return res.json(genericResponse);

  const user = await prisma.user.findUnique({ where: { email } });
  if (user && !user.deletedAt) {
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    const raw = issueRawToken();
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
    });
    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();
    const link = `${frontendUrl}/reset-password?token=${raw}`;
    await sendMail(
      user.email,
      "Reset your Rolichat password",
      `<p>Someone requested a password reset for this account. If that was you, set a new password:</p><p><a href="${link}">${link}</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`,
      `Reset your password: ${link} (expires in 1 hour; ignore if you didn't request this)`
    ).catch((err) => console.error("Failed to send reset email:", err));
  }

  return res.json(genericResponse);
}));

// POST /api/auth/reset-password — consumes a token minted above and sets a
// new password. Tokens are single-use and short-lived.
router.post("/reset-password", asyncHandler(async (req, res) => {
  const ip = getClientIp(req);
  const limit = checkRateLimit(`reset-password:${ip}`, 10, 60 * 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many attempts. Please try again later." });
  }

  const rawToken = typeof req.body?.token === "string" ? req.body.token : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!rawToken) return res.status(400).json({ error: "Missing reset token." });
  const invalidPassword = passwordError(password);
  if (invalidPassword) return res.status(400).json({ error: invalidPassword });

  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
    return res.status(400).json({ error: "That reset link is invalid or has expired. Request a new one." });
  }

  const passwordHash = await hashPassword(password);
  const consumed = await prisma.$transaction(async tx => {
    const claim = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() }, user: { deletedAt: null } },
      data: { usedAt: new Date() },
    });
    if (claim.count !== 1) return false;
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    await tx.passwordResetToken.updateMany({ where: { userId: record.userId, usedAt: null }, data: { usedAt: new Date() } });
    return true;
  });
  if (!consumed) return res.status(400).json({ error: "That reset link is invalid or has expired. Request a new one." });
  clearSessionCookie(res);

  return res.json({ ok: true });
}));

// GET /api/auth/verify-email?token=... — confirms the email that was used
// to sign up. Not required to use the app, but required before a character
// can be shared to Discover (see routes/characters.ts).
router.post("/verify-email", asyncHandler(async (req, res) => {
  const rawToken = typeof req.body?.token === "string" ? req.body.token : "";
  if (!rawToken) return res.status(400).json({ error: "Missing verification token." });

  const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!record || record.expiresAt.getTime() <= Date.now()) {
    return res.status(400).json({ error: "That verification link is invalid or has expired." });
  }

  const consumed = await prisma.$transaction(async tx => {
    const claim = await tx.emailVerificationToken.deleteMany({ where: { id: record.id, expiresAt: { gt: new Date() }, user: { deletedAt: null } } });
    if (claim.count !== 1) return false;
    await tx.user.update({ where: { id: record.userId }, data: { emailVerified: true } });
    await tx.emailVerificationToken.deleteMany({ where: { userId: record.userId } });
    return true;
  });
  if (!consumed) return res.status(400).json({ error: "That verification link is invalid or has expired." });

  return res.json({ ok: true });
}));

// POST /api/auth/resend-verification — for the signed-in user, re-sends the
// verification email (e.g. the first one expired or got lost).
router.post("/resend-verification", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const limit = checkRateLimit(`resend-verification:${userId}`, 3, 60 * 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: "Account not found." });
  if (user.emailVerified) return res.json({ ok: true, message: "Your email is already verified." });

  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();
  await issueEmailVerification(user.id, user.email, frontendUrl);

  return res.json({ ok: true, message: "Verification email sent." });
}));

export default router;
