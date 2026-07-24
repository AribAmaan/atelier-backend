import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import multer from "multer";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { prisma } from "../lib/db";
import { getCurrentUserId } from "../lib/auth";

const router = Router();

const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_BYTES = 5 * 1024 * 1024; // 5MB

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

const uploadsDir = path.join(process.cwd(), "public", "uploads", "avatars");

// POST /api/characters/:id/avatar — upload an image file
router.post("/:id/avatar", upload.single("avatar"), asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
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

  await mkdir(uploadsDir, { recursive: true });

  const filename = `${req.params.id}-${Date.now()}.${ext}`;
  await writeFile(path.join(uploadsDir, filename), file.buffer);

  const avatarUrl = `/uploads/avatars/${filename}`;
  const updated = await prisma.character.update({ where: { id: req.params.id }, data: { avatarUrl } });

  return res.json({ character: updated });
}));

// Keeps generated art on-model: a portrait, no text, no photorealistic real people.
function buildImagePrompt(character: { name: string; personality: string; tagline: string }) {
  return (
    `A stylized portrait avatar of a fictional character named ${character.name}. ` +
    `Tagline: ${character.tagline || "n/a"}. Traits: ${character.personality}. ` +
    `Digital illustration, shoulders-up portrait, clean background, no text, safe for general audiences.`
  );
}

// POST /api/characters/:id/avatar/generate — AI-generate an avatar (needs OPENAI_API_KEY)
router.post("/:id/avatar/generate", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const character = await prisma.character.findUnique({ where: { id: req.params.id } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      error:
        "Avatar generation is optional and needs an OPENAI_API_KEY set in .env to work. Upload an image instead, or add that key.",
    });
  }

  const prompt = buildImagePrompt(character);

  const controller = new AbortController();
  const timeoutMs = Number(process.env.OPENAI_IMAGE_TIMEOUT_SECONDS || "30") * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let apiRes: Response;
  try {
    apiRes = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1024", n: 1 }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return res.status(504).json({
        error: `Image generation timed out after ${timeoutMs / 1000}s. Try again, or upload an image instead.`,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!apiRes.ok) {
    const errText = await apiRes.text().catch(() => "");
    console.error("Image generation failed", errText);
    return res.status(502).json({ error: "Image generation failed. Check your OPENAI_API_KEY and try again." });
  }

  const data: any = await apiRes.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    return res.status(502).json({ error: "Image generation returned no image." });
  }

  await mkdir(uploadsDir, { recursive: true });
  const filename = `${req.params.id}-${Date.now()}-generated.png`;
  await writeFile(path.join(uploadsDir, filename), Buffer.from(b64, "base64"));

  const avatarUrl = `/uploads/avatars/${filename}`;
  const updated = await prisma.character.update({ where: { id: req.params.id }, data: { avatarUrl } });

  return res.json({ character: updated });
}));

export default router;
