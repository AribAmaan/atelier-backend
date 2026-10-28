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
import { minorSexualContentDetected, MINOR_CONTENT_ERROR } from "../lib/minorSafety";
import { truncateUnits } from "../lib/text";
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

const POLLINATIONS_LEGACY_IMAGE_URL = "https://image.pollinations.ai/prompt";
const POLLINATIONS_CURRENT_IMAGE_URL = "https://gen.pollinations.ai/image";
const POLLINATIONS_SAFE_IMAGE_MODEL = "lykon/dreamshaper-8-lcm";
const POLLINATIONS_EXPLICIT_IMAGE_MODEL = "vendouple/uncensored-image-enhanced";

const pollinationsBreaker = new ProviderBreaker("Pollinations", { cooldownSeconds: 30, timeoutTripThreshold: 1, timeoutCooldownSeconds: 30 }, "POLLINATIONS");
let legacyPollinationsQueue: Promise<void> = Promise.resolve();

/**
 * Use the current authenticated Pollinations API when a server-side key is configured.
 * Without a key, retain the legacy Classic endpoint as a best-effort free fallback;
 * that endpoint has a strict per-IP limit, so its errors must open the breaker below.
 */
function buildPollinationsRequest(prompt: string, params: URLSearchParams): { url: string; init: RequestInit } {
  const apiKey = process.env.POLLINATIONS_API_KEY?.trim();
  const baseUrl = apiKey ? POLLINATIONS_CURRENT_IMAGE_URL : POLLINATIONS_LEGACY_IMAGE_URL;
  const url = `${baseUrl}/${encodeURIComponent(prompt)}?${params.toString()}`;
  if (!apiKey) return { url, init: {} };
  return { url, init: { headers: { Authorization: `Bearer ${apiKey}` } } };
}

function isPollinationsUnavailableError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // These are provider-side conditions. Do not retry them synchronously: fall through
  // to Cloudflare and cool Pollinations down so every new avatar does not hit the same wall.
  return /\b(?:401|402|403|429|503)\b/.test(message)
    || message.includes("free_limit")
    || message.includes("service_unavailable")
    || message.includes("insufficient balance")
    || message.includes("upstream provider failed")
    || /too many requests|queue full/i.test(message);
}

async function withPollinationsProtection<T>(fn: () => Promise<T>): Promise<T> {
  const hasApiKey = Boolean(process.env.POLLINATIONS_API_KEY?.trim());
  let releaseLegacySlot: (() => void) | undefined;

  // The legacy Classic endpoint is rate-limited per egress IP. Serialize it so
  // concurrent avatar/background jobs do not all race into the same quota window.
  if (!hasApiKey) {
    const previous = legacyPollinationsQueue;
    legacyPollinationsQueue = new Promise<void>((resolve) => { releaseLegacySlot = resolve; });
    await previous;
  }

  try {
    if (pollinationsBreaker.isOpen()) {
      throw new Error("Pollinations circuit breaker open, retry later");
    }
    const result = await fn();
    if (!hasApiKey) {
      // Classic documents one anonymous image every 45 seconds per IP. Open the
      // breaker after a success, not only after a 402, so the next job uses fallback.
      pollinationsBreaker.cooldownFor(45, "legacy Classic per-IP generation window");
    }
    return result;
  } catch (err) {
    if (isPollinationsUnavailableError(err) || isRateLimitError(err)) {
      pollinationsBreaker.trip(err);
    } else if (isTimeoutError(err)) {
      pollinationsBreaker.recordTimeout();
    }
    // Avoid synchronously retrying a rate-limited/slow provider; use Cloudflare now.
    throw err;
  } finally {
    releaseLegacySlot?.();
  }
}

async function generatePollinationsAvatar(
  character: { isExplicit?: boolean },
  prompt: string,
  timeoutMs: number
): Promise<Buffer> {
  const params = new URLSearchParams({
    // DreamShaper 8 LCM is optimized for low-step SD 1.5 generation. Keep the
    // safe path near its native working size; avatars are displayed small anyway.
    width: character.isExplicit ? "1024" : "768",
    height: character.isExplicit ? "1024" : "768",
    model: character.isExplicit ? POLLINATIONS_EXPLICIT_IMAGE_MODEL : POLLINATIONS_SAFE_IMAGE_MODEL,
    nologo: "true",
    safe: character.isExplicit ? "false" : "true",
    seed: String(Date.now() % 1_000_000),
    steps: character.isExplicit ? "35" : "8",
    // Explicitly pinned off: Pollinations' `enhance` flag lets an LLM
    // rewrite the prompt before generation. Default is already false,
    // but we pin it so a user's exact custom prompt can never get
    // silently reworded if that default ever changes upstream.
    enhance: "false",
  });
  const request = buildPollinationsRequest(prompt, params);
  const { body } = await requestMediaResource(request.url, request.init, "Pollinations", timeoutMs);
  return body;
}

