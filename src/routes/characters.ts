import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/db";
import { getCurrentUserId } from "../lib/auth";
import { checkRateLimit } from "../lib/rateLimit";
import { draftCharacterWithFallback, listAvailableProviders } from "../lib/providers";
import { truncateGraphemes, truncateUnits } from "../lib/text";
import { minorSexualContentDetected, characterMinorFlagged, MINOR_CONTENT_ERROR } from "../lib/minorSafety";


const router = Router();


const MAX_FIELD_LENGTH = 1200;
const MAX_IMPORT_BATCH = 50;

function clean(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  return truncateUnits(value.trim(), MAX_FIELD_LENGTH);
}

type CharacterInput = {
  name: string;
  tagline: string;
  personality: string;
  backstory: string;
  greeting: string;
  avatarEmoji: string;
  accentColor: string;
  isExplicit: boolean;
  isPublic: boolean;
  roleplayNotes: string;
  avatarPrompt: string;
  scenePromptTemplate: string;
  examples: string;
  tags: string;
};

const MAX_PROMPT_FIELD_LENGTH = 2000;

function cleanPrompt(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  return truncateUnits(value.trim(), MAX_PROMPT_FIELD_LENGTH);
}

function parseExamples(value: unknown): string {
  if (typeof value !== "string") return "[]";
  const trimmed = value.trim();
  if (!trimmed) return "[]";
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return "[]";
    const sanitized = parsed.slice(0, 10).map((turn: any) => ({
      user: typeof turn?.user === "string" ? truncateUnits(turn.user, 500) : "",
      character: typeof turn?.character === "string" ? truncateUnits(turn.character, 500) : "",
    })).filter((turn: any) => turn.user || turn.character);
    while (JSON.stringify(sanitized).length > 8000) sanitized.pop();
    return JSON.stringify(sanitized);
  } catch {
    return "[]";
  }
}

function parseTags(value: unknown): string {
  if (typeof value !== "string") return "[]";
  const trimmed = value.trim();
  if (!trimmed) return "[]";
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const sanitized = parsed.filter((t: any) => typeof t === "string").map((t: string) => truncateUnits(t.trim(), 30)).filter(Boolean).slice(0, 10);
      return JSON.stringify(sanitized);
    }
  } catch {
    // fall through to comma-separated parsing
  }
  const sanitized = trimmed.split(",").map((t) => truncateUnits(t.trim(), 30)).filter(Boolean).slice(0, 10);
  return JSON.stringify(sanitized);
}

// Server-side backstop against sexualized minors in character content. See
// lib/minorSafety.ts — deliberately narrow so ordinary adult backstories pass.
function characterFieldsFlagged(
  f: { name: string; tagline: string; personality: string; backstory: string; greeting: string; roleplayNotes: string; avatarPrompt: string; scenePromptTemplate: string; examples: string; tags: string },
  isExplicit: boolean
): boolean {
  return characterMinorFlagged(
    {
      subject: [f.name, f.tagline, f.personality, f.greeting, f.avatarPrompt, f.tags],
      narrative: [f.backstory, f.roleplayNotes, f.scenePromptTemplate, f.examples],
    },
    isExplicit
  );
}

