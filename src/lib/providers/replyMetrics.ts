import { FUNCTION_WORDS, analyzeReply, normTokens, stockLabels, trigrams } from "./turnDirector";

/**
 * Deterministic reply metrics: no model, no network, no message content kept.
 *
 * They exist so that claims about roleplay quality can be checked rather than
 * assumed. Each one is tied to a finding or a failure mode:
 *  - words / actionRate     reply length and non-verbal description, the two
 *                           factors the real-user retention study tied to
 *                           retention.
 *  - assistantismRate       drift toward generic assistant behaviour, which
 *                           long-dialogue persona studies report as the
 *                           failure mode.
 *  - ticRate / repeat*      stock gestures and repeated lines.
 *  - questionEndRate        the "hand every turn back" habit.
 *
 * repeatAdjacentRate is a cheap lexical proxy (word-set overlap of adjacent
 * replies). The study it echoes used embedding similarity, so absolute values
 * are not comparable to that paper; compare arms and time windows to each
 * other, not to published numbers.
 */

/** Phrases a character in a scene would not say; a rise over time suggests drift to a default assistant voice. */
export const ASSISTANTISMS: RegExp[] = [
  /\bas an ai\b/i,
  /\b(?:language model|virtual assistant)\b/i,
  /\bi(?:'m|\s+am)\s+here\s+to\s+(?:help|assist|support)\b/i,
  /\bhow\s+(?:can|may)\s+i\s+(?:help|assist)\b/i,
  /\bis\s+there\s+anything\s+else\b/i,
  /\bfeel\s+free\s+to\b/i,
  /\bi\s+(?:apologi[sz]e|understand\s+your\s+(?:concern|frustration))\b/i,
  /\bit(?:'s|\s+is)\s+important\s+to\s+(?:remember|note|acknowledge)\b/i,
  /\bsafe\s+(?:space|environment)\b/i,
];

export type ReplyMeasure = {
  words: number;
  actions: number;
  endsQuestion: boolean;
  opensAction: boolean;
  assistantisms: number;
  tics: number;
};

export function measureReply(text: string): ReplyMeasure {
  const shape = analyzeReply(text);
  return {
    words: shape.words,
    actions: shape.actions,
    endsQuestion: shape.ending === "question",
    opensAction: shape.opening === "action",
    assistantisms: ASSISTANTISMS.filter(re => re.test(text)).length,
    tics: stockLabels(text).length,
  };
}

export type TranscriptMeasure = {
  replies: number;
  meanWords: number;
  actionRate: number;
  questionEndRate: number;
  assistantismRate: number;
  ticRate: number;
  repeatAdjacentRate: number;
  repeatedPhraseRate: number;
  openingDiversity: number;
};

const rate = (n: number, d: number) => (d ? n / d : 0);

function contentSet(text: string): Set<string> {
  return new Set(normTokens(text).filter(w => !FUNCTION_WORDS.has(w) && [...w].length >= 3));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export const ADJACENT_REPEAT_THRESHOLD = 0.6;

export function measureTranscript(replies: string[], characterName = ""): TranscriptMeasure {
  const clean = replies.filter(r => r.trim());
  const measures = clean.map(measureReply);
  const n = clean.length;
  const skip = new Set(normTokens(characterName));

  let adjacent = 0;
  for (let i = 1; i < n; i++) {
    if (jaccard(contentSet(clean[i - 1]), contentSet(clean[i])) >= ADJACENT_REPEAT_THRESHOLD) adjacent++;
  }

  let repeatedPhrase = 0;
  const grams = clean.map(r => trigrams(normTokens(r), skip));
  for (let i = 1; i < n; i++) {
    const earlier = new Set<string>();
    const counts = new Map<string, number>();
    for (let j = Math.max(0, i - 4); j < i; j++) for (const g of grams[j]) counts.set(g, (counts.get(g) ?? 0) + 1);
    for (const [g, c] of counts) if (c >= 2) earlier.add(g);
    if ([...grams[i]].some(g => earlier.has(g))) repeatedPhrase++;
  }

  const openings = new Set(clean.map(r => analyzeReply(r).openingWord).filter(Boolean));
  return {
    replies: n,
    meanWords: rate(measures.reduce((a, m) => a + m.words, 0), n),
    actionRate: rate(measures.filter(m => m.actions > 0).length, n),
    questionEndRate: rate(measures.filter(m => m.endsQuestion).length, n),
    assistantismRate: rate(measures.filter(m => m.assistantisms > 0).length, n),
    ticRate: rate(measures.filter(m => m.tics > 0).length, n),
    repeatAdjacentRate: rate(adjacent, Math.max(0, n - 1)),
    repeatedPhraseRate: rate(repeatedPhrase, Math.max(0, n - 1)),
    openingDiversity: rate(openings.size, n),
  };
}

export type DriftReport = {
  windowSize: number;
  early: TranscriptMeasure;
  late: TranscriptMeasure;
  /** late minus early; positive assistantism / repetition deltas are the drift signal. */
  delta: Record<Exclude<keyof TranscriptMeasure, "replies">, number>;
};

/** Compares the first and last `windowSize` replies. Needs at least 6 replies. */
export function driftReport(replies: string[], characterName = "", windowSize?: number): DriftReport | null {
  const clean = replies.filter(r => r.trim());
  if (clean.length < 6) return null;
  const w = Math.max(3, Math.min(windowSize ?? Math.floor(clean.length / 2), Math.floor(clean.length / 2)));
  const early = measureTranscript(clean.slice(0, w), characterName);
  const late = measureTranscript(clean.slice(-w), characterName);
  const delta = {} as DriftReport["delta"];
  for (const key of Object.keys(early) as (keyof TranscriptMeasure)[]) {
    if (key === "replies") continue;
    delta[key] = late[key] - early[key];
  }
  return { windowSize: w, early, late, delta };
}
