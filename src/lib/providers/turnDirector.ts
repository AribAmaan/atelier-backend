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
};

export function analyzeReply(text: string): Shape {
  const t = text.trim();
  const opening: Shape["opening"] = /^\*/.test(t) ? "action" : "speech";
  const openingWord = (t.replace(/^[\s*"“'‘_(\[]+/u, "").match(/^[\p{L}\p{N}]+/u)?.[0] ?? "").toLowerCase();
  let ending: Shape["ending"] = "statement";
  if (/\*$/.test(t)) ending = "action";
  else if (/[?？][\s"'”’)_\]]*$/u.test(t)) ending = "question";
  const actions = splitRoleplayInput(t).filter(s => s.kind === "narration").length;
  return { opening, openingWord, ending, actions, words: wordCount(t) };
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

function repeatedPhrases(recent: string[], skip: Set<string>): string[] {
  const window = recent.slice(-PHRASE_WINDOW);
  if (window.length < PHRASE_MIN_REPLIES) return [];
  const counts = new Map<string, number>();
  for (const reply of window) {
    for (const g of trigrams(normTokens(reply), skip)) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= PHRASE_MIN_REPLIES).sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 2);
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

  const shapes = assistant.slice(-SHAPE_WINDOW).map(analyzeReply);
  if (shapes.length >= QUESTION_RUN) {
    if (shapes.slice(-QUESTION_RUN).every(s => s.ending === "question")) {
      add("question_run", "Close on an action, a line that lands, or a change in the scene. The last two replies both ended on a question.");
    }
  }
  if (shapes.length === SHAPE_WINDOW) {
    // Only runs of the same habit are steered. A run of speech openings is
    // never pushed toward actions by itself.
    if (shapes.every(s => s.opening === "action")) {
      add("open_action_run", "Open with the character's spoken words; the last three replies all opened with an action.");
    }
    if (shapes[0].openingWord && shapes.every(s => s.openingWord === shapes[0].openingWord)) {
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
  if (assistant.slice(-2).some(narratesUser)) {
    add("agency", "Leave the user's body, feelings and reactions to the user; show only what the character does, says and can see.");
  }

  const skip = new Set(normTokens(input.characterName ?? ""));
  const retire = [...stockTics(assistant), ...repeatedPhrases(assistant, skip)].slice(0, 4);
  if (retire.length) add("retire", `Retire for now (used too often): ${quoted(retire)}. Use something specific to this moment instead.`);

  if (last?.role === "user" && !input.sceneDirective?.trim()) {
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
