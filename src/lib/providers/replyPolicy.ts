
function envTokens(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 64 ? Math.min(n, 4096) : def;
}

/** Per-tier generation ceiling only; see planReply. Strawberry/manual = free tier, Choco Hazelnut = plus. */
export function replyProfile(intelligence: number) {
  if (intelligence <= 7) return { name: intelligence <= 5 ? "Balanced" : "Strawberry", tokens: envTokens("REPLY_MAX_TOKENS_FREE", 700) };
  return { name: "Choco Hazelnut", tokens: envTokens("REPLY_MAX_TOKENS_PLUS", 1000) };
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

/**
 * Server-side generation budget. No length is requested from the model and no
 * word ceiling or floor is enforced: the model decides how long a reply should
 * be. The token ceiling is only a runaway guard (and a cost control), sized so
 * a normal reply never reaches it. Override with REPLY_MAX_TOKENS_FREE /
 * REPLY_MAX_TOKENS_PLUS.
 */
export function planReply() {
  return {
    mode: "open" as const,
    continuationMaxTokens: 400,
  };
}
