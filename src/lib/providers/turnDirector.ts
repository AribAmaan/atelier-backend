import { splitRoleplayInput } from "../roleplayInput";

/**
 * Turn director — deterministic, zero extra model calls.
 *
 * Sentence-level repeat detection (replyRepeat.ts) catches a model copying an
 * earlier SENTENCE. What makes long roleplay feel mechanical is usually the
 * reply SHAPE repeating: the same opening move, a question closing every
 * turn, the same number of action beats, the same stock gesture ("smirk",
 * "breath hitched"), the same three-word phrase in four replies out of five.
 * Prompts alone are weak against this because a model imitates its own recent
 * replies more strongly than it obeys a general rule.
 *
 * This module reads the character's last few replies and the user's latest
 * turn, then emits at most a few short, concrete, per-turn steers. It is
 * appended fresh on every request (never cached with the persona prompt) and
 * returns "" when there is nothing useful to say, so it costs nothing on a
 * healthy conversation. It never looks at what a sentence MEANS and adds no
 * content restrictions; it only asks for variety of form.
 */

/** Tuning knobs. Every steer needs real evidence, so these stay conservative. */
const QUICK_BEAT_MAX_WORDS = 5;       // user turn at or below this is a brief beat (greeting, ack, one-liner)
const WEIGHTY_BEAT_WORDS = 45;        // total words at or above this is a weighty turn
const WEIGHTY_NARRATION_WORDS = 25;   // or this much narration alone
const SHAPE_WINDOW = 3;               // replies examined for opening / action-density runs
const QUESTION_RUN = 2;               // consecutive closing questions before a steer
const TIC_WINDOW = 4;                 // recent replies scanned for stock gestures
const TIC_MIN_REPLIES = 2;            // a stock gesture must appear in this many of them
const PHRASE_WINDOW = 5;              // recent replies scanned for a repeated line
const PHRASE_MIN_REPLIES = 3;         // a 3-word line must appear in this many of them
const RECENT_PHRASE_WINDOW = 3;       // a paraphrased line shows up faster than a copied one,
const RECENT_PHRASE_MIN_REPLIES = 2;  // so the newest replies get a stricter check
const QUESTION_WINDOW = 4;            // replies scanned for a question asked again and again
const STARTER_WINDOW = 4;             // replies scanned for a sentence-opening habit ("Means ...")
const STARTER_MIN_REPLIES = 3;
const OPENER_WINDOW = 3;              // opening beats compared for a repeated object or gesture
const FILLER_WINDOW = 4;              // replies scanned for a pet filler word ("honestly")
const FILLER_MIN_TOTAL = 3;
const PAST_CLAIM_WINDOW = 2;          // recent replies checked for invented past events
const CLARIFY_MAX_WORDS = 6;          // a user turn this short that asks "what do you mean" is a clarification
const DIRECT_QUESTION_MAX_WORDS = 14; // longer turns are usually a story with a question inside it

export type UserBeat = "rapid" | "normal" | "weighty";

type Turn = { role: string; content: string };

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/gu;

function wordCount(text: string): number {
  const spaced = text.trim().split(/\s+/).filter(Boolean).length;
  // Scripts written without spaces would otherwise always look "rapid".
  const cjk = (text.match(CJK) ?? []).length;
  return Math.max(spaced, Math.ceil(cjk / 2));
}

/**
 * How much the user's latest turn carries. Used to size the reply to the
 * moment instead of padding a one-word turn to a fixed length.
 */
export function classifyUserBeat(latestUserText: string): UserBeat {
  const text = (latestUserText ?? "").trim();
  if (!text) return "normal";
  let spoken = 0;
  let narration = 0;
  for (const segment of splitRoleplayInput(text)) {
    const n = wordCount(segment.text);
    if (segment.kind === "narration") narration += n; else spoken += n;
  }
  const total = spoken + narration;
  if (total <= QUICK_BEAT_MAX_WORDS) return "rapid";
  if (total >= WEIGHTY_BEAT_WORDS || narration >= WEIGHTY_NARRATION_WORDS) return "weighty";
  return "normal";
}

export type Shape = {
  opening: "action" | "speech";
  openingWord: string;
  ending: "question" | "action" | "statement";
  actions: number;
  words: number;
  /** Action beats found in a reply that has no asterisks at all (the model dropped the format). */
  unmarkedActions: number;
  /** Sentence skeleton such as "A S" (action, then speech); "" when the reply is a single block. */
  skeleton: string;
};

