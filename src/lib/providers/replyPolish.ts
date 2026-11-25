import { replySentenceEnds } from "./replyPolicy";

/**
 * Deterministic polish for the final, saved reply. Form only: it removes
 * things no character in a scene would write (a speaker label, a customer-
 * service sign-off) and repairs formatting that would make the client italicise
 * the rest of the message. It never judges or rewrites what a line says.
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * "Aria: ...", "**Aria:** ...", "[Aria] ..." or "Assistant: ..." at the very
 * start of a reply is a leaked transcript label, not dialogue.
 */
export function stripSpeakerLabel(text: string, characterName = ""): string {
  const names = [characterName.trim(), "assistant", "character", "ai"].filter(Boolean).map(escapeRegExp).join("|");
  // Each form is anchored and explicit so an action opener such as
  // "Aria: *She smiles*" keeps its own leading asterisk.
  const forms = [
    new RegExp(`^\\s*(\\*{1,2})\\s*(?:${names})\\s*[:：]\\s*\\1\\s*`, "i"), // **Aria:**
    new RegExp(`^\\s*(\\*{1,2})\\s*(?:${names})\\s*\\1\\s*[:：]\\s*`, "i"), // **Aria**:
    new RegExp(`^\\s*[\\[(]\\s*(?:${names})\\s*[\\])]\\s*[:：]?\\s*`, "i"), // [Aria] / (Aria)
    new RegExp(`^\\s*(?:${names})\\s*[:：]\\s*`, "i"), // Aria:
  ];
  for (const form of forms) {
    const stripped = text.replace(form, "");
    if (stripped !== text) {
      // Never turn a reply into an empty string.
      return stripped.trim() ? stripped : text;
    }
  }
  return text;
}

/**
 * Closing questions that hand the turn back the way an assistant would.
 * Deliberately narrow and anchored to the END of the reply: a question the
 * character genuinely needs answered ("What about you?", "Where were you?")
 * is never touched. Only phrasings that no person in a scene would say are
 * listed. Lines such as "How does that sound?", "Shall we continue?", "What
 * happens next?" or "Where do we go from here?" are ordinary in-character
 * questions (an offer, a tour, a crossroads) and were removed from the list
 * after a false-positive audit; a missed tic is cheaper than a deleted ask.
 */