function parseCharacterInput(body: unknown): { data?: CharacterInput; error?: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Each entry must be an object." };
  }
  const raw = body as Record<string, unknown>;
  const name = truncateUnits(clean(raw.name), 191);
  const tagline = truncateUnits(clean(raw.tagline), 191);
  const personality = clean(raw.personality);
  const backstory = clean(raw.backstory);
  const greeting = clean(raw.greeting);
  const avatarEmoji = truncateGraphemes(clean(raw.avatarEmoji, "🌸"), 8) || "🌸";
  const accentColor = /^#[0-9a-fA-F]{6}$/.test(String(raw.accentColor ?? ""))
    ? String(raw.accentColor)
    : "#c9a227";
  const isExplicit = raw.isExplicit === true;
  // Explicit characters CAN be shared publicly — /discover already gates
  // them server-side behind ?nsfw=1, which the client only ever sends once
  // the person has explicitly turned on the 18+ toggle (see explore/page.tsx).
  // So a public+explicit character simply never appears to a viewer who
  // hasn't opted in, the same way a private character never appears to
  // anyone but its owner.
  const isPublic = raw.isPublic === true;
  const roleplayNotes = isExplicit ? clean(raw.roleplayNotes) : "";
  const avatarPrompt = cleanPrompt(raw.avatarPrompt);
  const scenePromptTemplate = cleanPrompt(raw.scenePromptTemplate);
  const examples = parseExamples(raw.examples);
  const tags = parseTags(raw.tags);

  if (!name || !personality || !backstory || !greeting) {
    return { error: "Name, personality, backstory, and greeting are all required." };
  }
  if (characterFieldsFlagged({ name, tagline, personality, backstory, greeting, roleplayNotes, avatarPrompt, scenePromptTemplate, examples, tags }, isExplicit)) {
    return { error: MINOR_CONTENT_ERROR };
  }

  return {
    data: {
      name,
      tagline,
      personality,
      backstory,
      greeting,
      avatarEmoji,
      accentColor,
      isExplicit,
      isPublic,
      roleplayNotes,
      avatarPrompt,
      scenePromptTemplate,
      examples,
      tags,
    },
  };
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

  // One row per character: its single most recent message (if any), so the
  // dashboard can show a preview + "last active" time without an N+1 query
  // per card.
  const latest: LatestRow[] = await prisma.$queryRaw`
    SELECT m.\`characterId\`, m.content, m.role, m.\`createdAt\`
    FROM \`Message\` AS m
    WHERE m.\`userId\` = ${userId}
      AND NOT EXISTS (
        SELECT 1
        FROM \`Message\` AS newer
        WHERE newer.\`userId\` = m.\`userId\`
          AND newer.\`characterId\` = m.\`characterId\`
          AND (
            newer.\`createdAt\` > m.\`createdAt\`
            OR (newer.\`createdAt\` = m.\`createdAt\` AND newer.id > m.id)
          )
      )
  `;
  const latestByCharacter = new Map<string, LatestRow>(latest.map((m: LatestRow) => [m.characterId, m]));

  const enriched = characters.map((c: any) => {
    const last = latestByCharacter.get(c.id);
    return {
      ...c,
      lastMessagePreview: last?.content ?? null,
      lastMessageRole: last?.role ?? null,
      lastActivityAt: last?.createdAt ?? c.createdAt,
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

// Sharing to the public Discover gallery requires a verified email address —
// it's the one place in the app where a stranger's content reaches other
// users, so we want at least that much confidence in who published it.
async function enforceVerifiedForPublic(userId: string, isPublic: boolean): Promise<string | null> {
  if (!isPublic) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerified: true } });
  if (!user?.emailVerified) {
    return "Verify your email before sharing a character to Discover. Check your inbox, or resend the link from your account.";
  }
  return null;
}

router.post("/", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const parsed = parseCharacterInput(req.body ?? {});
  if (!parsed.data) {
    return res.status(400).json({ error: parsed.error });
  }

  const verifyError = await enforceVerifiedForPublic(userId, parsed.data.isPublic);
  if (verifyError) return res.status(403).json({ error: verifyError });

  const character = await prisma.character.create({
    data: { ownerId: userId, ...parsed.data },
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

  const idea = typeof req.body?.idea === "string" ? truncateUnits(req.body.idea.trim(), 300) : "";
  const allowExplicit = req.body?.allowExplicit === true;
  if (!idea) {
    return res.status(400).json({ error: "Describe your character idea in a sentence first." });
  }

  if (minorSexualContentDetected([idea], allowExplicit)) {
    return res.status(400).json({ error: MINOR_CONTENT_ERROR });
  }

  const available = await listAvailableProviders();
  if (available.length === 0) {
    return res.status(502).json({
      error: "No chat provider is available to draft a character right now. Fill in the form yourself instead.",
    });
  }

  try {
    const draft = await draftCharacterWithFallback(idea, allowExplicit);
    // The model's output is checked too, not just the idea.
    const d = draft as unknown as Record<string, string | undefined>;
    if (characterMinorFlagged({
      subject: [d.name, d.tagline, d.personality, d.greeting],
      narrative: [d.backstory, d.roleplayNotes],
    }, allowExplicit)) {
      return res.status(422).json({ error: MINOR_CONTENT_ERROR });
    }
    return res.json({ draft });
  } catch (err) {
    console.error(err);
    return res.status(502).json({
      error: "Couldn't draft a character right now. Try again, or fill in the form yourself.",
    });
  }
}));

