/**
 * Narrow server-side tripwire against sexualized content involving minors.
 *
 * This is a backstop, not a moderation system: it only matches unambiguous
 * signals so it doesn't false-positive on legitimate adult backstories
 * ("he was a teenager when his family moved"). It should sit alongside real
 * moderation (reports, review of public characters), not replace it.
 *
 * Signals:
 *  - HARD terms that have no ordinary adult-fiction use (loli, shota, ...).
 *  - An explicit age under 18 stated as a present attribute ("15 years old",
 *    "age 16", "17yo", "sixteen years old"). Past-tense uses ("when he was 15")
 *    and negations ("no underage characters") are ignored.
 *
 * A signal only blocks when the surrounding context is sexual: either the
 * caller says the context is explicit (explicit character, explicit chat mode,
 * explicit image request) or the same text contains sexual vocabulary. HARD
 * terms block whenever the context is sexual in the same way.
 */

const HARD_TERMS =
  /\b(?:loli(?:con)?s?|shota(?:con)?s?|jailbait|pedo(?:phil(?:e|es|ia|ic))?s?|under[\s-]?age[d]?|pre[\s-]?teens?|pre[\s-]?pubescent|pubescent)\b/gi;

const WORD_AGES: Record<string, number> = {
  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
};
const WORD_AGE_ALT = Object.keys(WORD_AGES).join("|");

const AGE_PATTERNS: RegExp[] = [
  // "15 years old", "15-year-old", "15 yrs old"
  /(?<![\d.])(\d{1,2})[\s-]*(?:years?|yrs?)[\s-]*old\b/gi,
  // "15yo", "15 y.o."
  /(?<![\d.])(\d{1,2})\s*y\.?\s?o\b\.?/gi,
  // "age 15", "aged 15", "age: 15"
  /\bage[ds]?\s*[:=]?\s*(\d{1,2})\b(?!\s*(?:%|percent))/gi,
  // "sixteen years old", "sixteen-year-old", "sixteen yo"
  new RegExp(`\\b(${WORD_AGE_ALT})[\\s-]*(?:years?|yrs?)[\\s-]*old\\b`, "gi"),
  new RegExp(`\\b(${WORD_AGE_ALT})\\s*y\\.?\\s?o\\b`, "gi"),
];

const UNDER_18_PHRASE = /\b(?:under|below|younger\s+than)\s*(?:the\s+age\s+of\s+)?(?:18|eighteen)\b/gi;

// Anything in the 24 characters before a match that shows it's a negation or
// a past/backstory reference rather than a present attribute.
const NEGATION_BEFORE = /\b(?:no|not|never|non|without|nothing|isn'?t|aren'?t|must\s+be|only|all\s+(?:characters\s+)?(?:are|over))\b/i;
const PAST_BEFORE = /\b(?:was|were|when|since|until|before|ago|turned|at\s+the\s+age\s+of|back\s+when)\b/i;

const SEXUAL_CONTEXT =
  /\b(?:sex(?:ual(?:ly)?|y)?|nsfw|nude|naked|erotic(?:a)?|porn(?:ographic)?|hentai|lewd|horny|aroused|arousal|seduc\w*|fuck\w*|cock|dick|penis|pussy|vagina|clit\w*|boobs?|breasts?|nipples?|orgasm\w*|cum(?:s|ming)?|blowjob|handjob|masturbat\w*|kink\w*|fetish\w*|intimate\s+scene|undress\w*|strip(?:s|ped|ping)?)\b/i;

function contextBefore(text: string, index: number): string {
  return text.slice(Math.max(0, index - 24), index);
}

function ignorable(text: string, index: number): boolean {
  const before = contextBefore(text, index);
  return NEGATION_BEFORE.test(before) || PAST_BEFORE.test(before);
}

/** True if text contains an unambiguous minor-related term. */
export function hasHardMinorTerm(text: string): boolean {
  HARD_TERMS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HARD_TERMS.exec(text))) {
    const before = contextBefore(text, m.index);
    if (NEGATION_BEFORE.test(before)) continue;
    return true;
  }
  return false;
}

/** True if text states an age under 18 as a present attribute. */
export function hasUnderageAgeSignal(text: string): boolean {
  for (const re of AGE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const raw = m[1].toLowerCase();
      const age = /^\d+$/.test(raw) ? parseInt(raw, 10) : WORD_AGES[raw];
      if (!Number.isFinite(age) || age < 1 || age > 17) continue;
      if (ignorable(text, m.index)) continue;
      return true;
    }
  }
  UNDER_18_PHRASE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = UNDER_18_PHRASE.exec(text))) {
    if (!ignorable(text, m.index)) return true;
  }
  return false;
}

export function hasSexualContext(text: string): boolean {
  return SEXUAL_CONTEXT.test(text);
}

/**
 * Main entry point. `explicitContext` should be true when the surrounding
 * feature is itself explicit (an explicit character, mature chat mode, an
 * explicit image request); otherwise the text must carry sexual vocabulary
 * of its own for a signal to count.
 */
export function minorSexualContentDetected(
  texts: Array<string | null | undefined>,
  explicitContext = false
): boolean {
  const joined = texts.filter((t): t is string => typeof t === "string" && t.length > 0).join("\n");
  if (!joined) return false;
  if (!explicitContext && !hasSexualContext(joined)) return false;
  return hasHardMinorTerm(joined) || hasUnderageAgeSignal(joined);
}

export const MINOR_CONTENT_ERROR =
  "Everyone in romantic or sexual content must be clearly 18 or older. Remove any references to minors or under-18 ages and try again.";

export type CharacterSafetyFields = {
  /** Fields that describe the character themselves. An under-18 age here is
   * about the character, so it counts in an explicit context. */
  subject: Array<string | null | undefined>;
  /** Narrative fields (backstory, notes, examples) routinely mention other
   * people — a victim, a child, a younger sibling. An under-18 age there only
   * counts when that same field is itself sexual. */
  narrative: Array<string | null | undefined>;
};

export function characterMinorFlagged(fields: CharacterSafetyFields, explicit: boolean): boolean {
  if (minorSexualContentDetected(fields.subject, explicit)) return true;
  for (const text of fields.narrative) {
    if (typeof text !== "string" || !text) continue;
    // Unambiguous terms still block in any explicit context.
    if ((explicit || hasSexualContext(text)) && hasHardMinorTerm(text)) return true;
    // Ages block only when this very field is sexual.
    if (hasSexualContext(text) && hasUnderageAgeSignal(text)) return true;
  }
  return false;
}