// Physical verbs a character performs in a beat. Deliberately a closed list: this is only used to
// recognise a beat the model forgot to wrap in asterisks, so a miss is harmless and a false hit is not.
const BEAT_VERBS = [
  "laugh", "chuckl", "giggl", "smil", "grin", "smirk", "nod", "shrug", "sigh", "frown", "wink", "blink", "stifl", "exhal", "inhal",
  "lean", "tilt", "tuck", "sip", "glanc", "gaz", "stare", "meet", "hold", "reach", "rest", "cross", "fold", "tap", "drum", "shak",
  "pause", "lift", "rais", "lower", "step", "turn", "walk", "sit", "stand", "press", "brush", "push", "pull", "slid", "wrap", "stir",
  "pour", "rub", "scratch", "bit", "swallow", "squeez", "grab", "pick", "drop", "clos", "open", "cup", "trac", "adjust", "straighten",
  "settl", "gestur", "point", "wav", "shift", "fidget", "twist", "toy", "pat", "hug", "touch", "tap", "wip", "clear", "lick", "purs",
  "arch", "narrow", "widen", "roll", "cock", "duck", "hesitat", "swat", "slip", "set", "run", "take", "look", "watch", "back", "move",
];
const BEAT_IRREGULAR = "ran|sat|stood|took|held|set|bit|slid|shook|met|stole|leant|lit|put";
const BEAT_VERB_RE = `(?:${BEAT_VERBS.map(v => `${v}\\w{0,4}`).join("|")}|${BEAT_IRREGULAR})`;
// "I stifle a laugh", "She finally meets your eyes", "Aria tilts her head" (first or third person).
const BEAT_SENTENCE = new RegExp(`^(?:i|she|he|they)\\s+(?:\\w+ly\\s+)?${BEAT_VERB_RE}\\b`, "i");
// Participle lead-ins: "Smiling without looking up, ..."
const BEAT_PARTICIPLE = /^(?:smiling|laughing|grinning|nodding|shrugging|sighing|leaning|tilting|glancing|shaking|pausing|turning|stepping|looking|watching|tucking|sipping|folding|crossing)\b/i;
const BEAT_NEEDS_OBJECT: [RegExp, RegExp][] = [
  // Ambiguous verbs only count when a body part or object follows.
  [/^(?:i|she|he|they)\s+(?:\w+ly\s+)?(?:run|ran|runs)\b/i, /\b(?:thumb|fingers?|hand|hands|nails?)\b/i],
  [/^(?:i|she|he|they)\s+(?:\w+ly\s+)?(?:take|took|takes)\b/i, /\b(?:sip|breath|step|seat|drink|bite)\b/i],
  [/^(?:i|she|he|they)\s+(?:\w+ly\s+)?(?:look|looks|looked|watch|watches|watched)\b/i, /\b(?:at|up|down|away|over|out|back)\b/i],
  [/^(?:i|she|he|they)\s+(?:\w+ly\s+)?(?:set|sets)\b/i, /\b(?:down|aside)\b/i],
  [/^(?:i|she|he|they)\s+(?:\w+ly\s+)?(?:move|moves|moved|back|backs|backed|point|points|pointed|clear|clears|cleared|close|closes|closed|open|opens|opened)\b/i, /\b(?:my|her|his|their|a|the|your)\b/i],
];

function stripQuoted(text: string): string {
  // Dialogue is not a beat: drop "straight" and “curly” quoted spans before looking for actions.
  return text.replace(/"[^"]*"|“[^”]*”/g, " ");
}

