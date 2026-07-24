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
  isGroqConfigured,
  getGroqKeys,
  synthesizeGroqSpeech,
  splitForSpeech,
  concatWavBuffers,
  TTS_VOICES,
} from "../lib/providers";
import type { TtsVoice } from "../lib/providers";

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
  const editMessageId = typeof body.editMessageId === "string" ? body.editMessageId : null;
  const editContent = typeof body.editContent === "string" ? body.editContent.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
  const isEdit = editMessageId !== null;
  const userMessage = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
  // The client's explicitMode reflects the chat page's Normal/Explicit toggle
  // (only shown at all when character.isExplicit is true). Still, never trust
  // it on its own — a character with isExplicit: false must never be pushed
  // into explicit mode no matter what a request claims.
  const explicitMode = character.isExplicit === true && body.explicitMode === true;

  if (!isRegenerate && !isEdit && !userMessage) {
    return res.status(400).json({ error: "Message can't be empty." });
  }
  if (isEdit && !editContent) {
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
  if (isEdit) {
    const target = await prisma.message.findFirst({
      where: { id: editMessageId as string, characterId, userId, role: "user" },
    });
    if (!target) {
      return res.status(404).json({ error: "That message couldn't be found." });
    }
    // Messages already folded into memorySummary are gone from the working
    // context, so editing one would silently do nothing useful — reject
    // rather than pretend it worked.
    const positionAmongAll = await prisma.message.count({
      where: { characterId, userId, createdAt: { lte: target.createdAt } },
    });
    if (positionAmongAll <= character.summarizedThrough) {
      return res.status(400).json({ error: "That message is too old to edit." });
    }
    // Standard "edit and resend" behavior: this message and everything
    // after it (its old reply, and any later turns) is discarded, then a
    // fresh reply is generated from the edited text.
    await prisma.message.deleteMany({
      where: { characterId, userId, createdAt: { gt: target.createdAt } },
    });
    await prisma.message.update({ where: { id: target.id }, data: { content: editContent } });
  } else if (isRegenerate) {
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

  // The frontend's "Stop" button aborts its fetch(), which closes this
  // connection from the client side — surfaced here as the request stream
  // closing early. Wiring that into an AbortSignal lets the fallback chain
  // stop paying for tokens nobody will see, while still keeping (and
  // saving) whatever text had already streamed out.
  const stopController = new AbortController();
  req.on("close", () => stopController.abort());

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
      },
      stopController.signal
    );

    if (fullText.trim().length > 0) {
      if (regenTargetId) {
        await prisma.message.delete({ where: { id: regenTargetId } });
      }
      await prisma.message.create({
        data: { characterId, userId, role: "assistant", content: fullText.trim() },
      });
    }
    console.log(
      stopController.signal.aborted
        ? `[chat] reply stopped by client mid-stream (via ${provider})`
        : `[chat] reply generated via ${provider}`
    );
    // If the client already disconnected, res.write/res.end below are
    // harmless no-ops — the assistant text above is already saved.
    res.end();

    // Fire-and-forget: fold older messages into the running memory summary
    // once the unsummarized window gets long.
    maybeSummarize(characterId, userId).catch((err) => console.error("summarize failed", err));
  } catch (err) {
    console.error(err);
    if (!stopController.signal.aborted) {
      res.write(
        encodeEvent({ type: "fatal", message: "Every configured provider failed to respond. Please try again shortly." })
      );
    }
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

// GET /api/chat/:characterId/memory — the running memory summary + how much
// of the conversation it currently represents, for the "what I remember"
// panel. NOTE: registered before GET "/:characterId" isn't required here
// since Express matches by segment count, but keep both routes together for
// readability.
router.get("/:characterId/memory", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const { characterId } = req.params;
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  const totalMessages = await prisma.message.count({ where: { characterId, userId } });

  return res.json({
    memorySummary: character.memorySummary,
    summarizedThrough: character.summarizedThrough,
    totalMessages,
  });
}));

// PUT /api/chat/:characterId/memory — either edit the memory text directly
// (the user correcting/curating what's remembered), or forget it entirely.
// "Forget" can't just reset summarizedThrough to 0, or the next
// summarization pass would re-read all the old messages and regenerate the
// exact memory the user just asked to erase — so it's marked as already
// fully accounted-for instead, at today's message count.
router.put("/:characterId/memory", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const { characterId } = req.params;
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  const body = req.body ?? {};
  if (body.forget === true) {
    const totalMessages = await prisma.message.count({ where: { characterId, userId } });
    const updated = await prisma.character.update({
      where: { id: characterId },
      data: { memorySummary: "", summarizedThrough: totalMessages },
    });
    return res.json({ memorySummary: updated.memorySummary, summarizedThrough: updated.summarizedThrough });
  }

  const memorySummary = typeof body.memorySummary === "string" ? body.memorySummary.trim().slice(0, 4000) : null;
  if (memorySummary === null) {
    return res.status(400).json({ error: "memorySummary must be a string." });
  }
  const updated = await prisma.character.update({
    where: { id: characterId },
    data: { memorySummary },
  });
  return res.json({ memorySummary: updated.memorySummary, summarizedThrough: updated.summarizedThrough });
}));

const GROQ_TTS_TIMEOUT_MS = Number(process.env.GROQ_TTS_TIMEOUT_SECONDS || "20") * 1000;
const MAX_SPEECH_INPUT_CHARS = 2000; // caps how much of a long reply we'll ever synthesize in one request

// POST /api/chat/:characterId/speak — text-to-speech for a message, using
// Groq's Orpheus TTS (same GROQ_API_KEY as chat; no separate key needed).
// Orpheus caps input at 200 characters per call, so longer text is split on
// sentence boundaries and the resulting WAV clips are stitched into one file.
router.post("/:characterId/speak", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const { characterId } = req.params;
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  if (!isGroqConfigured()) {
    return res.status(400).json({
      error: "Voice playback needs a GROQ_API_KEY set in .env (Groq is currently the only configured TTS provider).",
    });
  }

  const limit = checkRateLimit(`speak:${userId}`, 20, 60);
  if (limit.limited) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ error: "Too many voice requests. Please slow down a bit." });
  }

  const body = req.body ?? {};
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_SPEECH_INPUT_CHARS) : "";
  if (!text) {
    return res.status(400).json({ error: "No text to speak." });
  }
  const requestedVoice = typeof body.voice === "string" ? body.voice : undefined;
  const voice: TtsVoice = (TTS_VOICES as readonly string[]).includes(requestedVoice ?? "")
    ? (requestedVoice as TtsVoice)
    : "hannah";

  const apiKey = getGroqKeys()[0]?.key;
  if (!apiKey) {
    return res.status(400).json({ error: "Voice playback needs a GROQ_API_KEY set in .env." });
  }

  const chunks = splitForSpeech(text);
  try {
    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
      buffers.push(await synthesizeGroqSpeech(chunk, voice, apiKey, GROQ_TTS_TIMEOUT_MS));
    }
    const combined = concatWavBuffers(buffers);
    res.set("Content-Type", "audio/wav");
    res.set("Cache-Control", "no-store");
    return res.send(combined);
  } catch (err) {
    console.error("[chat] TTS synthesis failed:", err);
    return res.status(502).json({ error: "Couldn't generate audio right now. Please try again." });
  }
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
