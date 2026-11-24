import { createHash } from "node:crypto";

/**
 * Roleplay experiment flags.
 *
 * The retention research this work follows (A/B pairs of models, stable
 * assignment, a week or more of observation) only works if a user stays in
 * the same arm for the whole test. Each flag is therefore resolved from an
 * environment variable that is either fixed or a deterministic split keyed on
 * the user id, so the arm is sticky and can be recomputed offline from the id.
 *
 *   ROLEPLAY_X=on | true | 1 | yes      everyone gets the treatment
 *   ROLEPLAY_X=off | false | 0 | no     nobody does (the control)
 *   ROLEPLAY_X=split:30                 30% of users, chosen by a stable hash
 *
 * Anything unrecognised falls back to the flag's default and never throws.
 * A split with no user id is the control arm (off).
 */

export type FlagName = "adaptiveRhythm" | "director" | "actionCap" | "personaAnchor";

type Spec = { env: string; fallback: boolean; about: string };

/**
 * Defaults follow the evidence available, not the intuition they replaced:
 *  - adaptiveRhythm: OFF. The only real-user retention study found longer
 *    replies correlate with retention, so shortening a reply is a hypothesis
 *    to test, not a default.
 *  - actionCap: OFF. Non-verbal description correlated with retention, so
 *    limiting action beats is a hypothesis to test as well.
 *  - director: ON. It only varies form and retires stock phrases.
 *  - personaAnchor: ON. Persona drift over long chats is documented in
 *    several independent studies.
 */
export const FLAG_SPECS: Record<FlagName, Spec> = {
  adaptiveRhythm: { env: "ADAPTIVE_REPLY_RHYTHM", fallback: false, about: "relax the word floor on a brief, light user turn" },
  director: { env: "ROLEPLAY_DIRECTOR", fallback: true, about: "per-turn form steers (openings, closers, stock phrases, agency)" },
  actionCap: { env: "ROLEPLAY_ACTION_CAP", fallback: false, about: "cap action beats after three action-heavy replies" },
  personaAnchor: { env: "ROLEPLAY_PERSONA_ANCHOR", fallback: true, about: "short persona reminder close to the end of the context" },
};

export const FLAG_NAMES = Object.keys(FLAG_SPECS) as FlagName[];

const TRUE_WORDS = new Set(["on", "true", "1", "yes"]);
const FALSE_WORDS = new Set(["off", "false", "0", "no"]);

/** Stable 0-99 bucket for (flag, user). Independent per flag. */
export function bucketFor(flag: string, userId: string): number {
  const digest = createHash("sha256").update(`${flag}:${userId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export function parseFlag(raw: string | undefined, fallback: boolean, flag: string, userId?: string): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (TRUE_WORDS.has(value)) return true;
  if (FALSE_WORDS.has(value)) return false;
  const split = /^split:(\d{1,3})$/.exec(value);
  if (split) {
    if (!userId) return false;
    const pct = Math.min(100, Number(split[1]));
    return bucketFor(flag, userId) < pct;
  }
  return fallback;
}

/** One flag for one user (or the no-user control when userId is omitted). */
export function flagEnabled(name: FlagName, userId?: string): boolean {
  const spec = FLAG_SPECS[name];
  return parseFlag(process.env[spec.env], spec.fallback, name, userId);
}

export type Arms = Record<FlagName, boolean>;

export function resolveArms(userId?: string): Arms {
  const arms = {} as Arms;
  for (const name of FLAG_NAMES) arms[name] = flagEnabled(name, userId);
  return arms;
}

/** Compact, log-friendly arm label such as "ar0.dr1.ac0.pa1". */
export function armsTag(arms: Arms): string {
  const short: Record<FlagName, string> = { adaptiveRhythm: "ar", director: "dr", actionCap: "ac", personaAnchor: "pa" };
  return FLAG_NAMES.map(n => `${short[n]}${arms[n] ? 1 : 0}`).join(".");
}
