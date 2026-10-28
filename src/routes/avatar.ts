import { checkRateLimit } from "../lib/rateLimit";
import { requireUser } from "../lib/requireUser";
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import multer from "multer";
import { prisma } from "../lib/db";
import { getCurrentUserId } from "../lib/auth";
import sharp from "sharp";
import { inspectImage } from "../lib/imageValidation";
import { imageTimeoutMs, requestMediaResource } from "../lib/providers/mediaHttp";
import { uploadAvatarBuffer } from "../lib/b2";
import { generateCloudflareImage, isCloudflareConfigured } from "../lib/providers/cloudflare";
import { generateDicebearAvatar } from "../lib/providers/dicebear";
import { acquireImageGenSlot, releaseImageGenSlot, ImageGenJobData, ImageGenJobResult } from "../lib/imageQueue";
import { ProviderBreaker, isRateLimitError, isTimeoutError } from "../lib/providers/circuitBreaker";

const router = Router();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_BYTES = 5 * 1024 * 1024; // 5MB

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 10, parts: 12 } });

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const POLLINATIONS_IMAGE_URL = "https://image.pollinations.ai/prompt";
const POLLINATIONS_SAFE_IMAGE_MODEL = "lykon/dreamshaper-8-lcm";
const POLLINATIONS_EXPLICIT_IMAGE_MODEL = "vendouple/uncensored-image-enhanced";

const pollinationsBreaker = new ProviderBreaker("Pollinations", { cooldownSeconds: 30, timeoutTripThreshold: 2, timeoutCooldownSeconds: 15 }, "POLLINATIONS");

async function withPollinationsRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (pollinationsBreaker.isOpen()) {
        throw new Error("Pollinations circuit breaker open, retry later");
      }
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = isRateLimitError(err);
      const isTimeout = isTimeoutError(err);
      if ((isRateLimit || isTimeout) && pollinationsBreaker.isOpen()) {
        throw err;
      }
      const isQueueFull = /429|Too Many Requests|Queue full/i.test(msg);
      if (!isQueueFull || attempt === maxAttempts) {
        if (isRateLimit) {
          pollinationsBreaker.trip(err);
        } else if (isTimeout) {
          pollinationsBreaker.recordTimeout();
        }
        throw err;
      }
      const backoffMs = 500 * attempt;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr;
}

async function generatePollinationsAvatar(
  character: { isExplicit?: boolean },
  prompt: string,
  timeoutMs: number
): Promise<Buffer> {
  const params = new URLSearchParams({
    width: "1024",
    height: "1024",
    model: character.isExplicit ? POLLINATIONS_EXPLICIT_IMAGE_MODEL : POLLINATIONS_SAFE_IMAGE_MODEL,
    nologo: "true",
    safe: character.isExplicit ? "false" : "true",
    seed: String(Date.now() % 1_000_000),
    steps: "35",
    // Explicitly pinned off: Pollinations' `enhance` flag lets an LLM
    // rewrite the prompt before generation. Default is already false,
    // but we pin it so a user's exact custom prompt can never get
    // silently reworded if that default ever changes upstream.
    enhance: "false",
  });
  const apiKey = process.env.POLLINATIONS_API_KEY;
  if (apiKey) params.set("key", apiKey);

  const url = `${POLLINATIONS_IMAGE_URL}/${encodeURIComponent(prompt)}?${params.toString()}`;

  const { body } = await requestMediaResource(url, {}, "Pollinations", timeoutMs);
  return body;
}

