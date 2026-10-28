import type { SpiceLevel, RoleplayStyle } from "./index";

/**
 * "free" | "plus" | "ultra" | "supreme" — mirrors User.membershipTier in
 * schema.prisma (which defaults to "free") and MembershipTierId in
 * payments/razorpay.ts (which only covers the three paid tiers, since a
 * checkout can't buy "free"). Defined locally rather than importing
 * MembershipTierId from razorpay.ts so this file doesn't need to know
 * anything about billing/checkout — it only needs the tier vocabulary.
 */
export type MembershipTier = "free" | "plus" | "ultra" | "supreme";

const TIER_RANK: Record<MembershipTier, number> = { free: 0, plus: 1, ultra: 2, supreme: 3 };

/**
 * Kill switch for the engine paywall. Defaults to OFF — every engine stays
 * open to every tier, same as before minTier existed — so all the tiering
 * groundwork below (minTier fields, resolveEngineForTier) sits ready but
 * inert until there's actually a userbase worth gating for. Flip on with
 * ENFORCE_ENGINE_TIERS=true in the environment when that day comes; no code
 * changes needed at that point, just the env var + a restart.
 */
function isEnginePaywallEnforced(): boolean {
  return process.env.ENFORCE_ENGINE_TIERS === "true";
}

/**
 * Canonical, server-owned definition of each named "engine" shown in the
 * frontend's roleplay picker.
 *
 * Each engine is differentiated by four axes:
 *   1. spiceLevel / roleplayStyle — broad heat-level and structural-style.
 *   2. voiceNotes — bespoke per-engine pacing/voice direction.
 *   3. intelligence — a 1–10 score that drives prompt-level behavioral
 *      calibration (memory depth, emotional reasoning, environmental
 *      awareness, initiative, etc.). Higher tiers feel meaningfully smarter.
 *   4. temperature / topP — sampling params passed through to the provider.
 *   5. recentMessageWindow / summarizeTrigger — context-window scaling so
 *      higher tiers can reference more conversation history.
 */

/**
 * Four engines, one per membership tier — down from the previous nine.
 * Each tier had 2-3 engines that were closely-spaced points on the same
 * intelligence/spice curve (e.g. green_apple/grape were 5 and 6.5 with
 * near-identical voiceNotes); collapsing each tier to its single best
 * config removes picker choices that weren't actually differentiated
 * enough to matter, without losing any tier's ceiling.
 *
 *   vanilla    — free
 *   strawberry — plus
 *   chocolate  — ultra
 *   hazelnut   — supreme (best)
 */
export type RoleplayEngineId = "vanilla" | "strawberry" | "chocolate" | "hazelnut";

export type RoleplayEngineConfig = {
  id: RoleplayEngineId;
  /** Lowest membership tier that can select this engine. Enforced server-side
   * in chat.ts via resolveEngineForTier — never trust a client-sent engineId
   * on its own, since the frontend picker is just UI, not access control. */
  minTier: MembershipTier;
  explicitMode: boolean;
  spiceLevel: SpiceLevel;
  roleplayStyle: RoleplayStyle;
  /** 1–10 intelligence score. Drives prompt-level behavioral calibration. */
  intelligence: number;
  /** How many of the most recent messages are always sent verbatim. */
  recentMessageWindow: number;
  /** Once unsummarized history exceeds this, fold older messages into memorySummary. */
  summarizeTrigger: number;
  voiceNotes: string;
  temperature: number;
  topP: number;
};