async function generatePollinationsBackground(
  isExplicit: boolean,
  prompt: string,
  timeoutMs: number
): Promise<Buffer> {
  const params = new URLSearchParams({
    // Generate the final 16:9 background at native target dimensions. The safe
    // DreamShaper LCM path uses 8 steps; do not render small then upscale, which
    // softens fine detail in the user's chat wallpaper.
    width: "1920",
    height: "1080",
    model: isExplicit ? POLLINATIONS_EXPLICIT_IMAGE_MODEL : POLLINATIONS_SAFE_IMAGE_MODEL,
    nologo: "true",
    safe: isExplicit ? "false" : "true",
    seed: String(Date.now() % 1_000_000),
    steps: isExplicit ? "35" : "8",
    enhance: "false",
  });
  const request = buildPollinationsRequest(prompt, params);
  const { body } = await requestMediaResource(request.url, request.init, "Pollinations", timeoutMs);
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
    character.backstory?.trim() ? `Setting: ${truncateUnits(character.backstory.trim(), 500)}.` : null,
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

function providerTimeoutMs(envName: string, fallbackMs: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") return fallbackMs;
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 120 ? seconds * 1000 : fallbackMs;
}

function isCloudflareSafetyRejection(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("output has been flagged") || message.includes("code 3030") || message.includes('"code":3030');
}

function buildSafeCloudflarePrompt(prompt: string, kind: "avatar" | "background"): string {
  const framing = kind === "avatar"
    ? "Create a safe-for-work, non-sexual portrait of an adult fictional character. The character is fully clothed and posed neutrally, with no nudity or suggestive content."
    : "Create a safe-for-work environment/background illustration with no nudity, sexual content, or graphic violence.";
  return truncateUnits(`${framing} Preserve the benign visual details from this creative brief: ${prompt}`, 3500);
}

async function generateCloudflareWithSafeRetry(
  prompt: string,
  isExplicit: boolean,
  kind: "avatar" | "background",
  timeoutMs: number,
  size: { width: number; height: number }
): Promise<Buffer> {
  try {
    return await generateCloudflareImage(prompt, timeoutMs, size);
  } catch (error) {
    // Only retry a content-safety rejection for a character explicitly marked SFW,
    // and only by asking for a more clearly safe result. Never retry this way for 18+ characters.
    if (isExplicit || !isCloudflareSafetyRejection(error)) throw error;
    console.warn(`[avatar] Cloudflare safety filter rejected the first ${kind} prompt; retrying once with explicit SFW framing`);
    return generateCloudflareImage(buildSafeCloudflarePrompt(prompt, kind), timeoutMs, size);
  }
}

export async function processImageGen(data: ImageGenJobData): Promise<ImageGenJobResult> {
  await acquireImageGenSlot();
  try {
    const { prompt, isExplicit, kind } = data;
    const sharedTimeoutMs = imageTimeoutMs();
    const pollinationsAvatarTimeoutMs = providerTimeoutMs("POLLINATIONS_TIMEOUT_SECONDS", Math.min(sharedTimeoutMs, 20_000));
    // Native 1080p background renders need more time than small avatar renders.
    // Keep the two timeouts independent so background quality is not traded away
    // just to meet the avatar latency budget.
    const pollinationsBackgroundTimeoutMs = providerTimeoutMs(
      "POLLINATIONS_BACKGROUND_TIMEOUT_SECONDS",
      Math.max(sharedTimeoutMs, 35_000)
    );
    // FLUX.2 Klein is noticeably slower than the Classic image endpoint. Keep its
    // timeout independent so Pollinations overrides do not prematurely kill Klein.
    const cloudflareTimeoutMs = providerTimeoutMs("CLOUDFLARE_IMAGE_TIMEOUT_SECONDS", Math.max(sharedTimeoutMs, 45_000));

    const pollinationsFn = kind === "avatar"
      ? () => withPollinationsProtection(() => generatePollinationsAvatar({ isExplicit }, prompt, pollinationsAvatarTimeoutMs))
      : () => withPollinationsProtection(() => generatePollinationsBackground(isExplicit, prompt, pollinationsBackgroundTimeoutMs));

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
      run: () => generateCloudflareWithSafeRetry(
        prompt,
        isExplicit,
        kind,
        cloudflareTimeoutMs,
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
        // withPollinationsProtection() already trips its own breaker
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
        const bytes = await generateDicebearAvatar(prompt, sharedTimeoutMs);
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
  const customPrompt = typeof body.prompt === "string" ? truncateUnits(body.prompt.trim(), 2000) : undefined;
  const prompt = buildAvatarPrompt(character, customPrompt);

  try {
    if (minorSexualContentDetected([prompt], !!character.isExplicit)) {
      return res.status(400).json({ error: MINOR_CONTENT_ERROR, code: "minor_content_blocked" });
    }
    const result = await processImageGen({ prompt, isExplicit: !!character.isExplicit, kind: "avatar" });
    // Never let the procedural placeholder replace a real avatar the owner
    // already has; only use it to fill an empty slot.
    if (result.provider === "dicebear-fallback" && character.avatarUrl) {
      return res.status(503).set("Retry-After", "30").json({ error: "Image generators are busy right now, so your current avatar was kept. Please try again in a bit." });
    }
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
  const customPrompt = typeof body.prompt === "string" ? truncateUnits(body.prompt.trim(), 2000) : undefined;
  const prompt = buildBackgroundPrompt(character, customPrompt);

  try {
    if (minorSexualContentDetected([prompt], !!character.isExplicit)) {
      return res.status(400).json({ error: MINOR_CONTENT_ERROR, code: "minor_content_blocked" });
    }
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
