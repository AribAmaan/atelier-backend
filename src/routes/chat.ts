import { minorSexualContentDetected, characterMinorFlagged, MINOR_CONTENT_ERROR } from "../lib/minorSafety";
import { truncateUnits } from "../lib/text";
import { Router } from "express";
import { createHash } from "node:crypto";
import { buildAwarenessTurnGuard } from "../lib/conversationAwareness";
import { buildStoryContext } from "../lib/storyContext";
import type { Prisma } from "@prisma/client";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/db";
import { getCurrentUserId } from "../lib/auth";
import { checkRateLimit } from "../lib/rateLimit";
import {
  buildSystemPrompt,
  streamChatWithFallback,
  summarizeConversation,
  RECENT_MESSAGE_WINDOW,
  SUMMARIZE_TRIGGER,
  isGroqConfigured,
  getGroqKeys,
  synthesizeGroqSpeech,
  splitForSpeech,
  concatWavBuffers,
  TTS_VOICES,
  parseSpiceLevel,
  parseRoleplayStyle,
  cleanAssistantResponse,
  withPersonaAnchor,
  maxTokensForIntelligence,
} from "../lib/providers";
import { estimateTokens, hazelnutContextEnabled, buildRecallQuery, recallTerms, selectHazelnutContext } from "../lib/hazelnutContext";
import { withTokenAccounting } from "../lib/providers/tokenStats";
import { planReply } from "../lib/providers/replyPolicy";
import { buildRoleplayTurnGuard, formatRoleplayInput } from "../lib/roleplayInput";
import type { GenParams, TtsVoice } from "../lib/providers";
import { resolveEngineForTier, type MembershipTier } from "../lib/providers/engines";
import { computeRelationshipLevel } from "../lib/relationship";

const router = Router();

