import { classifyUserBeat, type UserBeat } from "./turnDirector";
import { flagEnabled } from "../roleplayFlags";

/**
 * Reply length and quality are engine properties first and user-message
 * properties only at the margin. The tier's CEILING, token budget and quality
 * never move: a greeting, long narration, an action-only turn, or a request to
 * be "short"/"detailed" cannot inflate or downgrade the selected tier.
 *
 * One experiment arm (ADAPTIVE_REPLY_RHYTHM, OFF by default; "on" or
 * "split:N" enables it, see roleplayFlags.ts): when the user's turn is a brief
 * beat of a few words, the tier's word FLOOR and aim relax to ~60% / ~80% so a
 * "hi" is not padded to a full paragraph. It is off by default because the
 * only real-user retention study found longer replies retain better, so
 * shortening a reply is a hypothesis to measure, not a default. Weighty and
 * ordinary turns always keep the full tier envelope.
 */
export function replyProfile(intelligence: number) {
  // Manual (no engine selected) mode runs at intelligence 5.
  if (intelligence <= 5) return {
    name: "Balanced",
    purpose: "natural conversation",
    ordinaryWords: 50,
    minWords: 40,
    maxWords: 60,
    tokens: 144,
    detailedTokens: 144,
  };
  // Strawberry (free engine).
  if (intelligence <= 7) return {
    name: "Strawberry",
    purpose: "attentive conversation with a relevant reaction",
    ordinaryWords: 60,
    minWords: 50,
    maxWords: 70,
    // 104 tokens was too close to the 70-word ceiling for punctuation-heavy
    // roleplay text and could end with finish_reason=length mid-sentence.
    tokens: 144,
    detailedTokens: 144,
  };
  // Choco Hazelnut (premium engine). Keeps Hazelnut's envelope, the larger of
  // the two engines it combines, so Chocolate's depth is not narrowed.
  return {
    name: "Choco Hazelnut",
    purpose: "grounded scene presence, emotional follow-through, precise character voice, subtext, continuity, and confident initiative",
    ordinaryWords: 120,
    minWords: 105,
    maxWords: 130,
    tokens: 256,
    detailedTokens: 256,
  };
}


/** Sentence boundaries shared by streaming and final word-cap reconciliation. */
export function replySentenceEnds(text: string, final = false): number[] {
  const ends: number[] = [];
  const pattern = /[.!?。！？।॥]+["'”’)*_\]]*(?=\s|$)/gu;
  for (const match of text.matchAll(pattern)) {
    const end = (match.index ?? 0) + match[0].length;
    // A punctuation-only chunk may still be followed by a quote, a decimal
    // digit, or another part of the same word. Wait for the next separator.
    if (!final && end === text.length) continue;
    const prefix = text.slice(0, end);
    if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\.$/i.test(prefix) || /\b[A-Z]\.$/.test(prefix)) continue;
    if (!formatClosers(prefix)) ends.push(end);
  }
  return ends;
}

/** Only close paired reply formatting, never rewrite its content. */
function formatClosers(text: string): string {
  const stack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "*" || ch === '"') {
      if (stack[stack.length - 1] === ch) stack.pop(); else stack.push(ch);
    } else if (ch === "“") stack.push("”");
    else if (ch === "”" && stack[stack.length - 1] === ch) stack.pop();
  }
  return stack.reverse().join("");
}

