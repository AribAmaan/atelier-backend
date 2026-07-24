import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/db";
import { getCurrentUserId } from "../lib/auth";
import { checkRateLimit } from "../lib/rateLimit";
import {
  buildSystemPrompt,
  streamChatWithFallback,
  summarizeConversation,
  listAvailableProviders,
  RECENT_MESSAGE_WINDOW,
  SUMMARIZE_TRIGGER,
} from "../lib/providers";

const router = Router();

const MAX_MESSAGE_LENGTH = 4000;

router.get("/:characterId", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const { characterId } = req.params;
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  const messages = await prisma.message.findMany({
    where: { characterId, userId },
    orderBy: { createdAt: "asc" },
  });

  return res.json({ character, messages });
}));

// Events (provider failover, stream end) are interleaved with reply text using an
// out-of-band marker the frontend strips before display: \x00EVT:{...json...}\x00
function encodeEvent(event: Record<string, unknown>) {
  return `\u0000EVT:${JSON.stringify(event)}\u0000`;
}

router.post("/:characterId", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const { characterId } = req.params;

  const limit = checkRateLimit(`chat:${userId}`, 30, 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({
      error: "You're sending messages faster than the free-tier providers can keep up with. Please slow down a bit.",
    });
  }

  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  const body = req.body ?? {};
  const isRegenerate = body.regenerate === true;
  const userMessage = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
  // The client's explicitMode reflects the chat page's Normal/Explicit toggle
  // (only shown at all when character.isExplicit is true). Still, never trust
  // it on its own — a character with isExplicit: false must never be pushed
  // into explicit mode no matter what a request claims.
  const explicitMode = character.isExplicit === true && body.explicitMode === true;

  if (!isRegenerate && !userMessage) {
    return res.status(400).json({ error: "Message can't be empty." });
  }

  const available = await listAvailableProviders();
  if (available.length === 0) {
    return res.status(502).json({
      error:
        "No chat provider is available. Add a GROQ_API_KEY or NVIDIA_API_KEY to .env, or make sure " +
        "Ollama is installed and running locally (see README), then try again.",
    });
  }

  let regenTargetId: string | null = null;
  if (isRegenerate) {
    // "regenerate" covers two cases: redoing an existing reply (last message
    // is the assistant's — mark it for replacement), or retrying a turn
    // where every provider failed last time (last message is still the
    // user's — nothing to replace, just try again).
    const last = await prisma.message.findFirst({
      where: { characterId, userId },
      orderBy: { createdAt: "desc" },
    });
    if (!last) {
      return res.status(400).json({ error: "Nothing to regenerate yet." });
    }
    if (last.role === "assistant") regenTargetId = last.id;
  } else {
    await prisma.message.create({
      data: { characterId, userId, role: "user", content: userMessage },
    });
  }

  const allSinceSummary = await prisma.message.findMany({
    where: { characterId, userId },
    orderBy: { createdAt: "asc" },
    skip: character.summarizedThrough,
  });

  const relevant = regenTargetId
    ? allSinceSummary.filter((m: { id: string }) => m.id !== regenTargetId)
    : allSinceSummary;
  const recentHistory = relevant.slice(-RECENT_MESSAGE_WINDOW);

  const system = buildSystemPrompt(character, explicitMode);
  const chatMessages = [
    { role: "system" as const, content: system },
    ...recentHistory.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  res.set({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
  });

  try {
    const { text: fullText, provider } = await streamChatWithFallback(
      chatMessages,
      (chunk) => {
        res.write(chunk);
      },
      () => {
        // Intentionally no provider names sent to the browser — users
        // shouldn't be able to see which backend(s) power the chat, even by
        // reading the network tab. The toast on the client is generic.
        res.write(encodeEvent({ type: "failover" }));
      }
    );

    if (fullText.trim().length > 0) {
      if (regenTargetId) {
        await prisma.message.delete({ where: { id: regenTargetId } });
      }
      await prisma.message.create({
        data: { characterId, userId, role: "assistant", content: fullText.trim() },
      });
    }
    console.log(`[chat] reply generated via ${provider}`);
    res.end();

    // Fire-and-forget: fold older messages into the running memory summary
    // once the unsummarized window gets long.
    maybeSummarize(characterId, userId).catch((err) => console.error("summarize failed", err));
  } catch (err) {
    console.error(err);
    res.write(
      encodeEvent({ type: "fatal", message: "Every configured provider failed to respond. Please try again shortly." })
    );
    res.end();
  }
}));

// Resets a conversation: wipes stored messages and the running memory summary
// for this character, scoped to the current user, without deleting the character itself.
router.delete("/:characterId", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const { characterId } = req.params;
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  await prisma.message.deleteMany({ where: { characterId, userId } });
  await prisma.character.update({
    where: { id: characterId },
    data: { memorySummary: "", summarizedThrough: 0 },
  });

  return res.json({ ok: true });
}));

async function maybeSummarize(characterId: string, userId: string) {
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character) return;

  const total = await prisma.message.count({ where: { characterId, userId } });
  const unsummarized = total - character.summarizedThrough;
  if (unsummarized < SUMMARIZE_TRIGGER) return;

  const toFoldCount = unsummarized - RECENT_MESSAGE_WINDOW;
  if (toFoldCount <= 0) return;

  const toFold = await prisma.message.findMany({
    where: { characterId, userId },
    orderBy: { createdAt: "asc" },
    skip: character.summarizedThrough,
    take: toFoldCount,
  });
  if (toFold.length === 0) return;

  const updatedSummary = await summarizeConversation(character, character.memorySummary, toFold);

  await prisma.character.update({
    where: { id: characterId },
    data: {
      memorySummary: updatedSummary,
      summarizedThrough: character.summarizedThrough + toFold.length,
    },
  });
}

export default router;