const STOCK_CLOSERS: RegExp[] = [
  /^(?:so,?\s+|well,?\s+)?what\s+(?:would|do)\s+you\s+(?:like|want|wish)\s+to\s+(?:do|talk\s+about|try|explore)\s+(?:next|now|from\s+here)\s*\?+$/i,
  /^(?:is\s+there\s+)?anything\s+else\s+(?:i\s+can|you(?:'d|\s+would)\s+like\s+me\s+to)\b[^?]*\?+$/i,
  /^(?:please\s+)?let\s+me\s+know\s+(?:if\s+(?:you(?:'d|\s+would)\s+like\s+(?:to\s+)?(?:continue|proceed)|there(?:'s|\s+is)\s+anything\s+else)|how\s+you(?:'d|\s+would)\s+like\s+to\s+(?:proceed|continue))\b[^.!?]*[.!]?$/i,
];

/**
 * Removes ONE trailing stock hand-back, and only when a real reply remains.
 */
export function stripStockCloser(text: string): string {
  const trimmed = text.trimEnd();
  const ends = replySentenceEnds(trimmed, true);
  if (ends.length < 2) return text;
  const lastStart = ends[ends.length - 2];
  const tail = trimmed.slice(lastStart);
  // Peel quotes/asterisks around the sentence so a spoken closer still matches.
  const core = tail.replace(/^[\s*"“_]+/u, "").replace(/[\s*"”_]+$/u, "");
  if (!STOCK_CLOSERS.some(re => re.test(core))) return text;
  let kept = trimmed.slice(0, lastStart).trimEnd();
  // "...So... what would you like to do next?" would otherwise leave a bare
  // "So..." behind. Drop a lead-in word that only existed to introduce the closer.
  kept = kept.replace(/(^|[\s*_"“”)\]])(?:so|well|anyway|and|but|now|then|okay|alright)(?:\s*,|\s*\.{2,}|\s*…)\s*$/i, "$1").trimEnd();
  return kept ? kept : text;
}

/**
 * Repairs the one unambiguous formatting fault: a SINGLE action left open
 * (the reply was cut mid-action, or the model forgot the closer), which would
 * make the client italicise whatever follows. An empty trailing opener is
 * removed instead of closed. Anything more tangled (nested or mismatched
 * markers) is left exactly as written, because guessing there can only make
 * it worse, and so the result is always stable (idempotent).
 */
function repairOnce(text: string): string {
  const stack: { width: number; index: number }[] = [];
  const re = /\\.|\*+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0][0] === "\\") continue;
    if (m[0].length > 2) continue; // literal runs like *** are not delimiters
    // "3 * 4" is arithmetic, not an action marker (same rule as splitRoleplayInput).
    if (/\d\s*$/.test(text.slice(0, m.index)) && /^\s*\d/.test(text.slice(m.index + m[0].length))) continue;
    const width = m[0].length;
    if (stack.length && stack[stack.length - 1].width === width) stack.pop(); else stack.push({ width, index: m.index });
  }
  if (stack.length !== 1) return text;
  const open = stack[0];
  const after = text.slice(open.index + open.width);
  if (!after.trim()) {
    // An empty trailing opener is junk, but never reduce a reply to nothing.
    const stripped = text.slice(0, open.index).trimEnd();
    return stripped || text;
  }
  const body = text.trimEnd();
  // A closer glued to another asterisk run, or escaped by a trailing
  // backslash, would not read as a delimiter. Leave those as written.
  if (/[*\\]$/.test(body)) return text;
  return body + "*".repeat(open.width);
}

export function closeDanglingAsterisks(text: string): string {
  const once = repairOnce(text);
  // Only ever return a stable result, so repeated cleanup cannot keep editing.
  return repairOnce(once) === once ? once : text;
}

export function polishReply(text: string, characterName = ""): string {
  if (!text) return text;
  let out = stripSpeakerLabel(text, characterName);
  out = stripStockCloser(out);
  return closeDanglingAsterisks(restoreActionMarkup(out)).trim();
}


/** "Ana:" or "Dr. Voss:" on its own is a speaker label, not narration. */
const SPEAKER_LABEL = /^[\p{L}][\p{L}\p{M} .'\u2019-]{0,30}:$/u;

function wrapNarrationRun(run: string): string {
  return run.split(/(\n+)/).map(part => {
    if (!part || /^\n+$/.test(part)) return part;
    const core = part.trim();
    if (!/\p{L}/u.test(core) || SPEAKER_LABEL.test(core)) return part;
    const lead = part.match(/^\s*/)![0], trail = part.match(/\s*$/)![0];
    return `${lead}*${core}*${trail}`;
  }).join("");
}

/**
 * The model sometimes drops the *action* format for a whole reply, so the client cannot italicise the
 * narration. When a reply has no asterisks at all but is laid out as quoted dialogue (a paragraph
 * starts with a quote), the text between the quotes is narration: wrap each such run in asterisks.
 * Anything ambiguous (existing asterisks, unbalanced quotes, no dialogue-style paragraph) is left
 * exactly as written. Form only: no word is added, removed or changed.
 */
export function restoreActionMarkup(text: string): string {
  if (!text || text.includes("*")) return text;
  if ((text.match(/"/g) ?? []).length % 2) return text;
  if ((text.match(/\u201c/g) ?? []).length !== (text.match(/\u201d/g) ?? []).length) return text;
  if (!/(^|\n)[ \t]*["\u201c]/.test(text)) return text;
  let out = "", last = 0;
  for (const m of text.matchAll(/"[^"]*"|\u201c[^\u201d]*\u201d/g)) {
    const at = m.index ?? 0;
    out += wrapNarrationRun(text.slice(last, at)) + m[0];
    last = at + m[0].length;
  }
  return out + wrapNarrationRun(text.slice(last));
}