/** Prefer a complete sentence inside the hard tier ceiling. */
export function clampReplyToWordCeiling(text: string, maxWords: number, minWords = 0): string {
  const clean = text.trim();
  if (!clean || maxWords <= 0) return clean;

  const words = [...clean.matchAll(/\S+/g)];
  // Preserve the provider text byte-for-byte when it is already inside the
  // ceiling. This matters while streaming: trimming harmless trailing space
  // here can make a later continuation emit an extra separator.
  if (words.length <= maxWords) return text;

  const hard = words[maxWords - 1];
  const hardEnd = (hard.index ?? 0) + hard[0].length;
  const prefix = clean.slice(0, hardEnd);

  // Avoid collapsing a premium reply too far below its own minimum merely
  // because an early sentence happens to end well before the tier ceiling.
  const floorWord = Math.min(maxWords - 1, Math.max(0, Math.min(minWords, maxWords) - 1));
  const floor = words[floorWord];
  const floorEnd = floor ? (floor.index ?? 0) + floor[0].length : Math.floor(hardEnd * 0.7);

  let boundary = -1;
  let lastCompleteBoundary = -1;
  for (const end of replySentenceEnds(prefix, true)) {
    lastCompleteBoundary = end;
    if (end >= floorEnd) boundary = end;
  }
  if (boundary > 0) return prefix.slice(0, boundary).trim();

  // Completeness beats mechanically hitting the tier minimum. If the model
  // started another long sentence that crosses the hard ceiling, keep the
  // last complete sentence even when it is a little below minWords; the
  // same-provider depth top-up can then add a fresh complete beat.
  if (lastCompleteBoundary > 0) return prefix.slice(0, lastCompleteBoundary).trim();

  // Last resort for one extremely long unpunctuated sentence: stay inside
  // the hard ceiling and terminate it cleanly rather than returning an
  // ellipsis that looks like a provider cutoff.
  const clipped = prefix.replace(/[\s,;:—-]+$/g, '').trim();
  const closed = formatClosers(clipped);
  return (/[.!?。！？।॥][\"'”’)*_\]]*$/.test(clipped) ? clipped : clipped + '.') + closed;
}

/** Rapid-beat relaxation. Exposed for tests and the guidance text. */
const RAPID_FLOOR = 0.6;
const RAPID_AIM = 0.8;

/** The no-user control value of the adaptive-rhythm flag (default off; see roleplayFlags.ts). */
export function adaptiveRhythmEnabled(): boolean {
  return flagEnabled("adaptiveRhythm");
}

export function buildReplyGuidance(intelligence: number, beat: UserBeat = "normal", adaptive: boolean = adaptiveRhythmEnabled()): string {
  const p = replyProfile(intelligence);
  const rapid = beat === "rapid" && adaptive;
  const aim = rapid ? Math.round(p.ordinaryWords * RAPID_AIM) : p.ordinaryWords;
  const floor = rapid ? Math.max(20, Math.round(p.minWords * RAPID_FLOOR)) : p.minWords;
  const size = rapid
    ? `The user's turn is brief. If it is light (a greeting, an acknowledgement, banter), a compact reply of about ${aim} words (${floor}\u2013${p.maxWords}) is natural; if it carries feeling, news or a decision, use the fuller ${p.minWords}\u2013${p.maxWords}.`
    : `Aim for around ${aim} words, normally ${floor}\u2013${p.maxWords} words.`;
  return `TIER-LOCKED REPLY ENVELOPE \u2014 ${p.name}: ${p.purpose}. ${size} ${p.maxWords} is the hard ceiling and it does not change with the length or format of the user's message. The engine's quality does not drop for a brief, long, narration-only or action-only turn. Develop one coherent character beat to this tier's depth. Every sentence must contribute: a relevant response, choice, consequence, or useful detail. Do not pad with repeated emotions, gestures, recaps, or automatic questions. Start wrapping up before the ceiling; finish the current sentence instead of opening a new thread. Do not imitate earlier reply lengths.`;
}

/**
 * Ceiling and token budget are input-invariant. Only the floor/aim relax, and
 * only for a quick user beat (see the header comment). A scene steer from the
 * quick-action chips always gets the normal envelope.
 */
export function planReply(intelligence: number, latestUserText: string, sceneDirective = "", opts: { adaptiveRhythm?: boolean } = {}) {
  const p = replyProfile(intelligence);
  const beat: UserBeat = sceneDirective.trim() ? "normal" : classifyUserBeat(latestUserText);
  const adaptive = opts.adaptiveRhythm ?? adaptiveRhythmEnabled();
  const rapid = beat === "rapid" && adaptive;
  const minWords = rapid ? Math.max(20, Math.round(p.minWords * RAPID_FLOOR)) : p.minWords;
  return {
    mode: "tier" as const,
    beat,
    maxTokens: p.tokens,
    continuationMaxTokens: p.name === "Strawberry" ? 128 : 160,
    // Sentence-aware streaming uses the same boundaries as the final cap.
    preserveStreamedLength: false,
    targetWords: rapid ? Math.max(minWords, Math.round(p.ordinaryWords * RAPID_AIM)) : p.ordinaryWords,
    minWords,
    maxWords: p.maxWords,
    instruction: buildReplyGuidance(intelligence, beat, adaptive),
  };
}
