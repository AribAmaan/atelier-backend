/**
 * Reply length and quality are engine properties, not user-message properties.
 * A one-word greeting, long narration, action-only turn, or a request to be
 * "short"/"detailed" must not collapse or inflate the selected tier.
 *
 * The word bands below are intentionally narrow enough to make engines feel
 * consistent while leaving a little room to finish a sentence naturally.
 */
export function replyProfile(intelligence: number) {
  if (intelligence <= 3) return {
    name: "Vanilla",
    purpose: "quick, direct dialogue",
    ordinaryWords: 35,
    minWords: 25,
    maxWords: 45,
    tokens: 128,
    detailedTokens: 128,
  };
  if (intelligence <= 5) return {
    name: "Balanced",
    purpose: "natural conversation",
    ordinaryWords: 50,
    minWords: 40,
    maxWords: 60,
    tokens: 144,
    detailedTokens: 144,
  };
  if (intelligence <= 7) return {
    name: "Strawberry",
    purpose: "attentive conversation with a relevant reaction",
    ordinaryWords: 60,
    minWords: 50,
    maxWords: 70,
    // 104 tokens was too close to the 70-word ceiling for punctuation-heavy
    // roleplay text and could end with finish_reason=length mid-sentence.
    // 144 still keeps Strawberry materially cheaper than Chocolate while
    // leaving enough room for a natural stop inside its 50–70 word envelope.
    tokens: 144,
    detailedTokens: 144,
  };
  if (intelligence <= 8.5) return {
    name: "Chocolate",
    purpose: "grounded atmosphere and emotional follow-through",
    ordinaryWords: 100,
    minWords: 85,
    maxWords: 110,
    tokens: 224,
    detailedTokens: 224,
  };
  return {
    name: "Hazelnut",
    purpose: "precise character voice, subtext, continuity, and confident initiative",
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

export function buildReplyGuidance(intelligence: number): string {
  const p = replyProfile(intelligence);
  return `TIER-LOCKED REPLY ENVELOPE — ${p.name}: ${p.purpose}. Aim for around ${p.ordinaryWords} words, normally ${p.minWords}–${p.maxWords} words; ${p.maxWords} is the hard ceiling. These limits stay stable regardless of whether the latest user message is brief, long, narration, or requests another length. Answer its actual point and develop one coherent character beat to this tier's depth. Every sentence must contribute: a relevant response, choice, consequence, or useful detail. Do not pad with repeated emotions, gestures, recaps, or automatic questions. Start wrapping up before the ceiling; finish the current sentence instead of opening a new thread. Keep natural dialogue and character-specific initiative inside this length. Do not imitate earlier reply lengths or another engine.`;
}

/**
 * The planner is deliberately input-invariant. It keeps the existing call
 * signature because chat.ts passes the latest turn and scene directive, but
 * those values must never change a named engine's length/quality budget.
 */
export function planReply(intelligence: number, _latestUserText: string, _sceneDirective = "") {
  const p = replyProfile(intelligence);
  return {
    mode: "tier" as const,
    maxTokens: p.tokens,
    continuationMaxTokens: p.name === "Vanilla" ? 96 : p.name === "Strawberry" ? 128 : 160,
    // Sentence-aware streaming uses the same boundaries as the final cap.
    preserveStreamedLength: false,
    targetWords: p.ordinaryWords,
    minWords: p.minWords,
    maxWords: p.maxWords,
    instruction: buildReplyGuidance(intelligence),
  };
}
