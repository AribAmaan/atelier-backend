import { truncateUnits } from "../lib/text";
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/db";
import { getCurrentUserId } from "../lib/auth";
import { isAdminEmail } from "../lib/admin";
import { checkRateLimit } from "../lib/rateLimit";

const router = Router();

// A character auto-hides from Discover once it collects this many open
// reports, pending an admin's decision — better to pull something out of
// view too eagerly than to leave a genuinely bad card up while it waits in
// a queue nobody's looked at yet.
const AUTO_HIDE_THRESHOLD = 3;

const VALID_REASONS = new Set([
  "harassment_or_hate",
  "impersonates_real_person",
  "sexual_content_not_marked_explicit",
  "spam_or_scam",
  "other",
]);

// POST /api/characters/:id/report — any signed-in user can report a public
// character card. Reporting your own character is a no-op error, and you
// can't file the same report twice.
router.post("/characters/:id/report", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const limit = checkRateLimit(`report:${userId}`, 20, 60 * 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many reports filed recently. Please slow down." });
  }

  const character = await prisma.character.findUnique({ where: { id: req.params.id } });
  if (!character || !character.isPublic) {
    return res.status(404).json({ error: "That character isn't available to report." });
  }
  if (character.ownerId === userId) {
    return res.status(400).json({ error: "You can't report your own character." });
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
  const note = typeof req.body?.note === "string" ? truncateUnits(req.body.note.trim(), 500) : "";
  if (!VALID_REASONS.has(reason)) {
    return res.status(400).json({ error: "Choose a valid report reason." });
  }

  await prisma.$transaction(async tx => {
    // Serialize report creation per character, so retries cannot count twice.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM \`Character\` WHERE id = ${character.id} FOR UPDATE`;
    if (!locked.length) throw Object.assign(new Error("Character not found."), { status: 404, expose: true });
    const duplicate = await tx.report.findFirst({ where: { characterId: character.id, reporterId: userId, status: "open" } });
    if (duplicate) return;
    await tx.report.create({ data: { characterId: character.id, reporterId: userId, reason, note } });
    const openCount = await tx.report.count({ where: { characterId: character.id, status: "open" } });
    await tx.character.update({ where: { id: character.id }, data: { flagCount: openCount, ...(openCount >= AUTO_HIDE_THRESHOLD ? { isHidden: true } : {}) } });
  });

  return res.json({ ok: true, message: "Thanks — this has been sent to the review queue." });
}));

async function requireAdmin(req: any, res: any): Promise<string | null> {
  const userId = await getCurrentUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Not signed in." });
    return null;
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!isAdminEmail(user?.email)) {
    res.status(403).json({ error: "Admin access required." });
    return null;
  }
  return userId;
}

// GET /api/admin/reports — open reports, grouped implicitly by character
// (each row is one report; a character with 3 reports appears 3 times, which
// is fine for a small review queue and lets an admin dismiss reports
// individually).
router.get("/admin/reports", asyncHandler(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;

  const reports = await prisma.report.findMany({
    where: { status: "open" },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      character: { select: { id: true, name: true, tagline: true, isHidden: true, ownerId: true } },
      reporter: { select: { displayName: true, email: true } },
    },
  });

  return res.json({ reports });
}));

// POST /api/admin/reports/:id/resolve  { action: "dismiss" | "hide" | "delete" }
router.post("/admin/reports/:id/resolve", asyncHandler(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;

  const report = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!report) return res.status(404).json({ error: "Report not found." });

  const action = req.body?.action;
  if (!["dismiss", "hide", "delete"].includes(action)) {
    return res.status(400).json({ error: "action must be dismiss, hide, or delete." });
  }

  await prisma.$transaction(async tx => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM \`Character\` WHERE id = ${report.characterId} FOR UPDATE`;
    if (!locked.length) return;
    const current = await tx.report.findUnique({ where: { id: report.id } });
    if (!current || current.status !== "open") return;
    if (action === "dismiss") {
      await tx.report.update({ where: { id: report.id }, data: { status: "dismissed" } });
      const stillOpen = await tx.report.count({ where: { characterId: report.characterId, status: "open" } });
      const upheld = await tx.report.count({ where: { characterId: report.characterId, status: "upheld" } });
      await tx.character.update({ where: { id: report.characterId }, data: { flagCount: stillOpen, isHidden: stillOpen >= AUTO_HIDE_THRESHOLD || upheld > 0 } });
    } else if (action === "hide") {
      await tx.report.updateMany({ where: { characterId: report.characterId, status: "open" }, data: { status: "upheld" } });
      await tx.character.update({ where: { id: report.characterId }, data: { isHidden: true, isPublic: false, flagCount: 0 } });
    } else {
      await tx.character.delete({ where: { id: report.characterId } });
    }
  });

  return res.json({ ok: true });
}));

export default router;
