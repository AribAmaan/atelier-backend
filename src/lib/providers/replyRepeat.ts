import { replySentenceEnds } from "./replyPolicy";

/**
 * Deterministic repetition guard for character replies.
 *
 * Why it exists: models (especially small/quantized fallbacks) loop. Three
 * shapes were seen in production chats:
 *   1. A continuation/top-up call RESTARTS the reply instead of continuing it,
 *      so the opening sentences appear twice in one message.
 *   2. The same sentence recurs inside one reply ("Main tumhe kabhi jaane nahi
 *      dungi..." twice).
 *   3. A stock line from an earlier reply is repeated verbatim in the next one.
 * No extra model call is made; sentences are compared after normalisation.
 */

/** Words in a normalised sentence. Unicode-aware so Devanagari etc. work. */
function tokens(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

type Piece = { text: string; key: string; tokens: string[] };

/** Split into pieces that concatenate back to the exact original text. */
function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let start = 0;
  for (const end of replySentenceEnds(text, true)) {
    if (end <= start) continue;
    const raw = text.slice(start, end);
    const t = tokens(raw);
    out.push({ text: raw, key: t.join(" "), tokens: t });
    start = end;
  }
  if (start < text.length) {
    const raw = text.slice(start);
    const t = tokens(raw);
    out.push({ text: raw, key: t.join(" "), tokens: t });
  }
  return out;
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a), sb = new Set(b);
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / (sa.size + sb.size - shared || 1);
}

/** Same sentence, ignoring case/punctuation, or an almost identical rewording. */
function sameSentence(a: Piece, b: Piece, minTokens: number): boolean {
  if (a.tokens.length < minTokens || b.tokens.length < minTokens) return false;
  if (a.key === b.key) return true;
  return Math.min(a.tokens.length, b.tokens.length) >= 6 && jaccard(a.tokens, b.tokens) >= 0.85;
}

export type RepeatOptions = {
  /** Shortest sentence (in words) that counts as a repeat inside the reply. */
  minWordsWithin?: number;
  /** Shortest sentence (in words) that counts as a repeat of an earlier reply. */
  minWordsAcross?: number;
  /** Trim the result (default). Disable for continuation suffixes whose leading space matters. */
  trim?: boolean;
  /** Return "" when every sentence was a repeat (continuations) instead of keeping the original. */
  allowEmpty?: boolean;
};

/**
 * Remove sentences that repeat earlier text. `prior` are earlier assistant
 * replies (or the already-visible start of this reply). Sentences shorter than
 * the thresholds ("Meri.", "Fine, English.") are normally kept, because short
 * dialogue legitimately recurs. They are dropped only when they sit INSIDE a
 * repeated run: directly after a removed repeat, or directly before one, in the
 * same order as the earlier copy. That removes whole restarted replies cleanly.
 * Unless `allowEmpty` is set, never returns an empty string for a non-empty input.
 */
export function dropRepeatedSentences(text: string, prior: string[] = [], opts: RepeatOptions = {}): string {
  const within = opts.minWordsWithin ?? 4;
  const across = opts.minWordsAcross ?? 5;
  const trim = opts.trim ?? true;
  if (!text.trim()) return text;

  type Entry = { piece: Piece; min: number };
  const history: Entry[] = prior.flatMap(p => pieces(p)).map(piece => ({ piece, min: across }));
  const matchIndex = (piece: Piece): number =>
    history.findIndex(h => sameSentence(piece, h.piece, h.min));

  const all = pieces(text);
  const kept: Piece[] = [];
  let lastMatch = -1; // history index the previous piece was a repeat of; -1 when the run is over
  let removed = 0;

  for (let i = 0; i < all.length; i++) {
    const piece = all[i];
    if (!piece.tokens.length) { kept.push(piece); continue; }

    const j = matchIndex(piece);
    let drop = false;
    if (j >= 0) {
      drop = true;
      lastMatch = j;
    } else if (lastMatch >= 0 && history[lastMatch + 1]?.piece.key === piece.key) {
      drop = true; // continues a repeated run ("Tum meri zimmedari ho. Meri.")
      lastMatch += 1;
    } else {
      const next = all[i + 1];
      const j2 = next && next.tokens.length ? matchIndex(next) : -1;
      if (j2 > 0 && history[j2 - 1].piece.key === piece.key) {
        drop = true; // opener of a repeated run ("Fine, English. She looks up...")
        lastMatch = j2 - 1;
      }
    }

    if (drop) { removed++; continue; }
    lastMatch = -1;
    kept.push(piece);
    history.push({ piece, min: within });
  }

  if (!removed) return text;
  let result = kept.map(p => p.text).join("");
  if (trim) result = result.trim();
  if (result.trim()) return result;
  // Safety net: a reply made only of repeats is better than an empty one.
  return opts.allowEmpty ? "" : text;
}