async function generatePollinationsBackground(
  isExplicit: boolean,
  prompt: string,
  timeoutMs: number
): Promise<Buffer> {
  const params = new URLSearchParams({
    width: "1920",
    height: "1080",
    model: isExplicit ? POLLINATIONS_EXPLICIT_IMAGE_MODEL : POLLINATIONS_SAFE_IMAGE_MODEL,
    nologo: "true",
    safe: isExplicit ? "false" : "true",
    seed: String(Date.now() % 1_000_000),
    steps: "35",
    enhance: "false",
  });
  const apiKey = process.env.POLLINATIONS_API_KEY;
  if (apiKey) params.set("key", apiKey);

  const url = `${POLLINATIONS_IMAGE_URL}/${encodeURIComponent(prompt)}?${params.toString()}`;

  const { body } = await requestMediaResource(url, {}, "Pollinations", timeoutMs);
  return body;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildAvatarPrompt(
  character: {
    name: string;
    tagline: string;
    personality: string;
    isExplicit?: boolean;
    avatarPrompt?: string | null;
  },
  customPrompt?: string
): string {
  if (customPrompt?.trim()) {
    return customPrompt.trim();
  }

  if (character.avatarPrompt?.trim()) {
    return character.avatarPrompt.trim();
  }

  return `A highly polished digital portrait of a fictional character named ${character.name}. Tagline: ${character.tagline || "n/a"}. Traits: ${character.personality}.`;
}

function buildBackgroundPrompt(
  character: {
    name: string;
    tagline: string;
    backstory?: string;
    isExplicit?: boolean;
  },
  customPrompt?: string
): string {
  if (customPrompt?.trim()) {
    return customPrompt.trim();
  }

  const parts = [
    `A background scene for ${character.name}.`,
    character.tagline ? `Tagline: ${character.tagline}.` : null,
    character.backstory?.trim() ? `Setting: ${character.backstory.trim().slice(0, 500)}.` : null,
  ].filter(Boolean);

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

async function validateGeneratedImage(bytes: Buffer): Promise<void> {
  await inspectImage(bytes);
  // Metadata alone accepts some truncated images; force an actual decode.
  await sharp(bytes, { limitInputPixels: 40_000_000 }).resize(1, 1).png().toBuffer();
}

type ProviderAttempt = { name: string; run: () => Promise<Buffer>; breaker?: ProviderBreaker };

export async function processImageGen(data: ImageGenJobData): Promise<ImageGenJobResult> {
  await acquireImageGenSlot();
  try {
    const { prompt, isExplicit, kind } = data;
    const timeoutMs = imageTimeoutMs();

    const pollinationsFn = kind === "avatar"
      ? () => withPollinationsRetry(() => generatePollinationsAvatar({ isExplicit }, prompt, timeoutMs))
      : () => withPollinationsRetry(() => generatePollinationsBackground(isExplicit, prompt, timeoutMs));

    // Ordered priority chain, not a race: each provider is tried in turn
    // and the first success wins.
    //
    // Gemini was removed (2026-08-24): its image models returned a hard
    // `limit: 0` free-tier quota for this project on every model tested
    // — not ordinary rate-limiting, but zero free-tier allocation,
    // meaning it would never succeed without linking billing.
    //
    // Hugging Face was tried and then removed the same day: its
    // Inference Providers routing for image models proved unusable via
    // raw HTTP calls in testing — every documented URL/provider
    // combination (hf-inference, fal-ai path routing, the unified
    // /v1/images/generations endpoint with a model:provider suffix)
    // either 410'd, 400'd with "Model not supported by provider X", or
    // 404'd outright. Their own docs route developers through the
    // huggingface_hub client library specifically because it handles
    // this model-to-provider translation internally — it isn't a stable
    // public REST contract yet, so it isn't worth depending on here.
    //
    // Current chain: Pollinations, then Cloudflare, then (avatars only)
    // a best-effort DiceBear fallback — see below.
    const pollinationsAttempt: ProviderAttempt = {
      name: "pollinations",
      run: pollinationsFn,
      breaker: pollinationsBreaker,
    };
    const cloudflareAttempt: ProviderAttempt = {
      name: "cloudflare",
      run: () => generateCloudflareImage(
        prompt,
        timeoutMs,
        kind === "avatar" ? { width: 1024, height: 1024 } : { width: 1920, height: 1080 }
      ),
    };

    const chain: ProviderAttempt[] = [pollinationsAttempt, cloudflareAttempt];

    const errors: string[] = [];

    for (const attempt of chain) {
      if (attempt.name === "cloudflare" && !isCloudflareConfigured()) {
        errors.push("cloudflare: not configured");
        continue;
      }
      if (attempt.breaker?.isOpen()) {
        errors.push(`${attempt.name}: circuit breaker open, skipped`);
        continue;
      }
      try {
        const bytes = await attempt.run();
        // Validate while still inside the provider attempt so corrupt/HTML
        // success responses trigger fallback instead of failing during upload.
        await validateGeneratedImage(bytes);
        attempt.breaker?.reset();
        return { bytes, provider: attempt.name };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[avatar] ${attempt.name} failed: ${msg.slice(0, 300)}`);
        errors.push(`${attempt.name}: ${msg}`);
        // withPollinationsRetry() already trips its own breaker
        // internally on a final rate-limit/timeout failure; avoid
        // double-tripping it here.
        if (attempt.breaker && attempt.name !== "pollinations") {
          if (isRateLimitError(err)) attempt.breaker.trip(err);
          else if (isTimeoutError(err)) attempt.breaker.recordTimeout();
        }
      }
    }

    // Best-effort final fallback for avatars only (DiceBear has no
    // background/scene equivalent): every real AI provider failed, so
    // hand back a deterministic procedural avatar instead of a hard
    // error. Seeded from the prompt so retries for the same character
    // return a consistent placeholder rather than a different random
    // one each time.
    if (kind === "avatar") {
      try {
        const bytes = await generateDicebearAvatar(prompt, timeoutMs);
        await validateGeneratedImage(bytes);
        return { bytes, provider: "dicebear-fallback" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`dicebear: ${msg}`);
      }
    }

    throw new Error(`All providers failed: ${errors.join("; ")}`);
  } finally {
    releaseImageGenSlot();
  }
}

export function startImageGenWorker(): void {
  console.log("[image-queue] Using in-memory queue (BullMQ Postgres backend disabled)");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /api/characters/:id/avatar — upload an image file
router.post("/:id/avatar", requireUser, upload.single("avatar"), asyncHandler(async (req, res) => {
  const userId = res.locals.uploadUserId as string;
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const character = await prisma.character.findUnique({ where: { id: req.params.id } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "No image file was sent." });
  }
  const ext = ALLOWED_TYPES[file.mimetype];
  if (!ext) {
    return res.status(400).json({ error: "Use a PNG, JPEG, WebP, or GIF image." });
  }

  const publicId = `${req.params.id}-${Date.now()}`;
  const avatarUrl = await uploadAvatarBuffer(file.buffer, publicId);
  const updated = await prisma.character.update({ where: { id: req.params.id }, data: { avatarUrl } });

  return res.json({ character: updated });
}));

// POST /api/characters/:id/avatar/generate — AI-generate an avatar
router.post("/:id/avatar/generate", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const character = await prisma.character.findUnique({ where: { id: req.params.id } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  const limit = checkRateLimit(`character-image:${userId}`, 10, 60 * 60);
  if (limit.limited) { res.set("Retry-After", String(limit.retryAfterSeconds)); return res.status(429).json({ error: "Too many image generations. Please try again later." }); }
  const body = req.body ?? {};
  const customPrompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 2000) : undefined;
  const prompt = buildAvatarPrompt(character, customPrompt);

  try {
    const result = await processImageGen({ prompt, isExplicit: !!character.isExplicit, kind: "avatar" });
    const cleanBytes = await sharp(result.bytes).sharpen().toBuffer().catch(() => result.bytes);
    const publicId = `${req.params.id}-${Date.now()}-generated`;
    const avatarUrl = await uploadAvatarBuffer(cleanBytes, publicId);
    const updated = await prisma.character.update({ where: { id: req.params.id }, data: { avatarUrl } });
    console.log(`[avatar] generated via ${result.provider}`);
    return res.json({ character: updated, imageGeneration: { provider: result.provider, isFallback: result.provider === "dicebear-fallback" } });
  } catch (err) {
    console.error("Avatar generation failed", err);
    if ((err as any)?.status === 503 && (err as any)?.expose) {
      res.set("Retry-After", "5");
      return res.status(503).json({ error: (err as Error).message });
    }
    return res.status(502).json({ error: "Avatar generation failed. Try again, or upload an image instead." });
  }
}));

// ---------------------------------------------------------------------------
// Background generation
// ---------------------------------------------------------------------------

// POST /api/characters/:id/background/generate — AI-generate a chat background/wallpaper image
router.post("/:id/background/generate", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const character = await prisma.character.findUnique({ where: { id: req.params.id } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  const limit = checkRateLimit(`character-image:${userId}`, 10, 60 * 60);
  if (limit.limited) { res.set("Retry-After", String(limit.retryAfterSeconds)); return res.status(429).json({ error: "Too many image generations. Please try again later." }); }
  const body = req.body ?? {};
  const customPrompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 2000) : undefined;
  const prompt = buildBackgroundPrompt(character, customPrompt);

  try {
    const result = await processImageGen({ prompt, isExplicit: !!character.isExplicit, kind: "background" });
    let cleanBytes = await sharp(result.bytes).sharpen().toBuffer().catch(() => result.bytes);
    if (cleanBytes.length) {
      cleanBytes = await sharp(cleanBytes)
        .resize(1920, 1080, { fit: "cover" })
        .toBuffer()
        .catch(() => cleanBytes);
    }
    const publicId = `${req.params.id}-${Date.now()}-bg`;
    const backgroundUrl = await uploadAvatarBuffer(cleanBytes, publicId);
    const updated = await prisma.character.update({ where: { id: req.params.id }, data: { backgroundUrl } });
    console.log(`[background] generated via ${result.provider}`);
    return res.json({ character: updated, imageGeneration: { provider: result.provider, isFallback: result.provider === "dicebear-fallback" } });
  } catch (err) {
    console.error("Background generation failed", err);
    if ((err as any)?.status === 503 && (err as any)?.expose) {
      res.set("Retry-After", "5");
      return res.status(503).json({ error: (err as Error).message });
    }
    return res.status(502).json({ error: "Background generation failed. Try again with a different prompt." });
  }
}));

// POST /api/characters/:id/background — upload a custom background image
router.post("/:id/background", requireUser, upload.single("background"), asyncHandler(async (req, res) => {
  const userId = res.locals.uploadUserId as string;
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const character = await prisma.character.findUnique({ where: { id: req.params.id } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "No image file was sent." });
  }
  const ext = ALLOWED_TYPES[file.mimetype];
  if (!ext) {
    return res.status(400).json({ error: "Use a PNG, JPEG, WebP, or GIF image." });
  }

  const publicId = `${req.params.id}-${Date.now()}-bg`;
  const backgroundUrl = await uploadAvatarBuffer(file.buffer, publicId);
  const updated = await prisma.character.update({ where: { id: req.params.id }, data: { backgroundUrl } });

  return res.json({ character: updated });
}));

// DELETE /api/characters/:id/background — remove the background image
router.delete("/:id/background", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const character = await prisma.character.findUnique({ where: { id: req.params.id } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  const updated = await prisma.character.update({
    where: { id: req.params.id },
    data: { backgroundUrl: null },
  });

  return res.json({ character: updated });
}));

export default router;