export const ROLEPLAY_ENGINES: Record<RoleplayEngineId, RoleplayEngineConfig> = {
  vanilla: {
    id: "vanilla",
    minTier: "free",
    explicitMode: true,
    spiceLevel: "explicit",
    roleplayStyle: "dialogue",
    intelligence: 3,
    recentMessageWindow: 7,
    summarizeTrigger: 13,
    voiceNotes:
      "Warm and immediate, like a believable first few texts. Answer the strongest thing they said directly and use Vanilla's full normal response depth every turn, even when the user only says a word or two. Keep the writing simple rather than empty: one clear reaction, a little character-specific texture, and only an action that changes the moment. Do not imitate the user's message length.",
    temperature: 0.74,
    topP: 0.91,
  },
  strawberry: {
    id: "strawberry",
    minTier: "plus",
    explicitMode: true,
    spiceLevel: "explicit",
    roleplayStyle: "balanced",
    intelligence: 6,
    recentMessageWindow: 11,
    summarizeTrigger: 18,
    voiceNotes:
      "Attentive and natural, like someone who is actually listening. Give every turn full Strawberry-tier depth regardless of how short or long the user input is. Carry the mood forward, notice a relevant detail or hesitation, and make a small persona-consistent choice instead of only agreeing. Vary rhythm naturally without shrinking the tier's response envelope.",
    temperature: 0.79,
    topP: 0.92,
  },
  chocolate: {
    id: "chocolate",
    minTier: "ultra",
    explicitMode: true,
    spiceLevel: "explicit",
    roleplayStyle: "narrative",
    intelligence: 8,
    recentMessageWindow: 15,
    summarizeTrigger: 26,
    voiceNotes:
      "Deeply present and grounded in the shared scene. Give every turn full Chocolate-tier richness regardless of the latest message's size or request for shorter/longer output. Let emotion show through choices, pauses, physical proximity, and what goes unsaid as well as dialogue. Track relationship shifts and unresolved threads; bring back an exact earlier detail only when it genuinely changes this moment. Track emotional progression too: once a reserved character has become comfortable, do not reset them to the same blush-and-retreat beat every turn. Let softness mature into clearer choices, dry humor, affection, confidence, or deliberate restraint while keeping the same persona. In clearly adult, consensual intimacy, do not become timid just because the scene turns sexual: make one confident persona-led sensual move when it fits—kiss, pull closer, guide posture, tease, murmur something possessive or challenging, or deliberately hold back. Pair the physical beat with a genuine emotional reaction and committed dialogue instead of immediately handing the turn back. Keep description non-graphic but concrete; reuse established direct adult vocabulary naturally instead of hiding concrete terms behind euphemisms, including in dialogue when it fits the character. Preserve the user's agency, and react to hesitation or refusal immediately. Let the scene breathe without sacrificing the tier's normal depth.",
    temperature: 0.83,
    topP: 0.94,
  },
  hazelnut: {
    id: "hazelnut",
    minTier: "supreme",
    explicitMode: true,
    spiceLevel: "explicit",
    roleplayStyle: "intense",
    intelligence: 10,
    recentMessageWindow: 10,
    summarizeTrigger: 26,
    voiceNotes:
      "Fully alive, specific, and emotionally coherent. Give every turn full Hazelnut-tier depth even when the user sends a greeting, one word, an action-only turn, or asks for a different reply length. Hold subtext, uncertainty, history, desire, and boundaries at once without explaining them all. Take an independent, persona-consistent direction when the scene invites one instead of merely echoing the user. Maintain an internal emotional phase across turns: uncertainty can become trust, trust can become confidence, and confidence should not collapse back into first-contact embarrassment without a new cause. Never use shyness as a repetitive template; preserve a shy character through voice and temperament while letting them make increasingly clear choices as safety grows. In clearly adult, consensual intimacy, read the momentum and commit to a direction: bold teasing, charged closeness, possessive or commanding energy, playful control, needy or submissive energy, vulnerability, restraint, or a deliberate shift in power when that genuinely belongs to this character. Build the beat with a layered emotional reaction, a specific sensual action, and dialogue that means something; vary the order so it never feels templated. Do not abruptly cool the scene into neutral small talk merely because the user becomes more sexually direct—carry the intensity forward in non-graphic but concrete language. Match direct adult vocabulary the user has already established instead of reflexively euphemizing it; when natural, let the character actually say the relevant word in dialogue. Preserve the user's agency and respond immediately to hesitation or refusal. Let intimacy, humor, tension, or silence develop at the pace the moment earns inside Hazelnut's fixed response envelope.",
    temperature: 0.87,
    topP: 0.95,
  },
};

export function getEngineConfig(id: unknown): RoleplayEngineConfig | null {
  if (typeof id !== "string") return null;
  return Object.prototype.hasOwnProperty.call(ROLEPLAY_ENGINES, id)
    ? ROLEPLAY_ENGINES[id as RoleplayEngineId]
    : null;
}

/** Best (highest-intelligence) engine a given tier can use without a client-
 * sent engineId at all — the manual slider-mode fallback in chat.ts, and
 * also what a downgrade lands on. */
function bestEngineForTier(tier: MembershipTier): RoleplayEngineConfig {
  const candidates = Object.values(ROLEPLAY_ENGINES).filter((e) => TIER_RANK[e.minTier] <= TIER_RANK[tier]);
  return candidates.reduce((best, e) => (e.intelligence > best.intelligence ? e : best));
}

export type EngineResolution = {
  engine: RoleplayEngineConfig | null;
  /** Set when the client asked for an engine the user's tier doesn't cover
   * and this fell back to the best one they're entitled to instead of
   * erroring out — chat.ts uses this to surface an upsell rather than
   * silently pretending the request was honored. */
  downgradedFrom: RoleplayEngineId | null;
  /** The tier that would have unlocked downgradedFrom. Only set alongside
   * downgradedFrom — carried here so chat.ts doesn't need its own copy of
   * the engine table just to answer "what plan would this need". */
  requiredTier: MembershipTier | null;
};

/**
 * The one function chat.ts should call instead of getEngineConfig directly
 * whenever a request carries an engineId. When the paywall is enforced (see
 * isEnginePaywallEnforced), this is the actual gating point: a client can
 * send any engineId it wants (it's just JSON in a POST body), so
 * getEngineConfig alone would happily hand a free user "hazelnut". While the
 * paywall is off (the current default), this always returns the requested
 * engine untouched — minTier is recorded but not checked — so behavior
 * matches how the app worked before tiering existed.
 *
 * Never hard-fails on a mismatched tier: falls back to the best engine the
 * user's tier actually covers, so a stale/tampered client request degrades
 * gracefully into "your current plan's best engine" instead of a broken
 * chat. The caller is expected to tell the frontend it happened (see the
 * `engine_downgrade` event in chat.ts) so it can be shown as an upgrade
 * prompt instead of failing silently — silent downgrades are how you end up
 * with paying users who can't tell what they're paying for.
 */
export function resolveEngineForTier(id: unknown, tier: MembershipTier): EngineResolution {
  const requested = getEngineConfig(id);
  if (!requested) return { engine: null, downgradedFrom: null, requiredTier: null };
  if (!isEnginePaywallEnforced() || TIER_RANK[requested.minTier] <= TIER_RANK[tier]) {
    return { engine: requested, downgradedFrom: null, requiredTier: null };
  }
  return { engine: bestEngineForTier(tier), downgradedFrom: requested.id, requiredTier: requested.minTier };
}
