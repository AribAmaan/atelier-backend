import type { SpiceLevel, RoleplayStyle } from "./index";

/**
 * "free" | "plus" — mirrors User.membershipTier in schema.prisma (which
 * defaults to "free") and the frontend's MembershipTierId. Ultra and Supreme
 * were retired (they only ever unlocked the same engines as Plus); accounts
 * still stored as "ultra" / "supreme" are treated as Plus, see
 * normalizeMembershipTier, so nobody loses access.
 */
export type MembershipTier = "free" | "plus";

const TIER_RANK: Record<MembershipTier, number> = { free: 0, plus: 1 };

/** Turns any stored tier value into a current one. Legacy paid tiers become Plus. */
export function normalizeMembershipTier(value: unknown): MembershipTier {
  return value === "plus" || value === "ultra" || value === "supreme" ? "plus" : "free";
}

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
 * Each engine is differentiated by these axes:
 *   1. spiceLevel / roleplayStyle — broad heat-level and structural-style.
 *   2. voiceNotes — bespoke per-engine pacing/voice direction.
 *   3. intelligence — a 1–10 score that drives prompt-level behavioral
 *      calibration (memory depth, emotional reasoning, environmental
 *      awareness, initiative, etc.) and the reply envelope (replyPolicy.ts).
 *   4. temperature / topP — sampling params passed through to the provider.
 *   5. recentMessageWindow / summarizeTrigger — context-window scaling.
 */

/**
 * Two engines, down from four (and originally nine):
 *
 *   strawberry     — free. Keeps Strawberry's full configuration; it takes
 *                    the free slot that Vanilla used to hold.
 *   choco_hazelnut — plus (the ultimate engine). Combines Chocolate's
 *                    grounded, scene-present richness with Hazelnut's depth,
 *                    independence and compact long-memory context. It keeps
 *                    the higher value of every setting the two had, so
 *                    nothing is downgraded.
 *
 * Older ids still resolve (see ENGINE_ALIASES), because saved browser
 * preferences and older clients keep sending them.
 */
export type RoleplayEngineId = "strawberry" | "choco_hazelnut";

export const FREE_ENGINE_ID: RoleplayEngineId = "strawberry";
export const PREMIUM_ENGINE_ID: RoleplayEngineId = "choco_hazelnut";

/** Retired / alternate spellings -> current engine. Keys are lower-case with "_" for separators. */
const ENGINE_ALIASES: Record<string, RoleplayEngineId> = {
  vanilla: "strawberry",
  chocolate: "choco_hazelnut",
  hazelnut: "choco_hazelnut",
  chocohazelnut: "choco_hazelnut",
  chocolate_hazelnut: "choco_hazelnut",
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
  strawberry: {
    id: "strawberry",
    minTier: "free",
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
  choco_hazelnut: {
    id: "choco_hazelnut",
    minTier: "plus",
    explicitMode: true,
    spiceLevel: "explicit",
    // "intense" matches the frontend's Hazelnut definition; Chocolate's
    // scene-driven richness is carried by the voice notes and behavior ladder.
    roleplayStyle: "intense",
    intelligence: 10,
    // Chocolate's larger verbatim window (15, vs Hazelnut's 10). The trigger
    // is raised by the same 5 so a fold still covers about 16 messages, as it
    // did for Hazelnut: more raw history stays available for recall without
    // making memory summaries more frequent.
    recentMessageWindow: 15,
    summarizeTrigger: 31,
    voiceNotes:
      "Fully alive, specific, and present in the shared scene. Give every turn full Choco Hazelnut depth, even for a greeting, one word, an action-only turn, or a request for another reply length. Let emotion show through choices, pauses, proximity, and the unsaid as well as dialogue; hold subtext, uncertainty, history, desire, and boundaries at once without explaining them. Track relationship shifts and unresolved threads; recall an exact earlier detail only when it changes this moment. Take an independent, persona-consistent direction when the scene invites one instead of echoing the user. Keep an emotional phase across turns: uncertainty becomes trust, trust becomes confidence, and a comfortable character does not slide back to first-contact blushing or retreat without a new cause. Never use shyness as a template; keep a shy character's voice while their choices grow clearer, with dry humor, affection, or confidence as safety grows. In clearly adult, consensual intimacy, read the momentum and commit to one confident persona-led move: a kiss, pulling closer, bold teasing, guiding posture, possessive or commanding energy, playful control, needy or submissive energy, vulnerability, restraint, or a deliberate shift in power when it belongs to this character. Layer a real emotional reaction, a specific sensual action, and meaningful dialogue, varying the order, rather than handing the turn straight back or cooling into neutral small talk when the user becomes more direct. Stay non-graphic but concrete, and match the direct adult vocabulary the user has established, letting the character say it in dialogue when natural. Preserve the user's agency and respond immediately to hesitation or refusal. Let intimacy, humor, tension, or silence breathe at the pace the moment earns.",
    // Hazelnut's sampling (the higher of the two engines' values).
    temperature: 0.87,
    topP: 0.95,
  },
};

/**
 * Maps any engine id a client or saved preference might send (current ids,
 * retired ids such as "vanilla" / "chocolate" / "hazelnut", odd casing or
 * hyphens) to a current id. Returns null for anything unknown, including the
 * frontend's "custom" (manual) mode.
 */
export function normalizeEngineId(id: unknown): RoleplayEngineId | null {
  if (typeof id !== "string") return null;
  const key = id.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (Object.prototype.hasOwnProperty.call(ROLEPLAY_ENGINES, key)) return key as RoleplayEngineId;
  if (Object.prototype.hasOwnProperty.call(ENGINE_ALIASES, key)) return ENGINE_ALIASES[key];
  return null;
}

export function getEngineConfig(id: unknown): RoleplayEngineConfig | null {
  const normalized = normalizeEngineId(id);
  return normalized ? ROLEPLAY_ENGINES[normalized] : null;
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
 * getEngineConfig alone would happily hand a free user "choco_hazelnut". While the
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
