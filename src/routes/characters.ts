import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/db";
import { getCurrentUserId } from "../lib/auth";
import { checkRateLimit } from "../lib/rateLimit";
import { draftCharacterWithFallback, listAvailableProviders } from "../lib/providers";

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

  type LatestRow = { characterId: string; content: string; role: string; createdAt: Date };
  type CountRow = { characterId: string; count: bigint };

  // One row per character: its single most recent message (if any), so the
  // dashboard can show a preview + "last active" time without an N+1 query
  // per card.
  const latest: LatestRow[] = await prisma.$queryRaw`
    SELECT DISTINCT ON ("characterId") "characterId", "content", "role", "createdAt"
    FROM "Message"
    WHERE "userId" = ${userId}
    ORDER BY "characterId", "createdAt" DESC
  `;
  const latestByCharacter = new Map<string, LatestRow>(latest.map((m: LatestRow) => [m.characterId, m]));

  // Total message count per character, so the dashboard can show how many
  // messages have been exchanged without an N+1 query per card.
  const counts: CountRow[] = await prisma.$queryRaw`
    SELECT "characterId", COUNT(*) as count
    FROM "Message"
    WHERE "userId" = ${userId}
    GROUP BY "characterId"
  `;
  const countByCharacter = new Map<string, number>(counts.map((row: CountRow) => [row.characterId, Number(row.count)]));

  const enriched = characters.map((c: any) => {
    const last = latestByCharacter.get(c.id);
    return {
      ...c,
      lastMessagePreview: last?.content ?? null,
      lastMessageRole: last?.role ?? null,
      lastActivityAt: last?.createdAt ?? c.createdAt,
      messageCount: countByCharacter.get(c.id) ?? 0,
    };
  });

  // Most recently active conversation first; characters with no messages
  // yet fall back to their creation time, so brand-new ones still show up
  // near the top rather than sorting as if long-forgotten.
  enriched.sort(
    (a: { lastActivityAt: Date }, b: { lastActivityAt: Date }) =>
      new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
  );

  return res.json({ characters: enriched });
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
  // Explicit characters never enter the public discovery gallery — this app
  // has no age-gating or content moderation for that gallery, so it's not a
  // safe place for NSFW personas regardless of what a request claims.
  const isPublic = body.isPublic === true && !isExplicit;

  if (!name || !personality || !backstory || !greeting) {
    return res.status(400).json({ error: "Name, personality, backstory, and greeting are all required." });
  }

  const character = await prisma.character.create({
    data: { ownerId: userId, name, tagline, personality, backstory, greeting, avatarEmoji, accentColor, isExplicit, isPublic },
  });

  return res.json({ character });
}));

// POST /api/characters/draft — turn a one-line idea into a full character
// draft (name/tagline/personality/backstory/greeting) for the user to review
// before creating. Uses the same free-tier provider chain as chat.
router.post("/draft", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const limit = checkRateLimit(`draft:${userId}`, 10, 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many draft requests. Please slow down a bit." });
  }

  const idea = typeof req.body?.idea === "string" ? req.body.idea.trim().slice(0, 300) : "";
  if (!idea) {
    return res.status(400).json({ error: "Describe your character idea in a sentence first." });
  }

  const available = await listAvailableProviders();
  if (available.length === 0) {
    return res.status(502).json({
      error: "No chat provider is available to draft a character right now. Fill in the form yourself instead.",
    });
  }

  try {
    const draft = await draftCharacterWithFallback(idea);
    return res.json({ draft });
  } catch (err) {
    console.error(err);
    return res.status(502).json({
      error: "Couldn't draft a character right now. Try again, or fill in the form yourself.",
    });
  }
}));

// GET /api/characters/discover — public gallery of characters shared by any
// user. Explicit characters are never included here (enforced when a
// character is made public, not just at read time, but double-checked here
// too as defense in depth).
// NOTE: this must be registered before GET "/:id" below, or Express will
// treat "discover" as an :id and this route will never be reached.
router.get("/discover", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const characters = await prisma.character.findMany({
    where: { isPublic: true, isExplicit: false },
    orderBy: [{ remixCount: "desc" }, { createdAt: "desc" }],
    take: 60,
    include: { owner: { select: { displayName: true } } },
  });

  return res.json({ characters });
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
  const requestedPublic = typeof body.isPublic === "boolean" ? body.isPublic : existing.isPublic;
  const isPublic = requestedPublic && !isExplicit;

  if (!name || !personality || !backstory || !greeting) {
    return res.status(400).json({ error: "Name, personality, backstory, and greeting are all required." });
  }

  const character = await prisma.character.update({
    where: { id: req.params.id },
    data: { name, tagline, personality, backstory, greeting, avatarEmoji, accentColor, isExplicit, isPublic },
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

// POST /api/characters/:id/remix — clone a public character into the
// requesting user's own collection so they can chat with and edit their own
// copy. The original stays untouched and owned by whoever shared it.
router.post("/:id/remix", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const source = await prisma.character.findUnique({ where: { id: req.params.id } });
  if (!source || !source.isPublic || source.isExplicit) {
    return res.status(404).json({ error: "That character isn't available to remix." });
  }

  const character = await prisma.character.create({
    data: {
      ownerId: userId,
      name: source.name,
      tagline: source.tagline,
      personality: source.personality,
      backstory: source.backstory,
      greeting: source.greeting,
      avatarEmoji: source.avatarEmoji,
      avatarUrl: source.avatarUrl,
      accentColor: source.accentColor,
      isExplicit: false,
      isPublic: false, // the remix starts private; the user can choose to share their own copy later
    },
  });

  // Track popularity on the original so Discover can rank by remix count.
  await prisma.character.update({
    where: { id: source.id },
    data: { remixCount: { increment: 1 } },
  });

  return res.json({ character });
}));

export default router;
