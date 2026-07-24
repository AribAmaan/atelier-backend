import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/db";
import { getCurrentUserId } from "../lib/auth";

const router = Router();

const MAX_FIELD_LENGTH = 1200;

function clean(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, MAX_FIELD_LENGTH);
}

async function loadOwnedCharacter(id: string, userId: string) {
  const character = await prisma.character.findUnique({ where: { id } });
  if (!character || character.ownerId !== userId) return null;
  return character;
}

router.get("/", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const characters = await prisma.character.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: "desc" },
  });
  return res.json({ characters });
}));

router.post("/", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const body = req.body ?? {};
  const name = clean(body.name);
  const tagline = clean(body.tagline);
  const personality = clean(body.personality);
  const backstory = clean(body.backstory);
  const greeting = clean(body.greeting);
  const avatarEmoji = clean(body.avatarEmoji, "🌸").slice(0, 8) || "🌸";
  const accentColor = /^#[0-9a-fA-F]{6}$/.test(body.accentColor) ? body.accentColor : "#c9a227";
  const isExplicit = body.isExplicit === true;

  if (!name || !personality || !backstory || !greeting) {
    return res.status(400).json({ error: "Name, personality, backstory, and greeting are all required." });
  }

  const character = await prisma.character.create({
    data: { ownerId: userId, name, tagline, personality, backstory, greeting, avatarEmoji, accentColor, isExplicit },
  });

  return res.json({ character });
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const character = await loadOwnedCharacter(req.params.id, userId);
  if (!character) return res.status(404).json({ error: "Character not found." });

  return res.json({ character });
}));

router.put("/:id", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const existing = await loadOwnedCharacter(req.params.id, userId);
  if (!existing) return res.status(404).json({ error: "Character not found." });

  const body = req.body ?? {};
  const name = clean(body.name, existing.name);
  const tagline = clean(body.tagline, existing.tagline);
  const personality = clean(body.personality, existing.personality);
  const backstory = clean(body.backstory, existing.backstory);
  const greeting = clean(body.greeting, existing.greeting);
  const avatarEmoji = clean(body.avatarEmoji, existing.avatarEmoji).slice(0, 8) || existing.avatarEmoji;
  const accentColor = /^#[0-9a-fA-F]{6}$/.test(body.accentColor) ? body.accentColor : existing.accentColor;
  const isExplicit = typeof body.isExplicit === "boolean" ? body.isExplicit : existing.isExplicit;

  if (!name || !personality || !backstory || !greeting) {
    return res.status(400).json({ error: "Name, personality, backstory, and greeting are all required." });
  }

  const character = await prisma.character.update({
    where: { id: req.params.id },
    data: { name, tagline, personality, backstory, greeting, avatarEmoji, accentColor, isExplicit },
  });

  return res.json({ character });
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const character = await loadOwnedCharacter(req.params.id, userId);
  if (!character) return res.status(404).json({ error: "Character not found." });

  await prisma.character.delete({ where: { id: req.params.id } });
  return res.json({ ok: true });
}));

export default router;