const MAX_MESSAGE_LENGTH = 4000;
// Prevent overlapping generations on the same server instance.
const activeGenerations = new Set<string>();
const activeSummaries = new Set<string>();
router.use((req, res, next) => {
  const characterId = req.path.split("/")[1];
  const changesHistory = req.method === "DELETE" || req.method === "PUT" || !!req.body?.editMessageId;
  if ((req.method !== "GET" && activeGenerations.has(characterId)) || (changesHistory && activeSummaries.has(characterId))) {
    res.status(409).json({ error: "A reply is still being saved. Try again in a moment." });
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// System prompt cache - avoids rebuilding prompts for unchanged characters
// ---------------------------------------------------------------------------
// Keyed by a hash of the character fields and generation settings that
// contribute to the prompt, so changed inputs invalidate cached content.
// Cache auto-expires after 5 minutes to handle edge cases.
// ---------------------------------------------------------------------------
interface CachedPrompt {
  prompt: string;
  expiresAt: number;
}
const promptCache = new Map<string, CachedPrompt>();
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedPrompt(key: string): string | null {
  const cached = promptCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    promptCache.delete(key);
    return null;
  }
  return cached.prompt;
}

function setCachedPrompt(key: string, prompt: string): void {
  // Limit cache size to prevent memory leaks
  if (promptCache.size > 1000) {
    // Delete oldest entries
    const now = Date.now();
    for (const [k, v] of promptCache) {
      if (now > v.expiresAt) promptCache.delete(k);
    }
    // If still too large, delete first 100 entries
    if (promptCache.size > 1000) {
      let count = 0;
      for (const k of promptCache.keys()) {
        if (count++ >= 100) break;
        promptCache.delete(k);
      }
    }
  }
  promptCache.set(key, { prompt, expiresAt: Date.now() + PROMPT_CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// SSE Keep-Alive - prevents proxy/load balancer timeout on idle connections
// ---------------------------------------------------------------------------
// Many proxies (nginx, Render, Cloudflare) close idle connections after 30-60s.
// If a provider is slow to respond, the SSE connection can drop before any
// data is sent. Sending periodic keep-alive comments prevents this.
// ---------------------------------------------------------------------------
const KEEP_ALIVE_INTERVAL_MS = 15_000; // 15 seconds - well under typical proxy timeouts

function startKeepAlive(res: import("express").Response): () => void {
  const timer = setInterval(() => {
    try {
      res.write(encodeEvent({ type: "ping" }));
    } catch {
      // Connection closed, stop the timer
      clearInterval(timer);
    }
  }, KEEP_ALIVE_INTERVAL_MS);
  // Don't keep the process alive just for keep-alive
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

// POST /api/chat/bulk-delete — wipes conversation history (messages + memory)
// for a set of characters, or for every character the user owns, in one go.
// This mirrors the existing DELETE /:characterId "reset conversation"
// behavior but scoped to many characters at once, so the "manage chat
// history" screen can offer per-chat checkboxes plus a "delete all" option
// without needing N round trips. Characters themselves are never touched —
// only their messages/memory — same as the single-chat reset.
//
// IMPORTANT: this must stay registered before the generic
// `POST /:characterId` route below, or Express would match "/bulk-delete"
// as characterId="bulk-delete" and try to send a chat message instead.
router.post("/bulk-delete", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const body = req.body ?? {};
  const all = body.all === true;
  const requestedIds: string[] = Array.isArray(body.characterIds)
    ? body.characterIds.filter((id: unknown): id is string => typeof id === "string")
    : [];

  if (!all && requestedIds.length === 0) {
    return res.status(400).json({ error: "Select at least one chat to delete, or pass all: true." });
  }

  // Only ever touch characters the caller actually owns — requestedIds is
  // client-supplied, so this scoping is what keeps it safe.
  const owned = await prisma.character.findMany({
    where: all ? { ownerId: userId } : { ownerId: userId, id: { in: requestedIds } },
    select: { id: true },
  });
  const ownedIds = owned.map((c: { id: string }) => c.id);
  if (ownedIds.some(id => activeGenerations.has(id) || activeSummaries.has(id))) return res.status(409).json({ error: "Wait for the active reply to finish before clearing history." });

  if (ownedIds.length === 0) {
    return res.json({ ok: true, deletedCount: 0 });
  }

  ownedIds.forEach(id => activeGenerations.add(id));
  try {
    await prisma.$transaction(async tx => {
      await tx.message.deleteMany({ where: { characterId: { in: ownedIds }, userId } });
      await tx.character.updateMany({ where: { id: { in: ownedIds }, ownerId: userId }, data: {
        memorySummary: "", summarizedThrough: 0, recallAfterCreatedAt: null, recallAfterId: "", explicitEverUsed: false,
      } });
    });
  } finally { ownedIds.forEach(id => activeGenerations.delete(id)); }

  return res.json({ ok: true, deletedCount: ownedIds.length });
}));

router.get("/:characterId", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const { characterId } = req.params;
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }

  // OPTIMIZATION: Only select fields needed for chat rendering.
  // NOTE: id and createdAt MUST stay — the frontend uses each message's id
  // to target edit / delete / regenerate requests, and this endpoint is the
  // only place it gets that id from.
  const messages = await prisma.message.findMany({
    where: { characterId, userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, role: true, content: true, createdAt: true },
  });

  const relationshipLevel = computeRelationshipLevel(messages.length, character.explicitEverUsed);

  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  return res.json({ character, messages, relationshipLevel });
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

  const [character, requestingUser] = await Promise.all([
    prisma.character.findUnique({ where: { id: characterId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { membershipTier: true, explicitMode: true } }),
  ]);
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }
  if (activeGenerations.has(characterId)) {
    return res.status(409).json({ error: "A reply is still being saved. Try again in a moment." });
  }
  if (req.body?.editMessageId && activeSummaries.has(characterId)) {
    return res.status(409).json({ error: "Memory is being updated. Try again in a moment." });
  }
  activeGenerations.add(characterId);
  try {
  const membershipTier = (requestingUser?.membershipTier as MembershipTier | undefined) ?? "free";

  const body = req.body ?? {};
  const isRegenerate = body.regenerate === true;
  const requestId = typeof body.requestId === "string" && /^[a-zA-Z0-9-]{16,80}$/.test(body.requestId) ? body.requestId : null;
  const turnId = requestId && !isRegenerate && !body.editMessageId && typeof body.message === "string" && body.message.trim()
    ? createHash("sha256").update(JSON.stringify([userId, characterId, requestId])).digest("hex") : null;
  const storyContext = buildStoryContext(body.story);
  const editMessageId = typeof body.editMessageId === "string" ? body.editMessageId : null;
  const editContent = typeof body.editContent === "string" ? truncateUnits(body.editContent.trim(), MAX_MESSAGE_LENGTH) : "";
  const isEdit = editMessageId !== null;
  const userMessage = typeof body.message === "string" ? truncateUnits(body.message.trim(), MAX_MESSAGE_LENGTH) : "";
  // explicitMode is controlled by the chat UI toggle. Any signed-in user may
  // enable it for their private conversations — not limited to isExplicit characters.
  // If the client sent a named engine id (from the roleplay-engine picker),
  // its config is the source of truth — explicitMode/spiceLevel/
  // roleplayStyle/voiceNotes/temperature all come from this fixed,
  // server-owned list (see providers/engines.ts), not from the client
  // directly. Falls back to the older raw explicitMode/spiceLevel/
  // roleplayStyle body fields for any client that isn't sending an
  // engineId yet (manual slider mode).
  //
  // resolveEngineForTier is the actual paywall enforcement: a client can
  // send any engineId it wants (it's just JSON in a POST body), so
  // getEngineConfig alone would happily hand a free user "hazelnut". This
  // checks body.engineId against requestingUser.membershipTier and, if the
  // user isn't entitled to it, transparently substitutes the best engine
  // their plan does cover rather than erroring the request out.
  const { engine, downgradedFrom, requiredTier } = resolveEngineForTier(body.engineId, membershipTier);
  // explicitMode is the intersection of the engine's capability and the
  // client's explicit toggle. The toggle (set by the frontend based on the
  // character's isExplicit flag + user preference) is the user's actual
  // intent — for 18+ characters, it's true; for innocent characters, it's
  // false. AND-ing it with the engine's own explicitMode flag keeps this purely a
  // content-context signal now: the OG system prompt keeps the content-mode
  // framing fixed, while explicitMode still affects intimate-response context,
  // spice/style fallback fields, and relationship tracking below. It no
  // longer has any effect on provider chain order.
  // Prefer the per-request toggle when the frontend sends it, but do not
  // silently disable mature mode when an older/stale client omits the field.
  // In that case, fall back to the user's persisted account preference. An
  // explicit `false` still wins, so the client can always turn mature mode
  // off for a particular chat.
  const clientExplicitMode = typeof body.explicitMode === "boolean" ? body.explicitMode : undefined;
  const requestedExplicitMode = clientExplicitMode ?? (requestingUser?.explicitMode === true);
  const explicitMode = engine ? engine.explicitMode && requestedExplicitMode : requestedExplicitMode;
  const explicitModeSource = clientExplicitMode === undefined ? "account-default" : "request";
  console.log(`[chat] engine=${engine?.id ?? "manual"} explicitMode=${explicitMode} source=${explicitModeSource}`);
  const spiceLevel = engine ? engine.spiceLevel : explicitMode ? parseSpiceLevel(body.spiceLevel) : undefined;
  const roleplayStyle = engine ? engine.roleplayStyle : explicitMode ? parseRoleplayStyle(body.roleplayStyle) : undefined;
  const voiceNotes = engine?.voiceNotes;
  const intelligence = engine?.intelligence ?? 5;
  const compactHazelnut = engine?.id === "hazelnut" && hazelnutContextEnabled();
  // Provider priority is fixed for every engine, including Chocolate and
  // Hazelnut: NVIDIA -> Groq -> SambaNova -> Cloudflare -> Ollama. Engine
  // quality remains controlled by prompt/context/sampling settings, not by
  // silently reordering providers.
  const maxTokens = maxTokensForIntelligence(intelligence);
  const genParams: GenParams = engine
    ? { temperature: engine.temperature, topP: engine.topP, maxTokens }
    : { maxTokens };
  const recentWindow = engine?.id === "hazelnut" && !compactHazelnut ? 20 : engine?.recentMessageWindow ?? RECENT_MESSAGE_WINDOW;
  const summarizeTrigger = engine?.id === "hazelnut" && !compactHazelnut ? 36 : engine?.summarizeTrigger ?? SUMMARIZE_TRIGGER;
  const sceneDirective =
    typeof body.sceneDirective === "string" ? truncateUnits(body.sceneDirective.trim(), 500) : undefined;

  if (!isRegenerate && !isEdit && !userMessage && !sceneDirective) {
    return res.status(400).json({ error: "Message can't be empty." });
  }
  if (isEdit && !editContent) {
    return res.status(400).json({ error: "Message can't be empty." });
  }

  // Backstop against sexualized minors, checked before anything is stored or
  // any provider is called — so provider failover can't route around it. The
  // user's own text must not state an under-18 age or use unambiguous minor
  // terms in a sexual context, and in mature mode the character itself must
  // not be defined as under 18. See lib/minorSafety.ts for the (deliberately
  // narrow) rules.
  const explicitContext = explicitMode || character.isExplicit === true;
  if (minorSexualContentDetected([userMessage, editContent, sceneDirective], explicitContext)) {
    return res.status(400).json({ error: MINOR_CONTENT_ERROR, code: "minor_content_blocked" });
  }
  if (
    explicitContext &&
    characterMinorFlagged(
      {
        subject: [character.name, character.tagline, character.personality, character.greeting, character.avatarPrompt],
        narrative: [character.backstory, character.roleplayNotes],
      },
      true
    )
  ) {
    return res.status(403).json({
      error: "This character can't be used for mature chat because it's described as under 18.",
      code: "minor_character_blocked",
    });
  }

  let regenTargetId: string | null = null;
  if (isEdit) {
    const target = await prisma.message.findFirst({
      where: { id: editMessageId as string, characterId, userId, role: "user" },
      select: { id: true, createdAt: true, content: true },
    });
    if (!target) {
      return res.status(404).json({ error: "That message couldn't be found." });
    }
    const positionAmongAll =
      (await prisma.message.count({
        where: {
          characterId,
          userId,
          OR: [
            { createdAt: { lt: target.createdAt } },
            { createdAt: target.createdAt, id: { lt: target.id } },
          ],
        },
      })) + 1;
    if (positionAmongAll <= character.summarizedThrough) {
      return res.status(400).json({ error: "That message is too old to edit." });
    }
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT id FROM \`Message\` WHERE id = ${target.id} FOR UPDATE`;
      await tx.message.deleteMany({
        where: {
          characterId,
          userId,
          OR: [
            { createdAt: { gt: target.createdAt } },
            { createdAt: target.createdAt, id: { gt: target.id } },
          ],
        },
      });
      await tx.message.update({ where: { id: target.id }, data: { content: editContent } });
    });
  } else if (isRegenerate) {
    // "regenerate" covers two cases: redoing an existing reply (last message
    // is the assistant's — mark it for replacement), or retrying a turn
    // where every provider failed last time (last message is still the
    // user's — nothing to replace, just try again).
    const last = await prisma.message.findFirst({
      where: { characterId, userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, role: true },
    });
    if (!last) {
      return res.status(400).json({ error: "Nothing to regenerate yet." });
    }
    if (last.role === "assistant") regenTargetId = last.id;
  } else if (userMessage) {
    if (turnId) {
      const existing = await prisma.message.findUnique({ where: { id: turnId } });
      if (existing && existing.content !== userMessage) {
        return res.status(409).json({ error: "This retry belongs to a different message." });
      }
      if (existing) {
        const completed = await prisma.message.findUnique({ where: { id: `${turnId}-reply` } });
        if (completed) {
          res.set("Content-Type", "text/plain; charset=utf-8");
          return res.send(completed.content);
        }
        const latest = await prisma.message.findFirst({ where: { characterId, userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        if (latest?.id !== turnId) return res.status(409).json({ error: "The conversation has moved on. Refresh before retrying." });
      }
      await prisma.message.upsert({ where: { id: turnId }, update: {}, create: { id: turnId, characterId, userId, role: "user", content: userMessage } });
    } else {
      await prisma.message.create({ data: { characterId, userId, role: "user", content: userMessage } });
    }
  }

  // OPTIMIZATION: Fetch message history and character data in parallel
  // Only select the fields we need (role, content, createdAt) instead of full rows
  const allSinceSummary = await prisma.message.findMany({
    where: { characterId, userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip: character.summarizedThrough,
    select: { id: true, role: true, content: true, createdAt: true },
  });

  const relevant = regenTargetId
    ? allSinceSummary.filter((m: { id: string }) => m.id !== regenTargetId)
    : allSinceSummary;
  // `relevant` is everything since the last summarization fold — it's
  // either recent enough to send verbatim, or old enough that
  // maybeSummarize (below, after the reply streams) is about to fold it
  // into memorySummary. Slicing straight down to recentWindow here, before
  // that fold has actually happened, silently drops whatever sits between
  // the two thresholds: e.g. Strawberry sends 11 messages verbatim but
  // only summarizes once there are 18 unsummarized, so messages 12-17 back
  // were neither shown raw nor folded into memory — just gone from the
  // model's context. maybeSummarize keeps `relevant` naturally bounded to
  // roughly summarizeTrigger messages in the steady state, so sending it
  // in full closes that gap; the length check below is only a safety net
  // for if summarization has been failing/lagging for a while, not the
  // normal path.
  const recentHistory = relevant.length <= summarizeTrigger * 2 ? relevant : relevant.slice(-recentWindow);

  // Gap between the character's last reply and the user's latest message —
  // what powers buildTimeAwarenessBlock (see its comment in providers/
  // index.ts for why this is worth computing). Pure Date math over rows
  // already fetched above, so this costs nothing extra: no query, no
  // tokens unless the resulting block actually gets included. Takes the
  // last two entries of the *full* filtered history rather than
  // recentHistory, since a long-idle chat could in principle have a
  // window smaller than 2 — recentWindow only trims which turns are sent
  // verbatim, it shouldn't be able to hide the gap we're measuring.
  let minutesSinceLastMessage: number | undefined;
  const gapPair = relevant.slice(-2);
  if (gapPair.length === 2 && gapPair[0].role === "assistant" && gapPair[1].role === "user") {
    minutesSinceLastMessage = (gapPair[1].createdAt.getTime() - gapPair[0].createdAt.getTime()) / 60000;
  }

  // OPTIMIZATION: Use cached system prompt when character hasn't changed.
  // IMPORTANT: the key must cover every input that changes the generated
  // text, not just the character's static fields — otherwise a stale
  // cached prompt (missing the latest folded-in memory, or built with a
  // different voice-notes/time-gap value) gets served for up to
  // PROMPT_CACHE_TTL_MS. buildSystemPrompt also reads character.memorySummary
  // and character.examples (which change as the conversation progresses via
  // maybeSummarize), opts.voiceNotes (a per-request value), and
  // minutesSinceLastMessage (which drives the "time gap" block, gated to
  // >=10 minutes and rounded to minute/hour/day — bucketed the same way
  // here so we don't fragment the cache over meaningless sub-minute noise).
  const intelligenceForCache = engine?.intelligence ?? 5;
  const timeGapBucket =
    intelligenceForCache < 6 || minutesSinceLastMessage === undefined || minutesSinceLastMessage < 10
      ? "none"
      : minutesSinceLastMessage < 60
      ? `m${Math.round(minutesSinceLastMessage)}`
      : minutesSinceLastMessage < 60 * 24
      ? `h${Math.round(minutesSinceLastMessage / 60)}`
      : `d${Math.round(minutesSinceLastMessage / (60 * 24))}`;
  const promptCacheKey = createHash("sha256").update(JSON.stringify([
    compactHazelnut ? "compact-v6-awareness" : "standard-v5-awareness", characterId, character.name,
    character.personality, character.backstory, character.roleplayNotes, character.tagline, character.greeting,
    character.memorySummary ?? "", character.examples ?? "", engine?.id ?? "none", explicitMode,
    spiceLevel, roleplayStyle, sceneDirective, voiceNotes, timeGapBucket,
  ])).digest("hex");
  let system = getCachedPrompt(promptCacheKey);
  if (!system) {
    system = buildSystemPrompt(character, {
      explicitMode,
      spiceLevel,
      roleplayStyle,
      sceneDirective,
      voiceNotes,
      engine,
      minutesSinceLastMessage,
      deferReplyGuidance: true,
    });
    setCachedPrompt(promptCacheKey, system);
  }
  let chatMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system" as const, content: system + storyContext },
    ...recentHistory.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];
  // Keep identity guidance in system context. User speech remains unchanged,
  // including during regeneration and scene continuation.
  if (!compactHazelnut) withPersonaAnchor(chatMessages, character, intelligence);
  // Fresh on every request, including engine switches and regeneration; never
  // cache turn-specific pacing inside the reusable character prompt.
  const latestUserText = [...recentHistory].reverse().find(m => m.role === "user")?.content ?? "";
  const replyPlan = planReply(intelligence, latestUserText, sceneDirective);
  genParams.maxTokens = replyPlan.maxTokens;
  genParams.continuationMaxTokens = replyPlan.continuationMaxTokens;
  genParams.preserveStreamedLength = replyPlan.preserveStreamedLength;
  genParams.targetWords = replyPlan.targetWords;
  genParams.minWords = replyPlan.minWords;
  genParams.maxWords = replyPlan.maxWords;
  chatMessages[0].content += `\n\n${replyPlan.instruction}`;
  // Include this per-turn guard in Hazelnut's context budgeting, not the cached
  // persona prompt. Keep it after recalled evidence at the provider boundary.
  const inputTurnGuard = buildAwarenessTurnGuard(relevant) +
    (relevant[relevant.length - 1]?.role === "user" ? buildRoleplayTurnGuard(latestUserText) : "");
  if (compactHazelnut) {
    const query = buildRecallQuery(relevant, sceneDirective);
    const terms = recallTerms(query);
    let recalled: typeof relevant = [];
    // Owner and conversation scoping are mandatory. Only already-folded older
    // history is searched, and only meaningful query terms trigger the lookup.
    // No provider call is used for retrieval or ranking.
    if (terms.length && character.summarizedThrough > 0 && relevant[0]) {
      try {
        recalled = await prisma.message.findMany({
          where: {
            characterId, userId,
            AND: [
              {
                OR: [
                  { createdAt: { lt: relevant[0].createdAt } },
                  { createdAt: relevant[0].createdAt, id: { lt: relevant[0].id } },
                ],
              },
              { OR: terms.map(term => ({ content: { contains: term } })) },
              ...(character.recallAfterCreatedAt ? [{ OR: [
                { createdAt: { gt: character.recallAfterCreatedAt } },
                { createdAt: character.recallAfterCreatedAt, id: { gt: character.recallAfterId } },
              ] }] : []),
            ],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 16,
          select: { id: true, role: true, content: true, createdAt: true },
        });
      } catch {
        // Existing memory + the recent exchange remain available on a DB
        // retrieval failure. Never fail the reply for an optional callback.
        console.warn("[hazelnut-context] Older-history lookup unavailable.");
      }
    }
    const selection = selectHazelnutContext({ history: relevant, recalled, query,
      systemTokens: estimateTokens(chatMessages[0].content + inputTurnGuard) });
    chatMessages = [{ role: "system", content: chatMessages[0].content + selection.memory }, ...selection.messages];
    console.log(`[hazelnut-context] ${JSON.stringify(selection.diagnostics)}`);
  } else if (recentHistory.length < relevant.length) {
    // If summaries lag, keep complete recent exchanges plus relevant older
    // evidence instead of silently discarding the intervening scene/constraints.
    const systemTokens = estimateTokens(chatMessages[0].content + inputTurnGuard);
    const selection = selectHazelnutContext({ history: relevant,
      query: buildRecallQuery(relevant, sceneDirective), systemTokens,
      targetTokens: systemTokens + Math.max(1800, recentWindow * 180) });
    chatMessages = [{ role: "system", content: chatMessages[0].content + selection.memory }, ...selection.messages];
  }

  chatMessages[0].content += inputTurnGuard;
  // Label input only at the provider boundary; saved messages remain original.
  chatMessages = chatMessages.map(m => m.role === "user"
    ? { ...m, content: formatRoleplayInput(m.content) } : m);

  res.set({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });

  // OPTIMIZATION: Start SSE keep-alive to prevent proxy timeout
  // Proxies (nginx, Render, Cloudflare) often close idle connections after 30-60s.
  // If a provider is slow to respond, periodic keep-alive comments prevent disconnection.
  const stopKeepAlive = startKeepAlive(res);

  // Surface the paywall downgrade to the client (unlike provider failover
  // above, this one names names on purpose — it's the hook for an upgrade
  // prompt, not something to hide). Sent before streaming starts so the
  // frontend can show "this reply is using {engine.id}, upgrade for
  // {downgradedFrom}" alongside the reply rather than after the fact.
  if (downgradedFrom && engine) {
    res.write(
      encodeEvent({
        type: "engine_downgrade",
        requested: downgradedFrom,
        used: engine.id,
        requiredTier,
      })
    );
  }

  // The frontend's "Stop" button aborts its fetch(), which closes this
  // connection from the client side — surfaced here as the request stream
  // closing early. Wiring that into an AbortSignal lets the fallback chain
  // stop paying for tokens nobody will see, while still keeping (and
  // saving) whatever text had already streamed out.
  const stopController = new AbortController();
  // IncomingMessage("close") is tied to completion of the request body in
  // modern Node, so it can fire before the streaming response finishes.
  // Watch the response instead so a healthy POST isn't mistaken for a client
  // disconnect. A true client abort closes the response before it is finished.
  const abortOnClientDisconnect = () => {
    if (!res.writableFinished) stopController.abort();
  };
  res.on("close", abortOnClientDisconnect);

  // NOTE: no request-level hard timeout here on purpose. streamChatWithFallback
  // already has a much better mechanism for a stuck/slow provider: each
  // candidate has its own tuned timeoutMs (see providers/index.ts and
  // openaiCompatible.ts) covering time-to-first-token and mid-stream stalls,
  // and a circuit breaker that opens after repeated timeouts so a bad
  // provider gets skipped on future requests too. A single global timer
  // sharing stopController with the client's own Stop-button abort would
  // undo that: once it fires, streamChatWithFallback sees the same signal
  // as aborted and gives up on the ENTIRE chain immediately — it doesn't
  // move on to the next candidate, it just kills the request. With several
  // providers chained (Groq x4, NVIDIA x3, SambaNova x2, Cloudflare...),
  // that meant a slow-but-not-dead provider partway through the chain could
  // cause the whole reply to fail instead of falling through to the next
  // one, and the user waited the full ceiling for nothing. The per-provider
  // timeouts already fail fast on their own.

  try {
    // Do not truncate at action or sentence counts. Provider termination
    // metadata drives bounded recovery; punctuation is not a completion test.
    const { text: fullText, provider, finishReason } = await withTokenAccounting(engine?.id ?? "manual", "reply", () => streamChatWithFallback(
      chatMessages,
      chunk => { if (!stopController.signal.aborted) res.write(chunk); },
      () => res.write(encodeEvent({ type: "failover" })),
      stopController.signal,
      genParams
    ));

    if (fullText.trim().length > 0) {
      const finalText = cleanAssistantResponse(fullText.trim(), intelligence);
      // NOTE: the save must complete BEFORE we count messages for the
      // relationship level — they are not independent, so this cannot be
      // parallelized with Promise.all without racing the count against the
      // create() and occasionally reporting a stale (one message short)
      // level. reportRelationshipLevel already parallelizes its own two
      // independent reads internally, so we don't lose that benefit.
      // Replace a regenerated reply in place: failures cannot delete the old reply.
      if (regenTargetId) {
        await prisma.message.update({ where: { id: regenTargetId }, data: { content: finalText } });
      } else if (turnId) {
        await prisma.message.upsert({ where: { id: `${turnId}-reply` }, update: { content: finalText }, create: { id: `${turnId}-reply`, characterId, userId, role: "assistant", content: finalText } });
      } else {
        await prisma.message.create({ data: { characterId, userId, role: "assistant", content: finalText } });
      }

      if (!stopController.signal.aborted) {
        // The authoritative saved text also reconciles light format cleanup.
        res.write(encodeEvent({ type: "reply_final", text: finalText }));
        if (finishReason && finishReason !== "stop" && finishReason !== "cancelled") {
          res.write(encodeEvent({ type: "reply_incomplete", message: "This reply may be unfinished. Use Continue to finish it, or Regenerate to try again." }));
        }
        const relLevel = await reportRelationshipLevel(characterId, userId, explicitMode);
        res.write(encodeEvent({ type: "relationship", level: relLevel }));
      }
    }
    console.log(
      stopController.signal.aborted
        ? `[chat] reply stopped by client mid-stream (via ${provider})`
        : `[chat] reply generated via ${provider}`
    );
    // Stop keep-alive timer
    stopKeepAlive();
    // If the client already disconnected, res.write/res.end below are
    // harmless no-ops — the assistant text above is already saved.
    res.end();

    // Fire-and-forget: fold older messages into the running memory summary
    // once the unsummarized window gets long.
    maybeSummarize(characterId, userId, intelligence, recentWindow, summarizeTrigger).catch((err) => console.error("summarize failed", err));
  } catch (err) {
    console.error(err);
    if (!stopController.signal.aborted) {
      res.write(
        encodeEvent({ type: "fatal", message: "Every configured provider failed to respond. Please try again shortly." })
      );
      // Even on a failed generation, the user's own message (and any edit's
      // deletion of trailing messages) above already changed the persisted
      // count — keep the client's bar in sync either way.
      try {
        res.write(encodeEvent({ type: "relationship", level: await reportRelationshipLevel(characterId, userId, explicitMode) }));
      } catch (relationshipError) {
        console.error("Could not refresh relationship after a failed turn", relationshipError);
      }
    }
    res.end();
  } finally {
    stopKeepAlive();
    res.off("close", abortOnClientDisconnect);
  }
  } finally {
    activeGenerations.delete(characterId);
  }
}));

router.delete("/:characterId/messages/:messageId", asyncHandler(async (req, res) => {
  const userId = await getCurrentUserId(req);
  if (!userId) return res.status(401).json({ error: "Not signed in." });

  const { characterId, messageId } = req.params;
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character || character.ownerId !== userId) {
    return res.status(404).json({ error: "Character not found." });
  }
  if (activeGenerations.has(characterId) || activeSummaries.has(characterId)) return res.status(409).json({ error: "Conversation is updating. Please try again shortly." });
  activeGenerations.add(characterId);
  try {
    const message = await prisma.message.findFirst({
      where: { id: messageId, characterId, userId },
      select: { id: true, createdAt: true },
    });
    if (!message) {
      return res.status(404).json({ error: "Message not found." });
    }

    // summarizedThrough is a positional cursor into chronological history.
    // Deleting inside that prefix would make the cursor skip one live message
    // on the next request. Keep summarized history immutable, just like edits.
    const positionAmongAll =
      (await prisma.message.count({
        where: {
          characterId,
          userId,
          OR: [
            { createdAt: { lt: message.createdAt } },
            { createdAt: message.createdAt, id: { lt: message.id } },
          ],
        },
      })) + 1;
    if (positionAmongAll <= character.summarizedThrough) {
      return res.status(400).json({ error: "That message is too old to delete." });
    }

    await prisma.message.delete({ where: { id: messageId } });
    const relationshipLevel = await reportRelationshipLevel(characterId, userId, false);
    return res.json({ ok: true, relationshipLevel });
  } finally { activeGenerations.delete(characterId); }
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
  if (activeGenerations.has(characterId) || activeSummaries.has(characterId)) return res.status(409).json({ error: "Conversation is updating. Please try again shortly." });
  activeGenerations.add(characterId);
  try {
    await prisma.$transaction(async tx => {
      await tx.message.deleteMany({ where: { characterId, userId } });
      await tx.character.update({ where: { id: characterId }, data: {
        memorySummary: "", summarizedThrough: 0, recallAfterCreatedAt: null, recallAfterId: "", explicitEverUsed: false,
      } });
    });

    return res.json({ ok: true, relationshipLevel: 0 });
  } finally { activeGenerations.delete(characterId); }
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
  if (activeGenerations.has(characterId) || activeSummaries.has(characterId)) return res.status(409).json({ error: "Conversation is updating. Please try again shortly." });
  activeGenerations.add(characterId);
  try {
    const body = req.body ?? {};
    if (body.forget === true) {
      const updated = await prisma.$transaction(async tx => {
        const [totalMessages, lastMessage] = await Promise.all([
          tx.message.count({ where: { characterId, userId } }),
          tx.message.findFirst({
            where: { characterId, userId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { id: true, createdAt: true },
          }),
        ]);
        return tx.character.update({
          where: { id: characterId },
          data: {
            memorySummary: "", summarizedThrough: totalMessages,
            recallAfterCreatedAt: lastMessage?.createdAt ?? null, recallAfterId: lastMessage?.id ?? "",
          },
        });
      });
      return res.json({ memorySummary: updated.memorySummary, summarizedThrough: updated.summarizedThrough });
    }

    const memorySummary = typeof body.memorySummary === "string" ? truncateUnits(body.memorySummary.trim(), 4000) : null;
    if (memorySummary === null) {
      return res.status(400).json({ error: "memorySummary must be a string." });
    }
    const updated = await prisma.character.update({
      where: { id: characterId },
      data: { memorySummary },
    });
    return res.json({ memorySummary: updated.memorySummary, summarizedThrough: updated.summarizedThrough });
  } finally { activeGenerations.delete(characterId); }
}));

// Validated like IMAGE_GEN_TIMEOUT_SECONDS: a non-numeric or out-of-range value
// would otherwise become NaN/0 and make every voice request fail immediately.
const GROQ_TTS_TIMEOUT_MS = (() => {
  const seconds = Number(process.env.GROQ_TTS_TIMEOUT_SECONDS || "20");
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 120 ? seconds * 1000 : 20_000;
})();
let ttsKeyCursor = 0;
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
  const text = typeof body.text === "string" ? truncateUnits(body.text.trim(), MAX_SPEECH_INPUT_CHARS) : "";
  if (!text) {
    return res.status(400).json({ error: "No text to speak." });
  }
  const requestedVoice = typeof body.voice === "string" ? body.voice : undefined;
  const voice: TtsVoice = (TTS_VOICES as readonly string[]).includes(requestedVoice ?? "")
    ? (requestedVoice as TtsVoice)
    : "hannah";

  // Spread TTS load across all configured Groq keys instead of always
  // spending the first key's quota.
  const ttsKeys = getGroqKeys();
  const apiKey = ttsKeys.length ? ttsKeys[ttsKeyCursor++ % ttsKeys.length].key : undefined;
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("model_terms_required") || message.includes("requires terms acceptance")) {
      return res.status(502).json({
        error: "Voice playback needs the Groq Orpheus model terms to be accepted in the Groq console. Please contact the server admin.",
      });
    }
    return res.status(502).json({ error: "Couldn't generate audio right now. Please try again." });
  }
}));

