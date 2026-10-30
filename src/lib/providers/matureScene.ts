import { splitRoleplayInput } from "../roleplayInput";

/**
 * High-precision, zero-provider-cost scene gate for paid-tier mature
 * engagement cues. `explicitMode` only grants permission; it does not mean
 * every turn is sexual. We therefore activate the extra prompt only when
 * the current/recent exchange actually looks adult-intimate.
 *
 * Design goals:
 * - no model/classifier call and no extra database query;
 * - avoid broad single-word triggers such as "hot", "bed", "come",
 *   "touch", or "kiss";
 * - respect ROLEPLAY_INPUT semantics: private *narration/thoughts* are not
 *   automatically spoken invitations, while observable actions may still
 *   establish the scene;
 * - keep a clearly established scene alive across short continuations such
 *   as "again" / "keep going" without latching forever;
 * - an actual user pull-back immediately wins over prior context.
 */

export type MatureSceneMessage = {
  role: string;
  content: string;
};

// Keep the strongest bucket explicit without treating expletives ("fuck this")
// or informational mentions of the word "sex" as proof that an intimate scene
// is underway. The scene gate prefers false negatives over sexualizing ordinary talk.
const DIRECT_ADULT = /\b(?:blowjob|handjob|oral\s+sex|intercourse|penetrat(?:e|es|ed|ing|ion)|masturbat(?:e|es|ed|ing|ion)|orgasm(?:s|ed|ing)?|ejaculat(?:e|es|ed|ing|ion)|cum(?:s|med|ming)?|(?:have|had|having|during|after|before)\s+sex|(?:want(?:s|ed|ing)?|need(?:s|ed|ing)?|going|gonna|want)\s+to\s+(?:have\s+)?sex|sex\s+with\s+(?:you|me|him|her|them)|fuck(?:s|ed|ing)?\s+(?:me|you|him|her|them)|(?:want(?:s|ed|ing)?|need(?:s|ed|ing)?|going|gonna)\s+to\s+fuck\s+(?:me|you|him|her|them)?)\b/i;
const NON_EROTIC_SEX_CONTEXT = /\b(?:sex\s+education|sexual\s+education|sexual\s+health|safe\s+sex|sex\s+therapy|sex\s+therapist|sex\s+research|sex\s+studies|sex\s+chromosomes?|biological\s+sex|penetration\s+test(?:ing)?|cum\s+laude)\b/gi;
const ADULT_ANATOMY = /\b(?:cock|dick|penis|pussy|vagina|clit(?:oris)?|breasts?|boobs?|nipples?)\b/i;
const NON_EROTIC_ANATOMY_CONTEXT = /\b(?:breast\s+cancer|breast\s+exam|breast\s+milk|chicken\s+breasts?|(?:penis|vagina|breasts?|nipples?)\s+(?:anatomy|health|exam|surgery|cancer|condition)|anatomy\s+(?:class|lesson|textbook|of\s+(?:the\s+)?(?:penis|vagina|breast))|medical\s+(?:exam|discussion)|cock\s+(?:crowed|crows|bird|rooster)|(?:he|she|you|they|this\s+guy|that\s+guy)(?:'s|\s+is|\s+are)\s+(?:a\s+)?dick|don'?t\s+be\s+a\s+dick)\b/gi;
const UNDRESSING = /\b(?:naked|nude|undress(?:es|ed|ing)?|strip(?:s|ped|ping)?(?:\s+(?:down|naked|for\s+(?:you|me|him|her|them))|\s+(?:(?:my|your|his|her|their)\s+)?(?:clothes?|shirt|top|pants?|dress|bra|underwear|panties))|take(?:s|n|ing)?\s+off\s+(?:(?:my|your|his|her|their)\s+)?(?:clothes?|shirt|top|pants?|dress|bra|underwear|panties))\b/i;

// Strong sexual actions require an intimate target or direction. This avoids
// ordinary phrases such as "suck at math", "the daily grind", "stroke of
// luck", or "strip the paint" manufacturing mature-scene confidence.
const STRONG_EROTIC_ACTION = /\b(?:(?:fondl(?:e|es|ed|ing)|grop(?:e|es|ed|ing))\s+(?:(?:my|your|his|her|their)\s+)?(?:you|me|him|her|them|body|chest|breasts?|boobs?|nipples?|ass|butt|thighs?|groin|cock|dick|penis|pussy|vagina|clit(?:oris)?)|straddl(?:e|es|ed|ing)\s+(?:you|me|him|her|them|(?:my|your|his|her|their)\s+(?:lap|waist|hips))|(?:thrust(?:s|ed|ing)?|grind(?:s|ed|ing)?)\s+(?:into|against|on|between)\s+(?:you|me|him|her|them|(?:my|your|his|her|their)\s+(?:body|hips?|lap|thighs?|groin))|(?:suck(?:s|ed|ing)?|lick(?:s|ed|ing)?|stroke(?:s|d|ing)?)\s+(?:(?:my|your|his|her|their)\s+)?(?:cock|dick|penis|pussy|vagina|clit(?:oris)?|breasts?|boobs?|nipples?|neck|inner\s+thighs?|groin))\b/i;

// Require an actual subject for ambiguous phrases such as "turned on",
// "hard for you", and "wet for you" so normal sentences like "I turned
// on the light" or "this is hard for you" stay ordinary.
const AROUSAL = /\b(?:horny|aroused|erect(?:ion)?|(?:i(?:'m| am)|you(?:'re| are)|he(?:'s| is)|she(?:'s| is)|they(?:'re| are))\s+(?:really\s+|so\s+)?turned\s+on(?:\s+(?:by|for)\b|(?=[.!?,]|$))|(?:i(?:'m| am)|you(?:'re| are)|he(?:'s| is)|she(?:'s| is)|they(?:'re| are))\s+(?:really\s+|so\s+)?(?:wet|hard)\s+for\s+(?:you|me|him|her|them))\b/i;
// Possessive anatomy often carries the arousal state through a later pronoun
// ("my cock ... it's hard"), which the subject-based AROUSAL pattern above
// intentionally does not match. Keep this proximity-based and suppress clear
// medical framing so ordinary health discussion does not activate the scene.
const ANATOMY_AROUSAL = /\b(?:(?:my|your|his|her|their)\s+(?:cock|dick|penis)\b(?:(?![.!?]).){0,56}\b(?:hard|erect)(?:\s+(?:for\s+(?:you|me|him|her|them)|right\s+now|this\s+morning|tonight|already|again))?(?=[.!?,]|$)|(?:my|your|his|her|their)\s+(?:pussy|vagina|clit(?:oris)?)\b(?:(?![.!?]).){0,56}\bwet(?:\s+(?:for\s+(?:you|me|him|her|them)|right\s+now|already|again))?(?=[.!?,]|$))/i;
const MEDICAL_AROUSAL_CONTEXT = /\b(?:doctor|medical|hospital|clinic|exam|condition|pain|injury|surgery|cancer|health|priapism|treatment|symptom)\b/i;
const AROUSAL_SOUND = /\b(?:moan(?:s|ed|ing)?|whimper(?:s|ed|ing)?)\b/i;

// These are intimate enough to establish the scene by themselves even when
// the turn avoids explicit anatomy words. Support both natural word orders
// for under-clothing actions ("hand slides under..." / "slide my hand under...").
const STRONG_INTIMATE_ACTION = /\b(?:make(?:s|ing)?\s+out|(?:slide|slides|slid|sliding|slip|slips|slipped|slipping)\s+(?:my|your|his|her|their)\s+hand\s+under\s+(?:my|your|his|her|their)\s+(?:shirt|top|clothes?|underwear)|(?:my|your|his|her|their)\s+hand\s+(?:slides?|slid|sliding|slips?|slipped|slipping)?\s*under\s+(?:my|your|his|her|their)\s+(?:shirt|top|clothes?|underwear)|hand\s+(?:slides?|slid|sliding|slips?|slipped|slipping)?\s*under\s+(?:my|your|his|her|their)\s+(?:shirt|top|clothes?|underwear)|(?:hand|fingers?)\s+(?:moves?|slides?|slips?)?\s*(?:between|up)\s+(?:my|your|his|her|their)\s+(?:inner\s+)?thighs?)\b/i;
const INTIMATE_ACTION = /\b(?:kiss(?:es|ed|ing)?|touch(?:es|ed|ing)?|caress(?:es|ed|ing)?|pull(?:s|ed|ing)?\s+(?:you|me|him|her|them)\s+closer|on\s+(?:my|your|his|her|their)\s+lap)\b/i;

// Deliberately avoids bare "adult": "act like an adult" is not a sexual steer.
const DIRECTIVE_MATURE = /\b(?:explicit|sexual|sexier|spicier|more\s+intimate|intimate\s+scene|heat\s+(?:it|this)\s+up|make\s+(?:it|this)\s+hotter|adult\s+(?:scene|content|roleplay))\b/i;

const CONTINUATION_SHORT = /^\s*[\*_~]*(?:yes|yeah|yep|please|again|more|keep\s+going|continue|go\s+on|don'?t\s+stop|do\s+not\s+stop|closer|like\s+that|right\s+there|stay\s+close)[.!…\s\*_~-]*$/i;
// Used only when a strong mature cue exists in the very recent context and
// the current turn is short, so natural phrasing like "I can't wait, keep
// going" can carry scene state without making these words global triggers.
const CONTINUATION_PHRASE = /\b(?:keep\s+going|continue|go\s+on|don'?t\s+stop|do\s+not\s+stop|again|more|like\s+that|right\s+there|stay\s+close)\b/i;
const CONTINUATION_ACTION = /\b(?:nod(?:s|ded|ding)?|lean(?:s|ed|ing)?\s+closer|come(?:s|came|ing)?\s+closer|hold(?:s|held|ing)?\s+me|pull(?:s|ed|ing)?\s+(?:you|me|him|her|them)\s+closer|(?:do(?:es)?\s+not|doesn'?t)\s+pull\s+away|stay(?:s|ed|ing)?\s+close)\b/i;

// Strong boundaries are respected wherever they appear in spoken text.
const STRONG_PULLBACK = /\b(?:not\s+now|enough|back\s+off|don'?t\s+touch|do\s+not\s+touch|i\s*(?:am|'m)\s+not\s+comfortable|change\s+the\s+subject|let'?s\s+talk\s+about\s+something\s+else|no\s+(?:more\s+)?(?:sex|sexual\s+stuff|intimacy|touching|kissing)|(?:i\s+)?(?:don'?t|do\s+not)\s+want\s+(?:any\s+)?(?:sex|sexual\s+stuff|intimacy|touching|kissing|to\s+(?:have\s+sex|be\s+sexual|do\s+anything\s+sexual))|(?:don'?t|do\s+not)\s+(?:be|make\s+(?:it|this))\s+(?:explicit|sexual|intimate)|nothing\s+sexual|keep\s+(?:it|this)\s+(?:non[- ]?sexual|sfw)|avoid\s+(?:sex|sexual\s+content|intimacy))\b/i;
// Bare pacing words need context: "stop talking and kiss me" is a redirect,
// while "stop" or "wait, I'm not comfortable" is a real pull-back.
const PACING_PULLBACK = /^(?:please\s+)?(?:stop|pause|wait|slow\s+down)\b/i;
const POSITIVE_REDIRECT = /\b(?:kiss(?:es|ed|ing)?|closer|hold\s+me|stay\s+close|come\s+closer|keep\s+going|continue|again|more|don'?t\s+stop|do\s+not\s+stop|fuck(?:s|ed|ing)?|sex|touch(?:es|ed|ing)?|caress(?:es|ed|ing)?|make\s+out)\b/i;
const STOPPED_INTIMATE_TARGET = /^(?:sex|fucking|touching|kissing|this|that|it|everything)\b/i;
const NONINTIMATE_STOP_TARGET = /^(?:talking|asking|teasing|joking|stalling|hesitating|overthinking)\b/i;
// Observable action-based withdrawal in asterisk narration should also win.
const PHYSICAL_PULLBACK = /\b(?:pull(?:s|ed|ing)?\s+away|move(?:s|d|ing)?\s+away|step(?:s|ped|ping)?\s+back|push(?:es|ed|ing)?\s+(?:you|me|him|her|them)\s+away|turn(?:s|ed|ing)?\s+away|withdraw(?:s|n|ing)?|remove(?:s|d|ing)?\s+(?:your|his|her|their)\s+hand)\b/i;

// Narration that explicitly frames the content as private cognition should not
// by itself buy the extra mature prompt. Observable narration still counts.
const PRIVATE_NARRATION = /\b(?:(?:i|he|she|they)\s+(?:think|imagine|wonder|remember|fantasi[sz]e|daydream|picture)|in\s+(?:my|his|her|their)\s+(?:head|mind)|to\s+(?:myself|himself|herself|themselves)|privately|secretly)\b/i;

function normalize(text: string): string {
  return text.replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
}

function roleplayParts(text: string): { spoken: string; narration: string; signal: string } {
  const segments = splitRoleplayInput(text);
  const spoken = normalize(segments.filter(s => s.kind === "spoken").map(s => s.text).join(" "));
  const narrationParts = segments.filter(s => s.kind === "narration").map(s => normalize(s.text)).filter(Boolean);
  const narration = normalize(narrationParts.join(" "));
  const observableNarration = narrationParts.filter(part => !PRIVATE_NARRATION.test(part));
  const signal = normalize([spoken, ...observableNarration].filter(Boolean).join(" "));
  return { spoken, narration, signal };
}

function hasPullback(text: string): boolean {
  const { spoken, narration } = roleplayParts(text);

  // Physical withdrawal in narration is an unambiguous scene-level pullback.
  if (PHYSICAL_PULLBACK.test(narration)) return true;
  if (!spoken) return false;

  // "don't stop" / "don't slow down" are continuations, not pull-backs.
  const protectedSpoken = normalize(spoken)
    .replace(/\b(?:don'?t|do\s+not)\s+stop\b/gi, "continue")
    .replace(/\b(?:don'?t|do\s+not)\s+slow\s+down\b/gi, "continue")
    .replace(/\b(?:can'?t|cannot)\s+wait\b/gi, "eager");

  if (STRONG_PULLBACK.test(protectedSpoken)) return true;

  // A leading "stop/wait/pause/slow down" is treated as a boundary unless
  // the same sentence clearly redirects into another welcomed intimate beat.
  if (PACING_PULLBACK.test(protectedSpoken)) {
    const remainder = normalize(protectedSpoken.replace(PACING_PULLBACK, "").replace(/^[,;:—-]+/, ""));
    // "stop sex/touching/this" is a boundary even though the stopped thing
    // contains an otherwise-positive intimate word. Only obvious non-intimate
    // targets such as "stop talking and kiss me" count as a redirect.
    if (STOPPED_INTIMATE_TARGET.test(remainder)) return true;
    const redirect = NONINTIMATE_STOP_TARGET.test(remainder) && POSITIVE_REDIRECT.test(remainder);
    return !redirect;
  }

  return false;
}

/**
 * Category scoring intentionally counts each cue family at most once. That
 * stops a repeated ambiguous word from manufacturing confidence.
 */
export function matureSceneScore(text: string): number {
  const t = normalize(text);
  if (!t) return 0;
  let score = 0;
  const adultSignal = t.replace(NON_EROTIC_SEX_CONTEXT, " ");
  const anatomySignal = t.replace(NON_EROTIC_ANATOMY_CONTEXT, " ");
  if (DIRECT_ADULT.test(adultSignal)) score += 4;
  if (ADULT_ANATOMY.test(anatomySignal)) score += 2;
  if (UNDRESSING.test(t)) score += 3;
  if (STRONG_EROTIC_ACTION.test(t)) score += 3;
  if (AROUSAL.test(t)) score += 3;
  if (!MEDICAL_AROUSAL_CONTEXT.test(t) && ANATOMY_AROUSAL.test(t)) score += 3;
  if (STRONG_INTIMATE_ACTION.test(t)) score += 3;
  if (AROUSAL_SOUND.test(t)) score += 1;
  if (INTIMATE_ACTION.test(t)) score += 1;
  return score;
}

export function isMatureSceneActive(args: {
  explicitMode: boolean;
  recentHistory: MatureSceneMessage[];
  sceneDirective?: string;
}): boolean {
  if (!args.explicitMode) return false;

  const history = args.recentHistory.filter(m => typeof m.content === "string" && m.content.trim());
  let latestUserIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      latestUserIndex = i;
      break;
    }
  }

  const latestUserRaw = latestUserIndex >= 0 ? history[latestUserIndex].content : "";
  const latestUserParts = latestUserRaw ? roleplayParts(latestUserRaw) : { spoken: "", narration: "", signal: "" };
  const latestUser = latestUserParts.signal;
  const continuationText = latestUserParts.spoken || latestUser;
  const directive = args.sceneDirective?.trim() ?? "";
  const current = [latestUser, directive].filter(Boolean).join("\n");

  // A current user/scene-steer pull-back always disables the mature
  // follow-through cue, even if the preceding assistant message was explicit.
  if (latestUserRaw && hasPullback(latestUserRaw)) return false;
  if (directive && hasPullback(directive)) return false;

  // Explicit quick-action/scene steering is deliberate enough to activate.
  if (directive && DIRECTIVE_MATURE.test(directive)) return true;

  const currentScore = matureSceneScore(current);
  if (currentScore >= 3) return true;

  // Look only a few messages back: this is a scene signal, not a permanent
  // conversation label. That keeps an old intimate moment from taxing later
  // ordinary chat.
  const lookbackStart = Math.max(0, (latestUserIndex >= 0 ? latestUserIndex : history.length) - 3);
  const prior = history.slice(lookbackStart, latestUserIndex >= 0 ? latestUserIndex : history.length);

  let strongestPrior = 0;
  let maturePriorIndex = -1;
  for (let i = 0; i < prior.length; i++) {
    // A user pull-back inside the hold window is a hard scene-state barrier:
    // nothing before it may reactivate from a later vague "again".
    if (prior[i].role === "user" && hasPullback(prior[i].content)) {
      strongestPrior = 0;
      maturePriorIndex = -1;
      continue;
    }
    const signal = prior[i].role === "user" ? roleplayParts(prior[i].content).signal : normalize(prior[i].content);
    const s = matureSceneScore(signal);
    if (s > strongestPrior) strongestPrior = s;
    if (s >= 3) maturePriorIndex = i;
  }

  // Two compatible medium-strength turns are enough; a lone "kiss" or
  // "touch" is not.
  if (currentScore >= 2 && strongestPrior >= 2) return true;

  // Preserve a clearly established scene across a short continuation without
  // forcing the user to repeat explicit vocabulary every turn. Limit this to
  // a very recent strong cue so it naturally expires after topic changes.
  if (maturePriorIndex >= 0 && continuationText) {
    const words = normalize(continuationText).split(/\s+/).filter(Boolean).length;
    if (words <= 10 && (CONTINUATION_SHORT.test(normalize(continuationText)) || CONTINUATION_PHRASE.test(continuationText) || CONTINUATION_ACTION.test(continuationText))) return true;
    if (currentScore >= 1) return true;
  }

  return false;
}


/** Backward-compatible alias for older imports/docs. */
export const isHazelnutMatureSceneActive = isMatureSceneActive;