/** Split into sentences, keeping the terminal punctuation on each. */
export function sentencesOf(text: string): string[] {
  return text.replace(/\s+/g, " ").match(/[^.!?？。]+(?:[.!?？。]+["'”’)_*\]]*|$)/gu)?.map(x => x.trim()).filter(Boolean) ?? [];
}

// Idioms that start like a beat but are speech: "I stand corrected", "I turn out to be", "I rest my case".
const NOT_A_BEAT = /^(?:i|she|he|they)\s+(?:\w+ly\s+)?(?:stand\s+(?:by|corrected)|turn\s+out|rest\s+my\s+case|hold\s+(?:on|that|no)|set\s+(?:out|about)|take\s+(?:it|that|care|your)|run\s+(?:a|the|my\s+own)\s+(?:shop|business|company|team))\b/i;

function isPlainBeat(sentence: string, names: string[] = []): boolean {
  let t = sentence.trim().replace(/^[\s"“'‘_(\[]+/u, "");
  // "Rhea leans against the doorframe": a named subject reads like "she leans ..."
  const lead = t.match(/^[\p{L}'’-]+/u)?.[0]?.toLowerCase();
  if (lead && names.includes(lead)) t = `she${t.slice(lead.length)}`;
  if (!t || /^["“]/.test(sentence.trim()) || NOT_A_BEAT.test(t)) return false;
  if (BEAT_PARTICIPLE.test(t)) return true;
  if (!BEAT_SENTENCE.test(t)) return false;
  const gated = BEAT_NEEDS_OBJECT.find(([lead]) => lead.test(t));
  return gated ? gated[1].test(t) : true;
}

/**
 * Action beats in a reply that has no asterisks. Used only when the model has dropped the
 * *action* format: without it every reply reads as "no actions" and the director steers blind.
 */
export function findPlainActionBeats(text: string, characterName = ""): string[] {
  if (/\*/.test(text)) return [];
  const names = nameTokens(characterName);
  return sentencesOf(stripQuoted(text)).filter(x => isPlainBeat(x, names));
}

function nameTokens(characterName: string): string[] {
  return characterName.toLowerCase().split(/\s+/).filter(w => [...w].length >= 2);
}

export function analyzeReply(text: string, characterName = ""): Shape {
  const t = text.trim();
  const names = nameTokens(characterName);
  const isBeat = (sentence: string) => isPlainBeat(sentence, names);
  const narration = splitRoleplayInput(t).filter(s => s.kind === "narration").length;
  const plain = narration ? [] : findPlainActionBeats(t, characterName);
  const sentences = narration ? [] : sentencesOf(stripQuoted(t));
  const firstSentence = sentences[0] ?? "";
  const lastSentence = sentences[sentences.length - 1] ?? "";
  let opening: Shape["opening"] = /^\*/.test(t) ? "action" : "speech";
  if (!narration && firstSentence && isBeat(firstSentence)) opening = "action";
  const openingWord = (t.replace(/^[\s*"“'‘_(\[]+/u, "").match(/^[\p{L}\p{N}]+/u)?.[0] ?? "").toLowerCase();
  let ending: Shape["ending"] = "statement";
  if (/\*$/.test(t) || (!narration && lastSentence && isBeat(lastSentence))) ending = "action";
  else if (/[?？][\s"'”’)_\]]*$/u.test(t)) ending = "question";
  const skeleton = narration
    ? splitRoleplayInput(t).filter(s => s.text.trim()).map(s => (s.kind === "narration" ? "A" : "S")).join(" ")
    : sentences.reduce((acc: string[], sentence) => {
        const kind = isBeat(sentence) ? "A" : "S";
        if (acc[acc.length - 1] !== kind) acc.push(kind);
        return acc;
      }, []).join(" ");
  return { opening, openingWord, ending, actions: narration || plain.length, words: wordCount(t), unmarkedActions: plain.length, skeleton };
}

/** Stock reactions that read as a template when they recur. Matched by form only. */
const STOCK: { label: string; re: RegExp }[] = [
  { label: "smirk", re: /\bsmirk\w*/i },
  { label: "chuckle", re: /\bchuckl\w*/i },
  { label: "shiver", re: /\bshiver\w*|\bshudder\w*/i },
  { label: "blush", re: /\bblush\w*/i },
  { label: "breath hitching", re: /\bbreath\s+(?:hitch\w*|catch\w*|caught)\b|\bcatch\w*\s+(?:her|his|their)\s+breath\b|\bhitch\w*\s+breath\b/i },
  { label: "racing heart", re: /\bheart\s+(?:skip\w*|rac\w*|pound\w*|hammer\w*|flutter\w*|thump\w*|stutter\w*|leap\w*)\b|\b(?:racing|pounding)\s+heart\b/i },
  { label: "sparkling eyes", re: /\beyes\s+(?:sparkl\w*|twinkl\w*|glint\w*|glitter\w*|danc\w*|smolder\w*|darken\w*)\b/i },
  { label: "a mix of", re: /\ba\s+(?:mix|mixture|flicker|flash|glimmer|hint)\s+of\b/i },
  { label: "can't help but", re: /\b(?:can(?:'|’)?t|couldn(?:'|’)?t|cannot)\s+help\s+(?:but|herself|himself|themselves)\b/i },
  { label: "biting a lip", re: /\bbit(?:es?|ing)\s+(?:her|his|their|my)\s+(?:bottom\s+|lower\s+|full\s+)?lip\b/i },
  { label: "hair behind the ear", re: /\b(?:tuck\w*|push\w*|brush\w*)\s+(?:a\s+|the\s+|her\s+|his\s+)?(?:strand|lock|hair)\b[^.!?]{0,30}\bear\b/i },
  { label: "barely a whisper", re: /\b(?:barely|hardly)\s+(?:above\s+)?a\s+whisper\b/i },
  { label: "soft smile", re: /\b(?:soft|gentle|small|faint|slight|warm|shy)\s+smile\b/i },
];

// Function words that must not make an n-gram look like a "stock line".
export const FUNCTION_WORDS = new Set((
  "the a an and or but to of in on at for with from by as is are was were be been it its this that these those i me my you your he she his her they them their we us our " +
  "do does did have has had not no yes so if then than what when where how just very " +
  // common romanized Hindi / Urdu function words
  "main mein tum tumhe tumhara aap hai hain ho tha thi the nahi nahin toh to kya ki ke ka ko se me aur par bhi ab yeh ye woh wo"
).split(/\s+/));

export function normTokens(text: string): string[] {
  // Drop narration markers so "*smiles*" and "smiles" are the same word.
  return text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s'’]/gu, " ").split(/\s+/).filter(Boolean);
}

export function trigrams(tokens: string[], skip: Set<string>): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 < tokens.length; i++) {
    const g = tokens.slice(i, i + 3);
    if (g.some(w => skip.has(w))) continue;
    const content = g.filter(w => !FUNCTION_WORDS.has(w) && [...w].length >= 4);
    if (content.length < 2) continue;
    out.add(g.join(" "));
  }
  return out;
}

// Words too generic to count as "what a question or a line is about".
const WEAK_WORDS = new Set((
  "really still always never something someone anything anyone little again there here about would could should think know like want much more some even also only over into " +
  "back away though because while being going make made thing things with your yours mine tell okay well maybe kind sort"
).split(/\s+/));

function contentWords(text: string, skip: Set<string> = new Set()): string[] {
  return normTokens(text).filter(w => [...w].length >= 4 && !/['\u2019]/.test(w) && !FUNCTION_WORDS.has(w) && !WEAK_WORDS.has(w) && !skip.has(w));
}

/** Cheap stem so "shake", "shaking" and "shakes" count as one thing. */
function stem(word: string): string {
  let w = word.toLowerCase();
  for (const suffix of ["ing", "ed", "es", "s", "ly"]) {
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) { w = w.slice(0, -suffix.length); break; }
  }
  return w.length > 4 ? w.replace(/e$/, "") : w;
}

function spokenText(reply: string): string {
  return splitRoleplayInput(reply).filter(seg => seg.kind === "spoken").map(seg => seg.text).join(" ");
}

function collapseOverlaps(candidates: string[]): string[] {
  const kept: string[] = [];
  for (const g of candidates) {
    // "someone i'd actually" and "i'd actually recognize" are one line, not two.
    const w = g.split(" ");
    const overlaps = kept.some(k => {
      const x = k.split(" ");
      return x.slice(1).join(" ") === w.slice(0, 2).join(" ") || w.slice(1).join(" ") === x.slice(0, 2).join(" ");
    });
    if (!overlaps) kept.push(g);
  }
  return kept;
}

function phraseCounts(replies: string[], skip: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const reply of replies) for (const g of trigrams(normTokens(reply), skip)) counts.set(g, (counts.get(g) ?? 0) + 1);
  return counts;
}

function repeatedPhrases(recent: string[], skip: Set<string>): string[] {
  const out: string[] = [];
  // A line copied across many replies, then a line that came back in two of the newest three
  // (a paraphrase surfaces fast, and the sentence-level repeat cleaner never sees it).
  const wide = recent.slice(-PHRASE_WINDOW);
  if (wide.length >= PHRASE_MIN_REPLIES) {
    out.push(...[...phraseCounts(wide, skip).entries()].filter(([, n]) => n >= PHRASE_MIN_REPLIES).sort((a, b) => b[1] - a[1]).map(([g]) => g));
  }
  const near = recent.slice(-RECENT_PHRASE_WINDOW);
  if (near.length >= RECENT_PHRASE_MIN_REPLIES) {
    out.push(...[...phraseCounts(near, skip).entries()].filter(([, n]) => n >= RECENT_PHRASE_MIN_REPLIES).map(([g]) => g));
  }
  return collapseOverlaps([...new Set(out)]).slice(0, 2);
}

/** Labels of the stock reactions present in one reply (form match only). */
export function stockLabels(text: string): string[] {
  return STOCK.filter(({ re }) => re.test(text)).map(s => s.label);
}

function stockTics(recent: string[]): string[] {
  const window = recent.slice(-TIC_WINDOW);
  if (window.length < TIC_MIN_REPLIES) return [];
  return STOCK.filter(({ re }) => window.filter(r => re.test(r)).length >= TIC_MIN_REPLIES).map(s => s.label).slice(0, 3);
}

// Gestures that are ordinary once and a template when they come back. Kept apart from STOCK so the
// reply metrics (which count STOCK) keep their baseline; "min" is how many recent replies must show it.
const GESTURE_TICS: { label: string; re: RegExp; min: number }[] = [
  { label: "laugh beat", re: /\b(?:laugh|laughs|laughed|laughing|giggl\w*)\b|\bstifl\w*\s+a\s+(?:laugh|smile)\b/i, min: 2 },
  { label: "shake of the head", re: /\bshak(?:e|es|ing)\s+(?:her|his|their|my)\s+head\b|\bshake\s+of\s+(?:her|his|their|my)\s+head\b/i, min: 2 },
  { label: "a beat longer", re: /\ba\s+beat\s+(?:longer|too\s+long)\b|\b(?:linger\w*|hold\w*)\s+(?:for\s+)?(?:a\s+)?(?:beat|moment)\b/i, min: 2 },
  { label: "smile", re: /\bsmil(?:e|es|ed|ing)\b/i, min: 3 },
];

function gestureTics(recent: string[]): string[] {
  const window = recent.slice(-TIC_WINDOW);
  return GESTURE_TICS.filter(({ re, min }) => window.length >= min && window.filter(r => re.test(r)).length >= min).map(g => g.label).slice(0, 2);
}

// Pet adverbs that quietly become a voice tic ("honestly" three times in four replies).
const FILLER_WORDS = ["honestly", "actually", "seriously", "literally", "basically", "frankly", "genuinely", "totally"];

function fillerTics(recent: string[]): string[] {
  const window = recent.slice(-FILLER_WINDOW);
  const out: string[] = [];
  for (const word of FILLER_WORDS) {
    const per = window.map(r => normTokens(r).filter(t => t === word).length);
    if (per.reduce((a, b) => a + b, 0) >= FILLER_MIN_TOTAL && per.filter(n => n > 0).length >= 2) out.push(word);
  }
  return out.slice(0, 2);
}

/** Words that start a sentence in most recent replies ("Means ..."). Contractions and function words never count. */
function starterTics(recent: string[], skip: Set<string>): string[] {
  const window = recent.slice(-STARTER_WINDOW);
  if (window.length < STARTER_MIN_REPLIES) return [];
  const counts = new Map<string, number>();
  for (const reply of window) {
    const seen = new Set<string>();
    for (const sentence of sentencesOf(reply.replace(/\*/g, " "))) {
      const first = normTokens(sentence)[0];
      if (first && [...first].length >= 4 && !/['\u2019]/.test(first) && !FUNCTION_WORDS.has(first) && !skip.has(first)) seen.add(first);
    }
    for (const w of seen) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= STARTER_MIN_REPLIES).map(([w]) => w).slice(0, 2);
}

/** What the first beat of recent replies keeps reaching for (the cup, the hands, a look). */
function openerRepeats(recent: string[], skip: Set<string>): string[] {
  const window = recent.slice(-OPENER_WINDOW);
  if (window.length < 2) return [];
  const byStem = new Map<string, { word: string; n: number }>();
  for (const reply of window) {
    const opener = sentencesOf(reply.replace(/\*/g, " "))[0] ?? "";
    const seenHere = new Set<string>();
    for (const w of contentWords(opener, skip)) {
      const key = stem(w);
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      const entry = byStem.get(key);
      if (entry) entry.n++; else byStem.set(key, { word: w, n: 1 });
    }
  }
  return [...byStem.values()].filter(e => e.n >= 2).map(e => e.word).slice(0, 3);
}

/**
 * A question the character keeps asking that the user has not answered ("are you just passing
 * through?" in two replies). Returns the shared topic words, or [] when there is none.
 */
function repeatedQuestion(turns: Turn[], skip: Set<string>): string[] {
  const asked: { at: number; words: Map<string, string>[] }[] = [];
  const assistantIdx = turns.map((t, i) => (t.role === "assistant" && t.content.trim() ? i : -1)).filter(i => i >= 0).slice(-QUESTION_WINDOW);
  for (const at of assistantIdx) {
    const qs = sentencesOf(spokenText(turns[at].content))
      .filter(x => /[?？]["'”’)_\]]*$/u.test(x))
      .map(x => new Map(contentWords(x, skip).map(w => [stem(w), w] as [string, string])));
    if (qs.length) asked.push({ at, words: qs });
  }
  for (let a = 0; a < asked.length; a++) {
    for (let b = a + 1; b < asked.length; b++) {
      for (const qa of asked[a].words) for (const qb of asked[b].words) {
        const shared = [...qa.keys()].filter(k => qb.has(k));
        if (shared.length < 2 || shared.length / Math.min(qa.size, qb.size) < 0.4) continue;
        // Answered if the user has since said any of the topic words.
        const userWords = new Set(turns.slice(asked[a].at + 1).filter(t => t.role === "user").flatMap(t => normTokens(t.content).map(stem)));
        if (shared.some(k => userWords.has(k))) continue;
        return shared.slice(0, 3).map(k => qa.get(k) ?? k);
      }
    }
  }
  return [];
}

// Specific shared history the character asserts ("you used to beg me", "when you were six", "the last time we met").
const PAST_CLAIMS: RegExp[] = [
  /\bwhen\s+(?:you|we)\s+were\s+(?:what,?\s+|only\s+|just\s+|about\s+|barely\s+)?(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|little|small|tiny|young|a\s+(?:kid|child|teen|teenager|boy|girl)|in\s+(?:school|college|class))\b/i,
  /\byou\s+(?:used\s+to|would\s+always|always\s+used\s+to)\s+\w+|\byou'd\s+always\s+\w+/i,
  /\b(?:last|first)\s+time\s+(?:i|we)\s+(?:saw|met|talked|spoke|were\s+together)\b/i,
  /\blast\s+(?:saw|seen)\s+you\b/i,
  /\bremember\s+(?:when|that\s+time|the\s+time|how\s+you)\b/i,
  /\bback\s+(?:when\s+(?:you|we)|in\s+the\s+day)\b/i,
];

const NUMBER_WORDS = new Set("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" "));

/**
 * True when a recent reply states a specific past event the persona and the chat never
 * established. Support is looked up by words: a claim whose details the persona text or the
 * user's own messages already contain is left alone.
 */
function inventedPast(recent: string[], known: Set<string>): boolean {
  for (const reply of recent.slice(-PAST_CLAIM_WINDOW)) {
    for (const sentence of sentencesOf(reply.replace(/\*/g, " ").replace(/\u2019/g, "'"))) {
      if (!PAST_CLAIMS.some(re => re.test(sentence))) continue;
      if (normTokens(sentence).some(w => (/^\d{1,2}$/.test(w) || NUMBER_WORDS.has(w)) && !known.has(stem(w)))) return true;
      const tokens = normTokens(sentence).filter(w => [...w].length >= 3 && !/'/.test(w) && !FUNCTION_WORDS.has(w) && !WEAK_WORDS.has(w));
      const supported = tokens.filter(w => known.has(stem(w))).length;
      if (!tokens.length || supported / tokens.length < 0.5) return true;
    }
  }
  return false;
}

/**
 * The character deciding what the USER's body does or feels ("you shiver, your
 * heart racing"). Looked for only inside the character's own narration, and
 * only for involuntary sensations or user actions, so observable detail such
 * as "your breath fogs in the cold" is not flagged.
 */
const USER_BODY_NARRATION =
  /\byou(?:'ve|\s+have)?\s+(?:feel|felt|feeling|shiver\w*|shudder\w*|tremble\w*|blush\w*|gasp\w*|moan\w*|whimper\w*|melt\w*|freeze|froze)\b|\byour\s+(?:heart|pulse|stomach|knees|spine|legs|mind)\b/i;

function narratesUser(reply: string): boolean {
  return splitRoleplayInput(reply).some(s => s.kind === "narration" && USER_BODY_NARRATION.test(s.text));
}

function quoted(items: string[]): string {
  return items.map(item => JSON.stringify(item.slice(0, 40))).join(", ");
}

export type TurnDirectorInput = {
  /** Conversation so far, oldest first. Roles other than user/assistant are ignored. */
  history: Turn[];
  latestUserText: string;
  /** Character name tokens are excluded from the repeated-phrase check. */
  characterName?: string;
  /**
   * Everything the persona and the saved memory already establish (backstory, tagline, greeting,
   * memory summary). A past event the character states that is not in here, and not in the
   * user's own messages, counts as invented.
   */
  knownFacts?: string;
  /** When set, the reply is driven by a scene steer rather than a user turn. */
  sceneDirective?: string;
  /**
   * Treatment arm: tell the model a light, brief user turn can get a compact
   * reply. Off by default. The only real-user retention evidence found longer
   * replies retain better, so shortening is a hypothesis to test.
   */
  adaptiveRhythm?: boolean;
  /**
   * Treatment arm: cap action beats after three action-heavy replies. Off by
   * default for the same reason: non-verbal description correlated with
   * retention, so limiting it is a hypothesis to test.
   */
  actionCap?: boolean;
};

export type Steer = { id: string; text: string };

const CLARIFY = /^\s*(?:what\s+(?:do\s+you|does\s+that|did\s+you)\s+mean|what(?:'s|\u2019s|\s+is|\s+was)\s+that\s+supposed\s+to\s+mean|wdym|huh|how\s+so|in\s+what\s+way)\b/i;
const QUESTION_LEAD = /^\s*(?:what|why|how|who|where|when|which|do|does|did|are|is|am|can|could|would|will|should|have|has)\b/i;

/**
 * The steers for this turn, each with a stable id so they can be counted in
 * telemetry. Returns [] on a healthy conversation.
 */
export function planTurnSteers(input: TurnDirectorInput): Steer[] {
  const turns = input.history.filter(m => m.role === "user" || m.role === "assistant");
  const last = turns[turns.length - 1];
  const assistant = turns.filter(m => m.role === "assistant").map(m => m.content).filter(c => c.trim());
  const steer: Steer[] = [];
  const add = (id: string, text: string) => steer.push({ id, text });

  const shapes = assistant.slice(-SHAPE_WINDOW).map(r => analyzeReply(r, input.characterName));
  if (shapes.length >= QUESTION_RUN) {
    if (shapes.slice(-QUESTION_RUN).every(s => s.ending === "question")) {
      add("question_run", "Close on an action, a line that lands, or a change in the scene. The last two replies both ended on a question.");
    }
  }
  if (shapes.length === SHAPE_WINDOW) {
    // Only runs of the same habit are steered. A run of speech openings is
    // never pushed toward actions by itself.
    const meanWords = shapes.reduce((sum, x) => sum + x.words, 0) / shapes.length;
    const uniform = meanWords > 0 && Math.max(...shapes.map(x => x.words)) - Math.min(...shapes.map(x => x.words)) <= meanWords * 0.15;
    const openedOnAction = shapes.every(x => x.opening === "action");
    if (openedOnAction && uniform) {
      // One template, not just one habit: the same action-first layout at nearly the same length.
      add("structure_run", "Open with the character's spoken words, or let the action land mid-reply or last. The last three replies all had the same layout: an action line first, then a block of speech of nearly the same length.");
    } else if (openedOnAction) {
      add("open_action_run", "Open with the character's spoken words; the last three replies all opened with an action.");
    }
    if (!(openedOnAction && uniform) && shapes[0].openingWord && shapes.every(s => s.openingWord === shapes[0].openingWord)) {
      add("first_word", `Start with a different first word than ${JSON.stringify(shapes[0].openingWord)}.`);
    }
    if (input.actionCap && shapes.every(s => s.actions >= 2)) {
      add("action_cap", "Use at most one action beat and let speech carry the turn; the last three replies were action-heavy.");
    } else if (shapes.every(s => s.actions === 0)) {
      // Non-verbal description (actions, expressions, the setting) is the
      // factor most consistently tied to retention after reply length.
      add("no_actions", "Ground this reply with one brief physical or scene beat; the last three replies had none.");
    }
  }
  // The model dropped the *action* format: beats are there but unmarked, so the client shows them as speech.
  const lastTwo = assistant.slice(-2).map(r => analyzeReply(r, input.characterName));
  if (lastTwo.length === 2 && lastTwo.every(x => x.unmarkedActions >= 1)) {
    add("format_actions", "Put each physical action beat between *asterisks*, for example *I tuck a strand of hair behind my ear*, and keep spoken words plain. The last replies wrote their actions without asterisks.");
  }
  if (assistant.slice(-2).some(narratesUser)) {
    add("agency", "Leave the user's body, feelings and reactions to the user; show only what the character does, says and can see.");
  }

  const skip = new Set(normTokens(input.characterName ?? ""));
  const retire = [...stockTics(assistant), ...gestureTics(assistant), ...fillerTics(assistant), ...repeatedPhrases(assistant, skip)].slice(0, 5);
  if (retire.length) add("retire", `Retire for now (used too often): ${quoted(retire)}. Use something specific to this moment instead.`);

  const starters = starterTics(assistant, skip);
  if (starters.length) add("starter_tic", `Stop starting sentences with ${quoted(starters)}; it has opened a sentence in most of the last replies.`);
  const openers = openerRepeats(assistant, skip);
  if (openers.length) add("opener_repeat", `Do not open on ${quoted(openers)} again; recent openings kept returning to it. Begin from a different beat.`);
  const asked = repeatedQuestion(turns, skip);
  if (asked.length) add("repeated_question", `You have already asked about ${quoted(asked)} more than once. Do not ask it again unless the user's last turn leaves it open; respond to what they just said.`);

  // Invented shared history. Support = the persona/memory text plus everything the user has said.
  const knownText = `${input.knownFacts ?? ""} ${turns.filter(m => m.role === "user").map(m => m.content).join(" ")}`;
  const knownStems = new Set(normTokens(knownText).map(stem));
  if (inventedPast(assistant, knownStems)) {
    add("invented_past", "Recent replies stated specific shared history (ages, habits, things said or done) that the persona and the chat never established. Do not add more; keep the shared past vague, or let the user supply the details.");
  }

  if (last?.role === "user" && !input.sceneDirective?.trim()) {
    const spoken = spokenText(input.latestUserText ?? "").trim();
    const spokenWords = wordCount(spoken);
    if (spoken && spokenWords <= CLARIFY_MAX_WORDS && CLARIFY.test(spoken)) {
      // The user is asking what the last line meant: restating it in new words is the failure.
      add("clarify", "The user is asking what your last line meant. Say plainly what you meant, in character, in the first line or two; do not restate it in new words or change the subject.");
    } else if (spoken && spokenWords <= DIRECT_QUESTION_MAX_WORDS && (/[?？]["'”’)_\]]*$/u.test(spoken) || QUESTION_LEAD.test(spoken))
      && analyzeReply(assistant[assistant.length - 1] ?? "", input.characterName).ending === "question") {
      // They answered a question with a question: answer it instead of asking another.
      add("direct_question", "The user asked a direct question. Answer it plainly in the first line or two, in character, before anything else; do not deflect or answer with another question.");
    }
    const beat = classifyUserBeat(input.latestUserText);
    if (beat === "rapid" && input.adaptiveRhythm) {
      add("brief_beat", "The user\u2019s turn is brief. If it is light (a greeting, an acknowledgement, banter) a compact reply fits and needs no padding; if it carries feeling, news or a decision, answer it fully.");
    } else if (beat === "weighty") {
      add("weighty_beat", "This turn carries weight: give it the full range, and show the reaction through what the character does as well as says.");
    }
  }
  return steer;
}

/** The steers as a prompt block ("" when there are none), ready to append next to the other per-turn guards. */
export function formatTurnSteers(steers: Steer[]): string {
  if (!steers.length) return "";
  return `\n\nTURN DIRECTOR (apply silently, this turn only)\n- ${steers.map(s => s.text).join("\n- ")}`;
}

/**
 * Returns "" or a short block that starts with a blank line, ready to append
 * to the system prompt next to the other per-turn guards.
 */
export function buildTurnDirective(input: TurnDirectorInput): string {
  return formatTurnSteers(planTurnSteers(input));
}
