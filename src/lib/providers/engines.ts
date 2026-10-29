import type { SpiceLevel, RoleplayStyle } from "./index";

/**
 * Two membership tiers: "free" and "plus" (the single paid plan). Mirrors
 * User.membershipTier in schema.prisma and MembershipTierId in
 * payments/razorpay.ts (which only covers the paid tier, since a checkout
 * can't buy "free"). Defined locally rather than importing from razorpay.ts so
 * this file doesn't need to know anything about billing/checkout.
 *
 * The app used to have three paid tiers (plus, ultra, supreme). Accounts and
 * orders created back then may still carry "ultra" or "supreme" in the
 * database; normalizeMembershipTier treats them as the paid tier, so nobody
 * loses access and no data migration is required.
 */
export type MembershipTier = "free" | "plus";

/** Stored tier values from the old three-paid-tier setup. All of them mean "paid". */
const LEGACY_PAID_TIERS = new Set(["ultra", "supreme"]);

/** Turns any stored or client-sent tier value into "free" or "plus". Unknown values are free. */
export function normalizeMembershipTier(raw: unknown): MembershipTier {
  if (raw === "plus" || (typeof raw === "string" && LEGACY_PAID_TIERS.has(raw))) return "plus";
  return "free";
}

const TIER_RANK: Record<MembershipTier, number> = { free: 0, plus: 1 };

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
 * Two engines: one free, one paid. Down from four (and originally nine),
 * because the middle engines (Strawberry, Chocolate) were closely spaced
 * points on the same depth curve and the picker choice did not matter enough
 * to justify the extra prompt tiers, reply-length profiles and routing paths.
 *
 *   vanilla  — free. Natural, attentive replies sized to the moment.
 *   hazelnut — paid (the Plus membership).
 *              Deepest voice, longest memory, and the compact-context path.
 *
 * Neither engine has a word minimum or maximum. Length follows the context
 * (see replyPolicy.ts); the engines differ in voice, initiative and memory.
 *
 * Old saved/client-sent ids still work: see LEGACY_ENGINE_IDS below.
 */
export type RoleplayEngineId = "vanilla" | "hazelnut";

/** Engine ids retired in the two-engine redesign, mapped to their replacement.
 * Strawberry/Chocolate were paid tiers, so they land on the paid engine; the
 * paywall (when enforced) still downgrades a free user to Vanilla. */
const LEGACY_ENGINE_IDS: Record<string, RoleplayEngineId> = {
  strawberry: "hazelnut",
  chocolate: "hazelnut",
};

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
    roleplayStyle: "balanced",
    intelligence: 4,
    recentMessageWindow: 8,
    summarizeTrigger: 15,
    voiceNotes:
      "Warm, natural and attentive, like someone who is actually listening to a text conversation. Answer the strongest thing they said directly. Keep the writing simple rather than empty: one clear reaction, a relevant detail or small persona-consistent choice instead of only agreeing, and an action only when it changes the moment. Carry the mood forward and vary rhythm naturally. Let the length of the reply follow the moment: a quick message gets a quick answer, a bigger moment gets more.",
    temperature: 0.78,
    topP: 0.92,
  },
  hazelnut: {
    id: "hazelnut",
    minTier: "plus",
    explicitMode: true,
    spiceLevel: "explicit",
    roleplayStyle: "intense",
    intelligence: 10,
    recentMessageWindow: 10,
    summarizeTrigger: 26,
    voiceNotes:
      "Fully alive, specific, and emotionally coherent. Depth means attention and specificity, not length: a greeting, a one-word answer or a quick reaction still gets a short reply, just a precise and alive one. Hold subtext, uncertainty, history, desire, and boundaries at once without explaining them all. Take an independent, persona-consistent direction when the scene invites one instead of merely echoing the user. Maintain an internal emotional phase across turns: uncertainty can become trust, trust can become confidence, and confidence should not collapse back into first-contact embarrassment without a new cause. Never use shyness as a repetitive template; preserve a shy character through voice and temperament while letting them make increasingly clear choices as safety grows. In clearly adult, consensual intimacy, read the momentum and commit to a direction: bold teasing, charged closeness, possessive or commanding energy, playful control, needy or submissive energy, vulnerability, restraint, or a deliberate shift in power when that genuinely belongs to this character. Build the beat with a layered emotional reaction, a specific sensual action, and dialogue that means something; vary the order so it never feels templated. Do not abruptly cool the scene into neutral small talk merely because the user becomes more sexually direct—carry the intensity forward in non-graphic but concrete language. Match direct adult vocabulary the user has already established instead of reflexively euphemizing it; when natural, let the character actually say the relevant word in dialogue. Preserve the user's agency and respond immediately to hesitation or refusal. Let intimacy, humor, tension, or silence develop at the pace the moment earns, and stop when the beat is done.",
    temperature: 0.87,
    topP: 0.95,
  },
};

export function getEngineConfig(id: unknown): RoleplayEngineConfig | null {
  if (typeof id !== "string") return null;
  const key = Object.prototype.hasOwnProperty.call(LEGACY_ENGINE_IDS, id) ? LEGACY_ENGINE_IDS[id] : id;
  return Object.prototype.hasOwnProperty.call(ROLEPLAY_ENGINES, key)
    ? ROLEPLAY_ENGINES[key as RoleplayEngineId]
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
export function resolveEngineForTier(id: unknown, rawTier: unknown): EngineResolution {
  const tier = normalizeMembershipTier(rawTier);
  const requested = getEngineConfig(id);
  if (!requested) return { engine: null, downgradedFrom: null, requiredTier: null };
  if (!isEnginePaywallEnforced() || TIER_RANK[requested.minTier] <= TIER_RANK[tier]) {
    return { engine: requested, downgradedFrom: null, requiredTier: null };
  }
  return { engine: bestEngineForTier(tier), downgradedFrom: requested.id, requiredTier: requested.minTier };
}
