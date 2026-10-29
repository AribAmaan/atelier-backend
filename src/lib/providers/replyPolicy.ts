/**
 * Reply length follows the scene, not a quota.
 *
 * There is no word minimum, word maximum or padding pass. A greeting gets a
 * short answer, a big emotional or plot-heavy turn gets room, and the reply
 * stops when the beat is done. Length is steered only by prompt guidance that
 * reads how heavy the user's latest turn is (see classifyTurn); nothing is cut
 * or extended after generation.
 *
 * `tokens` is a runaway guard, not a target: it only matters if a model loops
 * or ignores the guidance. If it is ever reached, the provider continuation in
 * completeReply.ts finishes the sentence instead of leaving it cut off.
 */
export function replyProfile(intelligence: number) {
  // Two engines: Vanilla (free, intelligence <= 5, which is also the manual
  // slider default) and Hazelnut (paid). They differ in voice, initiative and
  // memory, not in how long a reply is allowed to be.
  if (intelligence <= 5) return {
    name: "Vanilla",
    purpose: "natural, attentive conversation with a relevant reaction",
    tokens: 400,
  };
  return {
    name: "Hazelnut",
    purpose: "precise character voice, subtext, continuity, and confident initiative",
    tokens: 600,
  };
}

/** Sentence boundaries, used by the repeated-sentence guard in replyRepeat.ts. */
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

export type TurnWeight = "light" | "normal" | "heavy";

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Cheap, language-agnostic read of how much the user's latest turn carries.
 * It is only a hint handed to the model; it never limits or extends output.
 *   light  — a greeting, a word or two, a quick yes/no/reaction
 *   normal — an ordinary message
 *   heavy  — a long message, several paragraphs, or a scene-setting turn
 */
export function classifyTurn(latestUserText: string, sceneDirective = ""): TurnWeight {
  const text = (latestUserText || "").trim();
  const words = wordCount(text);
  const paragraphs = text.split(/\n\s*\n/).filter(part => part.trim()).length;
  if (words >= 45 || paragraphs >= 3) return "heavy";
  if (words <= 6 && !sceneDirective.trim()) return "light";
  return "normal";
}

const WEIGHT_HINT: Record<TurnWeight, string> = {
  light: "The latest user turn is light (a greeting, a few words, or a quick reaction). Keep the reply compact, usually two to four sentences, but still alive: a small *action or expression* plus a line or two of dialogue in the character's own voice.",
  normal: "The latest user turn is an ordinary message. Answer at conversation size, usually one short paragraph: a visible *action or bit of atmosphere* woven with dialogue that shows real personality.",
  heavy: "The latest user turn is long or sets a scene. It can earn a fuller, scene-rich reply (action, setting, dialogue, emotion), but only as long as there is real substance to respond to; still stop when the beat is done.",
};

export function buildReplyGuidance(intelligence: number, weight: TurnWeight = "normal"): string {
  const p = replyProfile(intelligence);
  return `REPLY LENGTH AND STYLE — ${p.name}: ${p.purpose}. Write like a real roleplay partner, not a chatbot: pair the character's spoken dialogue with a brief *action, expression, body language or sensory detail* (in asterisks, or whatever style this chat already uses) so the character's personality, mood and voice show in both. Even a short reply carries a little of this; never send bare plain words with no character in them, and vary the action each time. Size every reply to the moment, never to a quota. ${WEIGHT_HINT[weight]} If the user asks for something shorter or longer, do that. Quick banter, a one-word answer, or a simple question gets a compact reply; a revealing, emotional, plot-moving, or scene-setting moment gets more. Stop as soon as the beat is complete. Every sentence must add a reaction, choice, consequence, or useful detail; do not pad with repeated emotions, the same gesture again, long scenery, recaps, or a tacked-on question. Do not copy the length of your earlier replies, and finish every sentence you start.`;
}

/**
 * Per-turn reply plan. The latest turn only selects the guidance wording; the
 * token ceiling is fixed per engine and exists purely to stop runaway output.
 */
export function planReply(intelligence: number, latestUserText: string, sceneDirective = "") {
  const p = replyProfile(intelligence);
  const weight = classifyTurn(latestUserText, sceneDirective);
  return {
    mode: "context" as const,
    weight,
    maxTokens: p.tokens,
    // Only used to finish a sentence the provider cut off at the ceiling.
    continuationMaxTokens: 160,
    instruction: buildReplyGuidance(intelligence, weight),
  };
}