// POST /api/characters/import — bulk-create characters from a JSON array
router.post("/import", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const limit = checkRateLimit(`import:${userId}`, 5, 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many import requests. Please slow down a bit." });
  }

  const raw = req.body?.characters;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: "Send a non-empty characters array." });
  }
  if (raw.length > MAX_IMPORT_BATCH) {
    return res.status(400).json({ error: `Import at most ${MAX_IMPORT_BATCH} characters at once.` });
  }

  // Same verified-email gate that POST / and PUT /:id enforce before a
  // character can reach the public Discover gallery. Checked once up front
  // (rather than per-item) since it depends only on the requesting user.
  // Bulk import intentionally never hard-fails the whole batch over this —
  // any entry requesting isPublic gets silently downgraded to private, and
  // the user is told so in the response instead of losing the rest of the
  // batch. Explicit characters are no longer excluded from this — they can
  // be public too, gated at read time by /discover's ?nsfw=1 param.
  const canPublish = !(await enforceVerifiedForPublic(userId, true));

  const created: Awaited<ReturnType<typeof prisma.character.create>>[] = [];
  const errors: { index: number; name: string; error: string }[] = [];
  let downgradedForVerification = 0;

  for (let i = 0; i < raw.length; i++) {
    const parsed = parseCharacterInput(raw[i]);
    if (!parsed.data) {
      errors.push({ index: i, name: clean((raw[i] as Record<string, unknown>)?.name), error: parsed.error ?? "Invalid entry." });
      continue;
    }
    if (parsed.data.isPublic && !canPublish) {
      parsed.data.isPublic = false;
      downgradedForVerification++;
    }
    const character = await prisma.character.create({
      data: { ownerId: userId, ...parsed.data },
    });
    created.push(character);
  }

  return res.json({
    imported: created.length,
    characters: created,
    errors,
    ...(downgradedForVerification > 0
      ? {
          notice: `${downgradedForVerification} character(s) were imported as private instead of public — verify your email to share to Discover.`,
        }
      : {}),
  });
}));