// Persists the explicit-mode flag (only writes if it's flipping false->true,
// so a chatty conversation doesn't re-write it every turn) and returns the
// freshly computed relationship level. Pure DB reads/writes — no provider
// call, so this never costs API tokens.
async function reportRelationshipLevel(characterId: string, userId: string, explicitMode: boolean): Promise<number> {
  // OPTIMIZATION: Parallelize the two independent DB reads
  const [character, totalMessages] = await Promise.all([
    prisma.character.findUnique({
      where: { id: characterId },
      select: { explicitEverUsed: true },
    }),
    prisma.message.count({ where: { characterId, userId } }),
  ]);

  let explicitEverUsed = character?.explicitEverUsed ?? false;
  if (explicitMode && !explicitEverUsed) {
    await prisma.character.update({ where: { id: characterId }, data: { explicitEverUsed: true } });
    explicitEverUsed = true;
  }
  return computeRelationshipLevel(totalMessages, explicitEverUsed);
}

async function maybeSummarize(
  characterId: string,
  userId: string,
  intelligence: number = 5,
  recentWindow: number = RECENT_MESSAGE_WINDOW,
  summarizeTrigger: number = SUMMARIZE_TRIGGER
) {
  if (activeSummaries.has(characterId)) return;
  activeSummaries.add(characterId);
  try {
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character) return;

  const total = await prisma.message.count({ where: { characterId, userId } });
  const unsummarized = total - character.summarizedThrough;
  if (unsummarized < summarizeTrigger) return;

  const toFoldCount = unsummarized - recentWindow;
  if (toFoldCount <= 0) return;

  const toFold = await prisma.message.findMany({
    where: { characterId, userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip: character.summarizedThrough,
    take: intelligence >= 10 && hazelnutContextEnabled() ? Math.min(toFoldCount, 24) : toFoldCount,
    select: { id: true, role: true, content: true, createdAt: true },
  });
  if (toFold.length === 0) return;

  // Bound each fold if memory processing was down for a long time. Process a
  // contiguous prefix only, so the cursor never skips an unprocessed message.
  if (intelligence >= 10 && hazelnutContextEnabled()) {
    let tokens = estimateTokens(character.memorySummary || "") + 250;
    let count = 0;
    for (const message of toFold) {
      const next = estimateTokens(message.content) + 8;
      if (count && tokens + next > 6000) break;
      tokens += next; count++;
    }
    toFold.splice(count);
  }
  // A question or offered action needs its answer to remain in recent
  // context. This applies to every engine, not only compact Hazelnut.
  if (toFold[toFold.length - 1]?.role === "user") toFold.pop();
  if (toFold.length === 0) return;
  const updatedSummary = await withTokenAccounting(intelligence >= 10 ? "hazelnut" : "other", "memory", () => summarizeConversation(
    character,
    character.memorySummary,
    toFold,
    character.isExplicit || character.explicitEverUsed,
    intelligence
  ));

  // Concurrent chat requests can reach this function with the same cursor.
  // Commit only if the cursor is still unchanged; otherwise this summary was
  // generated from stale state and must not overwrite the newer summary.
  const committed = await prisma.character.updateMany({
    where: {
      id: characterId,
      summarizedThrough: character.summarizedThrough,
      memorySummary: character.memorySummary,
    },
    data: {
      // memorySummary is VARCHAR(8000); the model is only told a word limit,
      // so clamp before writing. An oversized value would fail the update on
      // every later turn and silently stall memory.
      memorySummary: truncateUnits(updatedSummary, 7900),
      summarizedThrough: character.summarizedThrough + toFold.length,
    },
  });
  if (committed.count === 0) {
    console.warn(`[chat] skipped stale memory-summary write for character ${characterId}`);
  }
  } finally { activeSummaries.delete(characterId); }
}

export default router;