// GET /api/characters/discover — public gallery of characters shared by any
// user. Two separate galleries, not one filtered list: by default only
// non-explicit ("SFW") characters are returned; pass ?nsfw=1 to switch to
// the explicit gallery instead. This is the server-side half of the
// homepage's 18+ toggle — the client sends ?nsfw=1 only once the person has
// switched it on, so explicit content never reaches a browser that hasn't
// asked for it.
// NOTE: this must be registered before GET "/:id" below, or Express will
// treat "discover" as an :id and this route will never be reached.
router.get("/discover", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const includeExplicit = req.query.nsfw === "1" || req.query.nsfw === "true";

  // Two separate galleries, not layered: the 18+ toggle switches from SFW to
  // explicit rather than adding explicit on top of SFW.
  const explicitFilter = includeExplicit
    ? { isExplicit: true }
    : { isExplicit: false };

  const characters = await prisma.character.findMany({
    where: {
      isPublic: true,
      isHidden: false,
      ...explicitFilter,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 60,
    // IMPORTANT: Discover is a cross-user/public surface. Never return a
    // full Character row here: it contains conversation memory, private
    // roleplay notes, and moderation/internal state. Keep this projection
    // explicit so adding a new private column to the Prisma model cannot
    // accidentally publish it later.
    select: {
      id: true,
      ownerId: true,
      name: true,
      tagline: true,
      avatarEmoji: true,
      avatarUrl: true,
      backgroundUrl: true,
      accentColor: true,
      personality: true,
      backstory: true,
      greeting: true,
      avatarPrompt: true,
      scenePromptTemplate: true,
      examples: true,
      tags: true,
      isExplicit: true,
      isPublic: true,
      remixOfId: true,
      createdAt: true,
      owner: { select: { displayName: true } },
      // Real remix count — replaces the frontend's fabricated pseudoViews()
      // and is also the strongest available "this character is good" signal
      // in a template/remix product (more direct than raw message volume,
      // since messages happen on the *remix*, not the original).
      _count: { select: { remixes: true } },
    },
  });

  // Recent message activity per character, for trending. Because this product
  // is template/remix-based, chats happen on the *remix* rows, not the
  // original template. Walk the full remix tree (any depth) and aggregate
  // descendant messages back to their root template so trendScore reflects
  // actual template popularity. Queried separately since Message doesn't
  // roll up via `include` with a date filter.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const rootMap = new Map<string, string>();
  const toVisit = [...characters.map((c) => c.id)];
  const visited = new Set<string>(characters.map((c) => c.id));
  for (const id of characters.map((c) => c.id)) {
    rootMap.set(id, id);
  }

  while (toVisit.length > 0) {
    const batch = toVisit.splice(0);
    const remixes = await prisma.character.findMany({
      where: { remixOfId: { in: batch } },
      select: { id: true, remixOfId: true },
    });
    for (const remix of remixes) {
      if (visited.has(remix.id)) continue;
      visited.add(remix.id);
      rootMap.set(remix.id, rootMap.get(remix.remixOfId!)!);
      toVisit.push(remix.id);
    }
  }

  const allIds = Array.from(visited);
  const recentActivity = await prisma.message.groupBy({
    by: ["characterId"],
    where: {
      characterId: { in: allIds },
      createdAt: { gte: sevenDaysAgo },
    },
    _count: { _all: true },
  });

  const templateMessageCounts = new Map<string, number>();
  for (const activity of recentActivity) {
    const rootId = rootMap.get(activity.characterId) ?? activity.characterId;
    templateMessageCounts.set(rootId, (templateMessageCounts.get(rootId) ?? 0) + activity._count._all);
  }

  const now = Date.now();
  const withStats = characters.map((c) => {
    const remixCount = c._count.remixes;
    const recentMessages = templateMessageCounts.get(c.id) ?? 0;
    const ageDays = (now - c.createdAt.getTime()) / (24 * 60 * 60 * 1000);
    const trendScore = recentMessages * 3 + remixCount * 10 - Math.min(ageDays, 30) * 0.5;
    const { _count, ...rest } = c;
    return { ...rest, remixCount, trendScore };
  });

  return res.json({ characters: withStats });
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
  const name = truncateUnits(clean(body.name, existing.name), 191);
  const tagline = truncateUnits(clean(body.tagline, existing.tagline), 191);
  const personality = clean(body.personality, existing.personality);
  const backstory = clean(body.backstory, existing.backstory);
  const greeting = clean(body.greeting, existing.greeting);
  const avatarEmoji = truncateGraphemes(clean(body.avatarEmoji, existing.avatarEmoji), 8) || existing.avatarEmoji;
  const accentColor = /^#[0-9a-fA-F]{6}$/.test(body.accentColor) ? body.accentColor : existing.accentColor;
  const isExplicit = typeof body.isExplicit === "boolean" ? body.isExplicit : existing.isExplicit;
  const requestedPublic = typeof body.isPublic === "boolean" ? body.isPublic : existing.isPublic;
  // Same as parseCharacterInput above — explicit no longer forces private,
  // /discover's ?nsfw=1 gate handles visibility instead.
  const isPublic = requestedPublic;
  const roleplayNotes = isExplicit
    ? clean(body.roleplayNotes, existing.roleplayNotes ?? "")
    : "";
  const avatarPrompt = cleanPrompt(body.avatarPrompt, existing.avatarPrompt ?? "");
  const scenePromptTemplate = cleanPrompt(body.scenePromptTemplate, existing.scenePromptTemplate ?? "");
  const examples = typeof body.examples === "string" ? parseExamples(body.examples) : existing.examples;
  const tags = typeof body.tags === "string" ? parseTags(body.tags) : existing.tags;

  if (!name || !personality || !backstory || !greeting) {
    return res.status(400).json({ error: "Name, personality, backstory, and greeting are all required." });
  }
  if (characterFieldsFlagged({ name, tagline, personality, backstory, greeting, roleplayNotes, avatarPrompt, scenePromptTemplate, examples, tags }, isExplicit)) {
    return res.status(400).json({ error: MINOR_CONTENT_ERROR });
  }

  if (isPublic && !existing.isPublic) {
    const verifyError = await enforceVerifiedForPublic(userId, true);
    if (verifyError) return res.status(403).json({ error: verifyError });
  }

  const character = await prisma.character.update({
    where: { id: req.params.id },
    data: {
      name,
      tagline,
      personality,
      backstory,
      greeting,
      avatarEmoji,
      accentColor,
      isExplicit,
      isPublic,
      roleplayNotes,
      avatarPrompt,
      scenePromptTemplate,
      examples,
      tags,
    },
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
  if (!source || !source.isPublic || source.isHidden) {
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
      backgroundUrl: source.backgroundUrl,
      accentColor: source.accentColor,
      isExplicit: source.isExplicit,
      avatarPrompt: source.avatarPrompt,
      scenePromptTemplate: source.scenePromptTemplate,
      examples: source.examples,
      tags: source.tags,
      isPublic: false, // the remix starts private; the user can choose to share their own copy later
      remixOfId: source.id, // lineage only — this row is otherwise a fully independent copy
    },
  });

  return res.json({ character });
}));

export default router;
